-- Corrected definition of mts_sam.persist_candidate_lifecycle
-- Fixes:
-- 1. Correct session_attempts target columns (session_id not session_uuid, omit non-existent updated_at)
-- 2. Correct headset_reviews and newbie_shift_requests target columns (session_id not session_uuid)
-- 3. Robust timestamptz casting with nullif(btrim(...), '') to handle empty strings gracefully

create or replace function mts_sam.persist_candidate_lifecycle(
  p_payload jsonb,
  p_actor_user_id uuid default null,
  p_actor_installation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor mts_sam.app_users%rowtype;
  v_installation mts_sam.mts_installations%rowtype;
  v_has_evaluator boolean := false;
  v_actor_display text;
  v_audit_user_id uuid := null;
  v_audit_installation_id text := null;

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
  if p_payload is null then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'INVALID_ARGUMENTS',
      'error', 'Payload is required.'
    );
  end if;

  -- 2. Authorize actor: Either installation credential or human evaluator user
  if p_actor_installation_id is not null and btrim(p_actor_installation_id) <> '' then
    select * into v_installation
    from mts_sam.mts_installations
    where installation_id = btrim(p_actor_installation_id)
      and active = true
      and revoked_at is null
    limit 1;

    if not found then
      return jsonb_build_object(
        'ok', false,
        'error_code', 'INSTALLATION_NOT_AUTHORIZED',
        'error', 'MTS installation is not active, registered, or has been revoked.'
      );
    end if;

    v_actor_display := 'MTS Installation: ' || coalesce(nullif(v_installation.label, ''), v_installation.installation_id);
    v_audit_installation_id := v_installation.installation_id;
    v_audit_user_id := null;

  elsif p_actor_user_id is not null then
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

    v_actor_display := v_actor.display_name;
    v_audit_user_id := v_actor.id;
    v_audit_installation_id := null;

  else
    return jsonb_build_object(
      'ok', false,
      'error_code', 'ACTOR_REQUIRED',
      'error', 'Either a valid actor user ID or installation ID is required.'
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
      'error', 'Session business identity is required.'
    );
  end if;

  -- 5. Inspect existing session state for idempotency / conflict detection
  select * into v_existing_sess
  from mts_sam.candidate_sessions
  where session_id = v_session_id
  limit 1;

  if found then
    if v_existing_sess.candidate_name <> v_candidate_name then
      return jsonb_build_object(
        'ok', false,
        'error_code', 'SESSION_CANDIDATE_MISMATCH',
        'error', 'Session business ID is already assigned to a different candidate.'
      );
    end if;

    if v_existing_sess.final_result is not null
       and v_final_result is not null
       and v_existing_sess.final_result <> v_final_result then
      return jsonb_build_object(
        'ok', false,
        'error_code', 'CONFLICTING_RETRY',
        'error', 'Cannot alter terminal final_result of an already-persisted session.'
      );
    end if;
  end if;

  -- 6. Upsert candidate (order 1: candidates)
  select * into v_existing_cand
  from mts_sam.candidates
  where source_system = v_source_system
    and source_candidate_id = v_source_candidate_id
  limit 1;

  if found then
    v_cand_id := v_existing_cand.id;
    update mts_sam.candidates
    set
      display_name = v_candidate_name,
      first_name = coalesce(v_first_name, v_existing_cand.first_name),
      last_initial = coalesce(v_last_initial, v_existing_cand.last_initial),
      updated_at = clock_timestamp()
    where id = v_cand_id;
  else
    insert into mts_sam.candidates (
      source_system,
      source_candidate_id,
      display_name,
      first_name,
      last_initial,
      created_at,
      updated_at
    ) values (
      v_source_system,
      v_source_candidate_id,
      v_candidate_name,
      v_first_name,
      v_last_initial,
      coalesce(case when nullif(btrim(v_candidate_payload->>'created_at'), '') is not null then (v_candidate_payload->>'created_at')::timestamptz else null end, clock_timestamp()),
      clock_timestamp()
    )
    returning id into v_cand_id;
  end if;

  -- 7. Upsert candidate_sessions (order 2: candidate_sessions)
  v_source_checksum := encode(extensions.digest(v_session_payload::text, 'sha256'), 'hex');

  if v_existing_sess.id is not null then
    v_sess_id := v_existing_sess.id;
    update mts_sam.candidate_sessions
    set
      candidate_id = v_cand_id,
      candidate_name = v_candidate_name,
      candidate_first_name = coalesce(v_first_name, v_existing_sess.candidate_first_name),
      candidate_last_initial = coalesce(v_last_initial, v_existing_sess.candidate_last_initial),
      tester_name = coalesce(nullif(btrim(v_session_payload->>'tester_name'), ''), v_existing_sess.tester_name),
      session_type = coalesce(v_session_type, v_existing_sess.session_type),
      attempt_number = coalesce(v_attempt_number, v_existing_sess.attempt_number),
      current_attempt_number = coalesce((v_session_payload->>'current_attempt_number')::integer, v_existing_sess.current_attempt_number),
      allowed_attempt_count = coalesce((v_session_payload->>'allowed_attempt_count')::integer, v_existing_sess.allowed_attempt_count),
      extra_attempts_granted = coalesce((v_session_payload->>'extra_attempts_granted')::integer, v_existing_sess.extra_attempts_granted),
      final_attempt = v_final_attempt,
      raw_status = coalesce(v_session_payload->>'raw_status', v_existing_sess.raw_status),
      calculated_result = coalesce(v_session_payload->>'calculated_result', v_existing_sess.calculated_result),
      final_result = coalesce(v_final_result, v_existing_sess.final_result),
      withdrawn = coalesce((v_session_payload->>'withdrawn')::boolean, v_existing_sess.withdrawn),
      archived = coalesce((v_session_payload->>'archived')::boolean, v_existing_sess.archived),
      needs_sup_transfer = coalesce((v_session_payload->>'needs_sup_transfer')::boolean, v_existing_sess.needs_sup_transfer),
      pending_sup_transfer_id = coalesce(v_session_payload->>'pending_sup_transfer_id', v_existing_sess.pending_sup_transfer_id),
      mock_calls_completed = coalesce((v_session_payload->>'mock_calls_completed')::integer, v_existing_sess.mock_calls_completed),
      sup_transfers_completed = coalesce((v_session_payload->>'sup_transfers_completed')::integer, v_existing_sess.sup_transfers_completed),
      call_results = coalesce(v_session_payload->'call_results', v_existing_sess.call_results),
      supervisor_transfer_results = coalesce(v_session_payload->'supervisor_transfer_results', v_existing_sess.supervisor_transfer_results),
      coaching_summary = coalesce(v_session_payload->>'coaching_summary', v_existing_sess.coaching_summary),
      fail_summary = coalesce(v_session_payload->>'fail_summary', v_existing_sess.fail_summary),
      review_notes = coalesce(v_session_payload->>'review_notes', v_existing_sess.review_notes),
      evaluator_notes_summary = coalesce(v_session_payload->>'evaluator_notes_summary', v_existing_sess.evaluator_notes_summary),
      skills = coalesce(v_session_payload->'skills', v_existing_sess.skills),
      final_notes = coalesce(v_session_payload->'final_notes', v_existing_sess.final_notes),
      headset_brand = coalesce(v_session_payload->>'headset_brand', v_existing_sess.headset_brand),
      headset_model = coalesce(v_session_payload->>'headset_model', v_existing_sess.headset_model),
      headset_usb = coalesce((v_session_payload->>'headset_usb')::boolean, v_existing_sess.headset_usb),
      noise_cancel = coalesce((v_session_payload->>'noise_cancel')::boolean, v_existing_sess.noise_cancel),
      environment_checks = coalesce(v_session_payload->'environment_checks', v_existing_sess.environment_checks),
      form_fill_status = coalesce(v_session_payload->>'form_fill_status', v_existing_sess.form_fill_status),
      form_filled_at = coalesce(case when nullif(btrim(v_session_payload->>'form_filled_at'), '') is not null then (v_session_payload->>'form_filled_at')::timestamptz else null end, v_existing_sess.form_filled_at),
      newbie_shift_number = coalesce(v_session_payload->>'newbie_shift_number', v_existing_sess.newbie_shift_number),
      newbie_shift_data = coalesce(v_session_payload->'newbie_shift_data', v_existing_sess.newbie_shift_data),
      completed_at = coalesce(case when nullif(btrim(v_session_payload->>'completed_at'), '') is not null then (v_session_payload->>'completed_at')::timestamptz else null end, v_existing_sess.completed_at),
      source_checksum = v_source_checksum,
      source_payload = coalesce(v_session_payload->'source_payload', v_existing_sess.source_payload),
      updated_at = clock_timestamp()
    where id = v_sess_id;
  else
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
      source_checksum,
      source_payload,
      updated_at
    ) values (
      v_session_id,
      v_cand_id,
      v_candidate_name,
      v_first_name,
      v_last_initial,
      nullif(btrim(v_session_payload->>'tester_name'), ''),
      v_session_type,
      v_attempt_number,
      coalesce((v_session_payload->>'current_attempt_number')::integer, 1),
      (v_session_payload->>'allowed_attempt_count')::integer,
      coalesce((v_session_payload->>'extra_attempts_granted')::integer, 0),
      v_final_attempt,
      v_session_payload->>'raw_status',
      v_session_payload->>'calculated_result',
      v_final_result,
      coalesce((v_session_payload->>'withdrawn')::boolean, false),
      (v_session_payload->>'archived')::boolean,
      coalesce((v_session_payload->>'needs_sup_transfer')::boolean, false),
      coalesce(v_session_payload->>'pending_sup_transfer_id', ''),
      coalesce((v_session_payload->>'mock_calls_completed')::integer, 0),
      coalesce((v_session_payload->>'sup_transfers_completed')::integer, 0),
      coalesce(v_session_payload->'call_results', '{}'::jsonb),
      coalesce(v_session_payload->'supervisor_transfer_results', '{}'::jsonb),
      coalesce(v_session_payload->>'coaching_summary', ''),
      coalesce(v_session_payload->>'fail_summary', ''),
      coalesce(v_session_payload->>'review_notes', ''),
      coalesce(v_session_payload->>'evaluator_notes_summary', ''),
      coalesce(v_session_payload->'skills', '{}'::jsonb),
      coalesce(v_session_payload->'final_notes', '{}'::jsonb),
      coalesce(v_session_payload->>'headset_brand', ''),
      v_session_payload->>'headset_model',
      (v_session_payload->>'headset_usb')::boolean,
      (v_session_payload->>'noise_cancel')::boolean,
      coalesce(v_session_payload->'environment_checks', '{}'::jsonb),
      coalesce(v_session_payload->>'form_fill_status', 'pending'),
      case when nullif(btrim(v_session_payload->>'form_filled_at'), '') is not null then (v_session_payload->>'form_filled_at')::timestamptz else null end,
      coalesce(v_session_payload->>'newbie_shift_number', ''),
      coalesce(v_session_payload->'newbie_shift_data', '{}'::jsonb),
      coalesce(case when nullif(btrim(v_session_payload->>'created_at'), '') is not null then (v_session_payload->>'created_at')::timestamptz else null end, clock_timestamp()),
      case when nullif(btrim(v_session_payload->>'completed_at'), '') is not null then (v_session_payload->>'completed_at')::timestamptz else null end,
      v_source_checksum,
      coalesce(v_session_payload->'source_payload', '{}'::jsonb),
      clock_timestamp()
    )
    returning id into v_sess_id;
  end if;

  -- 8. Upsert session_attempts (order 3: session_attempts)
  if v_attempt_payloads is not null and jsonb_typeof(v_attempt_payloads) = 'array' then
    for v_attempt in select * from jsonb_array_elements(v_attempt_payloads)
    loop
      v_att_source_action_id := btrim(coalesce(v_attempt->>'source_action_id', ''));
      if v_att_source_action_id = '' then
        continue;
      end if;

      v_att_number := coalesce((v_attempt->>'attempt_number')::integer, 1);
      v_att_type := coalesce(nullif(btrim(v_attempt->>'attempt_type'), ''), 'call');
      v_att_result := coalesce(nullif(btrim(v_attempt->>'result'), ''), 'unknown');
      v_att_occurred_at := coalesce(case when nullif(btrim(v_attempt->>'occurred_at'), '') is not null then (v_attempt->>'occurred_at')::timestamptz else null end, clock_timestamp());
      v_att_details := coalesce(v_attempt->'details', '{}'::jsonb);

      insert into mts_sam.session_attempts (
        session_id,
        attempt_number,
        attempt_type,
        result,
        occurred_at,
        details,
        source_action_id
      ) values (
        v_sess_id,
        v_att_number,
        v_att_type,
        v_att_result,
        v_att_occurred_at,
        v_att_details,
        v_att_source_action_id
      )
      on conflict (source_action_id)
      do update set
        session_id = v_sess_id,
        attempt_number = v_att_number,
        attempt_type = v_att_type,
        result = v_att_result,
        occurred_at = v_att_occurred_at,
        details = v_att_details;

      v_attempts_written := v_attempts_written + 1;
    end loop;
  end if;

  -- 9. Upsert headset_reviews conditionally (order 4: headset_reviews)
  if v_headset_review_payload is not null and (v_headset_review_payload->>'review_id') is not null then
    v_review_id := btrim(coalesce(v_headset_review_payload->>'review_id', ''));
    if v_review_id <> '' then
      v_review_source_session_id := coalesce(nullif(btrim(v_headset_review_payload->>'source_session_id'), ''), v_session_id);
      v_review_brand := coalesce(v_headset_review_payload->>'brand', '');
      v_review_model := coalesce(v_headset_review_payload->>'model', '');
      v_review_note := coalesce(v_headset_review_payload->>'note', '');
      v_review_status := coalesce(v_headset_review_payload->>'status', 'pending');

      insert into mts_sam.headset_reviews (
        review_id,
        source_session_id,
        candidate_name,
        tester_name,
        brand,
        model,
        note,
        status,
        session_id,
        created_at,
        updated_at,
        source_checksum,
        source_payload
      ) values (
        v_review_id,
        v_review_source_session_id,
        v_candidate_name,
        nullif(btrim(v_session_payload->>'tester_name'), ''),
        v_review_brand,
        v_review_model,
        v_review_note,
        v_review_status,
        v_sess_id,
        coalesce(case when nullif(btrim(v_headset_review_payload->>'created_at'), '') is not null then (v_headset_review_payload->>'created_at')::timestamptz else null end, clock_timestamp()),
        clock_timestamp(),
        encode(extensions.digest(v_headset_review_payload::text, 'sha256'), 'hex'),
        coalesce(v_headset_review_payload, '{}'::jsonb)
      )
      on conflict (review_id)
      do update set
        source_session_id = v_review_source_session_id,
        candidate_name = v_candidate_name,
        tester_name = coalesce(nullif(btrim(v_session_payload->>'tester_name'), ''), mts_sam.headset_reviews.tester_name),
        brand = v_review_brand,
        model = v_review_model,
        note = v_review_note,
        session_id = v_sess_id,
        updated_at = clock_timestamp(),
        source_checksum = encode(extensions.digest(v_headset_review_payload::text, 'sha256'), 'hex'),
        source_payload = coalesce(v_headset_review_payload, mts_sam.headset_reviews.source_payload);

      v_review_written := true;
    end if;
  end if;

  -- 10. Upsert newbie_shift_requests conditionally (order 5: newbie_shift_requests)
  if v_newbie_shift_request_payload is not null and (v_newbie_shift_request_payload->>'request_id') is not null then
    v_newbie_req_id := btrim(coalesce(v_newbie_shift_request_payload->>'request_id', ''));
    if v_newbie_req_id <> '' then
      v_newbie_source_session_id := coalesce(nullif(btrim(v_newbie_shift_request_payload->>'source_session_id'), ''), v_session_id);
      v_newbie_status := coalesce(v_newbie_shift_request_payload->>'request_status', 'pending');

      declare
        v_existing_req mts_sam.newbie_shift_requests%rowtype;
      begin
        select * into v_existing_req
        from mts_sam.newbie_shift_requests
        where request_id = v_newbie_req_id
        limit 1;

        if v_existing_req.id is not null and v_existing_req.request_status in ('approved', 'denied') then
          v_newbie_status := v_existing_req.request_status;
        end if;
      end;

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
        coalesce(v_newbie_shift_request_payload->>'request_type', 'initial_newbie_shift'),
        v_newbie_status,
        coalesce(v_newbie_shift_request_payload->>'newbie_shift_number', ''),
        case when nullif(btrim(v_newbie_shift_request_payload->>'scheduled_at'), '') is not null then (v_newbie_shift_request_payload->>'scheduled_at')::timestamptz else null end,
        case when nullif(btrim(v_newbie_shift_request_payload->>'original_scheduled_at'), '') is not null then (v_newbie_shift_request_payload->>'original_scheduled_at')::timestamptz else null end,
        case when nullif(btrim(v_newbie_shift_request_payload->>'rescheduled_at'), '') is not null then (v_newbie_shift_request_payload->>'rescheduled_at')::timestamptz else null end,
        coalesce(v_newbie_shift_request_payload->>'timezone', ''),
        coalesce((v_newbie_shift_request_payload->>'within_24_hours')::boolean, false),
        coalesce((v_newbie_shift_request_payload->>'counts_as_attempt')::boolean, false),
        coalesce((v_newbie_shift_request_payload->>'final_attempt')::boolean, false),
        (v_newbie_shift_request_payload->>'current_attempt')::integer,
        (v_newbie_shift_request_payload->>'resulting_attempt')::integer,
        coalesce((v_newbie_shift_request_payload->>'becomes_final_attempt')::boolean, false),
        v_newbie_shift_request_payload->>'attempt_rule',
        v_newbie_shift_request_payload->>'terminal_outcome',
        coalesce(v_newbie_shift_request_payload->>'requested_by', 'tester'),
        v_newbie_shift_request_payload->>'request_reason',
        v_newbie_shift_request_payload->>'request_details',
        v_newbie_shift_request_payload->>'decision_by',
        v_newbie_shift_request_payload->>'denial_reason',
        coalesce(case when nullif(btrim(v_newbie_shift_request_payload->>'created_at'), '') is not null then (v_newbie_shift_request_payload->>'created_at')::timestamptz else null end, clock_timestamp()),
        case when nullif(btrim(v_newbie_shift_request_payload->>'decision_at'), '') is not null then (v_newbie_shift_request_payload->>'decision_at')::timestamptz else null end,
        clock_timestamp(),
        encode(extensions.digest(v_newbie_shift_request_payload::text, 'sha256'), 'hex'),
        coalesce(v_newbie_shift_request_payload, '{}'::jsonb)
      )
      on conflict (request_id)
      do update set
        source_session_id = v_newbie_source_session_id,
        session_id = v_sess_id,
        scheduled_at = coalesce(case when nullif(btrim(v_newbie_shift_request_payload->>'scheduled_at'), '') is not null then (v_newbie_shift_request_payload->>'scheduled_at')::timestamptz else null end, mts_sam.newbie_shift_requests.scheduled_at),
        rescheduled_at = coalesce(case when nullif(btrim(v_newbie_shift_request_payload->>'rescheduled_at'), '') is not null then (v_newbie_shift_request_payload->>'rescheduled_at')::timestamptz else null end, mts_sam.newbie_shift_requests.rescheduled_at),
        timezone = coalesce(v_newbie_shift_request_payload->>'timezone', mts_sam.newbie_shift_requests.timezone),
        within_24_hours = coalesce((v_newbie_shift_request_payload->>'within_24_hours')::boolean, mts_sam.newbie_shift_requests.within_24_hours),
        counts_as_attempt = coalesce((v_newbie_shift_request_payload->>'counts_as_attempt')::boolean, mts_sam.newbie_shift_requests.counts_as_attempt),
        final_attempt = coalesce((v_newbie_shift_request_payload->>'final_attempt')::boolean, mts_sam.newbie_shift_requests.final_attempt),
        updated_at = clock_timestamp(),
        source_checksum = encode(extensions.digest(v_newbie_shift_request_payload::text, 'sha256'), 'hex'),
        source_payload = coalesce(v_newbie_shift_request_payload, mts_sam.newbie_shift_requests.source_payload)
      where mts_sam.newbie_shift_requests.request_status not in ('approved', 'denied');

      v_newbie_request_written := true;
    end if;
  end if;


  -- 11. Append audit event (order 6: audit_events)
  v_action_id := 'lifecycle-persist-' || v_session_id || '-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS');

  insert into mts_sam.audit_events (
    action_id,
    entity_type,
    entity_id,
    source_entity_id,
    action_type,
    actor_user_id,
    actor_installation_id,
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
    'mts_session_persisted',
    v_audit_user_id,
    v_audit_installation_id,
    v_actor_display,
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

revoke all on function mts_sam.persist_candidate_lifecycle(jsonb, uuid, text) from public, anon, authenticated;
grant execute on function mts_sam.persist_candidate_lifecycle(jsonb, uuid, text) to service_role;
