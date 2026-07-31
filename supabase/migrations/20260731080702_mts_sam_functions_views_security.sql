create or replace function mts_sam.current_app_has_role(required_roles text[])
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, mts_sam
as $$
  select exists (
    select 1
    from mts_sam.app_users u
    join mts_sam.user_role_assignments ura on ura.user_id = u.id
    where u.auth_user_id = auth.uid()
      and u.active
      and ura.revoked_at is null
      and ura.role_key = any(required_roles)
  );
$$;

create or replace function mts_sam.prevent_historical_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, mts_sam
as $$
begin
  raise exception 'Historical records are append-only';
end;
$$;

create trigger audit_events_immutable before update or delete on mts_sam.audit_events
for each row execute function mts_sam.prevent_historical_mutation();
create trigger candidate_status_actions_immutable before update or delete on mts_sam.candidate_status_actions
for each row execute function mts_sam.prevent_historical_mutation();
create trigger extra_attempt_grants_immutable before update or delete on mts_sam.extra_attempt_grants
for each row execute function mts_sam.prevent_historical_mutation();
create trigger headset_review_actions_immutable before update or delete on mts_sam.headset_review_actions
for each row execute function mts_sam.prevent_historical_mutation();
create trigger newbie_shift_reschedules_immutable before update or delete on mts_sam.newbie_shift_reschedules
for each row execute function mts_sam.prevent_historical_mutation();

create or replace function mts_sam.grant_extra_attempt(
  p_action_id text,
  p_session_id text,
  p_expected_allowed_count integer,
  p_reason text,
  p_actor text,
  p_occurred_at timestamptz default statement_timestamp()
)
returns mts_sam.candidate_sessions
language plpgsql
security definer
set search_path = pg_catalog, mts_sam, extensions
as $$
declare
  v_session mts_sam.candidate_sessions;
begin
  if btrim(coalesce(p_action_id, '')) = '' or btrim(coalesce(p_session_id, '')) = '' then
    raise exception 'Exact action and session identity are required';
  end if;
  select * into v_session from mts_sam.candidate_sessions where session_id = p_session_id for update;
  if not found then raise exception 'Session not found'; end if;
  if coalesce(v_session.allowed_attempt_count, 3) <> p_expected_allowed_count then
    raise exception 'Stale session state';
  end if;
  insert into mts_sam.extra_attempt_grants (
    action_id, session_id, source_session_id, granted_count,
    resulting_allowed_attempt_count, reason, granted_by, granted_at, source_provider
  ) values (
    p_action_id, v_session.id, v_session.session_id, 1,
    p_expected_allowed_count + 1, p_reason, p_actor, p_occurred_at, 'supabase'
  );
  update mts_sam.candidate_sessions
  set extra_attempts_granted = coalesce(extra_attempts_granted, 0) + 1,
      allowed_attempt_count = p_expected_allowed_count + 1
  where id = v_session.id
  returning * into v_session;
  insert into mts_sam.audit_events (
    action_id, entity_type, entity_id, source_entity_id, action_type,
    actor_source_value, reason, after_state, source_provider, occurred_at
  ) values (
    p_action_id, 'candidate_session', v_session.id, v_session.session_id, 'grant_extra_attempt',
    p_actor, p_reason, jsonb_build_object('allowed_attempt_count', v_session.allowed_attempt_count), 'supabase', p_occurred_at
  );
  return v_session;
end;
$$;

create or replace function mts_sam.apply_candidate_status_override(
  p_action_id text,
  p_session_id text,
  p_expected_result text,
  p_result text,
  p_reason text,
  p_actor text,
  p_occurred_at timestamptz default statement_timestamp()
)
returns mts_sam.candidate_sessions
language plpgsql
security definer
set search_path = pg_catalog, mts_sam, extensions
as $$
declare
  v_session mts_sam.candidate_sessions;
  v_before jsonb;
begin
  select * into v_session from mts_sam.candidate_sessions where session_id = p_session_id for update;
  if not found then raise exception 'Session not found'; end if;
  if coalesce(v_session.final_result, '') is distinct from coalesce(p_expected_result, '') then
    raise exception 'Stale session state';
  end if;
  v_before := jsonb_build_object('result', v_session.final_result, 'override', v_session.readiness_override_applied);
  update mts_sam.candidate_sessions
  set readiness_override_applied = true,
      readiness_override_result = p_result,
      readiness_override_reason = p_reason
  where id = v_session.id returning * into v_session;
  insert into mts_sam.candidate_status_actions (
    action_id, session_id, action_type, result, reason, actor_name,
    before_state, after_state, occurred_at, source_provider
  ) values (
    p_action_id, v_session.id, 'readiness_override', p_result, p_reason, p_actor,
    v_before, jsonb_build_object('result', p_result, 'override', true), p_occurred_at, 'supabase'
  );
  return v_session;
