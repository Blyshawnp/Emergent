-- Additional Attempt Override: reservation, cancellation, admin decision, conflict resolution.
-- Adds authorization_status to candidate_sessions for positive certification clearance.
set search_path = '';

-- ---------------------------------------------------------------------------
-- 1. Add authorization_status column to candidate_sessions
-- ---------------------------------------------------------------------------
-- Legacy rows (created before this migration) receive 'not_required' to
-- preserve historical certification compatibility. New override sessions
-- will be inserted with 'pending_admin_authorization'.
alter table mts_sam.candidate_sessions
  add column if not exists authorization_status text
    not null default 'not_required';

comment on column mts_sam.candidate_sessions.authorization_status is
  'Positive certification clearance: only ''approved'' or ''not_required'' grant certification. '
  'Legacy rows default to ''not_required'' for backward compatibility.';

-- ---------------------------------------------------------------------------
-- 2. Table: additional_attempt_overrides
-- ---------------------------------------------------------------------------
create table mts_sam.additional_attempt_overrides (
  id uuid primary key default extensions.gen_random_uuid(),
  override_key text not null unique check (btrim(override_key) <> ''),
  candidate_id uuid not null references mts_sam.candidates(id) on delete restrict,
  -- session_id is NULL until the lifecycle write creates the candidate_sessions row
  session_id uuid references mts_sam.candidate_sessions(id) on delete restrict,
  source_session_id text not null check (btrim(source_session_id) <> ''),
  attempt_number integer not null check (attempt_number > 0),
  authorized_max_attempts integer not null check (authorized_max_attempts > 0),
  tester_name text,
  actor_installation_id text not null references mts_sam.mts_installations(installation_id) on delete restrict,
  reason text not null check (btrim(reason) <> ''),
  authorization_status text not null default 'pending_admin_authorization'
    check (authorization_status in (
      'pending_admin_authorization', 'approved', 'denied',
      'abandoned', 'local_pending_sync', 'conflict'
    )),
  decision text check (decision is null or decision in ('approved', 'denied')),
  decision_by_user_id uuid references mts_sam.app_users(id) on delete set null,
  decision_at timestamptz,
  decision_reason text,
  conflict_source_override_id uuid references mts_sam.additional_attempt_overrides(id) on delete set null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create index additional_attempt_overrides_candidate_idx
  on mts_sam.additional_attempt_overrides (candidate_id, occurred_at desc);

create index additional_attempt_overrides_pending_idx
  on mts_sam.additional_attempt_overrides (candidate_id)
  where authorization_status = 'pending_admin_authorization';

alter table mts_sam.additional_attempt_overrides enable row level security;
alter table mts_sam.additional_attempt_overrides force row level security;
revoke all on table mts_sam.additional_attempt_overrides from public, anon, authenticated;
grant select, insert, update on table mts_sam.additional_attempt_overrides to service_role;
grant select on table mts_sam.additional_attempt_overrides to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Trigger: link candidate_sessions to existing reservation by source_session_id
-- ---------------------------------------------------------------------------
create or replace function mts_sam.link_session_to_override_reservation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- When a candidate_sessions row is inserted, check if a reservation
  -- exists with the same source_session_id and populate the FK.
  update mts_sam.additional_attempt_overrides
  set session_id = new.id,
      updated_at = clock_timestamp()
  where source_session_id = new.session_id
    and session_id is null
    and authorization_status in ('pending_admin_authorization', 'local_pending_sync', 'conflict');
  return new;
end;
$$;

revoke all on function mts_sam.link_session_to_override_reservation() from public, anon, authenticated;

create trigger candidate_sessions_link_override_reservation
after insert on mts_sam.candidate_sessions
for each row execute function mts_sam.link_session_to_override_reservation();

-- ---------------------------------------------------------------------------
-- 4. RPC: reserve_additional_attempt_session
-- ---------------------------------------------------------------------------
create or replace function mts_sam.reserve_additional_attempt_session(
  p_candidate_name text,
  p_source_candidate_id text,
  p_session_id text,
  p_tester_name text,
  p_actor_installation_id text,
  p_reason text,
  p_is_offline_emergency boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate_id uuid;
  v_reason text;
  v_override_key text;
  v_override_id uuid;
  v_counted_attempts integer;
  v_extra_grants integer;
  v_max_attempts integer;
  v_existing record;
  v_notification_id uuid;
  v_message text;
begin
  -- Validate required fields
  if btrim(coalesce(p_session_id, '')) = '' then
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_REQUEST', 'error', 'Session identity is required.');
  end if;
  if btrim(coalesce(p_source_candidate_id, '')) = '' then
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_REQUEST', 'error', 'Candidate identity is required.');
  end if;
  if btrim(coalesce(p_actor_installation_id, '')) = '' then
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_REQUEST', 'error', 'Installation identity is required.');
  end if;
  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    return jsonb_build_object('ok', false, 'error_code', 'REASON_REQUIRED', 'error', 'A written reason is required for Additional Attempt Override.');
  end if;

  -- Locate candidate with row-level lock
  select id into v_candidate_id
  from mts_sam.candidates
  where source_candidate_id = btrim(p_source_candidate_id)
  for update;

  if v_candidate_id is null then
    return jsonb_build_object('ok', false, 'error_code', 'CANDIDATE_NOT_FOUND', 'error', 'Candidate not found in shared records.');
  end if;

  -- Check for already-certified (positive clearance rule)
  if exists (
    select 1 from mts_sam.candidate_sessions cs
    where cs.candidate_id = v_candidate_id
      and upper(btrim(coalesce(cs.final_result, ''))) in ('PASS', 'RESUMED-PASS')
      and cs.authorization_status in ('approved', 'not_required')
  ) then
    return jsonb_build_object('ok', false, 'error_code', 'CANDIDATE_ALREADY_CERTIFIED', 'error', 'Candidate has already passed certification.');
  end if;

  -- Check for withdrawn
  if exists (
    select 1 from mts_sam.candidate_sessions cs
    where cs.candidate_id = v_candidate_id
      and cs.withdrawn = true
  ) then
    return jsonb_build_object('ok', false, 'error_code', 'CANDIDATE_WITHDRAWN', 'error', 'Candidate has withdrawn from certification.');
  end if;

  -- Derive canonical attempt counts
  select count(*) into v_counted_attempts
  from mts_sam.candidate_sessions cs
  where cs.candidate_id = v_candidate_id
    and cs.session_type <> 'sup_transfer_only'
    and cs.archived is not true
    and cs.final_result is not null;

  select coalesce(sum(eag.granted_count), 0) into v_extra_grants
  from mts_sam.extra_attempt_grants eag
  join mts_sam.candidate_sessions cs on cs.id = eag.session_id
  where cs.candidate_id = v_candidate_id;

  v_max_attempts := 3 + v_extra_grants;

  -- If candidate is actually still within allowance, no override needed
  if v_counted_attempts < v_max_attempts then
    return jsonb_build_object(
      'ok', true, 'override_needed', false,
      'attempt_number', v_counted_attempts + 1,
      'max_attempts', v_max_attempts
    );
  end if;

  -- Check existing pending override (one-pending rule)
  select * into v_existing
  from mts_sam.additional_attempt_overrides
  where candidate_id = v_candidate_id
    and authorization_status = 'pending_admin_authorization'
  limit 1;

  if found then
    if v_existing.source_session_id = btrim(p_session_id) then
      -- Idempotent replay
      return jsonb_build_object(
        'ok', true, 'replayed', true,
        'reservation_id', v_existing.id,
        'attempt_number', v_existing.attempt_number,
        'max_attempts', v_existing.authorized_max_attempts,
        'authorization_status', v_existing.authorization_status
      );
    elsif coalesce(p_is_offline_emergency, false) then
      -- Safeguard 1: Real canonical SAM review mechanism for conflicting offline evaluations.
      -- Preserves the second conflicting session as 'conflict' linked to the existing pending override.
      v_override_key := 'additional-attempt-override:' || btrim(p_session_id);
      insert into mts_sam.additional_attempt_overrides (
        override_key, candidate_id, source_session_id, session_id,
        attempt_number, authorized_max_attempts, tester_name,
        actor_installation_id, reason, authorization_status,
        conflict_source_override_id, occurred_at
      ) values (
        v_override_key, v_candidate_id, btrim(p_session_id), null,
        v_counted_attempts + 1, v_max_attempts, btrim(coalesce(p_tester_name, '')),
        btrim(p_actor_installation_id), v_reason, 'conflict',
        v_existing.id, clock_timestamp()
      ) on conflict (override_key) do update
        set conflict_source_override_id = coalesce(mts_sam.additional_attempt_overrides.conflict_source_override_id, v_existing.id),
            updated_at = clock_timestamp()
      returning id into v_override_id;

      -- Post conflict notification to administrators
      v_message := 'Offline Additional Attempt Override Conflict: Tester '
        || coalesce(nullif(btrim(p_tester_name), ''), 'Unknown')
        || ' submitted an emergency offline session for '
        || coalesce(nullif(btrim(p_candidate_name), ''), 'the candidate')
        || ' while an outstanding override (session ' || v_existing.source_session_id || ') is already pending. Administrative review required.';

      insert into mts_sam.notifications (
        notification_id, enabled, notification_type, title, message,
        show_ticker, show_popup, show_banner, persistent, starts_at,
        created_at, updated_at, source_checksum, source_payload
      ) values (
        'conflict-override:' || btrim(p_session_id), true, 'warning',
        'Additional Attempt Override Conflict', v_message,
        false, true, true, true, clock_timestamp(), clock_timestamp(), clock_timestamp(),
        encode(extensions.digest(convert_to('conflict-override:' || btrim(p_session_id) || ':' || v_message, 'UTF8'), 'sha256'), 'hex'),
        jsonb_build_object(
          'category', 'Additional Attempt Override Conflict',
          'candidate_id', v_candidate_id,
          'source_session_id', btrim(p_session_id),
          'conflicting_session_id', v_existing.source_session_id,
          'override_id', v_override_id,
          'tester_name', btrim(coalesce(p_tester_name, ''))
        )
      ) on conflict (notification_id) do nothing
      returning id into v_notification_id;

      if v_notification_id is not null then
        insert into mts_sam.notification_deliveries (
          notification_id, recipient_user_id, delivery_status, metadata
        )
        select distinct v_notification_id, u.id, 'pending',
          jsonb_build_object('category', 'Additional Attempt Override Conflict', 'source_session_id', btrim(p_session_id))
        from mts_sam.app_users u
        join mts_sam.user_role_assignments ura on ura.user_id = u.id
        where u.active = true and ura.role_key = 'administrator' and ura.revoked_at is null
        on conflict do nothing;
      end if;

      return jsonb_build_object(
        'ok', true, 'conflict', true,
        'reservation_id', v_override_id,
        'attempt_number', v_counted_attempts + 1,
        'max_attempts', v_max_attempts,
        'authorization_status', 'conflict',
        'conflicting_reservation_id', v_existing.id
      );
    else
      return jsonb_build_object(
        'ok', false, 'error_code', 'OUTSTANDING_OVERRIDE_PENDING',
        'error', 'An additional certification attempt is already awaiting administrator authorization for this candidate. The administrator must review the outstanding request before another additional session can be started.'
      );
    end if;
  end if;

  -- Insert reservation
  v_override_key := 'additional-attempt-override:' || btrim(p_session_id);
  insert into mts_sam.additional_attempt_overrides (
    override_key, candidate_id, source_session_id, session_id,
    attempt_number, authorized_max_attempts, tester_name,
    actor_installation_id, reason, authorization_status, occurred_at
  ) values (
    v_override_key, v_candidate_id, btrim(p_session_id), null,
    v_counted_attempts + 1, v_max_attempts, btrim(coalesce(p_tester_name, '')),
    btrim(p_actor_installation_id), v_reason, 'pending_admin_authorization', clock_timestamp()
  ) on conflict (override_key) do nothing
  returning id into v_override_id;

  if v_override_id is null then
    -- Conflict on override_key means idempotent replay
    select id, attempt_number, authorized_max_attempts, authorization_status
    into v_existing
    from mts_sam.additional_attempt_overrides
    where override_key = v_override_key;
    return jsonb_build_object(
      'ok', true, 'replayed', true,
      'reservation_id', v_existing.id,
      'attempt_number', v_existing.attempt_number,
      'max_attempts', v_existing.authorized_max_attempts,
      'authorization_status', v_existing.authorization_status
    );
  end if;

  -- Create admin notification
  v_message := coalesce(nullif(btrim(p_tester_name), ''), 'A tester')
    || ' is requesting an Additional Attempt Override for '
    || coalesce(nullif(btrim(p_candidate_name), ''), 'the candidate')
    || ' (attempt ' || (v_counted_attempts + 1)::text || ' of ' || v_max_attempts::text
    || ' authorized). Reason: ' || v_reason;

  insert into mts_sam.notifications (
    notification_id, enabled, notification_type, title, message,
    show_ticker, show_popup, show_banner, persistent, starts_at,
    created_at, updated_at, source_checksum, source_payload
  ) values (
    v_override_key, true, 'warning', 'Additional Attempt Authorization Required', v_message,
    false, true, true, true, clock_timestamp(), clock_timestamp(), clock_timestamp(),
    encode(extensions.digest(convert_to(v_override_key || ':' || v_message, 'UTF8'), 'sha256'), 'hex'),
    jsonb_build_object(
      'category', 'Additional Attempt Override',
      'candidate_id', v_candidate_id,
      'source_session_id', btrim(p_session_id),
      'attempt_number', v_counted_attempts + 1,
      'override_id', v_override_id,
      'tester_name', btrim(coalesce(p_tester_name, '')),
      'reason', v_reason
    )
  ) on conflict (notification_id) do nothing
  returning id into v_notification_id;

  if v_notification_id is not null then
    insert into mts_sam.notification_deliveries (
      notification_id, recipient_user_id, delivery_status, metadata
    )
    select distinct v_notification_id, u.id, 'pending',
      jsonb_build_object('category', 'Additional Attempt Override', 'source_session_id', btrim(p_session_id))
    from mts_sam.app_users u
    join mts_sam.user_role_assignments ura on ura.user_id = u.id
    where u.active = true and ura.role_key = 'administrator' and ura.revoked_at is null
    on conflict do nothing;
  end if;

  return jsonb_build_object(
    'ok', true, 'override_needed', true,
    'reservation_id', v_override_id,
    'attempt_number', v_counted_attempts + 1,
    'max_attempts', v_max_attempts,
    'authorization_status', 'pending_admin_authorization'
  );
end;
$$;

revoke all on function mts_sam.reserve_additional_attempt_session(text, text, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function mts_sam.reserve_additional_attempt_session(text, text, text, text, text, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 5. RPC: cancel_additional_attempt_reservation
--    Revision 7: Protects partially started sessions — checks for both
--    canonical (Supabase) AND locally-reported test activity.
-- ---------------------------------------------------------------------------
create or replace function mts_sam.cancel_additional_attempt_reservation(
  p_session_id text,
  p_actor_installation_id text,
  p_has_local_call_activity boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_override record;
  v_has_canonical_activity boolean;
begin
  if btrim(coalesce(p_session_id, '')) = '' then
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_REQUEST', 'error', 'Session identity is required.');
  end if;

  select * into v_override
  from mts_sam.additional_attempt_overrides
  where source_session_id = btrim(p_session_id)
    and authorization_status in ('pending_admin_authorization', 'local_pending_sync')
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'RESERVATION_NOT_FOUND', 'error', 'No active reservation found for this session.');
  end if;

  -- Revision 7: Check for canonical (Supabase) test activity
  v_has_canonical_activity := false;
  if v_override.session_id is not null then
    select exists(
      select 1 from mts_sam.session_attempts sa
      where sa.session_id = v_override.session_id
    ) into v_has_canonical_activity;
  end if;

  -- Revision 3 (Offline cancellation safety): Also respect locally-reported activity
  if v_has_canonical_activity or coalesce(p_has_local_call_activity, false) then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'SESSION_IN_PROGRESS',
      'error', 'This session has test activity and cannot be cancelled. Complete or finish the session.'
    );
  end if;

  -- Mark as abandoned
  update mts_sam.additional_attempt_overrides
  set authorization_status = 'abandoned',
      updated_at = clock_timestamp()
  where id = v_override.id;

  -- Resolve notification
  update mts_sam.notifications
  set enabled = false,
      updated_at = clock_timestamp()
  where notification_id = 'additional-attempt-override:' || btrim(p_session_id);

  return jsonb_build_object('ok', true, 'abandoned', true);
end;
$$;

revoke all on function mts_sam.cancel_additional_attempt_reservation(text, text, boolean) from public, anon, authenticated;
grant execute on function mts_sam.cancel_additional_attempt_reservation(text, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 6. RPC: decide_additional_attempt_override
--    Revision 8: Blocks decision before evaluation is canonically persisted.
--    Stale replay protection: terminal decisions cannot be overwritten.
-- ---------------------------------------------------------------------------
create or replace function mts_sam.decide_additional_attempt_override(
  p_override_id uuid,
  p_decision text,
  p_reason text default null,
  p_caller_auth_uid uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jwt_caller_uid uuid;
  v_caller mts_sam.app_users%rowtype;
  v_override mts_sam.additional_attempt_overrides%rowtype;
  v_linked_session mts_sam.candidate_sessions%rowtype;
begin
  -- Validate decision value
  if p_decision not in ('approved', 'denied') then
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_DECISION', 'error', 'Decision must be ''approved'' or ''denied''.');
  end if;

  -- JWT authentication
  v_jwt_caller_uid := coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
    auth.uid()
  );
  if v_jwt_caller_uid is null then
    return jsonb_build_object('ok', false, 'error_code', 'UNAUTHENTICATED', 'error', 'Authentication required.');
  end if;
  if p_caller_auth_uid is not null and p_caller_auth_uid <> v_jwt_caller_uid then
    return jsonb_build_object('ok', false, 'error_code', 'CALLER_IDENTITY_MISMATCH', 'error', 'Caller identity mismatch.');
  end if;

  -- Verify active administrator role
  select * into v_caller from mts_sam.app_users
  where auth_user_id = v_jwt_caller_uid and active = true limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'INACTIVE_CALLER', 'error', 'Active SAM membership required.');
  end if;
  if not exists (
    select 1 from mts_sam.user_role_assignments
    where user_id = v_caller.id and role_key = 'administrator' and revoked_at is null
  ) then
    return jsonb_build_object('ok', false, 'error_code', 'ADMINISTRATOR_REQUIRED', 'error', 'Administrator role required.');
  end if;

  -- Lock and fetch the override
  select * into v_override
  from mts_sam.additional_attempt_overrides
  where id = p_override_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'OVERRIDE_NOT_FOUND', 'error', 'Override record not found.');
  end if;

  -- Terminal decision check (stale replay protection)
  if v_override.authorization_status in ('approved', 'denied') then
    if v_override.decision = p_decision then
      return jsonb_build_object('ok', true, 'replayed', true, 'authorization_status', v_override.authorization_status);
    else
      return jsonb_build_object('ok', false, 'error_code', 'ALREADY_DECIDED',
        'error', 'This exception has already been decided and cannot be modified.');
    end if;
  end if;

  -- Cannot decide abandoned overrides
  if v_override.authorization_status in ('abandoned') then
    return jsonb_build_object('ok', false, 'error_code', 'OVERRIDE_ABANDONED',
      'error', 'This override reservation was abandoned and cannot be decided.');
  end if;

  -- Revision 8: Guard — evaluation must be canonically persisted
  if v_override.session_id is null then
    return jsonb_build_object('ok', false, 'error_code', 'SESSION_IN_PROGRESS',
      'error', 'Session in Progress — Evaluation Not Yet Available. The tester has not yet completed and submitted the session evaluation.');
  end if;

  select * into v_linked_session
  from mts_sam.candidate_sessions
  where id = v_override.session_id;

  if not found or v_linked_session.final_result is null then
    return jsonb_build_object('ok', false, 'error_code', 'SESSION_IN_PROGRESS',
      'error', 'Session in Progress — Evaluation Not Yet Available. The tester has not yet completed and submitted the session evaluation.');
  end if;

  -- Apply decision
  update mts_sam.additional_attempt_overrides
  set authorization_status = p_decision,
      decision = p_decision,
      decision_by_user_id = v_caller.id,
      decision_at = clock_timestamp(),
      decision_reason = nullif(btrim(coalesce(p_reason, '')), ''),
      updated_at = clock_timestamp()
  where id = p_override_id;

  -- Update the candidate_sessions authorization_status
  update mts_sam.candidate_sessions
  set authorization_status = p_decision
  where id = v_override.session_id;

  -- Resolve notification deliveries
  update mts_sam.notification_deliveries nd
  set delivery_status = 'resolved',
      acknowledged_at = clock_timestamp()
  from mts_sam.notifications n
  where n.id = nd.notification_id
    and n.notification_id = 'additional-attempt-override:' || v_override.source_session_id
    and nd.delivery_status <> 'resolved';

  return jsonb_build_object(
    'ok', true, 'replayed', false,
    'authorization_status', p_decision,
    'override_id', p_override_id,
    'session_final_result', v_linked_session.final_result,
    'certification_cleared', (
      p_decision = 'approved'
      and upper(btrim(coalesce(v_linked_session.final_result, ''))) in ('PASS', 'RESUMED-PASS')
    )
  );
end;
$$;

revoke all on function mts_sam.decide_additional_attempt_override(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function mts_sam.decide_additional_attempt_override(uuid, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. RPC: resolve_offline_override_conflict
--    Real canonical SAM review mechanism for conflicting offline evaluations.
--    The second session is preserved with authorization_status = 'conflict'
--    and can be individually approved or denied by an administrator.
-- ---------------------------------------------------------------------------
create or replace function mts_sam.resolve_offline_override_conflict(
  p_conflict_override_id uuid,
  p_decision text,
  p_reason text default null,
  p_caller_auth_uid uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jwt_caller_uid uuid;
  v_caller mts_sam.app_users%rowtype;
  v_override mts_sam.additional_attempt_overrides%rowtype;
  v_linked_session mts_sam.candidate_sessions%rowtype;
begin
  if p_decision not in ('approved', 'denied') then
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_DECISION', 'error', 'Decision must be ''approved'' or ''denied''.');
  end if;

  -- JWT auth (same pattern as decide)
  v_jwt_caller_uid := coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
    auth.uid()
  );
  if v_jwt_caller_uid is null then
    return jsonb_build_object('ok', false, 'error_code', 'UNAUTHENTICATED', 'error', 'Authentication required.');
  end if;
  if p_caller_auth_uid is not null and p_caller_auth_uid <> v_jwt_caller_uid then
    return jsonb_build_object('ok', false, 'error_code', 'CALLER_IDENTITY_MISMATCH', 'error', 'Caller identity mismatch.');
  end if;
  select * into v_caller from mts_sam.app_users
  where auth_user_id = v_jwt_caller_uid and active = true limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'INACTIVE_CALLER', 'error', 'Active SAM membership required.');
  end if;
  if not exists (
    select 1 from mts_sam.user_role_assignments
    where user_id = v_caller.id and role_key = 'administrator' and revoked_at is null
  ) then
    return jsonb_build_object('ok', false, 'error_code', 'ADMINISTRATOR_REQUIRED', 'error', 'Administrator role required.');
  end if;

  select * into v_override
  from mts_sam.additional_attempt_overrides
  where id = p_conflict_override_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'OVERRIDE_NOT_FOUND', 'error', 'Override record not found.');
  end if;

  -- Must be in 'conflict' status to use this RPC
  if v_override.authorization_status <> 'conflict' then
    -- If already decided, check for idempotent replay
    if v_override.authorization_status in ('approved', 'denied') then
      if v_override.decision = p_decision then
        return jsonb_build_object('ok', true, 'replayed', true, 'authorization_status', v_override.authorization_status);
      else
        return jsonb_build_object('ok', false, 'error_code', 'ALREADY_DECIDED',
          'error', 'This conflict has already been decided and cannot be modified.');
      end if;
    end if;
    return jsonb_build_object('ok', false, 'error_code', 'NOT_A_CONFLICT',
      'error', 'This override is not in conflict status. Use decide_additional_attempt_override for standard decisions.');
  end if;

  -- Evaluation timing guard (same as decide)
  if v_override.session_id is null then
    return jsonb_build_object('ok', false, 'error_code', 'SESSION_IN_PROGRESS',
      'error', 'Session in Progress — Evaluation Not Yet Available.');
  end if;
  select * into v_linked_session
  from mts_sam.candidate_sessions where id = v_override.session_id;
  if not found or v_linked_session.final_result is null then
    return jsonb_build_object('ok', false, 'error_code', 'SESSION_IN_PROGRESS',
      'error', 'Session in Progress — Evaluation Not Yet Available.');
  end if;

  -- Apply decision (transitions conflict -> approved/denied)
  update mts_sam.additional_attempt_overrides
  set authorization_status = p_decision,
      decision = p_decision,
      decision_by_user_id = v_caller.id,
      decision_at = clock_timestamp(),
      decision_reason = nullif(btrim(coalesce(p_reason, '')), ''),
      updated_at = clock_timestamp()
  where id = p_conflict_override_id;

  update mts_sam.candidate_sessions
  set authorization_status = p_decision
  where id = v_override.session_id;

  -- Resolve conflict notification
  update mts_sam.notification_deliveries nd
  set delivery_status = 'resolved',
      acknowledged_at = clock_timestamp()
  from mts_sam.notifications n
  where n.id = nd.notification_id
    and n.notification_id = 'conflict-override:' || v_override.source_session_id
    and nd.delivery_status <> 'resolved';

  return jsonb_build_object(
    'ok', true, 'replayed', false,
    'authorization_status', p_decision,
    'override_id', p_conflict_override_id,
    'session_final_result', v_linked_session.final_result,
    'certification_cleared', (
      p_decision = 'approved'
      and upper(btrim(coalesce(v_linked_session.final_result, ''))) in ('PASS', 'RESUMED-PASS')
    )
  );
end;
$$;

revoke all on function mts_sam.resolve_offline_override_conflict(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function mts_sam.resolve_offline_override_conflict(uuid, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Stale replay protection for persist_candidate_lifecycle
--    Prevent lifecycle replays from overwriting terminal authorization decisions.
--    This trigger fires BEFORE UPDATE on candidate_sessions.
-- ---------------------------------------------------------------------------
create or replace function mts_sam.protect_terminal_authorization_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- If the existing row has a terminal authorization decision (approved/denied),
  -- prevent a lifecycle replay from resetting it back to pending or any other value.
  if old.authorization_status in ('approved', 'denied')
     and new.authorization_status is distinct from old.authorization_status then
    -- Preserve the terminal decision; allow all other column updates
    new.authorization_status := old.authorization_status;
  end if;
  return new;
end;
$$;

revoke all on function mts_sam.protect_terminal_authorization_status() from public, anon, authenticated;

create trigger candidate_sessions_protect_terminal_auth
before update on mts_sam.candidate_sessions
for each row execute function mts_sam.protect_terminal_authorization_status();
