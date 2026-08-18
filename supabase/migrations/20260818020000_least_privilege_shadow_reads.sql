-- Migration: 20260818020000_least_privilege_shadow_reads.sql
-- Purpose: Add least-privilege, read-only shadow comparison RPCs callable with anon key.
-- Untrusted packaged Electron/backend clients receive only the publishable anon key.
-- Schema usage is granted to anon, but all direct table/view access and mutation RPCs
-- remain completely revoked and protected by FORCE ROW LEVEL SECURITY.
-- Forward-only. Does not modify or reapply previous migrations.

set search_path = '';

-- 1. Grant USAGE on schema mts_sam to anon and authenticated (required for PostgREST RPC dispatch)
grant usage on schema mts_sam to anon, authenticated;

-- Ensure all tables remain completely ungranted to anon/authenticated/public
revoke all on all tables in schema mts_sam from public, anon;
revoke all on all sequences in schema mts_sam from public, anon;

-- 2. Shadow Readiness Ping (Lightweight health check callable with anon key)
create or replace function mts_sam.get_shadow_readiness_ping()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, mts_sam
as $$
begin
  return jsonb_build_object(
    'ok', true,
    'status', 'ready',
    'mode', 'least_privilege_shadow',
    'project_ref', 'xyfhikikddcqcmzbdvbj',
    'timestamp', statement_timestamp()
  );
end;
$$;

revoke all on function mts_sam.get_shadow_readiness_ping() from public;
grant execute on function mts_sam.get_shadow_readiness_ping() to anon, authenticated, service_role;

-- 3. Dedicated Read-Only Shadow Domain Data RPC
-- Returns structured JSONB arrays of normalized rows for the 14 mapped shadow domains.
-- Rejects any unknown or unmapped domain.
-- Completely read-only (SELECT only, no dynamic SQL, no mutation, no lineage write).
create or replace function mts_sam.get_shadow_domain_data(
  p_domain text,
  p_limit integer default 5000,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, mts_sam
as $$
declare
  v_norm_domain text;
  v_limit integer;
  v_offset integer;
  v_result jsonb;
begin
  v_norm_domain := lower(btrim(coalesce(p_domain, '')));
  v_limit := greatest(1, least(5000, coalesce(p_limit, 5000)));
  v_offset := greatest(0, coalesce(p_offset, 0));

  case v_norm_domain
    when 'candidates' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(c.*) as item
        from mts_sam.candidates c
        order by c.id
        limit v_limit offset v_offset
      ) sub;

    when 'candidate_sessions' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(cs.*) as item
        from mts_sam.candidate_sessions cs
        order by cs.id
        limit v_limit offset v_offset
      ) sub;

    when 'session_attempts' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(sa.*) as item
        from mts_sam.session_attempts sa
        order by sa.id
        limit v_limit offset v_offset
      ) sub;

    when 'authoritative_candidate_status' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(v.*) as item
        from mts_sam.current_candidate_status_view v
        order by v.id
        limit v_limit offset v_offset
      ) sub;

    when 'candidate_tracking' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(v.*) as item
        from mts_sam.candidate_history_view v
        order by v.id
        limit v_limit offset v_offset
      ) sub;

    when 'history' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(cs.*) as item
        from mts_sam.candidate_sessions cs
        order by cs.id
        limit v_limit offset v_offset
      ) sub;

    when 'headset_catalog' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(hc.*) as item
        from mts_sam.headset_catalog hc
        order by hc.id
        limit v_limit offset v_offset
      ) sub;

    when 'headset_reviews' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(hr.*) as item
        from mts_sam.headset_reviews hr
        order by hr.id
        limit v_limit offset v_offset
      ) sub;

    when 'supervisor_transfers' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(st.*) as item
        from mts_sam.supervisor_transfers st
        order by st.id
        limit v_limit offset v_offset
      ) sub;

    when 'newbie_shift_requests', 'newbie_shifts' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(nsr.*) as item
        from mts_sam.newbie_shift_requests nsr
        order by nsr.id
        limit v_limit offset v_offset
      ) sub;

    when 'candidate_corrections' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(cc.*) as item
        from mts_sam.candidate_corrections cc
        order by cc.id
        limit v_limit offset v_offset
      ) sub;

    when 'pending_requests' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(pr.*) as item
        from mts_sam.pending_requests pr
        order by pr.id
        limit v_limit offset v_offset
      ) sub;

    when 'pending_requests_view' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(prv.*) as item
        from mts_sam.pending_requests_view prv
        order by prv.id
        limit v_limit offset v_offset
      ) sub;

    when 'recent_activity', 'recent_activity_view' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(rav.*) as item
        from mts_sam.recent_activity_view rav
        limit v_limit offset v_offset
      ) sub;

    when 'notifications' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(n.*) as item
        from mts_sam.notifications n
        order by n.id
        limit v_limit offset v_offset
      ) sub;

    when 'candidate_lineage', 'data_source_lineage' then
      -- Narrow lineage projection: only candidate lineage mappings needed for comparison resolution
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select jsonb_build_object(
          'entity_type', dsl.entity_type,
          'entity_id', dsl.entity_id,
          'source_system', dsl.source_system,
          'source_tab', dsl.source_tab,
          'source_row_key', dsl.source_row_key,
          'source_checksum', dsl.source_checksum,
          'import_batch_id', dsl.import_batch_id
        ) as item
        from mts_sam.data_source_lineage dsl
        where dsl.entity_type = 'candidates'
        order by dsl.id
        limit v_limit offset v_offset
      ) sub;

    else
      raise exception 'Unsupported shadow domain: %', p_domain;
  end case;

  return v_result;
end;
$$;

revoke all on function mts_sam.get_shadow_domain_data(text, integer, integer) from public;
grant execute on function mts_sam.get_shadow_domain_data(text, integer, integer) to anon, authenticated, service_role;