end;
$$;

create or replace function mts_sam.decide_headset_review(
  p_action_id text,
  p_review_id text,
  p_expected_status text,
  p_status text,
  p_actor text,
  p_reason text default null,
  p_occurred_at timestamptz default statement_timestamp()
)
returns mts_sam.headset_reviews
language plpgsql
security definer
set search_path = pg_catalog, mts_sam, extensions
as $$
declare
  v_review mts_sam.headset_reviews;
  v_before jsonb;
begin
  if p_status not in ('approved','denied','archived','deleted') then raise exception 'Invalid decision'; end if;
  select * into v_review from mts_sam.headset_reviews where review_id = p_review_id for update;
  if not found then raise exception 'Review not found'; end if;
  if v_review.status is distinct from p_expected_status then raise exception 'Stale review state'; end if;
  v_before := jsonb_build_object('status', v_review.status);
  update mts_sam.headset_reviews
  set status = p_status, decision_by = p_actor, decision_at = p_occurred_at,
      denial_reason = case when p_status = 'denied' then p_reason else denial_reason end,
      updated_at = p_occurred_at
  where id = v_review.id returning * into v_review;
  insert into mts_sam.headset_review_actions (
    action_id, review_id, action_type, actor_name, reason, before_state, after_state, occurred_at, source_provider
  ) values (
    p_action_id, v_review.id, case p_status when 'approved' then 'approve' when 'denied' then 'deny' else p_status end,
    p_actor, p_reason, v_before, jsonb_build_object('status', p_status), p_occurred_at, 'supabase'
  );
  return v_review;
end;
$$;

create or replace function mts_sam.correct_candidate_information(
  p_action_id text,
  p_session_id text,
  p_expected_updated_at timestamptz,
  p_changes jsonb,
  p_actor text,
  p_reason text,
  p_occurred_at timestamptz default statement_timestamp()
)
returns mts_sam.candidate_sessions
language plpgsql
security definer
set search_path = pg_catalog, mts_sam, extensions
as $$
declare
  v_session mts_sam.candidate_sessions;
  v_allowed text[] := array['candidate_name','candidate_first_name','candidate_last_initial','headset_brand','headset_model'];
  v_key text;
  v_before jsonb;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then raise exception 'Changes must be an object'; end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if not (v_key = any(v_allowed)) then raise exception 'Unsupported correction field: %', v_key; end if;
  end loop;
  select * into v_session from mts_sam.candidate_sessions where session_id = p_session_id for update;
  if not found then raise exception 'Session not found'; end if;
  if v_session.updated_at is distinct from p_expected_updated_at then raise exception 'Stale session state'; end if;
  v_before := jsonb_build_object(
    'candidate_name', v_session.candidate_name, 'candidate_first_name', v_session.candidate_first_name,
    'candidate_last_initial', v_session.candidate_last_initial, 'headset_brand', v_session.headset_brand,
    'headset_model', v_session.headset_model
  );
  update mts_sam.candidate_sessions set
    candidate_name = case when p_changes ? 'candidate_name' then p_changes->>'candidate_name' else candidate_name end,
    candidate_first_name = case when p_changes ? 'candidate_first_name' then p_changes->>'candidate_first_name' else candidate_first_name end,
    candidate_last_initial = case when p_changes ? 'candidate_last_initial' then p_changes->>'candidate_last_initial' else candidate_last_initial end,
    headset_brand = case when p_changes ? 'headset_brand' then p_changes->>'headset_brand' else headset_brand end,
    headset_model = case when p_changes ? 'headset_model' then p_changes->>'headset_model' else headset_model end
  where id = v_session.id returning * into v_session;
  insert into mts_sam.audit_events (
    action_id, entity_type, entity_id, source_entity_id, action_type, actor_source_value,
    reason, before_state, after_state, source_provider, occurred_at
  ) values (
    p_action_id, 'candidate_session', v_session.id, v_session.session_id, 'correct_candidate_information', p_actor,
    p_reason, v_before, p_changes, 'supabase', p_occurred_at
  );
  return v_session;
end;
$$;

