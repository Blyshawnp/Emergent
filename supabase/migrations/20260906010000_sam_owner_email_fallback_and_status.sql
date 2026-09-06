-- Migration: 20260906010000_sam_owner_email_fallback_and_status.sql
-- Purpose:
-- 1. Correct inactive state for legacy users Kimberly O'Brien, Kristi Green, and Lisa Byrd.
-- 2. Backfill Owner (Shawn Bly) canonical email from auth.users into app_users metadata.
-- 3. Enhance mts_sam.get_sam_user_management_list with deterministic fallback to auth.users.email
--    and precise canonical enrollment status calculation.
-- Forward-only. Does not modify or reapply previous migrations.

set search_path = '';

-- 1. Correct active status for legacy users who were not explicitly activated by the Owner
update mts_sam.app_users
set active = false,
    metadata = jsonb_set(
      coalesce(metadata, '{}'::jsonb),
      '{deactivation_audit}',
      jsonb_build_object(
        'corrected_at', clock_timestamp(),
        'reason', 'Resolved active-state contradiction: legacy un-enrolled users default to inactive pending Owner activation'
      )
    ),
    updated_at = clock_timestamp()
where display_name in ('Kimberly O''brien', 'Kristi Green', 'Lisa Byrd')
  and active = true;

-- 2. Backfill Owner's canonical application email from linked Auth identity
update mts_sam.app_users u
set metadata = jsonb_set(coalesce(u.metadata, '{}'::jsonb), '{email}', to_jsonb(au.email)),
    updated_at = clock_timestamp()
from auth.users au
where u.auth_user_id = au.id
  and u.display_name = 'Shawn Bly'
  and (u.metadata->>'email' is null or u.metadata->>'email' = '');

-- 3. Update get_sam_user_management_list RPC with deterministic auth email fallback
create or replace function mts_sam.get_sam_user_management_list(
  p_caller_auth_uid uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jwt_caller_uid uuid;
  v_effective_caller_uid uuid;
  v_caller mts_sam.app_users%rowtype;
  v_caller_role text;
  v_is_owner boolean := false;
  v_result jsonb;
begin
  v_jwt_caller_uid := coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
    auth.uid()
  );

  if v_jwt_caller_uid is not null then
    if p_caller_auth_uid is not null and p_caller_auth_uid != v_jwt_caller_uid then
      return jsonb_build_object(
        'ok', false,
        'error_code', 'CALLER_IDENTITY_MISMATCH',
        'error', 'Client-supplied caller identity does not match verified authentication token.'
      );
    end if;
    v_effective_caller_uid := v_jwt_caller_uid;
  elsif current_user = 'service_role' or current_user = 'postgres' then
    v_effective_caller_uid := p_caller_auth_uid;
  else
    return jsonb_build_object('ok', false, 'error', 'Unauthorized: Missing or invalid authentication token.');
  end if;

  if v_effective_caller_uid is null then
    return jsonb_build_object('ok', false, 'error', 'Unauthorized');
  end if;

  select * into v_caller
  from mts_sam.app_users
  where auth_user_id = v_effective_caller_uid
    and active = true
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Unauthorized caller');
  end if;

  select role_key into v_caller_role
  from mts_sam.user_role_assignments
  where user_id = v_caller.id
    and revoked_at is null
  order by (case when role_key = 'administrator' then 1 else 2 end)
  limit 1;

  if v_caller_role is null or v_caller_role != 'administrator' then
    return jsonb_build_object('ok', false, 'error', 'Insufficient permissions.');
  end if;

  v_is_owner := (coalesce(v_caller.metadata->>'source_role', 'admin') = 'owner');

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', u.id,
        'display_name', u.display_name,
        'source_user_id', u.source_user_id,
        'active', u.active,
        'email', coalesce(nullif(u.metadata->>'email', ''), au.email),
        'auth_user_id', u.auth_user_id,
        'is_linked', (u.auth_user_id is not null),
        'source_role', coalesce(u.metadata->>'source_role', 'admin'),
        'role', coalesce(r.role_key, 'administrator'),
        'is_owner', (coalesce(u.metadata->>'source_role', 'admin') = 'owner'),
        'installed', coalesce((u.metadata->>'installed')::boolean, false),
        'install_date', u.metadata->>'install_date',
        'invited_at', u.metadata->>'invited_at',
        'enrollment_status', (
          case
            -- Active cases
            when u.active and u.auth_user_id is not null then 'Active / Enrolled'
            when u.active and coalesce(nullif(u.metadata->>'email', ''), au.email) is not null and (u.metadata->>'invited_at') is not null then 'Active / Setup Sent'
            when u.active and coalesce(nullif(u.metadata->>'email', ''), au.email) is not null then 'Active / Setup Not Sent'
            when u.active then 'Active / Enrollment Required'
            -- Inactive cases
            when not u.active and u.auth_user_id is not null then 'Inactive / Enrolled'
            when not u.active and coalesce(nullif(u.metadata->>'email', ''), au.email) is not null then 'Inactive / Enrollment Ready'
            else 'Inactive / No Email'
          end
        ),
        'created_at', u.created_at
      )
      order by (case when coalesce(u.metadata->>'source_role', 'admin') = 'owner' then 0 else 1 end), u.display_name
    ),
    '[]'::jsonb
  ) into v_result
  from mts_sam.app_users u
  left join auth.users au on au.id = u.auth_user_id
  left join mts_sam.user_role_assignments r on r.user_id = u.id and r.revoked_at is null
  where u.source_system = 'google_sheets' or u.source_system = 'supabase';

  return jsonb_build_object(
    'ok', true,
    'users', v_result,
    'caller_is_owner', v_is_owner
  );
end;
$$;

-- Ensure permissions remain restricted
revoke all on function mts_sam.get_sam_user_management_list(uuid) from public, anon;
grant execute on function mts_sam.get_sam_user_management_list(uuid) to authenticated, service_role;
