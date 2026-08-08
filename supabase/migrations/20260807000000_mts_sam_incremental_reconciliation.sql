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
  dependencies jsonb not null default '[]'::jsonb,
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
  canonical_entity_id, created_by_batch, result_status, result_code, post_sync_checksum
) on mts_sam.reconciliation_plan_items to service_role;
grant select, insert on mts_sam.reconciliation_before_images to service_role;

comment on table mts_sam.reconciliation_before_images is
  'Private narrow rollback evidence. Never expose through anon/authenticated views.';
comment on column mts_sam.reconciliation_plan_items.created_by_batch is
  'True only after this exact batch proves it created the canonical entity.';
