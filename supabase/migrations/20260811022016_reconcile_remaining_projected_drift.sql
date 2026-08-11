-- Local-only forward support for separately approved narrow drift repairs.
-- This migration must be deployed before any 28+6 execution is considered.

set search_path = '';

create or replace view mts_sam.reconciliation_runtime_capabilities
with (security_invoker = true) as
select true::boolean as candidate_correction_update;

revoke all on mts_sam.reconciliation_runtime_capabilities from public, anon, authenticated;
grant select on mts_sam.reconciliation_runtime_capabilities to service_role;

create or replace function mts_sam.reconciliation_entity_checksum(p_entity_type text, p_entity_id uuid)
returns text language plpgsql security invoker set search_path = '' as $$
declare v_payload jsonb;
begin
  case p_entity_type
    when 'candidates' then select to_jsonb(t)-array['updated_at']::text[] into v_payload from mts_sam.candidates t where id=p_entity_id;
    when 'candidate_sessions' then select to_jsonb(t)-array['updated_at','imported_at']::text[] into v_payload from mts_sam.candidate_sessions t where id=p_entity_id;
    when 'session_attempts' then select to_jsonb(t) into v_payload from mts_sam.session_attempts t where id=p_entity_id;
    when 'headset_catalog' then select to_jsonb(t)-array['updated_at']::text[] into v_payload from mts_sam.headset_catalog t where id=p_entity_id;
    when 'headset_reviews' then select to_jsonb(t)-array['updated_at']::text[] into v_payload from mts_sam.headset_reviews t where id=p_entity_id;
    when 'supervisor_transfers' then select to_jsonb(t) into v_payload from mts_sam.supervisor_transfers t where id=p_entity_id;
    when 'newbie_shift_requests' then select to_jsonb(t)-array['updated_at']::text[] into v_payload from mts_sam.newbie_shift_requests t where id=p_entity_id;
    when 'candidate_corrections' then select to_jsonb(t) into v_payload from mts_sam.candidate_corrections t where id=p_entity_id;
    when 'pending_requests' then select to_jsonb(t)-array['updated_at']::text[] into v_payload from mts_sam.pending_requests t where id=p_entity_id;
    else raise exception 'entity_type_not_supported' using errcode='22023';
  end case;
  if v_payload is null then return null; end if;
  return encode(extensions.digest(convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
end;
$$;

create or replace function mts_sam.execute_reconciliation_candidate_session_update(
  p_batch_id uuid, p_plan_item_id uuid, p_precondition jsonb, p_changes jsonb, p_expected_values jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_batch mts_sam.reconciliation_batches%rowtype; v_item mts_sam.reconciliation_plan_items%rowtype;
  v_before mts_sam.candidate_sessions%rowtype; v_after mts_sam.candidate_sessions%rowtype;
  v_before_values jsonb; v_original text; v_post text; v_count integer;
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
  if (select array_agg(k order by k) from jsonb_object_keys(p_changes) k) is distinct from
     (select array_agg(k order by k) from unnest(v_item.changed_fields) k) then raise exception 'changed_fields_do_not_match_plan'; end if;
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
  if not (to_jsonb(v_after) @> coalesce(p_expected_values,'{}'::jsonb)) then raise exception 'post_write_value_mismatch'; end if;
  v_post:=mts_sam.reconciliation_entity_checksum('candidate_sessions',v_item.canonical_entity_id);
  update mts_sam.reconciliation_plan_items set result_status='updated',result_code='exact_update',post_sync_checksum=v_post,
    started_at=coalesce(started_at,statement_timestamp()),completed_at=statement_timestamp() where id=p_plan_item_id;
  return jsonb_build_object('result','updated','entity_id',v_item.canonical_entity_id,'before_image',true,'post_checksum',v_post);
end;
$$;

create function mts_sam.execute_reconciliation_candidate_correction_update(
  p_batch_id uuid, p_plan_item_id uuid, p_precondition jsonb, p_changes jsonb, p_expected_values jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_batch mts_sam.reconciliation_batches%rowtype; v_item mts_sam.reconciliation_plan_items%rowtype;
  v_before mts_sam.candidate_corrections%rowtype; v_after mts_sam.candidate_corrections%rowtype;
  v_parent mts_sam.candidate_sessions%rowtype;
  v_before_values jsonb; v_original text; v_post text; v_count integer;
  v_allowed constant text[]:=array['candidate_id'];
begin
  select * into v_batch from mts_sam.reconciliation_batches where id=p_batch_id for update;
  select * into v_item from mts_sam.reconciliation_plan_items where id=p_plan_item_id and reconciliation_batch_id=p_batch_id for update;
  if v_batch.status<>'running' or v_item.operation<>'update' or v_item.entity_type<>'candidate_corrections' then raise exception 'update_item_not_runnable'; end if;
  if v_item.result_status='updated' then return jsonb_build_object('result','already_committed','entity_id',v_item.canonical_entity_id,'post_checksum',v_item.post_sync_checksum); end if;
  perform mts_sam.assert_reconciliation_json_keys(p_changes,v_allowed);
  if (select array_agg(k order by k) from jsonb_object_keys(p_changes) k) is distinct from
     (select array_agg(k order by k) from unnest(v_item.changed_fields) k) then raise exception 'changed_fields_do_not_match_plan'; end if;
  select * into v_before from mts_sam.candidate_corrections where id=v_item.canonical_entity_id for update;
  if not found then raise exception 'update_target_missing'; end if;
  if not (to_jsonb(v_before) @> coalesce(p_precondition,'{}'::jsonb)) then raise exception 'target_precondition_mismatch'; end if;
  select * into v_parent from mts_sam.candidate_sessions where session_id=v_before.source_session_id;
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'stable_parent_session_not_exact'; end if;
  if v_before.session_id is distinct from v_parent.id then raise exception 'correction_session_fk_mismatch'; end if;
  if p_changes->>'candidate_id' is null or (p_changes->>'candidate_id')::uuid is distinct from v_parent.candidate_id then raise exception 'candidate_not_proven_by_stable_session'; end if;
  if not exists(select 1 from mts_sam.candidates where id=(p_changes->>'candidate_id')::uuid) then raise exception 'parent_candidate_missing'; end if;
  v_original:=mts_sam.reconciliation_entity_checksum('candidate_corrections',v_item.canonical_entity_id);
  v_before_values:=jsonb_build_object('candidate_id',v_before.candidate_id);
  insert into mts_sam.reconciliation_before_images(
    reconciliation_batch_id,plan_item_id,entity_type,canonical_entity_id,safe_identity_hash,changed_fields,before_values,original_checksum,proposed_checksum,plan_checksum
  ) values (p_batch_id,p_plan_item_id,'candidate_corrections',v_item.canonical_entity_id,v_item.safe_identity_hash,v_item.changed_fields,v_before_values,v_original,v_item.proposed_target_checksum,v_batch.plan_checksum);
  update mts_sam.candidate_corrections set candidate_id=(p_changes->>'candidate_id')::uuid where id=v_item.canonical_entity_id;
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'update_row_count_mismatch'; end if;
  select * into v_after from mts_sam.candidate_corrections where id=v_item.canonical_entity_id;
  if not (to_jsonb(v_after) @> coalesce(p_expected_values,'{}'::jsonb)) then raise exception 'post_write_value_mismatch'; end if;
  v_post:=mts_sam.reconciliation_entity_checksum('candidate_corrections',v_item.canonical_entity_id);
  update mts_sam.reconciliation_plan_items set result_status='updated',result_code='exact_stable_session_fk_update',post_sync_checksum=v_post,
    started_at=coalesce(started_at,statement_timestamp()),completed_at=statement_timestamp() where id=p_plan_item_id;
  return jsonb_build_object('result','updated','entity_id',v_item.canonical_entity_id,'before_image',true,'post_checksum',v_post);
end;
$$;

create or replace function mts_sam.rollback_reconciliation_batch(p_batch_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_preview jsonb; v_image record; v_item record; v_session mts_sam.candidate_sessions%rowtype;
  v_correction mts_sam.candidate_corrections%rowtype; v_actual_counts jsonb; v_key text;
begin
  perform pg_advisory_xact_lock(hashtextextended('mts_sam:reconciliation:xyfhikikddcqcmzbdvbj',0));
  if exists(select 1 from mts_sam.reconciliation_batches where id=p_batch_id and status='rolled_back') then return jsonb_build_object('result','already_rolled_back','batch_id',p_batch_id,'audit_preserved',true); end if;
  v_preview:=mts_sam.preview_reconciliation_rollback(p_batch_id);
  if not coalesce((v_preview->>'eligible')::boolean,false) then return v_preview||jsonb_build_object('result','blocked'); end if;
  update mts_sam.reconciliation_batches set status='rollback_pending',rollback_status='running' where id=p_batch_id;
  begin
    for v_image in select * from mts_sam.reconciliation_before_images where reconciliation_batch_id=p_batch_id loop
      if v_image.entity_type='candidate_sessions' then
        select * into v_session from mts_sam.candidate_sessions where id=v_image.canonical_entity_id for update;
        if not found then raise exception 'rollback_update_target_missing'; end if;
        select * into v_session from jsonb_populate_record(v_session,v_image.before_values);
        update mts_sam.candidate_sessions set
          raw_status=v_session.raw_status,calculated_result=v_session.calculated_result,final_result=v_session.final_result,
          archived=v_session.archived,withdrawn=v_session.withdrawn,final_attempt=v_session.final_attempt,
          current_attempt_number=v_session.current_attempt_number,allowed_attempt_count=v_session.allowed_attempt_count,
          needs_sup_transfer=v_session.needs_sup_transfer,pending_sup_transfer_id=v_session.pending_sup_transfer_id,
          newbie_shift_number=v_session.newbie_shift_number,session_type=v_session.session_type,completed_at=v_session.completed_at
        where id=v_image.canonical_entity_id;
      elsif v_image.entity_type='candidate_corrections' then
        select * into v_correction from mts_sam.candidate_corrections where id=v_image.canonical_entity_id for update;
        if not found then raise exception 'rollback_update_target_missing'; end if;
        select * into v_correction from jsonb_populate_record(v_correction,v_image.before_values);
        update mts_sam.candidate_corrections set candidate_id=v_correction.candidate_id where id=v_image.canonical_entity_id;
      else raise exception 'rollback_update_type_not_supported';
      end if;
      if mts_sam.reconciliation_entity_checksum(v_image.entity_type,v_image.canonical_entity_id)<>v_image.original_checksum then raise exception 'rollback_restore_checksum_mismatch'; end if;
    end loop;
    delete from mts_sam.data_source_lineage where reconciliation_batch_id=p_batch_id;
    delete from mts_sam.pending_requests where created_by_reconciliation_batch_id=p_batch_id;
    delete from mts_sam.newbie_shift_requests where created_by_reconciliation_batch_id=p_batch_id;
    delete from mts_sam.supervisor_transfers where created_by_reconciliation_batch_id=p_batch_id;
    delete from mts_sam.headset_reviews where created_by_reconciliation_batch_id=p_batch_id;
    delete from mts_sam.session_attempts where created_by_reconciliation_batch_id=p_batch_id;
    delete from mts_sam.candidate_sessions where created_by_reconciliation_batch_id=p_batch_id;
    delete from mts_sam.headset_catalog where created_by_reconciliation_batch_id=p_batch_id;
    delete from mts_sam.candidates where created_by_reconciliation_batch_id=p_batch_id;
    if exists(select 1 from mts_sam.data_source_lineage where reconciliation_batch_id=p_batch_id)
       or exists(select 1 from mts_sam.candidates where created_by_reconciliation_batch_id=p_batch_id)
       or exists(select 1 from mts_sam.candidate_sessions where created_by_reconciliation_batch_id=p_batch_id)
       or exists(select 1 from mts_sam.session_attempts where created_by_reconciliation_batch_id=p_batch_id)
       or exists(select 1 from mts_sam.headset_catalog where created_by_reconciliation_batch_id=p_batch_id)
       or exists(select 1 from mts_sam.headset_reviews where created_by_reconciliation_batch_id=p_batch_id)
       or exists(select 1 from mts_sam.supervisor_transfers where created_by_reconciliation_batch_id=p_batch_id)
       or exists(select 1 from mts_sam.newbie_shift_requests where created_by_reconciliation_batch_id=p_batch_id)
       or exists(select 1 from mts_sam.pending_requests where created_by_reconciliation_batch_id=p_batch_id) then raise exception 'rollback_batch_artifacts_remain'; end if;
    v_actual_counts:=jsonb_build_object(
      'candidates',(select count(*) from mts_sam.candidates),'candidate_sessions',(select count(*) from mts_sam.candidate_sessions),
      'session_attempts',(select count(*) from mts_sam.session_attempts),'headset_catalog',(select count(*) from mts_sam.headset_catalog),
      'headset_reviews',(select count(*) from mts_sam.headset_reviews),'supervisor_transfers',(select count(*) from mts_sam.supervisor_transfers),
      'newbie_shift_requests',(select count(*) from mts_sam.newbie_shift_requests),'pending_requests',(select count(*) from mts_sam.pending_requests));
    for v_key in select jsonb_object_keys(v_preview->'expected_post_rollback_counts') loop
      if (v_actual_counts->>v_key)::integer<>(v_preview->'expected_post_rollback_counts'->>v_key)::integer then raise exception 'rollback_ending_count_mismatch:%',v_key; end if;
    end loop;
    for v_item in select * from mts_sam.reconciliation_plan_items where reconciliation_batch_id=p_batch_id and result_status in ('inserted','updated') loop
      update mts_sam.reconciliation_plan_items set result_status='rolled_back',result_code='exact_batch_rollback',completed_at=statement_timestamp() where id=v_item.id;
    end loop;
    update mts_sam.reconciliation_batches set status='rolled_back',rollback_status='succeeded',completed_at=statement_timestamp(),rollback_eligible=false where id=p_batch_id;
    return jsonb_build_object('result','rolled_back','batch_id',p_batch_id,'audit_preserved',true,'ending_counts',v_actual_counts);
  exception when others then
    update mts_sam.reconciliation_batches set status='rollback_failed',rollback_status='failed',completed_at=statement_timestamp(),
      verification_result=jsonb_build_object('rollback_error_code',sqlstate) where id=p_batch_id;
    return jsonb_build_object('result','rollback_failed','batch_id',p_batch_id,'error_code',sqlstate);
  end;
end;
$$;

revoke all on function mts_sam.execute_reconciliation_candidate_correction_update(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function mts_sam.execute_reconciliation_candidate_correction_update(uuid,uuid,jsonb,jsonb,jsonb) to service_role;

comment on function mts_sam.execute_reconciliation_candidate_correction_update(uuid,uuid,jsonb,jsonb,jsonb) is
  'Updates candidate_corrections.candidate_id only when proven by the exact canonical source session; retains a narrow before-image.';
