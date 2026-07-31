create table mts_sam.headset_catalog (
  id uuid primary key default extensions.gen_random_uuid(),
  catalog_id text not null unique,
  source_row_key text not null unique,
  brand text not null check (btrim(brand) <> ''),
  model text not null check (btrim(model) <> ''),
  status text not null default 'unknown' check (status in ('approved','denied','archived','deleted','inactive','pending','unknown')),
  note text,
  legacy_source_value text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  archived_at timestamptz,
  deleted_at timestamptz,
  source_checksum text not null,
  source_payload jsonb not null,
  unique (brand, model)
);

create table mts_sam.headset_reviews (
  id uuid primary key default extensions.gen_random_uuid(),
  review_id text not null unique,
  source_session_id text,
  session_id uuid references mts_sam.candidate_sessions(id) on delete set null,
  catalog_id uuid references mts_sam.headset_catalog(id) on delete set null,
  candidate_name text,
  tester_name text,
  brand text,
  model text,
  status text not null default 'pending' check (status in ('approved','denied','archived','deleted','inactive','pending','unknown')),
  note text,
  denial_reason text,
  decision_by text,
  legacy_source_value text,
  normalization_status text not null default 'canonical' check (
    normalization_status in ('canonical','deterministic_catalog_match','unresolved_legacy_brand','missing_identity','invalid')
  ),
  normalization_rule text,
  created_at timestamptz,
  updated_at timestamptz,
  decision_at timestamptz,
  source_checksum text not null,
  source_payload jsonb not null
);

create table mts_sam.headset_review_actions (
  id uuid primary key default extensions.gen_random_uuid(),
  action_id text not null unique,
  review_id uuid not null references mts_sam.headset_reviews(id) on delete restrict,
  action_type text not null check (action_type in ('approve','deny','edit','archive','restore','delete')),
  actor_name text,
  reason text,
  before_state jsonb,
  after_state jsonb,
  occurred_at timestamptz not null,
  source_provider text not null
);

create table mts_sam.pending_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  request_id text not null unique,
  request_type text not null,
  source_session_id text,
  session_id uuid references mts_sam.candidate_sessions(id) on delete set null,
  status text not null default 'pending',
  candidate_name text,
  tester_name text,
  request_reason text,
  request_details jsonb not null default '{}'::jsonb,
  requested_by text,
  decision_by text,
  denial_reason text,
  created_at timestamptz,
  decision_at timestamptz,
  updated_at timestamptz,
  source_checksum text not null,
  source_payload jsonb not null
);

create table mts_sam.notifications (
  id uuid primary key default extensions.gen_random_uuid(),
  notification_id text not null unique,
  enabled boolean not null default true,
  notification_type text,
  title text not null,
  message text not null default '',
  show_ticker boolean not null default false,
  show_popup boolean not null default false,
  show_banner boolean not null default false,
  persistent boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  action_text text,
  action_url text,
  created_at timestamptz,
  updated_at timestamptz,
  source_checksum text not null,
  source_payload jsonb not null
);

create table mts_sam.notification_deliveries (
  id uuid primary key default extensions.gen_random_uuid(),
  notification_id uuid not null references mts_sam.notifications(id) on delete cascade,
  recipient_user_id uuid references mts_sam.app_users(id) on delete set null,
  device_key text,
  delivery_status text not null,
  delivered_at timestamptz,
  acknowledged_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  unique nulls not distinct (notification_id, recipient_user_id, device_key)
);

create table mts_sam.activity_events (
  id uuid primary key default extensions.gen_random_uuid(),
  event_id text not null unique,
  event_type text not null,
  entity_type text,
  entity_id uuid,
  source_entity_id text,
  actor_name text,
  summary text,
  event_data jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  source_provider text not null
);

create trigger headset_catalog_set_updated_at before update on mts_sam.headset_catalog
for each row execute function mts_sam.set_updated_at();

create index headset_catalog_selectable_idx on mts_sam.headset_catalog (brand, model) where status = 'approved' and archived_at is null and deleted_at is null;
create index headset_reviews_queue_idx on mts_sam.headset_reviews (status, created_at desc);
create index headset_reviews_session_idx on mts_sam.headset_reviews (source_session_id);
create index pending_requests_queue_idx on mts_sam.pending_requests (status, created_at desc);
create index activity_events_recent_idx on mts_sam.activity_events (occurred_at desc);
create index notifications_active_idx on mts_sam.notifications (enabled, starts_at, ends_at);
