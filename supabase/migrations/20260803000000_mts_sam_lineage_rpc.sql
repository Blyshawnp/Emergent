-- Migration: 20260803000000_mts_sam_lineage_rpc
-- Purpose: Add transactional RPC for safe, race-free lineage insertion.
-- This replaces client-side ON CONFLICT DO UPDATE with atomic insert-or-skip.
-- Forward-only. Does not modify or reapply previous migrations.

set search_path = '';

create or replace function mts_sam.insert_lineage_if_absent(
  p_entity_type    text,
  p_entity_id      uuid,
  p_source_system  text,
  p_source_tab     text,
  p_source_row_key text,
  p_source_checksum text,
  p_import_batch_id uuid,
  p_metadata       jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_by_source mts_sam.data_source_lineage%rowtype;
  v_existing_by_entity mts_sam.data_source_lineage%rowtype;
  v_inserted           boolean := false;
begin
  -- Check for existing row by source key (unique constraint 1)
  select * into v_existing_by_source
  from mts_sam.data_source_lineage
  where source_system  = p_source_system
    and source_tab     = p_source_tab
    and source_row_key = p_source_row_key
  limit 1;

  if found then
    if v_existing_by_source.entity_id = p_entity_id then
      return jsonb_build_object(
        'result', 'already_exists_same_mapping',
        'entity_id', v_existing_by_source.entity_id
      );
    else
      return jsonb_build_object(
        'result', 'conflict_source_maps_to_different_entity',
        'existing_entity_id', v_existing_by_source.entity_id,
        'requested_entity_id', p_entity_id
      );
    end if;
  end if;

  -- Check for existing row by entity identity (unique constraint 2)
  select * into v_existing_by_entity
  from mts_sam.data_source_lineage
  where entity_type   = p_entity_type
    and entity_id     = p_entity_id
    and source_system = p_source_system
    and source_tab    = p_source_tab
  limit 1;

  if found then
    if v_existing_by_entity.source_row_key = p_source_row_key then
      return jsonb_build_object(
        'result', 'already_exists_same_mapping',
        'entity_id', p_entity_id
      );
    else
      return jsonb_build_object(
        'result', 'conflict_entity_maps_to_different_source',
        'existing_source_row_key', v_existing_by_entity.source_row_key,
        'requested_source_row_key', p_source_row_key
      );
    end if;
  end if;

  -- Both checks passed — atomically insert with DO NOTHING to guard against race
  insert into mts_sam.data_source_lineage (
    entity_type, entity_id,
    source_system, source_tab, source_row_key,
    source_checksum, import_batch_id, metadata
  ) values (
    p_entity_type, p_entity_id,
    p_source_system, p_source_tab, p_source_row_key,
    p_source_checksum, p_import_batch_id, p_metadata
  )
  on conflict (source_system, source_tab, source_row_key)
    do nothing
  returning true into v_inserted;

  if not v_inserted then
    -- Race: another concurrent writer inserted before us
    return jsonb_build_object(
      'result', 'conflict_race_skipped',
      'entity_id', p_entity_id
    );
  end if;

  return jsonb_build_object(
    'result', 'inserted',
    'entity_id', p_entity_id
  );
end;
$$;

-- Revoke from public and anon; grant only to service_role
revoke all on function mts_sam.insert_lineage_if_absent(
  text, uuid, text, text, text, text, uuid, jsonb
) from public;

grant execute on function mts_sam.insert_lineage_if_absent(
  text, uuid, text, text, text, text, uuid, jsonb
) to service_role;
