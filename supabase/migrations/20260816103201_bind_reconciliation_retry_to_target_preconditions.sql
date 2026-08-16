-- Bind retry eligibility to the planner's freshly regenerated, exact target
-- preconditions. The planner checksum and the hosted entity checksum use
-- intentionally different canonical serializations and must not be compared.

set search_path = '';

create or replace function mts_sam.preview_reconciliation_retry_eligibility(
  p_project_ref text,
  p_source_snapshot_checksum text,
  p_plan_checksum text,
  p_plan_expires_at timestamptz,
  p_provider_state jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  v_prior mts_sam.reconciliation_batches%rowtype;
  v_non_terminal mts_sam.reconciliation_batches%rowtype;
  v_blockers jsonb:='[]'::jsonb;
  v_item jsonb;
  v_mismatch_count integer;
  v_overlap_count integer;
begin
  if p_project_ref is distinct from 'xyfhikikddcqcmzbdvbj' then v_blockers:=v_blockers||jsonb_build_array('project_ref_mismatch'); end if;
  if p_plan_expires_at is null or p_plan_expires_at<=statement_timestamp() then v_blockers:=v_blockers||jsonb_build_array('plan_expired'); end if;
  if p_provider_state is distinct from jsonb_build_object('provider','sheets','shadow_compare','false','dual_write','false') then
    v_blockers:=v_blockers||jsonb_build_array('provider_state_unsafe');
  end if;
  if coalesce(p_source_snapshot_checksum,'') !~ '^[0-9a-f]{64}$' or coalesce(p_plan_checksum,'') !~ '^[0-9a-f]{64}$' then
    v_blockers:=v_blockers||jsonb_build_array('checksum_format_invalid');
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then v_blockers:=v_blockers||jsonb_build_array('plan_items_invalid'); end if;
  if jsonb_array_length(v_blockers)>0 then
    return jsonb_build_object('result','blocked','eligible',false,'retry_required',false,'retry_of_batch_id',null,'blockers',v_blockers);
  end if;

  select * into v_non_terminal from mts_sam.reconciliation_batches
  where plan_checksum=p_plan_checksum and status<>'rolled_back' order by created_at desc limit 1;
  if found then
    if v_non_terminal.status='running' then v_blockers:=v_blockers||jsonb_build_array('plan_checksum_execution_active');
    elsif v_non_terminal.status='succeeded' then v_blockers:=v_blockers||jsonb_build_array('plan_checksum_succeeded');
    elsif v_non_terminal.status='rollback_pending' then v_blockers:=v_blockers||jsonb_build_array('plan_checksum_rollback_pending');
    elsif v_non_terminal.status='rollback_failed' or v_non_terminal.rollback_status='failed' then v_blockers:=v_blockers||jsonb_build_array('plan_checksum_rollback_failed');
    else v_blockers:=v_blockers||jsonb_build_array('plan_checksum_unresolved'); end if;
    return jsonb_build_object('result','blocked','eligible',false,'retry_required',false,
      'retry_of_batch_id',null,'blocking_batch_id',v_non_terminal.id,'blockers',v_blockers);
  end if;

  select * into v_prior from mts_sam.reconciliation_batches
  where plan_checksum=p_plan_checksum and status='rolled_back' order by created_at desc limit 1;
  if not found then
    return jsonb_build_object('result','eligible','eligible',true,'retry_required',false,'retry_of_batch_id',null,'blockers','[]'::jsonb);
  end if;

  if v_prior.rollback_status is distinct from 'succeeded' then v_blockers:=v_blockers||jsonb_build_array('prior_rollback_not_succeeded'); end if;
  if v_prior.target_project_ref<>p_project_ref then v_blockers:=v_blockers||jsonb_build_array('prior_project_mismatch'); end if;
  if v_prior.source_snapshot_checksum<>p_source_snapshot_checksum then v_blockers:=v_blockers||jsonb_build_array('prior_source_checksum_mismatch'); end if;
  if v_prior.provider_state<>p_provider_state then v_blockers:=v_blockers||jsonb_build_array('prior_provider_state_mismatch'); end if;
  if coalesce(mts_sam.reconciliation_batch_residue_count(v_prior.id),0)<>0 then v_blockers:=v_blockers||jsonb_build_array('prior_batch_residue_exists'); end if;
  if v_prior.verification_result ? 'rollback_error_code' then v_blockers:=v_blockers||jsonb_build_array('prior_rollback_error_recorded'); end if;
  if not coalesce(mts_sam.reconciliation_batch_has_exact_reviewed_scope(v_prior.id),false) then v_blockers:=v_blockers||jsonb_build_array('prior_scope_not_exactly_reviewed'); end if;
  if exists(select 1 from mts_sam.reconciliation_batches where retry_of_batch_id=v_prior.id) then v_blockers:=v_blockers||jsonb_build_array('prior_batch_retry_already_created'); end if;

  select count(*) into v_mismatch_count from jsonb_array_elements(p_items) j
  where not exists (
    select 1 from mts_sam.reconciliation_plan_items i
    where i.reconciliation_batch_id=v_prior.id and i.entity_type=j->>'entity_type'
      and i.operation=j->>'operation' and i.classification=j->>'classification'
      and i.safe_identity_hash=j->>'safe_identity_hash' and i.canonical_entity_id=(j->>'canonical_entity_id')::uuid
      and i.source_tab=j->>'source_tab' and i.source_row_key=j->>'source_row_key'
      and i.source_checksum=j->>'source_checksum'
      and i.expected_target_checksum is not distinct from nullif(j->>'target_checksum','')
      and i.proposed_target_checksum=j->>'proposed_checksum'
      and to_jsonb(i.changed_fields)=coalesce(j->'changed_fields','[]'::jsonb)
      and i.dependencies=coalesce(j->'dependencies','[]'::jsonb)
      and i.lineage_expected_outcome is not distinct from j->>'lineage_outcome'
      and i.lineage_required=coalesce((j->>'lineage_required')::boolean,true)
  );
  if v_mismatch_count<>0 or jsonb_array_length(p_items)<>(select count(*) from mts_sam.reconciliation_plan_items where reconciliation_batch_id=v_prior.id) then
    v_blockers:=v_blockers||jsonb_build_array('operation_identity_mismatch');
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    if v_item->>'operation'='insert'
       and mts_sam.reconciliation_entity_checksum(v_item->>'entity_type',(v_item->>'canonical_entity_id')::uuid) is not null then
      v_blockers:=v_blockers||jsonb_build_array('insert_target_now_exists:'||(v_item->>'safe_identity_hash'));
    end if;
  end loop;

  select count(*) into v_overlap_count from mts_sam.reconciliation_batches b
  where b.created_at>v_prior.created_at and b.id<>v_prior.id and b.status<>'rolled_back'
    and exists (
      select 1 from mts_sam.reconciliation_plan_items later_item
      join mts_sam.reconciliation_plan_items prior_item
        on prior_item.reconciliation_batch_id=v_prior.id
       and prior_item.entity_type=later_item.entity_type
       and prior_item.safe_identity_hash=later_item.safe_identity_hash
      where later_item.reconciliation_batch_id=b.id
    );
  if v_overlap_count<>0 then v_blockers:=v_blockers||jsonb_build_array('later_overlapping_batch_exists'); end if;
  if exists(select 1 from mts_sam.reconciliation_batches where target_project_ref=p_project_ref and status in ('running','rollback_pending')) then
    v_blockers:=v_blockers||jsonb_build_array('active_reconciliation_batch');
  end if;

  return jsonb_build_object(
    'result',case when jsonb_array_length(v_blockers)=0 then 'eligible' else 'blocked' end,
    'eligible',jsonb_array_length(v_blockers)=0,'retry_required',true,
    'retry_of_batch_id',v_prior.id,'blockers',v_blockers
  );
end;
$$;

create function mts_sam.reconciliation_entity_json(p_entity_type text,p_entity_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare v_result jsonb;
begin
  case p_entity_type
    when 'candidates' then select to_jsonb(t) into v_result from mts_sam.candidates t where id=p_entity_id;
    when 'candidate_sessions' then select to_jsonb(t) into v_result from mts_sam.candidate_sessions t where id=p_entity_id;
    when 'session_attempts' then select to_jsonb(t) into v_result from mts_sam.session_attempts t where id=p_entity_id;
    when 'headset_catalog' then select to_jsonb(t) into v_result from mts_sam.headset_catalog t where id=p_entity_id;
    when 'headset_reviews' then select to_jsonb(t) into v_result from mts_sam.headset_reviews t where id=p_entity_id;
    when 'supervisor_transfers' then select to_jsonb(t) into v_result from mts_sam.supervisor_transfers t where id=p_entity_id;
    when 'newbie_shift_requests' then select to_jsonb(t) into v_result from mts_sam.newbie_shift_requests t where id=p_entity_id;
    when 'candidate_corrections' then select to_jsonb(t) into v_result from mts_sam.candidate_corrections t where id=p_entity_id;
    when 'pending_requests' then select to_jsonb(t) into v_result from mts_sam.pending_requests t where id=p_entity_id;
    else raise exception 'entity_type_not_supported' using errcode='22023';
  end case;
  return v_result;
end;
$$;

create function mts_sam.preview_reconciliation_retry_eligibility(
  p_project_ref text,
  p_source_snapshot_checksum text,
  p_plan_checksum text,
  p_plan_expires_at timestamptz,
  p_provider_state jsonb,
  p_items jsonb,
  p_target_preconditions jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare v_result jsonb; v_blockers jsonb; v_item jsonb; v_precondition jsonb; v_current jsonb; v_count integer;
begin
  v_result:=mts_sam.preview_reconciliation_retry_eligibility(
    p_project_ref,p_source_snapshot_checksum,p_plan_checksum,p_plan_expires_at,p_provider_state,p_items
  );
  if not coalesce((v_result->>'eligible')::boolean,false) then return v_result; end if;
  if jsonb_typeof(p_target_preconditions) is distinct from 'object' then
    return v_result||jsonb_build_object('result','blocked','eligible',false,'blockers',jsonb_build_array('target_preconditions_invalid'));
  end if;
  select count(*) into v_count from jsonb_object_keys(p_target_preconditions);
  if v_count<>(select count(*) from jsonb_array_elements(p_items) j where j->>'operation'='update') then
    return v_result||jsonb_build_object('result','blocked','eligible',false,'blockers',jsonb_build_array('target_precondition_count_mismatch'));
  end if;
  v_blockers:=coalesce(v_result->'blockers','[]'::jsonb);
  for v_item in select value from jsonb_array_elements(p_items) loop
    if v_item->>'operation'='update' then
      v_precondition:=p_target_preconditions->(v_item->>'safe_identity_hash');
      if jsonb_typeof(v_precondition) is distinct from 'object' then
        v_blockers:=v_blockers||jsonb_build_array('target_precondition_missing:'||(v_item->>'safe_identity_hash'));
      else
        v_current:=mts_sam.reconciliation_entity_json(v_item->>'entity_type',(v_item->>'canonical_entity_id')::uuid);
        if v_current is null or not (v_current @> v_precondition) then
          v_blockers:=v_blockers||jsonb_build_array('target_precondition_changed:'||(v_item->>'safe_identity_hash'));
        end if;
      end if;
    end if;
  end loop;
  return v_result||jsonb_build_object(
    'result',case when jsonb_array_length(v_blockers)=0 then 'eligible' else 'blocked' end,
    'eligible',jsonb_array_length(v_blockers)=0,'blockers',v_blockers
  );
end;
$$;

create or replace function mts_sam.begin_reconciliation_execution(
  p_project_ref text,p_source_snapshot_at timestamptz,p_source_snapshot_checksum text,
  p_plan_checksum text,p_plan_expires_at timestamptz,p_provider_state jsonb,p_source_rows integer,
  p_inserts integer,p_updates integer,p_lineage integer,p_expected_ending_counts jsonb,
  p_actor_metadata jsonb,p_items jsonb
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'target_preconditions_required' using errcode='22023';
end;
$$;

create function mts_sam.begin_reconciliation_execution(
  p_project_ref text,p_source_snapshot_at timestamptz,p_source_snapshot_checksum text,
  p_plan_checksum text,p_plan_expires_at timestamptz,p_provider_state jsonb,p_source_rows integer,
  p_inserts integer,p_updates integer,p_lineage integer,p_expected_ending_counts jsonb,
  p_actor_metadata jsonb,p_items jsonb,p_target_preconditions jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_batch_id uuid; v_item jsonb; v_count integer; v_active record; v_eligibility jsonb; v_retry_of_batch_id uuid;
begin
  if p_project_ref<>'xyfhikikddcqcmzbdvbj' then raise exception 'project_ref_mismatch' using errcode='22023'; end if;
  if p_plan_expires_at<=statement_timestamp() then raise exception 'plan_expired' using errcode='22023'; end if;
  if p_provider_state<>jsonb_build_object('provider','sheets','shadow_compare','false','dual_write','false') then raise exception 'provider_state_unsafe' using errcode='22023'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)<>(p_inserts+p_updates) then raise exception 'plan_item_count_mismatch' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('mts_sam:reconciliation:'||p_project_ref,0));
  select id,status,started_at into v_active from mts_sam.reconciliation_batches
    where target_project_ref=p_project_ref and status in ('running','rollback_pending') limit 1;
  if found then
    if v_active.started_at < statement_timestamp()-interval '30 minutes' then raise exception 'stale_active_reconciliation_batch' using errcode='55P03'; end if;
    raise exception 'active_reconciliation_batch' using errcode='55P03';
  end if;
  v_eligibility:=mts_sam.preview_reconciliation_retry_eligibility(
    p_project_ref,p_source_snapshot_checksum,p_plan_checksum,p_plan_expires_at,p_provider_state,p_items,p_target_preconditions
  );
  if not coalesce((v_eligibility->>'eligible')::boolean,false) then
    if (v_eligibility->'blockers') ? 'plan_checksum_execution_active' then raise exception 'plan_checksum_execution_active' using errcode='55P03';
    elsif (v_eligibility->'blockers') ? 'plan_checksum_succeeded'
       or (v_eligibility->'blockers') ? 'plan_checksum_unresolved'
       or (v_eligibility->'blockers') ? 'plan_checksum_rollback_pending'
       or (v_eligibility->'blockers') ? 'plan_checksum_rollback_failed' then
      raise exception 'plan_checksum_already_used' using errcode='22023';
    end if;
    raise exception 'reconciliation_retry_not_eligible:%',v_eligibility->'blockers' using errcode='22023';
  end if;
  v_retry_of_batch_id:=nullif(v_eligibility->>'retry_of_batch_id','')::uuid;
  insert into mts_sam.reconciliation_batches(
    mode,status,target_project_ref,source_snapshot_at,source_snapshot_checksum,plan_checksum,plan_expires_at,
    provider_state,source_rows_considered,inserts_planned,updates_planned,planned_lineage_count,
    expected_ending_counts,actor_metadata,started_at,rollback_eligible,retry_of_batch_id
  ) values (
    'execute','ready',p_project_ref,p_source_snapshot_at,p_source_snapshot_checksum,p_plan_checksum,p_plan_expires_at,
    p_provider_state,p_source_rows,p_inserts,p_updates,p_lineage,coalesce(p_expected_ending_counts,'{}'::jsonb),
    coalesce(p_actor_metadata,'{}'::jsonb),statement_timestamp(),false,v_retry_of_batch_id
  ) returning id into v_batch_id;
  v_count:=0;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_count:=v_count+1;
    if v_item->>'operation' not in ('insert','update') then raise exception 'unsupported_plan_operation'; end if;
    insert into mts_sam.reconciliation_plan_items(
      reconciliation_batch_id,sequence_number,entity_type,operation,classification,safe_identity_hash,
      canonical_entity_id,source_tab,source_row_key,source_checksum,expected_target_checksum,
      proposed_target_checksum,changed_fields,dependencies,lineage_expected_outcome,lineage_required,
      created_by_batch,result_status
    ) values (
      v_batch_id,v_count,v_item->>'entity_type',v_item->>'operation',v_item->>'classification',
      v_item->>'safe_identity_hash',(v_item->>'canonical_entity_id')::uuid,v_item->>'source_tab',
      v_item->>'source_row_key',v_item->>'source_checksum',nullif(v_item->>'target_checksum',''),
      v_item->>'proposed_checksum',array(select jsonb_array_elements_text(coalesce(v_item->'changed_fields','[]'::jsonb))),
      coalesce(v_item->'dependencies','[]'::jsonb),v_item->>'lineage_outcome',
      coalesce((v_item->>'lineage_required')::boolean,true),false,'planned'
    );
  end loop;
  update mts_sam.reconciliation_batches set status='running' where id=v_batch_id;
  return jsonb_build_object(
    'result','started','batch_id',v_batch_id,'retry_of_batch_id',v_retry_of_batch_id,'plan_item_count',v_count,
    'items',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'sequence_number',sequence_number,'safe_identity_hash',safe_identity_hash) order by sequence_number),'[]'::jsonb)
      from mts_sam.reconciliation_plan_items where reconciliation_batch_id=v_batch_id)
  );
end;
$$;

revoke all on function mts_sam.reconciliation_entity_json(text,uuid) from public,anon,authenticated;
revoke all on function mts_sam.preview_reconciliation_retry_eligibility(text,text,text,timestamptz,jsonb,jsonb,jsonb) from public,anon,authenticated;
revoke all on function mts_sam.begin_reconciliation_execution(text,timestamptz,text,text,timestamptz,jsonb,integer,integer,integer,integer,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function mts_sam.reconciliation_entity_json(text,uuid) to service_role;
grant execute on function mts_sam.preview_reconciliation_retry_eligibility(text,text,text,timestamptz,jsonb,jsonb,jsonb) to service_role;
grant execute on function mts_sam.begin_reconciliation_execution(text,timestamptz,text,text,timestamptz,jsonb,integer,integer,integer,integer,jsonb,jsonb,jsonb,jsonb) to service_role;
