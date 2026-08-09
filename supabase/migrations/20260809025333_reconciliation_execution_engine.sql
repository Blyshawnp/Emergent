-- Plan-bound MTS/SAM reconciliation execution and exact rollback framework.
-- Forward-only and intentionally unapplied in this checkpoint.

set search_path = '';

alter table mts_sam.reconciliation_batches
  drop constraint if exists reconciliation_batches_status_check;
alter table mts_sam.reconciliation_batches
  add constraint reconciliation_batches_status_check check (status in (
    'planned','blocked','ready','running','succeeded','partially_failed','failed',
    'rollback_pending','rolled_back','rollback_failed'
  ));

alter table mts_sam.reconciliation_batches
  add column planned_lineage_count integer not null default 0 check (planned_lineage_count >= 0),
  add column expected_ending_counts jsonb not null default '{}'::jsonb,
  add column actor_metadata jsonb not null default '{}'::jsonb;

alter table mts_sam.reconciliation_plan_items
  add column lineage_required boolean not null default true,
  add column started_at timestamptz,
  add column completed_at timestamptz;

alter table mts_sam.reconciliation_plan_items
  add constraint reconciliation_plan_items_result_status_check check (
    result_status is null or result_status in (
      'planned','validating','running','inserted','updated','already_current',
      'reused_lineage','blocked_by_dependency','conflict','failed','rolled_back'
    )
  );

alter table mts_sam.candidates
  add column created_by_reconciliation_batch_id uuid references mts_sam.reconciliation_batches(id) on delete restrict;
alter table mts_sam.candidate_sessions
  add column created_by_reconciliation_batch_id uuid references mts_sam.reconciliation_batches(id) on delete restrict;
alter table mts_sam.session_attempts
  add column created_by_reconciliation_batch_id uuid references mts_sam.reconciliation_batches(id) on delete restrict;
alter table mts_sam.headset_catalog
  add column created_by_reconciliation_batch_id uuid references mts_sam.reconciliation_batches(id) on delete restrict;
alter table mts_sam.headset_reviews
  add column created_by_reconciliation_batch_id uuid references mts_sam.reconciliation_batches(id) on delete restrict;
alter table mts_sam.supervisor_transfers
  add column created_by_reconciliation_batch_id uuid references mts_sam.reconciliation_batches(id) on delete restrict;
alter table mts_sam.newbie_shift_requests
  add column created_by_reconciliation_batch_id uuid references mts_sam.reconciliation_batches(id) on delete restrict;
alter table mts_sam.pending_requests
  add column created_by_reconciliation_batch_id uuid references mts_sam.reconciliation_batches(id) on delete restrict;

alter table mts_sam.data_source_lineage
  add column reconciliation_batch_id uuid references mts_sam.reconciliation_batches(id) on delete restrict,
  add column reconciliation_plan_item_id uuid references mts_sam.reconciliation_plan_items(id) on delete restrict;

create unique index reconciliation_one_active_batch_idx
  on mts_sam.reconciliation_batches (target_project_ref)
  where status in ('running','rollback_pending');

create index reconciliation_lineage_batch_idx
  on mts_sam.data_source_lineage (reconciliation_batch_id, reconciliation_plan_item_id)
  where reconciliation_batch_id is not null;

create index candidates_reconciliation_batch_idx on mts_sam.candidates (created_by_reconciliation_batch_id)
  where created_by_reconciliation_batch_id is not null;
create index candidate_sessions_reconciliation_batch_idx on mts_sam.candidate_sessions (created_by_reconciliation_batch_id)
  where created_by_reconciliation_batch_id is not null;
create index session_attempts_reconciliation_batch_idx on mts_sam.session_attempts (created_by_reconciliation_batch_id)
  where created_by_reconciliation_batch_id is not null;
create index headset_catalog_reconciliation_batch_idx on mts_sam.headset_catalog (created_by_reconciliation_batch_id)
  where created_by_reconciliation_batch_id is not null;
create index headset_reviews_reconciliation_batch_idx on mts_sam.headset_reviews (created_by_reconciliation_batch_id)
  where created_by_reconciliation_batch_id is not null;
create index supervisor_transfers_reconciliation_batch_idx on mts_sam.supervisor_transfers (created_by_reconciliation_batch_id)
  where created_by_reconciliation_batch_id is not null;
create index newbie_shift_requests_reconciliation_batch_idx on mts_sam.newbie_shift_requests (created_by_reconciliation_batch_id)
  where created_by_reconciliation_batch_id is not null;
create index pending_requests_reconciliation_batch_idx on mts_sam.pending_requests (created_by_reconciliation_batch_id)
  where created_by_reconciliation_batch_id is not null;

-- Extend the sole trusted lineage RPC with exact reconciliation attribution.
drop function mts_sam.insert_lineage_if_absent(text, uuid, text, text, text, text, uuid, jsonb);

