create table mts_sam.import_batches (
  id uuid primary key default extensions.gen_random_uuid(),
  batch_key text not null unique,
  source_system text not null,
  importer_version text not null,
  status text not null default 'created' check (status in ('created','extracting','staged','validating','loading','reconciling','succeeded','failed','rolled_back')),
  source_snapshot_at timestamptz,
  started_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  source_row_count integer not null default 0 check (source_row_count >= 0),
  staged_row_count integer not null default 0 check (staged_row_count >= 0),
  normalized_row_count integer not null default 0 check (normalized_row_count >= 0),
  unresolved_row_count integer not null default 0 check (unresolved_row_count >= 0),
  duplicate_row_count integer not null default 0 check (duplicate_row_count >= 0),
  rejected_row_count integer not null default 0 check (rejected_row_count >= 0),
  source_checksum text,
  error_summary text,
  metadata jsonb not null default '{}'::jsonb
);

alter table mts_sam.audit_events
  add constraint audit_events_import_batch_fk foreign key (import_batch_id) references mts_sam.import_batches(id) on delete set null;
alter table mts_sam.data_source_lineage
  add constraint lineage_import_batch_fk foreign key (import_batch_id) references mts_sam.import_batches(id) on delete set null;

create table mts_sam.import_staging_rows (
  id uuid primary key default extensions.gen_random_uuid(),
  import_batch_id uuid not null references mts_sam.import_batches(id) on delete cascade,
  source_system text not null,
  source_tab text not null,
  source_row_number integer not null check (source_row_number >= 2),
  source_row_key text not null,
  source_record_id text,
  source_checksum text not null,
  raw_row jsonb not null,
  header_presence jsonb not null default '{}'::jsonb,
  normalization_status text not null default 'pending' check (normalization_status in ('pending','valid','loaded','duplicate','unresolved','rejected','rolled_back')),
  normalization_rule text,
  unresolved_reason_code text,
  normalized_entity_type text,
  normalized_entity_id uuid,
  staged_at timestamptz not null default statement_timestamp(),
  imported_at timestamptz,
  unique (import_batch_id, source_tab, source_row_key)
);

create table mts_sam.import_row_results (
  id uuid primary key default extensions.gen_random_uuid(),
  import_batch_id uuid not null references mts_sam.import_batches(id) on delete cascade,
  staging_row_id uuid not null references mts_sam.import_staging_rows(id) on delete cascade,
  result_status text not null check (result_status in ('loaded','duplicate','unresolved','rejected','rolled_back')),
  result_code text not null,
  entity_type text,
  entity_id uuid,
  message text,
  created_at timestamptz not null default statement_timestamp(),
  unique (staging_row_id)
);

create table mts_sam.reconciliation_results (
  id uuid primary key default extensions.gen_random_uuid(),
  import_batch_id uuid not null references mts_sam.import_batches(id) on delete cascade,
  source_tab text not null,
  source_row_count integer not null default 0,
  staged_row_count integer not null default 0,
  normalized_row_count integer not null default 0,
  unresolved_row_count integer not null default 0,
  duplicate_row_count integer not null default 0,
  rejected_row_count integer not null default 0,
  missing_identity_count integer not null default 0,
  relationship_mismatch_count integer not null default 0,
  status_mismatch_count integer not null default 0,
  date_parse_failure_count integer not null default 0,
  blank_required_field_count integer not null default 0,
  legacy_format_count integer not null default 0,
  source_checksum text,
  staged_checksum text,
  normalized_checksum text,
  reconciled_at timestamptz not null default statement_timestamp(),
  details jsonb not null default '{}'::jsonb,
  unique (import_batch_id, source_tab)
);

create table mts_sam.synchronization_events (
  id uuid primary key default extensions.gen_random_uuid(),
  event_key text not null unique,
  provider_from text not null,
  provider_to text not null,
  resource_name text not null,
  operation text not null,
  source_entity_id text,
  status text not null,
  mismatch_count integer not null default 0 check (mismatch_count >= 0),
  source_checksum text,
  destination_checksum text,
  error_code text,
  occurred_at timestamptz not null default statement_timestamp(),
  metadata jsonb not null default '{}'::jsonb
);

create index staging_batch_tab_idx on mts_sam.import_staging_rows (import_batch_id, source_tab, normalization_status);
create index staging_unresolved_idx on mts_sam.import_staging_rows (source_tab, unresolved_reason_code) where normalization_status = 'unresolved';
create index reconciliation_batch_idx on mts_sam.reconciliation_results (import_batch_id, source_tab);
