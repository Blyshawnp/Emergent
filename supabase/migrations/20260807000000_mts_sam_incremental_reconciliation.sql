-- Forward-only infrastructure for exact incremental reconciliation accounting.
-- This migration is intentionally shipped unapplied. Sheets remains authoritative.

set search_path = '';

create table mts_sam.reconciliation_batches (
  id uuid primary key default extensions.gen_random_uuid(),
  mode text not null check (mode in ('dry_run','execute')),
  status text not null check (status in (
    'planned','blocked','ready','running','succeeded','partially_failed','failed','rolled_back'
  )),
  target_project_ref text not null,
  source_snapshot_at timestamptz not null,
  source_snapshot_checksum text not null check (source_snapshot_checksum ~ '^[0-9a-f]{64}$'),
  plan_checksum text not null unique check (plan_checksum ~ '^[0-9a-f]{64}$'),
  plan_expires_at timestamptz not null,
  provider_state jsonb not null,
  source_rows_considered integer not null default 0 check (source_rows_considered >= 0),
  inserts_planned integer not null default 0 check (inserts_planned >= 0),
  updates_planned integer not null default 0 check (updates_planned >= 0),
  unresolved_count integer not null default 0 check (unresolved_count >= 0),
  conflicts_count integer not null default 0 check (conflicts_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  lineage_outcomes jsonb not null default '{}'::jsonb,
  before_image_count integer not null default 0 check (before_image_count >= 0),
  created_entity_count integer not null default 0 check (created_entity_count >= 0),
  verification_result jsonb not null default '{}'::jsonb,
  rollback_eligible boolean not null default false,
  rollback_status text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  check (plan_expires_at > source_snapshot_at)
);

create table mts_sam.reconciliation_plan_items (
  id uuid primary key default extensions.gen_random_uuid(),
  reconciliation_batch_id uuid not null references mts_sam.reconciliation_batches(id) on delete restrict,
  sequence_number integer not null check (sequence_number > 0),
  entity_type text not null,
  operation text not null check (operation in ('insert','update','lineage','skip')),
  classification text not null check (classification in (
    'insert_new','update_existing','already_current','expected_historical','expected_duplicate',
    'unresolved','ambiguous','conflict','unsupported','derived_only'
  )),
  safe_identity_hash text not null check (safe_identity_hash ~ '^[0-9a-f]{64}$'),
  canonical_entity_id uuid,
  source_tab text not null,
  source_row_key text not null,
  source_checksum text,
  expected_target_checksum text,
  proposed_target_checksum text,
  changed_fields text[] not null default '{}',
  dependencies jsonb not null default '[]'::jsonb check (jsonb_typeof(dependencies) = 'array'),
  lineage_expected_outcome text,
  blocking_reason text,
  created_by_batch boolean not null default false,
  result_status text,
  result_code text,
  post_sync_checksum text,
  created_at timestamptz not null default statement_timestamp(),
  unique (reconciliation_batch_id, sequence_number),
  unique (reconciliation_batch_id, entity_type, safe_identity_hash, operation)
);

create table mts_sam.reconciliation_before_images (
  id uuid primary key default extensions.gen_random_uuid(),
  reconciliation_batch_id uuid not null references mts_sam.reconciliation_batches(id) on delete restrict,
  plan_item_id uuid not null unique references mts_sam.reconciliation_plan_items(id) on delete restrict,
  entity_type text not null,
  canonical_entity_id uuid not null,
  safe_identity_hash text not null check (safe_identity_hash ~ '^[0-9a-f]{64}$'),
  changed_fields text[] not null check (cardinality(changed_fields) > 0),
  before_values jsonb not null,
  original_checksum text not null check (original_checksum ~ '^[0-9a-f]{64}$'),
  proposed_checksum text not null check (proposed_checksum ~ '^[0-9a-f]{64}$'),
  plan_checksum text not null check (plan_checksum ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz not null default statement_timestamp()
);

create index reconciliation_batches_status_idx
  on mts_sam.reconciliation_batches (status, created_at desc);
create index reconciliation_items_batch_operation_idx
  on mts_sam.reconciliation_plan_items (reconciliation_batch_id, operation, sequence_number);
create index reconciliation_items_created_idx
  on mts_sam.reconciliation_plan_items (reconciliation_batch_id, entity_type)
  where created_by_batch;

create function mts_sam.guard_reconciliation_batch_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'reconciliation batches are immutable audit evidence';
  end if;

  if (to_jsonb(new) - array[
        'status','started_at','completed_at','unresolved_count','conflicts_count',
        'skipped_count','lineage_outcomes','before_image_count','created_entity_count',
        'verification_result','rollback_eligible','rollback_status'
      ]::text[])
     is distinct from
     (to_jsonb(old) - array[
        'status','started_at','completed_at','unresolved_count','conflicts_count',
        'skipped_count','lineage_outcomes','before_image_count','created_entity_count',
        'verification_result','rollback_eligible','rollback_status'
      ]::text[]) then
    raise exception 'reconciliation planning evidence is immutable';
  end if;

  if old.status is distinct from new.status and not (
    (old.status = 'planned' and new.status in ('blocked','ready')) or
    (old.status = 'blocked' and new.status = 'ready') or
    (old.status = 'ready' and new.status = 'running') or
    (old.status = 'running' and new.status in ('succeeded','partially_failed','failed')) or
    (old.status in ('succeeded','partially_failed') and new.status = 'rolled_back')
  ) then
    raise exception 'invalid reconciliation batch status transition: % -> %', old.status, new.status;
  end if;

  if new.status = 'running' and (old.mode <> 'execute' or new.started_at is null) then
    raise exception 'only an execute batch with started_at may run';
  end if;
  if new.status in ('succeeded','partially_failed','failed','rolled_back') and new.completed_at is null then
    raise exception 'terminal reconciliation status requires completed_at';
  end if;
  if new.rollback_eligible and new.status not in ('succeeded','partially_failed') then
    raise exception 'rollback eligibility requires a completed write batch';
  end if;
  if new.status = 'rolled_back' and (not old.rollback_eligible or new.rollback_status <> 'succeeded') then
    raise exception 'rollback requires prior eligibility and a succeeded batch-scoped rollback';
  end if;
  return new;
end;
$$;

create function mts_sam.guard_reconciliation_plan_item_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  batch_status text;
begin
  if tg_op = 'DELETE' then
    raise exception 'reconciliation plan items are immutable audit evidence';
  end if;

  select status into batch_status
  from mts_sam.reconciliation_batches
  where id = coalesce(new.reconciliation_batch_id, old.reconciliation_batch_id);

  if tg_op = 'INSERT' then
    if batch_status not in ('planned','blocked','ready') then
      raise exception 'plan items cannot be inserted after execution starts';
    end if;
    return new;
  end if;

  if batch_status <> 'running' then
    raise exception 'plan result fields may change only while the batch is running';
  end if;
  if (to_jsonb(new) - array[
        'created_by_batch','result_status','result_code','post_sync_checksum'
      ]::text[])
     is distinct from
     (to_jsonb(old) - array[
        'created_by_batch','result_status','result_code','post_sync_checksum'
      ]::text[]) then
    raise exception 'plan definition cannot be altered after execution starts';
  end if;
  if new.created_by_batch and (
    new.operation <> 'insert' or new.canonical_entity_id is null or
    new.result_status <> 'succeeded' or new.post_sync_checksum is null
  ) then
    raise exception 'created-by-batch accounting requires a proven successful insert';
  end if;
  return new;
end;
$$;

create function mts_sam.guard_reconciliation_before_image_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  batch_status text;
  item_batch_id uuid;
  item_operation text;
  item_entity_id uuid;
begin
  if tg_op <> 'INSERT' then
    raise exception 'reconciliation before-images are immutable audit evidence';
  end if;
  select b.status, p.reconciliation_batch_id, p.operation, p.canonical_entity_id
    into batch_status, item_batch_id, item_operation, item_entity_id
  from mts_sam.reconciliation_batches b
  join mts_sam.reconciliation_plan_items p on p.id = new.plan_item_id
  where b.id = new.reconciliation_batch_id;
  if batch_status <> 'running' or item_batch_id is distinct from new.reconciliation_batch_id
     or item_operation <> 'update' or item_entity_id is distinct from new.canonical_entity_id then
    raise exception 'before-image must be batch-scoped to a running exact update';
  end if;
  return new;
end;
$$;

create trigger reconciliation_batch_change_guard
before update or delete on mts_sam.reconciliation_batches
for each row execute function mts_sam.guard_reconciliation_batch_change();

create trigger reconciliation_plan_item_change_guard
before insert or update or delete on mts_sam.reconciliation_plan_items
for each row execute function mts_sam.guard_reconciliation_plan_item_change();

create trigger reconciliation_before_image_change_guard
before insert or update or delete on mts_sam.reconciliation_before_images
for each row execute function mts_sam.guard_reconciliation_before_image_change();

alter table mts_sam.reconciliation_batches enable row level security;
alter table mts_sam.reconciliation_batches force row level security;
alter table mts_sam.reconciliation_plan_items enable row level security;
alter table mts_sam.reconciliation_plan_items force row level security;
alter table mts_sam.reconciliation_before_images enable row level security;
alter table mts_sam.reconciliation_before_images force row level security;

revoke all on mts_sam.reconciliation_batches from public, anon, authenticated;
revoke all on mts_sam.reconciliation_plan_items from public, anon, authenticated;
revoke all on mts_sam.reconciliation_before_images from public, anon, authenticated;

grant select, insert on mts_sam.reconciliation_batches to service_role;
grant update (
  status, started_at, completed_at, unresolved_count, conflicts_count, skipped_count,
  lineage_outcomes, before_image_count, created_entity_count, verification_result,
  rollback_eligible, rollback_status
) on mts_sam.reconciliation_batches to service_role;
grant select, insert on mts_sam.reconciliation_plan_items to service_role;
grant update (
  created_by_batch, result_status, result_code, post_sync_checksum
) on mts_sam.reconciliation_plan_items to service_role;
grant select, insert on mts_sam.reconciliation_before_images to service_role;

revoke all on function mts_sam.guard_reconciliation_batch_change() from public, anon, authenticated;
revoke all on function mts_sam.guard_reconciliation_plan_item_change() from public, anon, authenticated;
revoke all on function mts_sam.guard_reconciliation_before_image_change() from public, anon, authenticated;

comment on table mts_sam.reconciliation_before_images is
  'Private narrow rollback evidence. Never expose through anon/authenticated views.';
comment on column mts_sam.reconciliation_plan_items.created_by_batch is
  'True only after this exact batch proves it created the canonical entity.';
