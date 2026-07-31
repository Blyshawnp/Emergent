-- MTS/SAM shared data foundation. Application objects are isolated from public.
create schema if not exists mts_sam;
comment on schema mts_sam is 'MTS/SAM canonical, staging, audit, and reconciliation data';

create extension if not exists pgcrypto with schema extensions;

create or replace function mts_sam.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, mts_sam
as $$
begin
  new.updated_at = statement_timestamp();
  return new;
end;
$$;

create table mts_sam.app_users (
  id uuid primary key default extensions.gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  source_system text not null default 'supabase',
  source_user_id text,
  display_name text not null default '',
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique nulls not distinct (source_system, source_user_id)
);

create table mts_sam.app_roles (
  role_key text primary key check (role_key ~ '^[a-z][a-z0-9_]*$'),
  description text not null default '',
  created_at timestamptz not null default statement_timestamp()
);

insert into mts_sam.app_roles (role_key, description) values
  ('evaluator', 'MTS evaluator workflow'),
  ('administrator', 'SAM administrative workflow'),
  ('importer', 'Trusted import and reconciliation process'),
  ('viewer', 'Read-only operational access')
on conflict (role_key) do update set description = excluded.description;

create table mts_sam.user_role_assignments (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references mts_sam.app_users(id) on delete cascade,
  role_key text not null references mts_sam.app_roles(role_key),
  assigned_by uuid references mts_sam.app_users(id) on delete set null,
  assigned_at timestamptz not null default statement_timestamp(),
  revoked_at timestamptz,
  unique (user_id, role_key)
);

create table mts_sam.application_settings (
  setting_key text primary key,
  setting_value jsonb not null default '{}'::jsonb,
  app_scope text not null default 'shared' check (app_scope in ('shared','mts','sam')),
  updated_by uuid references mts_sam.app_users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp()
);

create table mts_sam.sync_state (
  provider text not null,
  resource_name text not null,
  cursor_value text,
  source_checksum text,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_error_code text,
  metadata jsonb not null default '{}'::jsonb,
  primary key (provider, resource_name)
);

create table mts_sam.audit_events (
  id uuid primary key default extensions.gen_random_uuid(),
  action_id text not null unique,
  entity_type text not null,
  entity_id uuid,
  source_entity_id text,
  action_type text not null,
  actor_user_id uuid references mts_sam.app_users(id) on delete set null,
  actor_source_value text,
  reason text,
  before_state jsonb,
  after_state jsonb,
  source_provider text not null,
  import_batch_id uuid,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default statement_timestamp()
);

create table mts_sam.data_source_lineage (
  id uuid primary key default extensions.gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  source_system text not null,
  source_tab text not null,
  source_row_key text not null,
  source_record_id text,
  source_checksum text not null,
  import_batch_id uuid,
  imported_at timestamptz not null default statement_timestamp(),
  last_reconciled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  unique (source_system, source_tab, source_row_key),
  unique (entity_type, entity_id, source_system, source_tab)
);

create trigger app_users_set_updated_at before update on mts_sam.app_users
for each row execute function mts_sam.set_updated_at();
create trigger application_settings_set_updated_at before update on mts_sam.application_settings
for each row execute function mts_sam.set_updated_at();

create index app_users_source_idx on mts_sam.app_users (source_system, source_user_id);
create index role_assignments_active_idx on mts_sam.user_role_assignments (user_id, role_key) where revoked_at is null;
create index audit_events_entity_idx on mts_sam.audit_events (entity_type, entity_id, occurred_at desc);
create index lineage_entity_idx on mts_sam.data_source_lineage (entity_type, entity_id);
