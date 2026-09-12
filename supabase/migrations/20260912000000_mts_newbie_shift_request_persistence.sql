-- Migration: 20260912000000_mts_newbie_shift_request_persistence.sql
-- Purpose: Service-role-only transactional RPC for authoritative MTS candidate lifecycle persistence,
-- including canonical persistence into mts_sam.newbie_shift_requests when a session qualifies.
-- Validates caller entitlement, performs idempotent upserts across candidates, candidate_sessions,
-- session_attempts, conditionally headset_reviews, and conditionally newbie_shift_requests,
-- records audit event with authoritative actor_user_id, and rejects conflicting retry attempts for the same session_id.
-- Forward-only. Does not modify or reapply previous migrations.

set search_path = '';

create or replace function mts_sam.persist_candidate_lifecycle(
  p_payload jsonb,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actor mts_sam.app_users%rowtype;
  v_has_evaluator boolean := false;
  v_candidate_payload jsonb;
  v_session_payload jsonb;
  v_attempt_payloads jsonb;
  v_headset_review_payload jsonb;
  v_newbie_shift_request_payload jsonb;

  v_source_system text;
  v_source_candidate_id text;
  v_candidate_name text;
  v_first_name text;
  v_last_initial text;
  v_session_id text;
  v_session_type text;
  v_final_result text;
  v_final_attempt boolean;
  v_attempt_number integer;

  v_cand_id uuid;
  v_sess_id uuid;
  v_existing_sess mts_sam.candidate_sessions%rowtype;
  v_existing_cand mts_sam.candidates%rowtype;

  v_attempt jsonb;
  v_att_source_action_id text;
  v_att_number integer;
  v_att_type text;
  v_att_result text;
  v_att_occurred_at timestamptz;
  v_att_details jsonb;
  v_attempts_written integer := 0;

  v_review_id text;
  v_review_source_session_id text;
  v_review_brand text;
  v_review_model text;
  v_review_note text;
  v_review_status text;
  v_review_written boolean := false;

  v_newbie_req_id text;
  v_newbie_source_session_id text;
  v_newbie_status text;
  v_newbie_request_written boolean := false;

  v_source_checksum text;
  v_action_id text;
begin
  -- 1. Validate parameters
  if p_payload is null or p_actor_user_id is null then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'INVALID_ARGUMENTS',
      'error', 'Payload and actor user ID are required.'
    );
  end if;

  -- 2. Authorize actor (Defense in Depth)
  select * into v_actor
  from mts_sam.app_users
  where id = p_actor_user_id
    and active = true
  limit 1;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'ACTOR_NOT_AUTHORIZED',
      'error', 'Authoritative actor is not active or registered in application users.'
    );
  end if;

  select exists (
    select 1
    from mts_sam.user_role_assignments
    where user_id = v_actor.id
      and role_key = 'evaluator'
      and revoked_at is null
  ) into v_has_evaluator;

  if not v_has_evaluator then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'EVALUATOR_ROLE_REQUIRED',
      'error', 'Actor lacks active evaluator entitlement.'
    );
  end if;

  -- 3. Extract and validate candidate section
  v_candidate_payload := p_payload->'candidate';
  v_session_payload := p_payload->'session';
  v_attempt_payloads := p_payload->'attempts';
  v_headset_review_payload := p_payload->'headset_review';
  v_newbie_shift_request_payload := p_payload->'newbie_shift_request';

  if v_candidate_payload is null or v_session_payload is null then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'INVALID_PAYLOAD_STRUCTURE',
      'error', 'Candidate and session structures are required.'
    );
  end if;

  v_source_system := coalesce(nullif(btrim(v_candidate_payload->>'source_system'), ''), 'google_sheets');
  v_source_candidate_id := btrim(coalesce(v_candidate_payload->>'source_candidate_id', ''));
  v_candidate_name := btrim(coalesce(v_candidate_payload->>'display_name', ''));
  v_first_name := nullif(btrim(v_candidate_payload->>'first_name'), '');
  v_last_initial := nullif(btrim(v_candidate_payload->>'last_initial'), '');

  if v_source_candidate_id = '' or v_candidate_name = '' then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'INVALID_CANDIDATE_DATA',
      'error', 'Candidate identity and display name are required.'
    );
  end if;

  -- 4. Extract and validate session section
  v_session_id := btrim(coalesce(v_session_payload->>'session_id', ''));
  v_session_type := coalesce(nullif(btrim(v_session_payload->>'session_type'), ''), 'mock_session');
  v_final_result := nullif(btrim(v_session_payload->>'final_result'), '');
  v_final_attempt := coalesce((v_session_payload->>'final_attempt')::boolean, false);
  v_attempt_number := coalesce((v_session_payload->>'attempt_number')::integer, 1);

  if v_session_id = '' then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'INVALID_SESSION_DATA',
      'error', 'Session identity is required.'
    );
  end if;

  -- 5. Detect Conflicting Retry vs Idempotent Duplicate
  select * into v_existing_sess
  from mts_sam.candidate_sessions
  where session_id = v_session_id
  for update;

  if found then
    -- Verify candidate identity consistency
    if v_existing_sess.candidate_id is not null then
      select * into v_existing_cand
      from mts_sam.candidates
      where id = v_existing_sess.candidate_id;

      if found and (v_existing_cand.source_candidate_id != v_source_candidate_id or v_existing_cand.source_system != v_source_system) then
        return jsonb_build_object(
          'ok', false,
          'error_code', 'CONFLICTING_RETRY_CANDIDATE_MISMATCH',
          'error', 'Session ID was previously recorded for a different candidate identity.'
        );
      end if;
    end if;

    -- Verify final result consistency (cannot change result of an existing finished session)
    if v_existing_sess.final_result is not null and v_final_result is not null and v_existing_sess.final_result != v_final_result then
      return jsonb_build_object(
        'ok', false,
        'error_code', 'CONFLICTING_RETRY_RESULT_MISMATCH',
        'error', 'Session ID was previously recorded with a different final result.'
      );
    end if;
  end if;

  -- 6. Upsert candidate (order 1: candidates)
  insert into mts_sam.candidates (
    source_system,
    source_candidate_id,
    display_name,
    first_name,
    last_initial,
    updated_at
  ) values (
    v_source_system,
    v_source_candidate_id,
    v_candidate_name,
    v_first_name,
    v_last_initial,
    clock_timestamp()
  )
  on conflict (source_system, source_candidate_id) do update set
    display_name = excluded.display_name,
    first_name = coalesce(excluded.first_name, mts_sam.candidates.first_name),
    last_initial = coalesce(excluded.last_initial, mts_sam.candidates.last_initial),
    updated_at = clock_timestamp()
  returning id into v_cand_id;

  -- Calculate checksum for session
  v_source_checksum := encode(extensions.digest(v_session_payload::text, 'sha256'), 'hex');

  -- 7. Upsert candidate_session (order 2: candidate_sessions)
  insert into mts_sam.candidate_sessions (
    session_id,
    candidate_id,
    candidate_name,
    candidate_first_name,
    candidate_last_initial,
    tester_name,
    session_type,
    attempt_number,
    current_attempt_number,
    allowed_attempt_count,
    extra_attempts_granted,
    final_attempt,
    raw_status,
    calculated_result,
    final_result,
    withdrawn,
    archived,
    needs_sup_transfer,
    pending_sup_transfer_id,
    mock_calls_completed,
    sup_transfers_completed,
    call_results,
    supervisor_transfer_results,
    coaching_summary,
    fail_summary,
    review_notes,
    evaluator_notes_summary,
    skills,
    final_notes,
    headset_brand,
    headset_model,
    headset_usb,
    noise_cancel,
    environment_checks,
    form_fill_status,
    form_filled_at,
    newbie_shift_number,
    newbie_shift_data,
    created_at,
    completed_at,
    imported_at,
    updated_at,
    source_checksum,
    source_payload
  ) values (
    v_session_id,
    v_cand_id,
    v_candidate_name,
    v_first_name,
    v_last_initial,
    v_session_payload->>'tester_name',
    v_session_type,
    v_attempt_number,
    coalesce((v_session_payload->>'current_attempt_number')::integer, v_attempt_number),
    coalesce((v_session_payload->>'allowed_attempt_count')::integer, 3),
    coalesce((v_session_payload->>'extra_attempts_granted')::integer, 0),
    v_final_attempt,
    v_session_payload->>'raw_status',
    v_session_payload->>'calculated_result',
    v_final_result,
    coalesce((v_session_payload->>'withdrawn')::boolean, false),
    coalesce((v_session_payload->>'archived')::boolean, false),
    coalesce((v_session_payload->>'needs_sup_transfer')::boolean, false),
    nullif(btrim(v_session_payload->>'pending_sup_transfer_id'), ''),
    (v_session_payload->>'mock_calls_completed')::integer,
    (v_session_payload->>'sup_transfers_completed')::integer,
    coalesce(v_session_payload->'call_results', '{}'::jsonb),
    coalesce(v_session_payload->'supervisor_transfer_results', '{}'::jsonb),
    v_session_payload->>'coaching_summary',
    v_session_payload->>'fail_summary',
    v_session_payload->>'review_notes',
    v_session_payload->>'evaluator_notes_summary',
    v_session_payload->'skills',
    coalesce(v_session_payload->'final_notes', '{}'::jsonb),
    v_session_payload->>'headset_brand',
    v_session_payload->>'headset_model',
    (v_session_payload->>'headset_usb')::boolean,
    (v_session_payload->>'noise_cancel')::boolean,
    coalesce(v_session_payload->'environment_checks', '{}'::jsonb),
    v_session_payload->>'form_fill_status',
    case when nullif(btrim(v_session_payload->>'form_filled_at'), '') is not null then (v_session_payload->>'form_filled_at')::timestamptz else null end,
    v_session_payload->>'newbie_shift_number',
    coalesce(v_session_payload->'newbie_shift_data', '{}'::jsonb),
    case when nullif(btrim(v_session_payload->>'created_at'), '') is not null then (v_session_payload->>'created_at')::timestamptz else clock_timestamp() end,
    case when nullif(btrim(v_session_payload->>'completed_at'), '') is not null then (v_session_payload->>'completed_at')::timestamptz else clock_timestamp() end,
    clock_timestamp(),
    clock_timestamp(),
    v_source_checksum,
    coalesce(v_session_payload->'source_payload', v_session_payload)
  )
  on conflict (session_id) do update set
    candidate_id = excluded.candidate_id,
    candidate_name = excluded.candidate_name,
    candidate_first_name = excluded.candidate_first_name,
    candidate_last_initial = excluded.candidate_last_initial,
    tester_name = coalesce(excluded.tester_name, mts_sam.candidate_sessions.tester_name),
    session_type = excluded.session_type,
    attempt_number = excluded.attempt_number,
    current_attempt_number = excluded.current_attempt_number,
    allowed_attempt_count = excluded.allowed_attempt_count,
    extra_attempts_granted = excluded.extra_attempts_granted,
    final_attempt = excluded.final_attempt,
    raw_status = coalesce(excluded.raw_status, mts_sam.candidate_sessions.raw_status),
    calculated_result = coalesce(excluded.calculated_result, mts_sam.candidate_sessions.calculated_result),
    final_result = coalesce(excluded.final_result, mts_sam.candidate_sessions.final_result),
    withdrawn = excluded.withdrawn,
    archived = excluded.archived,
    needs_sup_transfer = excluded.needs_sup_transfer,
    pending_sup_transfer_id = excluded.pending_sup_transfer_id,
    mock_calls_completed = coalesce(excluded.mock_calls_completed, mts_sam.candidate_sessions.mock_calls_completed),
    sup_transfers_completed = coalesce(excluded.sup_transfers_completed, mts_sam.candidate_sessions.sup_transfers_completed),
    call_results = excluded.call_results,
    supervisor_transfer_results = excluded.supervisor_transfer_results,
    coaching_summary = coalesce(excluded.coaching_summary, mts_sam.candidate_sessions.coaching_summary),
    fail_summary = coalesce(excluded.fail_summary, mts_sam.candidate_sessions.fail_summary),
    review_notes = coalesce(excluded.review_notes, mts_sam.candidate_sessions.review_notes),
    evaluator_notes_summary = coalesce(excluded.evaluator_notes_summary, mts_sam.candidate_sessions.evaluator_notes_summary),
    skills = coalesce(excluded.skills, mts_sam.candidate_sessions.skills),
    final_notes = excluded.final_notes,
    headset_brand = coalesce(excluded.headset_brand, mts_sam.candidate_sessions.headset_brand),
    headset_model = coalesce(excluded.headset_model, mts_sam.candidate_sessions.headset_model),
    headset_usb = coalesce(excluded.headset_usb, mts_sam.candidate_sessions.headset_usb),
    noise_cancel = coalesce(excluded.noise_cancel, mts_sam.candidate_sessions.noise_cancel),
    environment_checks = excluded.environment_checks,
    form_fill_status = coalesce(excluded.form_fill_status, mts_sam.candidate_sessions.form_fill_status),
    form_filled_at = coalesce(excluded.form_filled_at, mts_sam.candidate_sessions.form_filled_at),
    newbie_shift_number = coalesce(excluded.newbie_shift_number, mts_sam.candidate_sessions.newbie_shift_number),
    newbie_shift_data = excluded.newbie_shift_data,
    completed_at = coalesce(excluded.completed_at, mts_sam.candidate_sessions.completed_at),
    updated_at = clock_timestamp(),
    source_checksum = excluded.source_checksum,
    source_payload = excluded.source_payload
  returning id into v_sess_id;

  -- 8. Upsert session_attempts (order 3: session_attempts)
  if v_attempt_payloads is not null and jsonb_array_length(v_attempt_payloads) > 0 then
    for i in 0 .. jsonb_array_length(v_attempt_payloads) - 1 loop
      v_attempt := v_attempt_payloads->i;
      v_att_source_action_id := btrim(coalesce(v_attempt->>'source_action_id', ''));
      v_att_number := coalesce((v_attempt->>'attempt_number')::integer, i + 1);
      v_att_type := coalesce(nullif(btrim(v_attempt->>'attempt_type'), ''), 'mock_call');
      v_att_result := v_attempt->>'result';
      v_att_occurred_at := case
        when nullif(btrim(v_attempt->>'occurred_at'), '') is not null then (v_attempt->>'occurred_at')::timestamptz
        else clock_timestamp()
      end;
      v_att_details := coalesce(v_attempt->'details', '{}'::jsonb);

      if v_att_source_action_id = '' then
        v_att_source_action_id := format('google_sheets:attempt:%s:%s', v_session_id, v_att_number);
      end if;

      insert into mts_sam.session_attempts (
        session_id,
        attempt_number,
        attempt_type,
        result,
        occurred_at,
        source_action_id,
        details
      ) values (
        v_sess_id,
        v_att_number,
        v_att_type,
        v_att_result,
        v_att_occurred_at,
        v_att_source_action_id,
        v_att_details
      )
      on conflict (source_action_id) do update set
        session_id = excluded.session_id,
        attempt_number = excluded.attempt_number,
        attempt_type = excluded.attempt_type,
        result = excluded.result,
        occurred_at = excluded.occurred_at,
        details = excluded.details;

      v_attempts_written := v_attempts_written + 1;
    end loop;
  end if;

  -- 9. Upsert headset_reviews conditionally (order 4: headset_reviews)
  if v_headset_review_payload is not null and (v_headset_review_payload->>'review_id') is not null then
    v_review_id := btrim(v_headset_review_payload->>'review_id');
    v_review_source_session_id := coalesce(nullif(btrim(v_headset_review_payload->>'source_session_id'), ''), v_session_id);
    v_review_brand := nullif(btrim(v_headset_review_payload->>'brand'), '');
    v_review_model := nullif(btrim(v_headset_review_payload->>'model'), '');
    v_review_note := coalesce(v_headset_review_payload->>'note', '');
    v_review_status := coalesce(nullif(btrim(v_headset_review_payload->>'status'), ''), 'pending');

    if v_review_id != '' and v_review_status = 'pending' then
      insert into mts_sam.headset_reviews (
        review_id,
        source_session_id,
        session_id,
        candidate_name,
        tester_name,
        brand,
        model,
        status,
        note,
        normalization_status,
        created_at,
        updated_at,
        source_checksum,
        source_payload
      ) values (
        v_review_id,
        v_review_source_session_id,
        v_sess_id,
        v_candidate_name,
        v_session_payload->>'tester_name',
        v_review_brand,
        v_review_model,
        'pending',
        v_review_note,
        'canonical',
        clock_timestamp(),
        clock_timestamp(),
        encode(extensions.digest(v_headset_review_payload::text, 'sha256'), 'hex'),
        v_headset_review_payload
      )
      on conflict (review_id) do update set
        source_session_id = excluded.source_session_id,
        session_id = excluded.session_id,
        candidate_name = excluded.candidate_name,
        tester_name = excluded.tester_name,
        brand = excluded.brand,
        model = excluded.model,
        note = excluded.note,
        updated_at = clock_timestamp(),
        source_checksum = excluded.source_checksum,
        source_payload = excluded.source_payload
      where mts_sam.headset_reviews.status = 'pending';

      v_review_written := true;
    end if;
  end if;

  -- 10. Upsert newbie_shift_requests conditionally (order 5: newbie_shift_requests)
  if v_newbie_shift_request_payload is not null and (v_newbie_shift_request_payload->>'request_id') is not null then
    v_newbie_req_id := btrim(v_newbie_shift_request_payload->>'request_id');
    v_newbie_source_session_id := coalesce(nullif(btrim(v_newbie_shift_request_payload->>'source_session_id'), ''), v_session_id);
    v_newbie_status := lower(coalesce(nullif(btrim(v_newbie_shift_request_payload->>'request_status'), ''), 'pending'));
    if v_newbie_status in ('approve', 'approved') then
      v_newbie_status := 'approved';
    elsif v_newbie_status in ('deny', 'denied') then
      v_newbie_status := 'denied';
    else
      v_newbie_status := 'pending';
    end if;

    if v_newbie_req_id != '' then
      insert into mts_sam.newbie_shift_requests (
        request_id,
        source_session_id,
        session_id,
        request_type,
        request_status,
        newbie_shift_number,
        scheduled_at,
        original_scheduled_at,
        rescheduled_at,
        timezone,
        within_24_hours,
        counts_as_attempt,
        final_attempt,
        current_attempt,
        resulting_attempt,
        becomes_final_attempt,
        attempt_rule,
        terminal_outcome,
        requested_by,
        request_reason,
        request_details,
        decision_by,
        denial_reason,
        created_at,
        decision_at,
        updated_at,
        source_checksum,
        source_payload
      ) values (
        v_newbie_req_id,
        v_newbie_source_session_id,
        v_sess_id,
        coalesce(nullif(btrim(v_newbie_shift_request_payload->>'request_type'), ''), 'initial_newbie_shift'),
        v_newbie_status,
        nullif(btrim(v_newbie_shift_request_payload->>'newbie_shift_number'), ''),
        case when nullif(btrim(v_newbie_shift_request_payload->>'scheduled_at'), '') is not null then (v_newbie_shift_request_payload->>'scheduled_at')::timestamptz else null end,
        case when nullif(btrim(v_newbie_shift_request_payload->>'original_scheduled_at'), '') is not null then (v_newbie_shift_request_payload->>'original_scheduled_at')::timestamptz else null end,
        case when nullif(btrim(v_newbie_shift_request_payload->>'rescheduled_at'), '') is not null then (v_newbie_shift_request_payload->>'rescheduled_at')::timestamptz else null end,
        nullif(btrim(v_newbie_shift_request_payload->>'timezone'), ''),
        case when v_newbie_shift_request_payload->>'within_24_hours' is not null then (v_newbie_shift_request_payload->>'within_24_hours')::boolean else null end,
        case when v_newbie_shift_request_payload->>'counts_as_attempt' is not null then (v_newbie_shift_request_payload->>'counts_as_attempt')::boolean else null end,
        case when v_newbie_shift_request_payload->>'final_attempt' is not null then (v_newbie_shift_request_payload->>'final_attempt')::boolean else null end,
        case when nullif(btrim(v_newbie_shift_request_payload->>'current_attempt'), '') is not null then (v_newbie_shift_request_payload->>'current_attempt')::integer else null end,
        case when nullif(btrim(v_newbie_shift_request_payload->>'resulting_attempt'), '') is not null then (v_newbie_shift_request_payload->>'resulting_attempt')::integer else null end,
        case when v_newbie_shift_request_payload->>'becomes_final_attempt' is not null then (v_newbie_shift_request_payload->>'becomes_final_attempt')::boolean else null end,
        nullif(btrim(v_newbie_shift_request_payload->>'attempt_rule'), ''),
        nullif(btrim(v_newbie_shift_request_payload->>'terminal_outcome'), ''),
        coalesce(nullif(btrim(v_newbie_shift_request_payload->>'requested_by'), ''), v_session_payload->>'tester_name'),
        nullif(btrim(v_newbie_shift_request_payload->>'request_reason'), ''),
        nullif(btrim(v_newbie_shift_request_payload->>'request_details'), ''),
        nullif(btrim(v_newbie_shift_request_payload->>'decision_by'), ''),
        nullif(btrim(v_newbie_shift_request_payload->>'denial_reason'), ''),
        case when nullif(btrim(v_newbie_shift_request_payload->>'created_at'), '') is not null then (v_newbie_shift_request_payload->>'created_at')::timestamptz else clock_timestamp() end,
        case when nullif(btrim(v_newbie_shift_request_payload->>'decision_at'), '') is not null then (v_newbie_shift_request_payload->>'decision_at')::timestamptz else null end,
        clock_timestamp(),
        encode(extensions.digest(v_newbie_shift_request_payload::text, 'sha256'), 'hex'),
        v_newbie_shift_request_payload
      )
      on conflict (request_id) do update set
        source_session_id = excluded.source_session_id,
        session_id = excluded.session_id,
        request_type = excluded.request_type,
        newbie_shift_number = coalesce(excluded.newbie_shift_number, mts_sam.newbie_shift_requests.newbie_shift_number),
        scheduled_at = coalesce(excluded.scheduled_at, mts_sam.newbie_shift_requests.scheduled_at),
        original_scheduled_at = coalesce(excluded.original_scheduled_at, mts_sam.newbie_shift_requests.original_scheduled_at),
        rescheduled_at = coalesce(excluded.rescheduled_at, mts_sam.newbie_shift_requests.rescheduled_at),
        timezone = coalesce(excluded.timezone, mts_sam.newbie_shift_requests.timezone),
        within_24_hours = coalesce(excluded.within_24_hours, mts_sam.newbie_shift_requests.within_24_hours),
        counts_as_attempt = coalesce(excluded.counts_as_attempt, mts_sam.newbie_shift_requests.counts_as_attempt),
        final_attempt = coalesce(excluded.final_attempt, mts_sam.newbie_shift_requests.final_attempt),
        current_attempt = coalesce(excluded.current_attempt, mts_sam.newbie_shift_requests.current_attempt),
        resulting_attempt = coalesce(excluded.resulting_attempt, mts_sam.newbie_shift_requests.resulting_attempt),
        becomes_final_attempt = coalesce(excluded.becomes_final_attempt, mts_sam.newbie_shift_requests.becomes_final_attempt),
        attempt_rule = coalesce(excluded.attempt_rule, mts_sam.newbie_shift_requests.attempt_rule),
        terminal_outcome = coalesce(excluded.terminal_outcome, mts_sam.newbie_shift_requests.terminal_outcome),
        requested_by = coalesce(excluded.requested_by, mts_sam.newbie_shift_requests.requested_by),
        request_reason = coalesce(excluded.request_reason, mts_sam.newbie_shift_requests.request_reason),
        request_details = coalesce(excluded.request_details, mts_sam.newbie_shift_requests.request_details),
        updated_at = clock_timestamp(),
        source_checksum = excluded.source_checksum,
        source_payload = excluded.source_payload
      where lower(mts_sam.newbie_shift_requests.request_status) = 'pending';

      v_newbie_request_written := true;
    end if;
  end if;

  -- 11. Record Audit Event with Authoritative actor_user_id
  v_action_id := format('mts_lifecycle:%s:%s', v_session_id, extract(epoch from clock_timestamp())::bigint);
  insert into mts_sam.audit_events (
    action_id,
    entity_type,
    entity_id,
    source_entity_id,
    action_type,
    actor_user_id,
    actor_source_value,
    reason,
    before_state,
    after_state,
    source_provider,
    occurred_at
  ) values (
    v_action_id,
    'candidate_session',
    v_sess_id,
    v_session_id,
    'persist_candidate_lifecycle',
    v_actor.id,
    v_actor.display_name,
    'Authoritative MTS candidate lifecycle persistence',
    case when v_existing_sess.id is not null then to_jsonb(v_existing_sess) else null end,
    jsonb_build_object(
      'session_id', v_session_id,
      'candidate_id', v_cand_id,
      'final_result', v_final_result,
      'attempts_count', v_attempts_written,
      'headset_review_logged', v_review_written,
      'newbie_shift_request_logged', v_newbie_request_written
    ),
    'supabase',
    clock_timestamp()
  );

  return jsonb_build_object(
    'ok', true,
    'canonical_ids', jsonb_build_object(
      'candidate_id', v_cand_id,
      'session_id', v_sess_id,
      'session_business_id', v_session_id
    ),
    'row_counts', jsonb_build_object(
      'candidates', 1,
      'candidate_sessions', 1,
      'session_attempts', v_attempts_written,
      'headset_reviews', case when v_review_written then 1 else 0 end,
      'newbie_shift_requests', case when v_newbie_request_written then 1 else 0 end
    )
  );
end;
$$;

-- Permissions: Revoke from all public, anon, and authenticated. Grant EXECUTE exclusively to service_role.
revoke all on function mts_sam.persist_candidate_lifecycle(jsonb, uuid) from public, anon, authenticated;
grant execute on function mts_sam.persist_candidate_lifecycle(jsonb, uuid) to service_role;
