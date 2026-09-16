-- Structured Final Attempt overrides and authenticated SAM attempt grants.
set search_path = '';

create table mts_sam.final_attempt_overrides (
  id uuid primary key default extensions.gen_random_uuid(),
  override_key text not null unique check (btrim(override_key) <> ''),
  candidate_id uuid not null references mts_sam.candidates(id) on delete restrict,
  session_id uuid not null references mts_sam.candidate_sessions(id) on delete restrict,
  source_session_id text not null check (btrim(source_session_id) <> ''),
  attempt_number integer not null check (attempt_number > 0),
  automatic_final_attempt boolean not null check (automatic_final_attempt = true),
  overridden_final_attempt boolean not null check (overridden_final_attempt = false),
  tester_name text,
  actor_installation_id text not null references mts_sam.mts_installations(installation_id) on delete restrict,
  reason text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);

create index final_attempt_overrides_candidate_idx
  on mts_sam.final_attempt_overrides (candidate_id, occurred_at desc);

alter table mts_sam.final_attempt_overrides enable row level security;
alter table mts_sam.final_attempt_overrides force row level security;
revoke all on table mts_sam.final_attempt_overrides from public, anon, authenticated;
grant select, insert on table mts_sam.final_attempt_overrides to service_role;

create trigger final_attempt_overrides_immutable
before update or delete on mts_sam.final_attempt_overrides
for each row execute function mts_sam.prevent_historical_mutation();

create or replace function mts_sam.capture_final_attempt_override()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_override_id uuid;
  v_notification_id uuid;
  v_override_key text := 'final-attempt-override:' || new.session_id;
  v_actor_installation_id text := nullif(btrim(new.source_payload->>'actor_installation_id'), '');
  v_occurred_at timestamptz := coalesce(new.completed_at, new.updated_at, clock_timestamp());
  v_message text;
begin
  if coalesce((new.source_payload->>'auto_final_attempt')::boolean, false) is not true
     or coalesce((new.source_payload->>'final_attempt_overridden')::boolean, false) is not true
     or new.final_attempt is distinct from false then
    return new;
  end if;
  if new.candidate_id is null or coalesce(new.attempt_number, new.current_attempt_number, 0) < 1
     or v_actor_installation_id is null
     or lower(coalesce(new.session_type, '')) = 'sup_transfer_only' then
    raise exception 'Invalid structured Final Attempt override metadata';
  end if;

  insert into mts_sam.final_attempt_overrides (
    override_key, candidate_id, session_id, source_session_id, attempt_number,
    automatic_final_attempt, overridden_final_attempt, tester_name,
    actor_installation_id, reason, occurred_at
  ) values (
    v_override_key, new.candidate_id, new.id, new.session_id,
    coalesce(new.attempt_number, new.current_attempt_number), true, false,
    new.tester_name, v_actor_installation_id,
    nullif(btrim(new.source_payload->>'final_attempt_override_reason'), ''), v_occurred_at
  ) on conflict (override_key) do nothing
  returning id into v_override_id;

  if v_override_id is null then
    return new;
  end if;

  v_message := coalesce(nullif(btrim(new.tester_name), ''), 'A tester')
    || ' changed Final Attempt from Yes to No for '
    || coalesce(nullif(btrim(new.candidate_name), ''), 'the candidate')
    || ' on certification attempt ' || coalesce(new.attempt_number, new.current_attempt_number)::text
    || '. This was the candidate''s final currently authorized attempt.';

  insert into mts_sam.notifications (
    notification_id, enabled, notification_type, title, message,
    show_ticker, show_popup, show_banner, persistent, starts_at,
    created_at, updated_at, source_checksum, source_payload
  ) values (
    v_override_key, true, 'warning', 'Final Attempt Override', v_message,
    false, true, true, true, v_occurred_at, v_occurred_at, v_occurred_at,
    encode(extensions.digest(convert_to(v_override_key || ':' || v_message, 'UTF8'), 'sha256'), 'hex'),
    jsonb_build_object(
      'category', 'Final Attempt Override', 'candidate_id', new.candidate_id,
      'session_id', new.session_id, 'attempt_number', coalesce(new.attempt_number, new.current_attempt_number),
      'override_id', v_override_id
    )
  ) on conflict (notification_id) do nothing
  returning id into v_notification_id;

  if v_notification_id is not null then
    insert into mts_sam.notification_deliveries (
      notification_id, recipient_user_id, delivery_status, metadata
    )
    select distinct v_notification_id, u.id, 'pending',
      jsonb_build_object('category', 'Final Attempt Override', 'session_id', new.session_id)
    from mts_sam.app_users u
    join mts_sam.user_role_assignments ura on ura.user_id = u.id
    where u.active = true and ura.role_key = 'administrator' and ura.revoked_at is null
    on conflict do nothing;
  end if;
  return new;
end;
$$;

revoke all on function mts_sam.capture_final_attempt_override() from public, anon, authenticated;

create trigger candidate_sessions_capture_final_attempt_override
after insert or update on mts_sam.candidate_sessions
for each row execute function mts_sam.capture_final_attempt_override();

create or replace function mts_sam.grant_sam_extra_attempt(
  p_session_id text,
  p_expected_allowed_count integer,
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
  v_session mts_sam.candidate_sessions%rowtype;
  v_action_id text;
begin
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
  if btrim(coalesce(p_session_id, '')) = '' or coalesce(p_expected_allowed_count, 0) < 1 then
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_REQUEST', 'error', 'Session identity and expected allowance are required.');
  end if;

  v_action_id := 'sam-extra-attempt:' || p_session_id || ':' || p_expected_allowed_count::text;
  select cs.* into v_session
  from mts_sam.extra_attempt_grants eag
  join mts_sam.candidate_sessions cs on cs.id = eag.session_id
  where eag.action_id = v_action_id;
  if found then
    return jsonb_build_object('ok', true, 'replayed', true, 'session_id', v_session.session_id,
      'allowed_attempt_count', v_session.allowed_attempt_count, 'extra_attempts_granted', v_session.extra_attempts_granted);
  end if;

  v_session := mts_sam.grant_extra_attempt(
    v_action_id, p_session_id, p_expected_allowed_count, p_reason,
    v_caller.display_name, clock_timestamp()
  );
  return jsonb_build_object('ok', true, 'replayed', false, 'session_id', v_session.session_id,
    'allowed_attempt_count', v_session.allowed_attempt_count, 'extra_attempts_granted', v_session.extra_attempts_granted);
end;
$$;

revoke all on function mts_sam.grant_sam_extra_attempt(text, integer, text, uuid) from public, anon, authenticated;
grant execute on function mts_sam.grant_sam_extra_attempt(text, integer, text, uuid) to authenticated;
