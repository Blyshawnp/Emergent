-- Migration: 20260818030000_mts_sam_configuration_domains.sql
-- Purpose: Add canonical relational configuration tables and extend least-privilege
-- read-only shadow RPC for the 9 Sheets configuration domains (66 rows total):
-- callers (22), call-types (5), call-fail-reasons (8), sup-coaching (8),
-- sup-fail-reasons (6), sup-reasons (7), shows (8), gemini-coaching-prompt (1),
-- gemini-fail-prompt (1).
-- Forward-only. Does not modify or reapply previous migrations.

set search_path = '';

-- 1. Caller Roster (from 'callers' tab - 22 rows)
create table if not exists mts_sam.caller_roster (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  first_name text not null,
  last_name text not null,
  address text not null default '',
  city text not null default '',
  state text not null default '',
  zip text not null default '',
  phone text not null default '',
  email text not null default '',
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint uq_caller_roster_identity unique (category, first_name, last_name, phone)
);

-- 2. Call Type Configuration (from 'call-types' tab - 5 rows)
create table if not exists mts_sam.call_type_config (
  id uuid primary key default gen_random_uuid(),
  call_type text not null,
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint uq_call_type_config unique (call_type)
);

-- 3. Call Fail Reason Configuration (from 'call-fail-reasons' tab - 8 rows)
create table if not exists mts_sam.call_fail_reason_config (
  id uuid primary key default gen_random_uuid(),
  fail_reason text not null,
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint uq_call_fail_reason_config unique (fail_reason)
);

-- 4. Supervisor Coaching Configuration (from 'sup-coaching' tab - 8 rows)
create table if not exists mts_sam.supervisor_coaching_config (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  helper_text text not null default '',
  children_pipe_delimited text not null default '',
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint uq_supervisor_coaching_config unique (label)
);

-- 5. Supervisor Fail Reason Configuration (from 'sup-fail-reasons' tab - 6 rows)
create table if not exists mts_sam.supervisor_fail_reason_config (
  id uuid primary key default gen_random_uuid(),
  fail_reason text not null,
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint uq_supervisor_fail_reason_config unique (fail_reason)
);

-- 6. Supervisor Reason Configuration (from 'sup-reasons' tab - 7 rows)
create table if not exists mts_sam.supervisor_reason_config (
  id uuid primary key default gen_random_uuid(),
  reason text not null,
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint uq_supervisor_reason_config unique (reason)
);

-- 7. Show Schedule Configuration (from 'shows' tab - 8 rows)
create table if not exists mts_sam.show_schedule_config (
  id uuid primary key default gen_random_uuid(),
  show_name text not null,
  one_time_amount text not null default '',
  monthly_amount text not null default '',
  gift text not null default '',
  notes text not null default '',
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint uq_show_schedule_config unique (show_name)
);

-- 8. AI Prompt Configuration (from 'gemini-coaching-prompt' & 'gemini-fail-prompt' tabs - 2 rows)
create table if not exists mts_sam.ai_prompt_config (
  id uuid primary key default gen_random_uuid(),
  prompt_key text not null,
  prompt_text text not null,
  description text not null default '',
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint uq_ai_prompt_config unique (prompt_key)
);

-- Indexes for efficient display_order queries
create index if not exists idx_caller_roster_order on mts_sam.caller_roster (display_order);
create index if not exists idx_call_type_config_order on mts_sam.call_type_config (display_order);
create index if not exists idx_call_fail_reason_config_order on mts_sam.call_fail_reason_config (display_order);
create index if not exists idx_supervisor_coaching_config_order on mts_sam.supervisor_coaching_config (display_order);
create index if not exists idx_supervisor_fail_reason_config_order on mts_sam.supervisor_fail_reason_config (display_order);
create index if not exists idx_supervisor_reason_config_order on mts_sam.supervisor_reason_config (display_order);
create index if not exists idx_show_schedule_config_order on mts_sam.show_schedule_config (display_order);
create index if not exists idx_ai_prompt_config_order on mts_sam.ai_prompt_config (display_order);

-- Enable and force RLS on all 8 tables
alter table mts_sam.caller_roster enable row level security;
alter table mts_sam.caller_roster force row level security;

alter table mts_sam.call_type_config enable row level security;
alter table mts_sam.call_type_config force row level security;

alter table mts_sam.call_fail_reason_config enable row level security;
alter table mts_sam.call_fail_reason_config force row level security;

alter table mts_sam.supervisor_coaching_config enable row level security;
alter table mts_sam.supervisor_coaching_config force row level security;

alter table mts_sam.supervisor_fail_reason_config enable row level security;
alter table mts_sam.supervisor_fail_reason_config force row level security;

alter table mts_sam.supervisor_reason_config enable row level security;
alter table mts_sam.supervisor_reason_config force row level security;

alter table mts_sam.show_schedule_config enable row level security;
alter table mts_sam.show_schedule_config force row level security;

