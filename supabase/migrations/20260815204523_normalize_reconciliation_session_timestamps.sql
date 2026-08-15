-- Canonicalize reviewed candidate-session timestamptz expectations before the
-- exact post-write comparison. PostgreSQL serializes timestamptz values in the
-- session timezone, so raw JSON string equality rejects equivalent instants
-- expressed with a different offset.

set search_path = '';

create or replace function mts_sam.execute_reconciliation_candidate_session_update(
  p_batch_id uuid, p_plan_item_id uuid, p_precondition jsonb, p_changes jsonb, p_expected_values jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_batch mts_sam.reconciliation_batches%rowtype; v_item mts_sam.reconciliation_plan_items%rowtype;
  v_before mts_sam.candidate_sessions%rowtype; v_after mts_sam.candidate_sessions%rowtype;
  v_before_values jsonb; v_expected_values jsonb; v_original text; v_post text; v_count integer;
  v_allowed constant text[]:=array[
    'raw_status','calculated_result','final_result','archived','withdrawn','final_attempt',
    'current_attempt_number','allowed_attempt_count','needs_sup_transfer','pending_sup_transfer_id',
    'newbie_shift_number','session_type','completed_at'
  ];
begin
  select * into v_batch from mts_sam.reconciliation_batches where id=p_batch_id for update;
  select * into v_item from mts_sam.reconciliation_plan_items where id=p_plan_item_id and reconciliation_batch_id=p_batch_id for update;
  if v_batch.status<>'running' or v_item.operation<>'update' or v_item.entity_type<>'candidate_sessions' then raise exception 'update_item_not_runnable'; end if;
  if v_item.result_status='updated' then return jsonb_build_object('result','already_committed','entity_id',v_item.canonical_entity_id,'post_checksum',v_item.post_sync_checksum); end if;
  perform mts_sam.assert_reconciliation_json_keys(p_changes,v_allowed);
  perform mts_sam.assert_reconciliation_json_keys(p_expected_values,v_allowed);
  if (select array_agg(k order by k) from jsonb_object_keys(p_changes) k) is distinct from
     (select array_agg(k order by k) from unnest(v_item.changed_fields) k) then raise exception 'changed_fields_do_not_match_plan'; end if;
  if (select array_agg(k order by k) from jsonb_object_keys(p_expected_values) k) is distinct from
     (select array_agg(k order by k) from unnest(v_item.changed_fields) k) then raise exception 'expected_fields_do_not_match_plan'; end if;
  if p_changes ? 'session_type' and (
    jsonb_typeof(p_changes->'session_type') is distinct from 'string'
    or p_changes->>'session_type' not in ('mock_session','sup_transfer_only')
  ) then raise exception 'unsupported_session_type_change'; end if;
  if p_changes ? 'completed_at' and (
    jsonb_typeof(p_changes->'completed_at') is distinct from 'string'
    or nullif(btrim(p_changes->>'completed_at'),'') is null
  ) then raise exception 'completed_at_clear_not_allowed'; end if;
  if p_changes ? 'completed_at' then
    perform (p_changes->>'completed_at')::timestamptz;
  end if;
  if p_expected_values ? 'completed_at' and (
    jsonb_typeof(p_expected_values->'completed_at') is distinct from 'string'
    or nullif(btrim(p_expected_values->>'completed_at'),'') is null
  ) then raise exception 'completed_at_expected_invalid'; end if;
  v_expected_values:=coalesce(p_expected_values,'{}'::jsonb);
  if v_expected_values ? 'completed_at' then
    v_expected_values:=jsonb_set(
      v_expected_values,'{completed_at}',to_jsonb((v_expected_values->>'completed_at')::timestamptz),false
    );
  end if;
  select * into v_before from mts_sam.candidate_sessions where id=v_item.canonical_entity_id for update;
  if not found then raise exception 'update_target_missing'; end if;
  if not (to_jsonb(v_before) @> coalesce(p_precondition,'{}'::jsonb)) then raise exception 'target_precondition_mismatch'; end if;
  v_original:=mts_sam.reconciliation_entity_checksum('candidate_sessions',v_item.canonical_entity_id);
  v_before_values:=(select coalesce(jsonb_object_agg(key,to_jsonb(v_before)->key),'{}'::jsonb) from unnest(v_item.changed_fields) key);
  insert into mts_sam.reconciliation_before_images(
    reconciliation_batch_id,plan_item_id,entity_type,canonical_entity_id,safe_identity_hash,changed_fields,before_values,original_checksum,proposed_checksum,plan_checksum
  ) values (p_batch_id,p_plan_item_id,'candidate_sessions',v_item.canonical_entity_id,v_item.safe_identity_hash,v_item.changed_fields,v_before_values,v_original,v_item.proposed_target_checksum,v_batch.plan_checksum);
  select * into v_after from jsonb_populate_record(v_before,p_changes);
  update mts_sam.candidate_sessions set
    raw_status=v_after.raw_status,calculated_result=v_after.calculated_result,final_result=v_after.final_result,
    archived=v_after.archived,withdrawn=v_after.withdrawn,final_attempt=v_after.final_attempt,
    current_attempt_number=v_after.current_attempt_number,allowed_attempt_count=v_after.allowed_attempt_count,
    needs_sup_transfer=v_after.needs_sup_transfer,pending_sup_transfer_id=v_after.pending_sup_transfer_id,
    newbie_shift_number=v_after.newbie_shift_number,session_type=v_after.session_type,completed_at=v_after.completed_at
  where id=v_item.canonical_entity_id;
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'update_row_count_mismatch'; end if;
  select * into v_after from mts_sam.candidate_sessions where id=v_item.canonical_entity_id;
  if not (to_jsonb(v_after) @> v_expected_values) then raise exception 'post_write_value_mismatch'; end if;
  v_post:=mts_sam.reconciliation_entity_checksum('candidate_sessions',v_item.canonical_entity_id);
  update mts_sam.reconciliation_plan_items set result_status='updated',result_code='exact_update',post_sync_checksum=v_post,
    started_at=coalesce(started_at,statement_timestamp()),completed_at=statement_timestamp() where id=p_plan_item_id;
  return jsonb_build_object('result','updated','entity_id',v_item.canonical_entity_id,'before_image',true,'post_checksum',v_post);
end;
$$;

revoke all on function mts_sam.execute_reconciliation_candidate_session_update(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function mts_sam.execute_reconciliation_candidate_session_update(uuid,uuid,jsonb,jsonb,jsonb) to service_role;

comment on function mts_sam.execute_reconciliation_candidate_session_update(uuid,uuid,jsonb,jsonb,jsonb) is
  'Updates only declared candidate-session fields, compares timestamptz values by exact instant, and retains an exact before-image.';
