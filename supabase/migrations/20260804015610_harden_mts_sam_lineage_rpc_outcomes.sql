-- Forward correction: make lineage insertion return only the four documented
-- deterministic outcomes, including under concurrent RPC calls.

set search_path = '';

create or replace function mts_sam.insert_lineage_if_absent(
  p_entity_type text,
  p_entity_id uuid,
  p_source_system text,
  p_source_tab text,
  p_source_row_key text,
  p_source_checksum text,
  p_import_batch_id uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_by_source mts_sam.data_source_lineage%rowtype;
  v_existing_by_entity mts_sam.data_source_lineage%rowtype;
begin
  -- Serialize this low-volume import path so both unique identities are checked
  -- against one authoritative state. The unique constraints remain the final
  -- defense against non-RPC writers.
  lock table mts_sam.data_source_lineage in share row exclusive mode;

  select * into v_existing_by_source
  from mts_sam.data_source_lineage
  where source_system = p_source_system
    and source_tab = p_source_tab
    and source_row_key = p_source_row_key
  limit 1;

  if found then
    if v_existing_by_source.entity_type = p_entity_type
       and v_existing_by_source.entity_id = p_entity_id then
      return jsonb_build_object(
        'result', 'already_exists_same_mapping',
        'entity_id', v_existing_by_source.entity_id
      );
    end if;
    return jsonb_build_object(
      'result', 'conflict_source_maps_to_different_entity',
      'existing_entity_id', v_existing_by_source.entity_id,
      'requested_entity_id', p_entity_id
    );
  end if;

  select * into v_existing_by_entity
  from mts_sam.data_source_lineage
  where entity_type = p_entity_type
    and entity_id = p_entity_id
    and source_system = p_source_system
    and source_tab = p_source_tab
  limit 1;

  if found then
    if v_existing_by_entity.source_row_key = p_source_row_key then
      return jsonb_build_object(
        'result', 'already_exists_same_mapping',
        'entity_id', p_entity_id
      );
    end if;
    return jsonb_build_object(
      'result', 'conflict_entity_maps_to_different_source',
      'existing_source_row_key', v_existing_by_entity.source_row_key,
      'requested_source_row_key', p_source_row_key
    );
  end if;

  insert into mts_sam.data_source_lineage (
    entity_type, entity_id, source_system, source_tab, source_row_key,
    source_checksum, import_batch_id, metadata
  ) values (
    p_entity_type, p_entity_id, p_source_system, p_source_tab, p_source_row_key,
    p_source_checksum, p_import_batch_id, p_metadata
  );

  return jsonb_build_object('result', 'inserted', 'entity_id', p_entity_id);
end;
$$;

revoke all on function mts_sam.insert_lineage_if_absent(
  text, uuid, text, text, text, text, uuid, jsonb
) from public, anon, authenticated;

grant execute on function mts_sam.insert_lineage_if_absent(
  text, uuid, text, text, text, text, uuid, jsonb
) to service_role;

-- Align the database authority projection with the current MTS/SAM business rule.
create or replace view mts_sam.current_candidate_status_view
with (security_invoker = true)
as
select
  s.id,
  s.session_id,
  case
    when s.readiness_override_applied and lower(coalesce(s.readiness_override_result, '')) in ('pass','passed') then 'Pass'
    when s.readiness_override_applied and lower(coalesce(s.readiness_override_result, '')) in ('fail-final attempt','failed final attempt') then 'FAIL-Final Attempt'
    when s.readiness_override_applied and lower(coalesce(s.readiness_override_result, '')) in ('fail','failed') then 'Fail'
    when lower(coalesce(s.final_result, '')) in ('fail-final attempt','failed final attempt') then 'FAIL-Final Attempt'
    when lower(coalesce(s.final_result, '')) in ('fail','failed') then 'Fail'
    when lower(coalesce(s.raw_status, '')) in ('fail-final attempt','failed final attempt') then 'FAIL-Final Attempt'
    when s.final_attempt and (
      (
        (case when lower(coalesce(s.call_results->>'call_1', '')) in ('fail','failed') then 1 else 0 end) +
        (case when lower(coalesce(s.call_results->>'call_2', '')) in ('fail','failed') then 1 else 0 end) +
        (case when lower(coalesce(s.call_results->>'call_3', '')) in ('fail','failed') then 1 else 0 end)
      ) >= 2
      or (
        (case when lower(coalesce(s.supervisor_transfer_results->>'transfer_1', '')) in ('fail','failed') then 1 else 0 end) +
        (case when lower(coalesce(s.supervisor_transfer_results->>'transfer_2', '')) in ('fail','failed') then 1 else 0 end)
      ) >= 2
    ) then 'FAIL-Final Attempt'
    when lower(coalesce(s.raw_status, '')) in ('fail','failed') then 'Fail'
    when lower(coalesce(s.final_result, '')) in ('pass','passed','resumed pass','resumed-pass') then 'Pass'
    when lower(coalesce(s.raw_status, '')) in ('pass','passed','resumed pass','resumed-pass') then 'Pass'
    when lower(coalesce(s.raw_status, '')) in ('withdrew from certification','withdrawn') then 'WITHDREW FROM CERTIFICATION'
    when lower(coalesce(s.raw_status, '')) in ('incomplete','pending','in progress') then 'INCOMPLETE'
    else coalesce(nullif(s.raw_status, ''), nullif(s.calculated_result, ''), 'INCOMPLETE')
  end as authoritative_status,
  s.candidate_id,
  s.final_attempt,
  s.archived
from mts_sam.candidate_sessions s;

create or replace view mts_sam.candidate_history_view
with (security_invoker = true)
as
select
  s.id, s.session_id, s.candidate_id, s.candidate_name, s.tester_name,
  s.attempt_number, s.current_attempt_number, s.allowed_attempt_count,
  cs.authoritative_status, s.completed_at,
  concat_ws(' ', nullif(s.headset_brand, ''), s.headset_model) as headset_display,
  s.archived, s.updated_at,
  s.final_attempt, s.raw_status, s.calculated_result, s.final_result,
  s.newbie_shift_number, s.source_payload->>'newbie_shift_request_status' as newbie_shift_request_status,
  s.needs_sup_transfer, s.pending_sup_transfer_id
from mts_sam.candidate_sessions s
join mts_sam.current_candidate_status_view cs on cs.id = s.id;