alter table mts_sam.ai_prompt_config enable row level security;
alter table mts_sam.ai_prompt_config force row level security;

-- Revoke all table direct access from public, anon, authenticated
revoke all on mts_sam.caller_roster from public, anon, authenticated;
revoke all on mts_sam.call_type_config from public, anon, authenticated;
revoke all on mts_sam.call_fail_reason_config from public, anon, authenticated;
revoke all on mts_sam.supervisor_coaching_config from public, anon, authenticated;
revoke all on mts_sam.supervisor_fail_reason_config from public, anon, authenticated;
revoke all on mts_sam.supervisor_reason_config from public, anon, authenticated;
revoke all on mts_sam.show_schedule_config from public, anon, authenticated;
revoke all on mts_sam.ai_prompt_config from public, anon, authenticated;

-- Grant administrative management to service_role
grant select, insert, update, delete on mts_sam.caller_roster to service_role;
grant select, insert, update, delete on mts_sam.call_type_config to service_role;
grant select, insert, update, delete on mts_sam.call_fail_reason_config to service_role;
grant select, insert, update, delete on mts_sam.supervisor_coaching_config to service_role;
grant select, insert, update, delete on mts_sam.supervisor_fail_reason_config to service_role;
grant select, insert, update, delete on mts_sam.supervisor_reason_config to service_role;
grant select, insert, update, delete on mts_sam.show_schedule_config to service_role;
grant select, insert, update, delete on mts_sam.ai_prompt_config to service_role;

-- Extend Read-Only Shadow Domain Data RPC to include all 23 domains (14 operational + 9 configuration)
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
    -- Operational Domains (14)
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
        select to_jsonb(v.*) as item
        from mts_sam.pending_requests_view v
        order by v.id
        limit v_limit offset v_offset
      ) sub;

    when 'recent_activity' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(v.*) as item
        from mts_sam.recent_activity_view v
        order by v.occurred_at desc, v.id
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

    -- Configuration Domains (9)
    when 'callers', 'caller_roster' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(cr.*) as item
        from mts_sam.caller_roster cr
        order by cr.display_order, cr.id
        limit v_limit offset v_offset
      ) sub;

    when 'call_types', 'call-types', 'call_type_config' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(ct.*) as item
        from mts_sam.call_type_config ct
        order by ct.display_order, ct.id
        limit v_limit offset v_offset
      ) sub;

    when 'call_fail_reasons', 'call-fail-reasons', 'call_fail_reason_config' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(cfr.*) as item
        from mts_sam.call_fail_reason_config cfr
        order by cfr.display_order, cfr.id
        limit v_limit offset v_offset
      ) sub;

    when 'supervisor_coaching', 'sup_coaching', 'sup-coaching', 'supervisor_coaching_config' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(sc.*) as item
        from mts_sam.supervisor_coaching_config sc
        order by sc.display_order, sc.id
        limit v_limit offset v_offset
      ) sub;

    when 'supervisor_fail_reasons', 'sup_fail_reasons', 'sup-fail-reasons', 'supervisor_fail_reason_config' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(sfr.*) as item
        from mts_sam.supervisor_fail_reason_config sfr
        order by sfr.display_order, sfr.id
        limit v_limit offset v_offset
      ) sub;

    when 'supervisor_reasons', 'sup_reasons', 'sup-reasons', 'supervisor_reason_config' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(sr.*) as item
        from mts_sam.supervisor_reason_config sr
        order by sr.display_order, sr.id
        limit v_limit offset v_offset
      ) sub;

    when 'shows', 'show_schedule', 'show_schedule_config' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(s.*) as item
        from mts_sam.show_schedule_config s
        order by s.display_order, s.id
        limit v_limit offset v_offset
      ) sub;

    when 'gemini_coaching_prompt', 'gemini-coaching-prompt' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(p.*) as item
        from mts_sam.ai_prompt_config p
        where p.prompt_key = 'gemini_coaching_prompt'
        order by p.display_order, p.id
        limit v_limit offset v_offset
      ) sub;

    when 'gemini_fail_prompt', 'gemini-fail-prompt' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(p.*) as item
        from mts_sam.ai_prompt_config p
        where p.prompt_key = 'gemini_fail_prompt'
        order by p.display_order, p.id
        limit v_limit offset v_offset
      ) sub;

    when 'ai_prompts', 'ai_prompt_config' then
      select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
      from (
        select to_jsonb(p.*) as item
        from mts_sam.ai_prompt_config p
        order by p.display_order, p.id
        limit v_limit offset v_offset
      ) sub;

    else
      raise exception 'Unsupported shadow domain: %', p_domain
        using errcode = '22023';
  end case;

  return v_result;
end;
$$;

revoke all on function mts_sam.get_shadow_domain_data(text, integer, integer) from public;
grant execute on function mts_sam.get_shadow_domain_data(text, integer, integer) to anon, authenticated, service_role;
