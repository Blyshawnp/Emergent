create table mts_sam.candidates (
  id uuid primary key default extensions.gen_random_uuid(),
  source_system text not null default 'google_sheets',
  source_candidate_id text,
  display_name text not null,
  first_name text,
  last_initial text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique nulls not distinct (source_system, source_candidate_id)
);

create table mts_sam.candidate_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id text not null unique check (btrim(session_id) <> ''),
  candidate_id uuid references mts_sam.candidates(id) on delete set null,
  candidate_name text not null default '',
  candidate_first_name text,
  candidate_last_initial text,
  tester_name text,
  session_type text,
  attempt_number integer check (attempt_number is null or attempt_number > 0),
  current_attempt_number integer check (current_attempt_number is null or current_attempt_number > 0),
  allowed_attempt_count integer check (allowed_attempt_count is null or allowed_attempt_count > 0),
  extra_attempts_granted integer check (extra_attempts_granted is null or extra_attempts_granted >= 0),
  final_attempt boolean,
  raw_status text,
  calculated_result text,
  final_result text,
  readiness_override_applied boolean,
  readiness_override_result text,
  readiness_override_reason text,
  readiness_override_explanation text,
  withdrawn boolean,
  archived boolean,
  needs_sup_transfer boolean,
  pending_sup_transfer_id text,
  mock_calls_completed integer,
  sup_transfers_completed integer,
  call_results jsonb not null default '{}'::jsonb,
  supervisor_transfer_results jsonb not null default '{}'::jsonb,
  coaching_summary text,
  fail_summary text,
  review_notes text,
  evaluator_notes_summary text,
  skills jsonb,
  final_notes jsonb not null default '{}'::jsonb,
  headset_brand text,
  headset_model text,
  headset_usb boolean,
  noise_cancel boolean,
  environment_checks jsonb not null default '{}'::jsonb,
  form_fill_status text,
  form_filled_at timestamptz,
  newbie_shift_number text,
  newbie_shift_data jsonb not null default '{}'::jsonb,
  deletion_request_data jsonb not null default '{}'::jsonb,
  created_at timestamptz,
  completed_at timestamptz,
  withdrawn_at timestamptz,
  retention_until timestamptz,
  imported_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  source_checksum text not null,
  source_payload jsonb not null,
  constraint candidate_attempt_bounds check (
    current_attempt_number is null or allowed_attempt_count is null or current_attempt_number <= allowed_attempt_count
  )
);

create table mts_sam.session_attempts (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references mts_sam.candidate_sessions(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  attempt_type text not null default 'mock_call',
  result text,
  occurred_at timestamptz,
  source_action_id text,
  details jsonb not null default '{}'::jsonb,
  unique (session_id, attempt_number, attempt_type),
  unique nulls not distinct (source_action_id)
);

create table mts_sam.candidate_status_actions (
  id uuid primary key default extensions.gen_random_uuid(),
  action_id text not null unique,
  session_id uuid not null references mts_sam.candidate_sessions(id) on delete restrict,
  action_type text not null check (action_type in ('mark_passed','mark_failed','readiness_override','clear_readiness_override')),
  result text,
  reason text,
  actor_name text,
  before_state jsonb,
  after_state jsonb,
  occurred_at timestamptz not null,
  source_provider text not null
);

create table mts_sam.candidate_corrections (
  id uuid primary key default extensions.gen_random_uuid(),
  request_id text not null unique,
  source_session_id text not null check (btrim(source_session_id) <> ''),
  session_id uuid references mts_sam.candidate_sessions(id) on delete set null,
  candidate_id uuid references mts_sam.candidates(id) on delete set null,
  request_type text,
  reason text,
  changes jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  requested_by text,
  decided_by text,
  denial_reason text,
  created_at timestamptz,
  decision_at timestamptz,
  updated_at timestamptz,
  source_checksum text not null,
  source_payload jsonb not null
);

create table mts_sam.extra_attempt_grants (
  id uuid primary key default extensions.gen_random_uuid(),
  action_id text not null unique,
  session_id uuid not null references mts_sam.candidate_sessions(id) on delete restrict,
  source_session_id text not null,
  granted_count integer not null default 1 check (granted_count > 0),
  resulting_allowed_attempt_count integer not null check (resulting_allowed_attempt_count > 0),
  reason text,
  granted_by text,
  granted_at timestamptz not null,
  source_provider text not null
);

create table mts_sam.supervisor_transfers (
  id uuid primary key default extensions.gen_random_uuid(),
  transfer_id text not null unique,
  source_session_id text not null,
  session_id uuid references mts_sam.candidate_sessions(id) on delete set null,
  candidate_name text,
  original_tester_name text,
  status text,
  final_attempt boolean,
  completed_by text,
  completed_status text,
  needed_reason text,
  notes text,
  created_at timestamptz,
  completed_at timestamptz,
  source_checksum text not null,
  source_payload jsonb not null
);

create table mts_sam.newbie_shift_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  request_id text not null unique,
  source_session_id text not null,
  session_id uuid references mts_sam.candidate_sessions(id) on delete set null,
  request_type text,
  request_status text,
  newbie_shift_number text,
  scheduled_at timestamptz,
  original_scheduled_at timestamptz,
  rescheduled_at timestamptz,
  timezone text,
  within_24_hours boolean,
  counts_as_attempt boolean,
  final_attempt boolean,
  current_attempt integer check (current_attempt is null or current_attempt > 0),
  resulting_attempt integer check (resulting_attempt is null or resulting_attempt > 0),
  becomes_final_attempt boolean,
  attempt_rule text,
  terminal_outcome text,
  requested_by text,
  request_reason text,
  request_details text,
  decision_by text,
  denial_reason text,
  created_at timestamptz,
  decision_at timestamptz,
  updated_at timestamptz,
  source_checksum text not null,
  source_payload jsonb not null
);

create table mts_sam.newbie_shift_reschedules (
  id uuid primary key default extensions.gen_random_uuid(),
  reschedule_id text not null unique,
  request_id uuid not null references mts_sam.newbie_shift_requests(id) on delete restrict,
  previous_scheduled_at timestamptz,
  scheduled_at timestamptz not null,
  requested_by text,
  reason text,
  occurred_at timestamptz not null,
  source_provider text not null
);

create trigger candidates_set_updated_at before update on mts_sam.candidates
for each row execute function mts_sam.set_updated_at();
create trigger candidate_sessions_set_updated_at before update on mts_sam.candidate_sessions
for each row execute function mts_sam.set_updated_at();

create index candidate_sessions_candidate_idx on mts_sam.candidate_sessions (candidate_id, created_at desc);
create index candidate_sessions_status_idx on mts_sam.candidate_sessions (raw_status, completed_at desc);
create index candidate_corrections_session_idx on mts_sam.candidate_corrections (source_session_id, created_at desc);
create index supervisor_transfers_session_idx on mts_sam.supervisor_transfers (source_session_id, created_at desc);
create index newbie_shift_requests_session_idx on mts_sam.newbie_shift_requests (source_session_id, created_at desc);