create or replace view mts_sam.current_headset_catalog_view
with (security_invoker = true)
as
select id as catalog_uuid, catalog_id, brand, model, concat_ws(' ', brand, model) as display_label, note, updated_at
from mts_sam.headset_catalog
where status = 'approved' and archived_at is null and deleted_at is null;

create or replace view mts_sam.headset_review_queue_view
with (security_invoker = true)
as
select id, review_id, source_session_id, candidate_name, tester_name, brand, model,
       concat_ws(' ', nullif(brand, ''), model) as display_label,
       status, note, normalization_status, created_at, updated_at
from mts_sam.headset_reviews
where status = 'pending';

create or replace view mts_sam.current_candidate_status_view
with (security_invoker = true)
as
select s.id, s.session_id,
  case
    when s.readiness_override_applied then coalesce(s.readiness_override_result, s.final_result, s.calculated_result, s.raw_status)
    when exists (
      select 1 from mts_sam.supervisor_transfers t
      where t.session_id = s.id and lower(coalesce(t.completed_status, t.status, '')) in ('failed','fail','denied')
    ) then 'Failed'
    when lower(coalesce(s.final_result, '')) in ('passed','pass') then 'Passed'
    else coalesce(s.calculated_result, s.final_result, s.raw_status)
  end as authoritative_status
from mts_sam.candidate_sessions s;

create or replace view mts_sam.candidate_history_view
with (security_invoker = true)
as
select s.id, s.session_id, s.candidate_id, s.candidate_name, s.tester_name,
       s.attempt_number, s.current_attempt_number, s.allowed_attempt_count,
       cs.authoritative_status, s.completed_at,
       concat_ws(' ', nullif(s.headset_brand, ''), s.headset_model) as headset_display,
       s.archived, s.updated_at
from mts_sam.candidate_sessions s
join mts_sam.current_candidate_status_view cs on cs.id = s.id;

create or replace view mts_sam.pending_requests_view
with (security_invoker = true)
as select * from mts_sam.pending_requests where lower(status) = 'pending';

create or replace view mts_sam.recent_activity_view
with (security_invoker = true)
as select * from mts_sam.activity_events order by occurred_at desc;

revoke all on schema mts_sam from public, anon, authenticated;
grant usage on schema mts_sam to service_role;
grant all privileges on all tables in schema mts_sam to service_role;
grant usage, select on all sequences in schema mts_sam to service_role;

revoke all on all functions in schema mts_sam from public, anon, authenticated;
grant execute on function mts_sam.current_app_has_role(text[]) to authenticated, service_role;
grant execute on function mts_sam.grant_extra_attempt(text,text,integer,text,text,timestamptz) to service_role;
grant execute on function mts_sam.apply_candidate_status_override(text,text,text,text,text,text,timestamptz) to service_role;
grant execute on function mts_sam.decide_headset_review(text,text,text,text,text,text,timestamptz) to service_role;
grant execute on function mts_sam.correct_candidate_information(text,text,timestamptz,jsonb,text,text,timestamptz) to service_role;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'app_users','app_roles','user_role_assignments','application_settings','sync_state',
    'audit_events','data_source_lineage','candidates','candidate_sessions','session_attempts',
    'candidate_status_actions','candidate_corrections','extra_attempt_grants','supervisor_transfers',
    'newbie_shift_requests','newbie_shift_reschedules','headset_catalog','headset_reviews',
    'headset_review_actions','pending_requests','notifications','notification_deliveries',
    'activity_events','import_batches','import_staging_rows','import_row_results',
    'reconciliation_results','synchronization_events'
  ] loop
    execute format('alter table mts_sam.%I enable row level security', v_table);
    execute format('alter table mts_sam.%I force row level security', v_table);
  end loop;
end $$;

grant select on mts_sam.app_roles to authenticated;
grant select on mts_sam.app_users, mts_sam.user_role_assignments to authenticated;
create policy app_users_read_self_or_admin on mts_sam.app_users for select to authenticated
using (auth_user_id = auth.uid() or mts_sam.current_app_has_role(array['administrator']));
create policy roles_read_assigned on mts_sam.app_roles for select to authenticated
using (mts_sam.current_app_has_role(array['evaluator','administrator','viewer']));
create policy role_assignments_read_self_or_admin on mts_sam.user_role_assignments for select to authenticated
using (
  exists (select 1 from mts_sam.app_users u where u.id = user_id and u.auth_user_id = auth.uid())
  or mts_sam.current_app_has_role(array['administrator'])
);

-- No anon privileges or policies are created. Operational data is backend-only
-- in this phase; service_role is permitted only in the trusted FastAPI process.