create function mts_sam.insert_lineage_if_absent(
  p_entity_type text,
  p_entity_id uuid,
  p_source_system text,
  p_source_tab text,
  p_source_row_key text,
  p_source_checksum text,
  p_import_batch_id uuid,
  p_metadata jsonb default '{}'::jsonb,
  p_reconciliation_batch_id uuid default null,
  p_reconciliation_plan_item_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source mts_sam.data_source_lineage%rowtype;
  v_entity mts_sam.data_source_lineage%rowtype;
begin
  lock table mts_sam.data_source_lineage in share row exclusive mode;

  select * into v_source
  from mts_sam.data_source_lineage
  where source_system = p_source_system
    and source_tab = p_source_tab
    and source_row_key = p_source_row_key
  limit 1;
  if found then
    if v_source.entity_type = p_entity_type and v_source.entity_id = p_entity_id then
      return jsonb_build_object('result','already_exists_same_mapping','entity_id',v_source.entity_id);
    end if;
    return jsonb_build_object(
      'result','conflict_source_maps_to_different_entity',
      'existing_entity_id',v_source.entity_id,'requested_entity_id',p_entity_id
    );
  end if;

  select * into v_entity
  from mts_sam.data_source_lineage
  where entity_type = p_entity_type and entity_id = p_entity_id
    and source_system = p_source_system and source_tab = p_source_tab
  limit 1;
  if found then
    if v_entity.source_row_key = p_source_row_key then
      return jsonb_build_object('result','already_exists_same_mapping','entity_id',p_entity_id);
    end if;
    return jsonb_build_object(
      'result','conflict_entity_maps_to_different_source',
      'existing_source_row_key',v_entity.source_row_key,
      'requested_source_row_key',p_source_row_key
    );
  end if;

  insert into mts_sam.data_source_lineage (
    entity_type, entity_id, source_system, source_tab, source_row_key,
    source_checksum, import_batch_id, metadata,
    reconciliation_batch_id, reconciliation_plan_item_id
  ) values (
    p_entity_type, p_entity_id, p_source_system, p_source_tab, p_source_row_key,
    p_source_checksum, p_import_batch_id, coalesce(p_metadata,'{}'::jsonb),
    p_reconciliation_batch_id, p_reconciliation_plan_item_id
  );
  return jsonb_build_object('result','inserted','entity_id',p_entity_id);
end;
$$;

create function mts_sam.assert_reconciliation_json_keys(p_payload jsonb, p_allowed text[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare v_key text;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload_not_object' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_payload) loop
    if not (v_key = any(p_allowed)) then
      raise exception 'payload_field_not_allowed' using errcode = '22023';
    end if;
  end loop;
end;
$$;

create function mts_sam.reconciliation_entity_checksum(p_entity_type text, p_entity_id uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare v_payload jsonb;
begin
  case p_entity_type
    when 'candidates' then
      select to_jsonb(t) - array['updated_at']::text[] into v_payload from mts_sam.candidates t where id=p_entity_id;
    when 'candidate_sessions' then
      select to_jsonb(t) - array['updated_at','imported_at']::text[] into v_payload from mts_sam.candidate_sessions t where id=p_entity_id;
    when 'session_attempts' then
      select to_jsonb(t) into v_payload from mts_sam.session_attempts t where id=p_entity_id;
    when 'headset_catalog' then
      select to_jsonb(t) - array['updated_at']::text[] into v_payload from mts_sam.headset_catalog t where id=p_entity_id;
    when 'headset_reviews' then
      select to_jsonb(t) - array['updated_at']::text[] into v_payload from mts_sam.headset_reviews t where id=p_entity_id;
    when 'supervisor_transfers' then
      select to_jsonb(t) into v_payload from mts_sam.supervisor_transfers t where id=p_entity_id;
    when 'newbie_shift_requests' then
      select to_jsonb(t) - array['updated_at']::text[] into v_payload from mts_sam.newbie_shift_requests t where id=p_entity_id;
    when 'pending_requests' then
      select to_jsonb(t) - array['updated_at']::text[] into v_payload from mts_sam.pending_requests t where id=p_entity_id;
    else raise exception 'entity_type_not_supported' using errcode='22023';
  end case;
  if v_payload is null then return null; end if;
  return encode(extensions.digest(convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
end;
$$;

create or replace function mts_sam.guard_reconciliation_batch_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op='DELETE' then raise exception 'reconciliation batches are immutable audit evidence'; end if;
  if (to_jsonb(new)-array[
      'status','started_at','completed_at','unresolved_count','conflicts_count','skipped_count',
      'lineage_outcomes','before_image_count','created_entity_count','verification_result',
      'rollback_eligible','rollback_status'
    ]::text[]) is distinct from (to_jsonb(old)-array[
      'status','started_at','completed_at','unresolved_count','conflicts_count','skipped_count',
      'lineage_outcomes','before_image_count','created_entity_count','verification_result',
      'rollback_eligible','rollback_status'
    ]::text[]) then
    raise exception 'reconciliation planning evidence is immutable';
  end if;
  if old.status is distinct from new.status and not (
    (old.status='planned' and new.status in ('blocked','ready')) or
    (old.status='blocked' and new.status='ready') or
    (old.status='ready' and new.status='running') or
    (old.status='running' and new.status in ('succeeded','partially_failed','failed')) or
    (old.status in ('succeeded','partially_failed','failed') and new.status='rollback_pending') or
    (old.status='rollback_pending' and new.status in ('rolled_back','rollback_failed'))
  ) then raise exception 'invalid reconciliation batch status transition'; end if;
  if new.status='running' and (old.mode<>'execute' or new.started_at is null) then
    raise exception 'only an execute batch with started_at may run';
  end if;
  if new.status in ('succeeded','partially_failed','failed','rolled_back','rollback_failed')
     and new.completed_at is null then raise exception 'terminal status requires completed_at'; end if;
  if new.rollback_eligible and new.status not in ('succeeded','partially_failed','failed','rollback_pending') then
    raise exception 'rollback eligibility requires completed or rollback-pending batch';
  end if;
  if new.status='rolled_back' and new.rollback_status<>'succeeded' then
    raise exception 'rolled back batch requires succeeded rollback status';
  end if;
  return new;
end;
$$;

create or replace function mts_sam.guard_reconciliation_plan_item_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare v_status text;
begin
  if tg_op='DELETE' then raise exception 'reconciliation plan items are immutable audit evidence'; end if;
  select status into v_status from mts_sam.reconciliation_batches
    where id=coalesce(new.reconciliation_batch_id,old.reconciliation_batch_id);
  if tg_op='INSERT' then
    if v_status not in ('planned','blocked','ready') then raise exception 'plan items cannot be inserted after execution starts'; end if;
    return new;
  end if;
  if v_status not in ('running','rollback_pending') then raise exception 'plan results may change only during execution or rollback'; end if;
  if (to_jsonb(new)-array['created_by_batch','result_status','result_code','post_sync_checksum','started_at','completed_at']::text[])
     is distinct from
     (to_jsonb(old)-array['created_by_batch','result_status','result_code','post_sync_checksum','started_at','completed_at']::text[])
  then raise exception 'plan definition cannot change after execution starts'; end if;
  if new.created_by_batch and (new.operation<>'insert' or new.canonical_entity_id is null
     or new.result_status not in ('inserted','rolled_back') or new.post_sync_checksum is null)
  then raise exception 'created-by-batch requires proven insert'; end if;
  return new;
end;
$$;

create function mts_sam.begin_reconciliation_execution(
  p_project_ref text, p_source_snapshot_at timestamptz, p_source_snapshot_checksum text,
  p_plan_checksum text, p_plan_expires_at timestamptz, p_provider_state jsonb,
  p_source_rows integer, p_inserts integer, p_updates integer, p_lineage integer,
  p_expected_ending_counts jsonb, p_actor_metadata jsonb, p_items jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_batch_id uuid; v_item jsonb; v_count integer; v_active record; v_existing mts_sam.reconciliation_batches%rowtype;
begin
  if p_project_ref<>'xyfhikikddcqcmzbdvbj' then raise exception 'project_ref_mismatch' using errcode='22023'; end if;
  if p_plan_expires_at<=statement_timestamp() then raise exception 'plan_expired' using errcode='22023'; end if;
  if p_provider_state<>jsonb_build_object('provider','sheets','shadow_compare','false','dual_write','false') then
    raise exception 'provider_state_unsafe' using errcode='22023';
  end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)<>(p_inserts+p_updates) then
    raise exception 'plan_item_count_mismatch' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mts_sam:reconciliation:'||p_project_ref,0));
  select * into v_existing from mts_sam.reconciliation_batches where plan_checksum=p_plan_checksum;
  if found then
    if v_existing.target_project_ref<>p_project_ref
       or v_existing.source_snapshot_checksum<>p_source_snapshot_checksum
       or v_existing.provider_state<>p_provider_state then
      raise exception 'existing_plan_evidence_mismatch' using errcode='22023';
    end if;
    if v_existing.status='running' then
      return jsonb_build_object(
        'result','already_started','batch_id',v_existing.id,
        'plan_item_count',(select count(*) from mts_sam.reconciliation_plan_items where reconciliation_batch_id=v_existing.id),
        'items',(select coalesce(jsonb_agg(jsonb_build_object(
          'id',id,'sequence_number',sequence_number,'safe_identity_hash',safe_identity_hash
        ) order by sequence_number),'[]'::jsonb) from mts_sam.reconciliation_plan_items where reconciliation_batch_id=v_existing.id)
      );
    end if;
    raise exception 'plan_checksum_already_used' using errcode='22023';
  end if;
  select id,status,started_at into v_active from mts_sam.reconciliation_batches
    where target_project_ref=p_project_ref and status in ('running','rollback_pending') limit 1;
  if found then
    if v_active.started_at < statement_timestamp()-interval '30 minutes' then
      raise exception 'stale_active_reconciliation_batch' using errcode='55P03';
    end if;
    raise exception 'active_reconciliation_batch' using errcode='55P03';
  end if;
  insert into mts_sam.reconciliation_batches(
    mode,status,target_project_ref,source_snapshot_at,source_snapshot_checksum,
    plan_checksum,plan_expires_at,provider_state,source_rows_considered,
    inserts_planned,updates_planned,planned_lineage_count,expected_ending_counts,
    actor_metadata,started_at,rollback_eligible
  ) values (
    'execute','ready',p_project_ref,p_source_snapshot_at,p_source_snapshot_checksum,
    p_plan_checksum,p_plan_expires_at,p_provider_state,p_source_rows,
    p_inserts,p_updates,p_lineage,coalesce(p_expected_ending_counts,'{}'::jsonb),
    coalesce(p_actor_metadata,'{}'::jsonb),statement_timestamp(),false
  ) returning id into v_batch_id;
  v_count:=0;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_count:=v_count+1;
    if v_item->>'operation' not in ('insert','update') then raise exception 'unsupported_plan_operation'; end if;
    insert into mts_sam.reconciliation_plan_items(
      reconciliation_batch_id,sequence_number,entity_type,operation,classification,
      safe_identity_hash,canonical_entity_id,source_tab,source_row_key,source_checksum,
      expected_target_checksum,proposed_target_checksum,changed_fields,dependencies,
      lineage_expected_outcome,lineage_required,created_by_batch,result_status
    ) values (
      v_batch_id,v_count,v_item->>'entity_type',v_item->>'operation',v_item->>'classification',
      v_item->>'safe_identity_hash',(v_item->>'canonical_entity_id')::uuid,
      v_item->>'source_tab',v_item->>'source_row_key',v_item->>'source_checksum',
      nullif(v_item->>'target_checksum',''),v_item->>'proposed_checksum',
      array(select jsonb_array_elements_text(coalesce(v_item->'changed_fields','[]'::jsonb))),
      coalesce(v_item->'dependencies','[]'::jsonb),v_item->>'lineage_outcome',
      coalesce((v_item->>'lineage_required')::boolean,true),false,'planned'
    );
  end loop;
  update mts_sam.reconciliation_batches set status='running' where id=v_batch_id;
  return jsonb_build_object(
    'result','started','batch_id',v_batch_id,'plan_item_count',v_count,
    'items',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',id,'sequence_number',sequence_number,'safe_identity_hash',safe_identity_hash
      ) order by sequence_number),'[]'::jsonb)
      from mts_sam.reconciliation_plan_items where reconciliation_batch_id=v_batch_id
    )
  );
end;
$$;

create function mts_sam.execute_reconciliation_insert(
  p_batch_id uuid, p_plan_item_id uuid, p_payload jsonb,
  p_expected_values jsonb, p_lineage jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_batch mts_sam.reconciliation_batches%rowtype;
  v_item mts_sam.reconciliation_plan_items%rowtype;
  v_candidate mts_sam.candidates%rowtype;
  v_session mts_sam.candidate_sessions%rowtype;
  v_attempt mts_sam.session_attempts%rowtype;
  v_catalog mts_sam.headset_catalog%rowtype;
  v_review mts_sam.headset_reviews%rowtype;
  v_transfer mts_sam.supervisor_transfers%rowtype;
  v_shift mts_sam.newbie_shift_requests%rowtype;
  v_request mts_sam.pending_requests%rowtype;
  v_payload jsonb; v_actual jsonb; v_lineage jsonb; v_checksum text;
begin
  select * into v_batch from mts_sam.reconciliation_batches where id=p_batch_id for update;
  select * into v_item from mts_sam.reconciliation_plan_items
    where id=p_plan_item_id and reconciliation_batch_id=p_batch_id for update;
  if v_batch.status<>'running' or v_item.operation<>'insert' then raise exception 'insert_item_not_runnable'; end if;
  if v_item.result_status='inserted' then
    return jsonb_build_object('result','already_committed','entity_id',v_item.canonical_entity_id,'post_checksum',v_item.post_sync_checksum);
  end if;
  if v_item.result_status<>'planned' then raise exception 'insert_item_invalid_status'; end if;
  if exists (
    select 1 from jsonb_array_elements(v_item.dependencies) d
    where exists (
      select 1 from mts_sam.reconciliation_plan_items declared
      where declared.reconciliation_batch_id=p_batch_id
        and declared.safe_identity_hash=d->>'safe_identity_hash'
    ) and not exists (
      select 1 from mts_sam.reconciliation_plan_items parent
      where parent.reconciliation_batch_id=p_batch_id
        and parent.safe_identity_hash=d->>'safe_identity_hash'
        and parent.result_status in ('inserted','updated','already_current','reused_lineage')
    )
  ) then raise exception 'dependency_not_satisfied'; end if;
  v_payload:=p_payload||jsonb_build_object('created_by_reconciliation_batch_id',p_batch_id);
  case v_item.entity_type
    when 'candidates' then
      perform mts_sam.assert_reconciliation_json_keys(p_payload,array['id','source_system','source_candidate_id','display_name','first_name','last_initial']);
      v_payload:=v_payload||jsonb_build_object('created_at',statement_timestamp(),'updated_at',statement_timestamp());
      select * into v_candidate from jsonb_populate_record(null::mts_sam.candidates,v_payload);
      if v_candidate.id<>v_item.canonical_entity_id then raise exception 'canonical_identity_mismatch'; end if;
      if exists(select 1 from mts_sam.candidates where id=v_candidate.id) then raise exception 'target_already_exists'; end if;
      insert into mts_sam.candidates select v_candidate.*;
    when 'candidate_sessions' then
      perform mts_sam.assert_reconciliation_json_keys(p_payload,array[
        'id','session_id','candidate_id','candidate_name','candidate_first_name','candidate_last_initial','tester_name','session_type',
        'attempt_number','current_attempt_number','allowed_attempt_count','extra_attempts_granted','final_attempt','raw_status',
        'calculated_result','final_result','readiness_override_applied','readiness_override_result','readiness_override_reason',
        'readiness_override_explanation','withdrawn','archived','needs_sup_transfer','pending_sup_transfer_id','mock_calls_completed',
        'sup_transfers_completed','call_results','supervisor_transfer_results','coaching_summary','fail_summary','review_notes',
        'evaluator_notes_summary','skills','final_notes','headset_brand','headset_model','headset_usb','noise_cancel','environment_checks',
        'form_fill_status','form_filled_at','newbie_shift_number','newbie_shift_data','deletion_request_data','created_at','completed_at',
        'withdrawn_at','retention_until','source_checksum','source_payload'
      ]);
      v_payload:=v_payload||jsonb_build_object('imported_at',statement_timestamp(),'updated_at',statement_timestamp());
      select * into v_session from jsonb_populate_record(null::mts_sam.candidate_sessions,v_payload);
      if v_session.id<>v_item.canonical_entity_id then raise exception 'canonical_identity_mismatch'; end if;
      if not exists(select 1 from mts_sam.candidates where id=v_session.candidate_id) then raise exception 'parent_candidate_missing'; end if;
      if exists(select 1 from mts_sam.candidate_sessions where id=v_session.id or session_id=v_session.session_id) then raise exception 'target_already_exists'; end if;
      insert into mts_sam.candidate_sessions select v_session.*;
    when 'session_attempts' then
      perform mts_sam.assert_reconciliation_json_keys(p_payload,array['id','session_id','attempt_number','attempt_type','result','occurred_at','source_action_id','details']);
      select * into v_attempt from jsonb_populate_record(null::mts_sam.session_attempts,v_payload);
      if v_attempt.id<>v_item.canonical_entity_id then raise exception 'canonical_identity_mismatch'; end if;
      if not exists(select 1 from mts_sam.candidate_sessions where id=v_attempt.session_id) then raise exception 'parent_session_missing'; end if;
      if exists(select 1 from mts_sam.session_attempts where id=v_attempt.id or source_action_id=v_attempt.source_action_id) then raise exception 'target_already_exists'; end if;
      insert into mts_sam.session_attempts select v_attempt.*;
    when 'headset_catalog' then
      perform mts_sam.assert_reconciliation_json_keys(p_payload,array['id','catalog_id','source_row_key','brand','model','status','note','legacy_source_value','archived_at','deleted_at','source_checksum','source_payload']);
      v_payload:=v_payload||jsonb_build_object('created_at',statement_timestamp(),'updated_at',statement_timestamp());
      select * into v_catalog from jsonb_populate_record(null::mts_sam.headset_catalog,v_payload);
      if v_catalog.id<>v_item.canonical_entity_id then raise exception 'canonical_identity_mismatch'; end if;
      if exists(select 1 from mts_sam.headset_catalog where id=v_catalog.id or (brand=v_catalog.brand and model=v_catalog.model)) then raise exception 'target_already_exists'; end if;
      insert into mts_sam.headset_catalog select v_catalog.*;
    when 'headset_reviews' then
      perform mts_sam.assert_reconciliation_json_keys(p_payload,array['id','review_id','source_session_id','session_id','catalog_id','candidate_name','tester_name','brand','model','status','note','denial_reason','decision_by','legacy_source_value','normalization_status','normalization_rule','created_at','updated_at','decision_at','source_checksum','source_payload']);
      select * into v_review from jsonb_populate_record(null::mts_sam.headset_reviews,v_payload);
      if v_review.id<>v_item.canonical_entity_id then raise exception 'canonical_identity_mismatch'; end if;
      if v_review.session_id is not null and not exists(select 1 from mts_sam.candidate_sessions where id=v_review.session_id) then raise exception 'parent_session_missing'; end if;
      if v_review.catalog_id is not null and not exists(select 1 from mts_sam.headset_catalog where id=v_review.catalog_id) then raise exception 'parent_catalog_missing'; end if;
      if exists(select 1 from mts_sam.headset_reviews where id=v_review.id or review_id=v_review.review_id) then raise exception 'target_already_exists'; end if;
      insert into mts_sam.headset_reviews select v_review.*;
    when 'supervisor_transfers' then
      perform mts_sam.assert_reconciliation_json_keys(p_payload,array['id','transfer_id','source_session_id','session_id','candidate_name','original_tester_name','status','final_attempt','completed_by','completed_status','needed_reason','notes','created_at','completed_at','source_checksum','source_payload']);
      select * into v_transfer from jsonb_populate_record(null::mts_sam.supervisor_transfers,v_payload);
      if v_transfer.id<>v_item.canonical_entity_id then raise exception 'canonical_identity_mismatch'; end if;
      if v_transfer.session_id is not null and not exists(select 1 from mts_sam.candidate_sessions where id=v_transfer.session_id) then raise exception 'parent_session_missing'; end if;
      if exists(select 1 from mts_sam.supervisor_transfers where id=v_transfer.id or transfer_id=v_transfer.transfer_id) then raise exception 'target_already_exists'; end if;
      insert into mts_sam.supervisor_transfers select v_transfer.*;
    when 'newbie_shift_requests' then
      perform mts_sam.assert_reconciliation_json_keys(p_payload,array['id','request_id','source_session_id','session_id','request_type','request_status','newbie_shift_number','scheduled_at','original_scheduled_at','rescheduled_at','timezone','within_24_hours','counts_as_attempt','final_attempt','current_attempt','resulting_attempt','becomes_final_attempt','attempt_rule','terminal_outcome','requested_by','request_reason','request_details','decision_by','denial_reason','created_at','decision_at','updated_at','source_checksum','source_payload']);
      select * into v_shift from jsonb_populate_record(null::mts_sam.newbie_shift_requests,v_payload);
      if v_shift.id<>v_item.canonical_entity_id then raise exception 'canonical_identity_mismatch'; end if;
      if v_shift.session_id is not null and not exists(select 1 from mts_sam.candidate_sessions where id=v_shift.session_id) then raise exception 'parent_session_missing'; end if;
      if exists(select 1 from mts_sam.newbie_shift_requests where id=v_shift.id or request_id=v_shift.request_id) then raise exception 'target_already_exists'; end if;
      insert into mts_sam.newbie_shift_requests select v_shift.*;
    when 'pending_requests' then
      perform mts_sam.assert_reconciliation_json_keys(p_payload,array['id','request_id','request_type','source_session_id','session_id','status','candidate_name','tester_name','request_reason','request_details','requested_by','decision_by','denial_reason','created_at','decision_at','updated_at','source_checksum','source_payload']);
      select * into v_request from jsonb_populate_record(null::mts_sam.pending_requests,v_payload);
      if v_request.id<>v_item.canonical_entity_id then raise exception 'canonical_identity_mismatch'; end if;
      if v_request.session_id is not null and not exists(select 1 from mts_sam.candidate_sessions where id=v_request.session_id) then raise exception 'parent_session_missing'; end if;
      if exists(select 1 from mts_sam.pending_requests where id=v_request.id or request_id=v_request.request_id) then raise exception 'target_already_exists'; end if;
      insert into mts_sam.pending_requests select v_request.*;
    else raise exception 'entity_type_not_supported' using errcode='22023';
  end case;
  case v_item.entity_type
    when 'candidates' then select to_jsonb(t) into v_actual from mts_sam.candidates t where id=v_item.canonical_entity_id;
    when 'candidate_sessions' then select to_jsonb(t) into v_actual from mts_sam.candidate_sessions t where id=v_item.canonical_entity_id;
    when 'session_attempts' then select to_jsonb(t) into v_actual from mts_sam.session_attempts t where id=v_item.canonical_entity_id;
    when 'headset_catalog' then select to_jsonb(t) into v_actual from mts_sam.headset_catalog t where id=v_item.canonical_entity_id;
    when 'headset_reviews' then select to_jsonb(t) into v_actual from mts_sam.headset_reviews t where id=v_item.canonical_entity_id;
    when 'supervisor_transfers' then select to_jsonb(t) into v_actual from mts_sam.supervisor_transfers t where id=v_item.canonical_entity_id;
    when 'newbie_shift_requests' then select to_jsonb(t) into v_actual from mts_sam.newbie_shift_requests t where id=v_item.canonical_entity_id;
    when 'pending_requests' then select to_jsonb(t) into v_actual from mts_sam.pending_requests t where id=v_item.canonical_entity_id;
  end case;
  if not (v_actual @> coalesce(p_expected_values,'{}'::jsonb)) then raise exception 'post_write_value_mismatch'; end if;
  select mts_sam.insert_lineage_if_absent(
    p_lineage->>'entity_type',v_item.canonical_entity_id,p_lineage->>'source_system',
    p_lineage->>'source_tab',p_lineage->>'source_row_key',p_lineage->>'source_checksum',
    null,coalesce(p_lineage->'metadata','{}'::jsonb),p_batch_id,p_plan_item_id
  ) into v_lineage;
  if v_lineage->>'result' not in ('inserted','already_exists_same_mapping') then raise exception 'lineage_conflict'; end if;
  v_checksum:=mts_sam.reconciliation_entity_checksum(v_item.entity_type,v_item.canonical_entity_id);
  update mts_sam.reconciliation_plan_items set
    created_by_batch=true,result_status='inserted',result_code=v_lineage->>'result',
    post_sync_checksum=v_checksum,started_at=coalesce(started_at,statement_timestamp()),completed_at=statement_timestamp()
  where id=p_plan_item_id;
  return jsonb_build_object('result','inserted','entity_id',v_item.canonical_entity_id,
    'lineage_result',v_lineage->>'result','post_checksum',v_checksum);
end;
$$;

create function mts_sam.execute_reconciliation_candidate_session_update(
  p_batch_id uuid, p_plan_item_id uuid, p_precondition jsonb,
  p_changes jsonb, p_expected_values jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_batch mts_sam.reconciliation_batches%rowtype;
  v_item mts_sam.reconciliation_plan_items%rowtype;
  v_before mts_sam.candidate_sessions%rowtype;
  v_after mts_sam.candidate_sessions%rowtype;
  v_before_values jsonb; v_original text; v_post text;
  v_allowed constant text[]:=array['raw_status','calculated_result','final_result','archived','withdrawn','final_attempt','current_attempt_number','allowed_attempt_count','needs_sup_transfer','pending_sup_transfer_id','newbie_shift_number'];
begin
  select * into v_batch from mts_sam.reconciliation_batches where id=p_batch_id for update;
  select * into v_item from mts_sam.reconciliation_plan_items
    where id=p_plan_item_id and reconciliation_batch_id=p_batch_id for update;
  if v_batch.status<>'running' or v_item.operation<>'update' or v_item.entity_type<>'candidate_sessions' then
    raise exception 'update_item_not_runnable';
  end if;
  if v_item.result_status='updated' then
    return jsonb_build_object('result','already_committed','entity_id',v_item.canonical_entity_id,'post_checksum',v_item.post_sync_checksum);
  end if;
  perform mts_sam.assert_reconciliation_json_keys(p_changes,v_allowed);
  if (select array_agg(k order by k) from jsonb_object_keys(p_changes) k)
     is distinct from (select array_agg(k order by k) from unnest(v_item.changed_fields) k)
  then raise exception 'changed_fields_do_not_match_plan'; end if;
  select * into v_before from mts_sam.candidate_sessions where id=v_item.canonical_entity_id for update;
  if not found then raise exception 'update_target_missing'; end if;
  if not (to_jsonb(v_before) @> coalesce(p_precondition,'{}'::jsonb)) then raise exception 'target_precondition_mismatch'; end if;
  v_original:=mts_sam.reconciliation_entity_checksum('candidate_sessions',v_item.canonical_entity_id);
  v_before_values:=(select coalesce(jsonb_object_agg(key,to_jsonb(v_before)->key),'{}'::jsonb)
    from unnest(v_item.changed_fields) key);
  insert into mts_sam.reconciliation_before_images(
    reconciliation_batch_id,plan_item_id,entity_type,canonical_entity_id,safe_identity_hash,
    changed_fields,before_values,original_checksum,proposed_checksum,plan_checksum
  ) values (
    p_batch_id,p_plan_item_id,'candidate_sessions',v_item.canonical_entity_id,v_item.safe_identity_hash,
    v_item.changed_fields,v_before_values,v_original,v_item.proposed_target_checksum,v_batch.plan_checksum
  );
  select * into v_after from jsonb_populate_record(v_before,p_changes);
  update mts_sam.candidate_sessions set
    raw_status=v_after.raw_status,calculated_result=v_after.calculated_result,final_result=v_after.final_result,
    archived=v_after.archived,withdrawn=v_after.withdrawn,final_attempt=v_after.final_attempt,
    current_attempt_number=v_after.current_attempt_number,allowed_attempt_count=v_after.allowed_attempt_count,
    needs_sup_transfer=v_after.needs_sup_transfer,pending_sup_transfer_id=v_after.pending_sup_transfer_id,
    newbie_shift_number=v_after.newbie_shift_number
  where id=v_item.canonical_entity_id returning * into v_after;
  if not (to_jsonb(v_after) @> coalesce(p_expected_values,'{}'::jsonb)) then raise exception 'post_write_value_mismatch'; end if;
  v_post:=mts_sam.reconciliation_entity_checksum('candidate_sessions',v_item.canonical_entity_id);
  update mts_sam.reconciliation_plan_items set result_status='updated',result_code='exact_update',
    post_sync_checksum=v_post,started_at=coalesce(started_at,statement_timestamp()),completed_at=statement_timestamp()
  where id=p_plan_item_id;
  return jsonb_build_object('result','updated','entity_id',v_item.canonical_entity_id,
    'before_image',true,'post_checksum',v_post);
end;
$$;

create function mts_sam.fail_reconciliation_batch(p_batch_id uuid, p_plan_item_id uuid, p_error_code text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_committed integer; v_status text;
begin
  select count(*) into v_committed from mts_sam.reconciliation_plan_items
    where reconciliation_batch_id=p_batch_id and result_status in ('inserted','updated');
  if p_plan_item_id is not null then
    update mts_sam.reconciliation_plan_items set result_status='failed',result_code=left(coalesce(p_error_code,'execution_failed'),120),
      completed_at=statement_timestamp()
    where id=p_plan_item_id and reconciliation_batch_id=p_batch_id and result_status='planned';
  end if;
  update mts_sam.reconciliation_plan_items set result_status='blocked_by_dependency',result_code='batch_aborted',
    completed_at=statement_timestamp()
    where reconciliation_batch_id=p_batch_id and result_status='planned';
  v_status:=case when v_committed>0 then 'partially_failed' else 'failed' end;
  update mts_sam.reconciliation_batches set status=v_status,completed_at=statement_timestamp(),
    rollback_eligible=(v_committed>0),rollback_status=case when v_committed>0 then 'pending' else null end
    where id=p_batch_id and status='running';
  return jsonb_build_object('result',v_status,'committed_items',v_committed);
end;
$$;

create function mts_sam.finalize_reconciliation_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_batch mts_sam.reconciliation_batches%rowtype; v_inserted int; v_updated int; v_before int; v_bad int;
  v_lineage int; v_actual_counts jsonb; v_key text;
begin
  select * into v_batch from mts_sam.reconciliation_batches where id=p_batch_id for update;
  if v_batch.status='succeeded' then
    return jsonb_build_object('result','already_committed','batch_id',p_batch_id);
  end if;
  if v_batch.status<>'running' then raise exception 'batch_not_running'; end if;
  select count(*) filter(where result_status='inserted'),count(*) filter(where result_status='updated'),
    count(*) filter(where result_status not in ('inserted','updated'))
    into v_inserted,v_updated,v_bad from mts_sam.reconciliation_plan_items where reconciliation_batch_id=p_batch_id;
  select count(*) into v_before from mts_sam.reconciliation_before_images where reconciliation_batch_id=p_batch_id;
  select count(*) into v_lineage from mts_sam.data_source_lineage where reconciliation_batch_id=p_batch_id;
  v_actual_counts:=jsonb_build_object(
    'candidates',(select count(*) from mts_sam.candidates),
    'candidate_sessions',(select count(*) from mts_sam.candidate_sessions),
    'session_attempts',(select count(*) from mts_sam.session_attempts),
    'headset_catalog',(select count(*) from mts_sam.headset_catalog),
    'headset_reviews',(select count(*) from mts_sam.headset_reviews),
    'supervisor_transfers',(select count(*) from mts_sam.supervisor_transfers),
    'newbie_shift_requests',(select count(*) from mts_sam.newbie_shift_requests),
    'pending_requests',(select count(*) from mts_sam.pending_requests)
  );
  for v_key in select jsonb_object_keys(v_batch.expected_ending_counts) loop
    if (v_actual_counts->>v_key)::integer<>(v_batch.expected_ending_counts->>v_key)::integer then
      raise exception 'ending_count_mismatch:%',v_key;
    end if;
  end loop;
  if v_bad<>0 or v_inserted<>v_batch.inserts_planned or v_updated<>v_batch.updates_planned
     or v_before<>v_updated or v_lineage<>v_batch.planned_lineage_count then
    raise exception 'batch_verification_failed';
  end if;
  update mts_sam.reconciliation_batches set status='succeeded',completed_at=statement_timestamp(),
    before_image_count=v_before,created_entity_count=v_inserted,rollback_eligible=true,
    lineage_outcomes=jsonb_build_object(
      'inserted',(select count(*) from mts_sam.reconciliation_plan_items where reconciliation_batch_id=p_batch_id and result_code='inserted'),
      'already_exists_same_mapping',(select count(*) from mts_sam.reconciliation_plan_items where reconciliation_batch_id=p_batch_id and result_code='already_exists_same_mapping'),
      'source_conflicts',0,'entity_conflicts',0,'unresolved',0
    ),
    verification_result=jsonb_build_object('verified',true,'inserted',v_inserted,'updated',v_updated,
      'before_images',v_before,'lineage',v_lineage,'ending_counts',v_actual_counts)
    where id=p_batch_id;
  return jsonb_build_object('result','succeeded','batch_id',p_batch_id,'inserted',v_inserted,'updated',v_updated);
end;
$$;

create function mts_sam.reconciliation_entity_owned_by_batch(p_entity_type text,p_entity_id uuid,p_batch_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare v_owned boolean;
begin
  case p_entity_type
    when 'candidates' then select created_by_reconciliation_batch_id=p_batch_id into v_owned from mts_sam.candidates where id=p_entity_id;
    when 'candidate_sessions' then select created_by_reconciliation_batch_id=p_batch_id into v_owned from mts_sam.candidate_sessions where id=p_entity_id;
    when 'session_attempts' then select created_by_reconciliation_batch_id=p_batch_id into v_owned from mts_sam.session_attempts where id=p_entity_id;
    when 'headset_catalog' then select created_by_reconciliation_batch_id=p_batch_id into v_owned from mts_sam.headset_catalog where id=p_entity_id;
    when 'headset_reviews' then select created_by_reconciliation_batch_id=p_batch_id into v_owned from mts_sam.headset_reviews where id=p_entity_id;
    when 'supervisor_transfers' then select created_by_reconciliation_batch_id=p_batch_id into v_owned from mts_sam.supervisor_transfers where id=p_entity_id;
    when 'newbie_shift_requests' then select created_by_reconciliation_batch_id=p_batch_id into v_owned from mts_sam.newbie_shift_requests where id=p_entity_id;
    when 'pending_requests' then select created_by_reconciliation_batch_id=p_batch_id into v_owned from mts_sam.pending_requests where id=p_entity_id;
    else return false;
  end case;
  return coalesce(v_owned,false);
end;
$$;

create function mts_sam.reconciliation_external_dependency_count(p_entity_type text,p_entity_id uuid,p_batch_id uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare v_count integer:=0;
begin
  case p_entity_type
    when 'candidates' then
      select (select count(*) from mts_sam.candidate_sessions where candidate_id=p_entity_id and created_by_reconciliation_batch_id is distinct from p_batch_id)
        +(select count(*) from mts_sam.candidate_corrections where candidate_id=p_entity_id)
        into v_count;
    when 'candidate_sessions' then
      select (select count(*) from mts_sam.session_attempts where session_id=p_entity_id and created_by_reconciliation_batch_id is distinct from p_batch_id)
        +(select count(*) from mts_sam.candidate_status_actions where session_id=p_entity_id)
        +(select count(*) from mts_sam.candidate_corrections where session_id=p_entity_id)
        +(select count(*) from mts_sam.extra_attempt_grants where session_id=p_entity_id)
        +(select count(*) from mts_sam.headset_reviews where session_id=p_entity_id and created_by_reconciliation_batch_id is distinct from p_batch_id)
        +(select count(*) from mts_sam.supervisor_transfers where session_id=p_entity_id and created_by_reconciliation_batch_id is distinct from p_batch_id)
        +(select count(*) from mts_sam.newbie_shift_requests where session_id=p_entity_id and created_by_reconciliation_batch_id is distinct from p_batch_id)
        +(select count(*) from mts_sam.pending_requests where session_id=p_entity_id and created_by_reconciliation_batch_id is distinct from p_batch_id)
        into v_count;
    when 'headset_catalog' then select count(*) into v_count from mts_sam.headset_reviews where catalog_id=p_entity_id and created_by_reconciliation_batch_id is distinct from p_batch_id;
    when 'headset_reviews' then select count(*) into v_count from mts_sam.headset_review_actions where review_id=p_entity_id;
    when 'newbie_shift_requests' then select count(*) into v_count from mts_sam.newbie_shift_reschedules where request_id=p_entity_id;
    else v_count:=0;
  end case;
  return v_count;
end;
$$;

create function mts_sam.preview_reconciliation_rollback(p_batch_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_batch mts_sam.reconciliation_batches%rowtype; v_item record; v_blockers jsonb:='[]'::jsonb;
  v_created jsonb; v_updates integer; v_later integer; v_expected jsonb;
begin
  select * into v_batch from mts_sam.reconciliation_batches where id=p_batch_id;
  if not found then return jsonb_build_object('eligible',false,'blockers',jsonb_build_array('batch_not_found')); end if;
  if v_batch.status not in ('succeeded','partially_failed','failed') or not v_batch.rollback_eligible then
    v_blockers:=v_blockers||jsonb_build_array('batch_not_rollback_eligible');
  end if;
  select count(*) into v_later from mts_sam.reconciliation_batches
    where created_at>v_batch.created_at and id<>p_batch_id and status in ('running','succeeded','partially_failed','rollback_pending');
  if v_later>0 then v_blockers:=v_blockers||jsonb_build_array('later_batch_dependency_exists'); end if;
  for v_item in select * from mts_sam.reconciliation_plan_items
    where reconciliation_batch_id=p_batch_id and result_status in ('inserted','updated') loop
    if mts_sam.reconciliation_entity_checksum(v_item.entity_type,v_item.canonical_entity_id) is distinct from v_item.post_sync_checksum then
      v_blockers:=v_blockers||jsonb_build_array('post_sync_checksum_changed:'||v_item.safe_identity_hash);
    end if;
    if v_item.result_status='inserted' and not mts_sam.reconciliation_entity_owned_by_batch(v_item.entity_type,v_item.canonical_entity_id,p_batch_id) then
      v_blockers:=v_blockers||jsonb_build_array('created_by_batch_incomplete:'||v_item.safe_identity_hash);
    end if;
    if v_item.result_status='inserted' and mts_sam.reconciliation_external_dependency_count(v_item.entity_type,v_item.canonical_entity_id,p_batch_id)>0 then
      v_blockers:=v_blockers||jsonb_build_array('external_dependency_exists:'||v_item.safe_identity_hash);
    end if;
    if v_item.result_status='updated' and not exists(select 1 from mts_sam.reconciliation_before_images where plan_item_id=v_item.id) then
      v_blockers:=v_blockers||jsonb_build_array('before_image_missing:'||v_item.safe_identity_hash);
    end if;
  end loop;
  select coalesce(jsonb_object_agg(entity_type,total),'{}'::jsonb) into v_created from (
    select entity_type,count(*) total from mts_sam.reconciliation_plan_items
    where reconciliation_batch_id=p_batch_id and result_status='inserted' group by entity_type
  ) s;
  select count(*) into v_updates from mts_sam.reconciliation_plan_items where reconciliation_batch_id=p_batch_id and result_status='updated';
  v_expected:=jsonb_build_object(
    'candidates',(select count(*) from mts_sam.candidates)-(select count(*) from mts_sam.candidates where created_by_reconciliation_batch_id=p_batch_id),
    'candidate_sessions',(select count(*) from mts_sam.candidate_sessions)-(select count(*) from mts_sam.candidate_sessions where created_by_reconciliation_batch_id=p_batch_id),
    'session_attempts',(select count(*) from mts_sam.session_attempts)-(select count(*) from mts_sam.session_attempts where created_by_reconciliation_batch_id=p_batch_id),
    'headset_catalog',(select count(*) from mts_sam.headset_catalog)-(select count(*) from mts_sam.headset_catalog where created_by_reconciliation_batch_id=p_batch_id),
    'headset_reviews',(select count(*) from mts_sam.headset_reviews)-(select count(*) from mts_sam.headset_reviews where created_by_reconciliation_batch_id=p_batch_id),
    'supervisor_transfers',(select count(*) from mts_sam.supervisor_transfers)-(select count(*) from mts_sam.supervisor_transfers where created_by_reconciliation_batch_id=p_batch_id),
    'newbie_shift_requests',(select count(*) from mts_sam.newbie_shift_requests)-(select count(*) from mts_sam.newbie_shift_requests where created_by_reconciliation_batch_id=p_batch_id),
    'pending_requests',(select count(*) from mts_sam.pending_requests)-(select count(*) from mts_sam.pending_requests where created_by_reconciliation_batch_id=p_batch_id)
  );
  return jsonb_build_object('batch_id',p_batch_id,'batch_status',v_batch.status,'eligible',jsonb_array_length(v_blockers)=0,
    'created_entities',v_created,'updates_with_before_images',v_updates,'later_batches',v_later,
    'delete_order',jsonb_build_array('pending_requests','newbie_shift_requests','supervisor_transfers','headset_reviews','session_attempts','candidate_sessions','headset_catalog','candidates'),
    'blockers',v_blockers,'expected_post_rollback_counts',v_expected);
end;
$$;

create function mts_sam.rollback_reconciliation_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_preview jsonb; v_image record; v_item record; v_session mts_sam.candidate_sessions%rowtype;
  v_count integer; v_actual_counts jsonb; v_key text;
begin
  perform pg_advisory_xact_lock(hashtextextended('mts_sam:reconciliation:xyfhikikddcqcmzbdvbj',0));
  if exists(select 1 from mts_sam.reconciliation_batches where id=p_batch_id and status='rolled_back') then
    return jsonb_build_object('result','already_rolled_back','batch_id',p_batch_id,'audit_preserved',true);
  end if;
  v_preview:=mts_sam.preview_reconciliation_rollback(p_batch_id);
  if not coalesce((v_preview->>'eligible')::boolean,false) then return v_preview||jsonb_build_object('result','blocked'); end if;
  update mts_sam.reconciliation_batches set status='rollback_pending',rollback_status='running' where id=p_batch_id;
  begin
    for v_image in select * from mts_sam.reconciliation_before_images where reconciliation_batch_id=p_batch_id loop
      if v_image.entity_type<>'candidate_sessions' then raise exception 'rollback_update_type_not_supported'; end if;
      select * into v_session from mts_sam.candidate_sessions where id=v_image.canonical_entity_id for update;
      select * into v_session from jsonb_populate_record(v_session,v_image.before_values);
      update mts_sam.candidate_sessions set
        raw_status=v_session.raw_status,calculated_result=v_session.calculated_result,final_result=v_session.final_result,
        archived=v_session.archived,withdrawn=v_session.withdrawn,final_attempt=v_session.final_attempt,
        current_attempt_number=v_session.current_attempt_number,allowed_attempt_count=v_session.allowed_attempt_count,
        needs_sup_transfer=v_session.needs_sup_transfer,pending_sup_transfer_id=v_session.pending_sup_transfer_id,
        newbie_shift_number=v_session.newbie_shift_number
      where id=v_image.canonical_entity_id;
      if mts_sam.reconciliation_entity_checksum('candidate_sessions',v_image.canonical_entity_id)<>v_image.original_checksum then
        raise exception 'rollback_restore_checksum_mismatch';
      end if;
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
       or exists(select 1 from mts_sam.pending_requests where created_by_reconciliation_batch_id=p_batch_id)
    then raise exception 'rollback_batch_artifacts_remain'; end if;
    v_actual_counts:=jsonb_build_object(
      'candidates',(select count(*) from mts_sam.candidates),
      'candidate_sessions',(select count(*) from mts_sam.candidate_sessions),
      'session_attempts',(select count(*) from mts_sam.session_attempts),
      'headset_catalog',(select count(*) from mts_sam.headset_catalog),
      'headset_reviews',(select count(*) from mts_sam.headset_reviews),
      'supervisor_transfers',(select count(*) from mts_sam.supervisor_transfers),
      'newbie_shift_requests',(select count(*) from mts_sam.newbie_shift_requests),
      'pending_requests',(select count(*) from mts_sam.pending_requests)
    );
    for v_key in select jsonb_object_keys(v_preview->'expected_post_rollback_counts') loop
      if (v_actual_counts->>v_key)::integer<>(v_preview->'expected_post_rollback_counts'->>v_key)::integer then
        raise exception 'rollback_ending_count_mismatch:%',v_key;
      end if;
    end loop;
    for v_item in select * from mts_sam.reconciliation_plan_items
      where reconciliation_batch_id=p_batch_id and result_status in ('inserted','updated') loop
      update mts_sam.reconciliation_plan_items set result_status='rolled_back',result_code='exact_batch_rollback',
        completed_at=statement_timestamp() where id=v_item.id;
    end loop;
    update mts_sam.reconciliation_batches set status='rolled_back',rollback_status='succeeded',
      completed_at=statement_timestamp(),rollback_eligible=false where id=p_batch_id;
    return jsonb_build_object('result','rolled_back','batch_id',p_batch_id,'audit_preserved',true,
      'ending_counts',v_actual_counts);
  exception when others then
    update mts_sam.reconciliation_batches set status='rollback_failed',rollback_status='failed',
      completed_at=statement_timestamp(),verification_result=jsonb_build_object('rollback_error_code',sqlstate)
      where id=p_batch_id;
    return jsonb_build_object('result','rollback_failed','batch_id',p_batch_id,'error_code',sqlstate);
  end;
end;
$$;

revoke all on function mts_sam.insert_lineage_if_absent(text,uuid,text,text,text,text,uuid,jsonb,uuid,uuid) from public,anon,authenticated;
revoke all on function mts_sam.assert_reconciliation_json_keys(jsonb,text[]) from public,anon,authenticated;
revoke all on function mts_sam.reconciliation_entity_checksum(text,uuid) from public,anon,authenticated;
revoke all on function mts_sam.begin_reconciliation_execution(text,timestamptz,text,text,timestamptz,jsonb,integer,integer,integer,integer,jsonb,jsonb,jsonb) from public,anon,authenticated;
revoke all on function mts_sam.execute_reconciliation_insert(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
revoke all on function mts_sam.execute_reconciliation_candidate_session_update(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
revoke all on function mts_sam.fail_reconciliation_batch(uuid,uuid,text) from public,anon,authenticated;
revoke all on function mts_sam.finalize_reconciliation_batch(uuid) from public,anon,authenticated;
revoke all on function mts_sam.reconciliation_entity_owned_by_batch(text,uuid,uuid) from public,anon,authenticated;
revoke all on function mts_sam.reconciliation_external_dependency_count(text,uuid,uuid) from public,anon,authenticated;
revoke all on function mts_sam.preview_reconciliation_rollback(uuid) from public,anon,authenticated;
revoke all on function mts_sam.rollback_reconciliation_batch(uuid) from public,anon,authenticated;

grant execute on function mts_sam.insert_lineage_if_absent(text,uuid,text,text,text,text,uuid,jsonb,uuid,uuid) to service_role;
grant execute on function mts_sam.assert_reconciliation_json_keys(jsonb,text[]) to service_role;
grant execute on function mts_sam.reconciliation_entity_checksum(text,uuid) to service_role;
grant execute on function mts_sam.reconciliation_entity_owned_by_batch(text,uuid,uuid) to service_role;
grant execute on function mts_sam.reconciliation_external_dependency_count(text,uuid,uuid) to service_role;
grant select, insert, update on mts_sam.reconciliation_batches to service_role;
grant select, insert, update on mts_sam.reconciliation_plan_items to service_role;
grant select, insert on mts_sam.reconciliation_before_images to service_role;
grant execute on function mts_sam.begin_reconciliation_execution(text,timestamptz,text,text,timestamptz,jsonb,integer,integer,integer,integer,jsonb,jsonb,jsonb) to service_role;
grant execute on function mts_sam.execute_reconciliation_insert(uuid,uuid,jsonb,jsonb,jsonb) to service_role;
grant execute on function mts_sam.execute_reconciliation_candidate_session_update(uuid,uuid,jsonb,jsonb,jsonb) to service_role;
grant execute on function mts_sam.fail_reconciliation_batch(uuid,uuid,text) to service_role;
grant execute on function mts_sam.finalize_reconciliation_batch(uuid) to service_role;
grant execute on function mts_sam.preview_reconciliation_rollback(uuid) to service_role;
grant execute on function mts_sam.rollback_reconciliation_batch(uuid) to service_role;

comment on function mts_sam.execute_reconciliation_insert(uuid,uuid,jsonb,jsonb,jsonb) is
  'Atomic fixed-handler canonical insert, lineage RPC, post-verification, and plan accounting.';
comment on function mts_sam.rollback_reconciliation_batch(uuid) is
  'Exact batch-scoped rollback preserving reconciliation audit evidence.';
