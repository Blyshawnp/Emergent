-- Migration: 20260818040000_mts_sam_user_management.sql
-- Purpose: Add secure server-side RPCs for SAM user authorization verification,
-- user management listing, and owner-protected user activation.
-- Forward-only. Does not modify or reapply previous migrations.

set search_path = '';

-- 1. Verify SAM Authorization RPC
create or replace function mts_sam.verify_sam_authorization(
  p_auth_uid uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user mts_sam.app_users%rowtype;
  v_role text;
  v_source_role text;
  v_is_owner boolean := false;
begin
  if p_auth_uid is null then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'missing_auth_identity',
      'error', 'Authentication identity is missing.'
    );
  end if;

  select * into v_user
  from mts_sam.app_users
  where auth_user_id = p_auth_uid
  limit 1;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'unauthorized_account',
      'error', 'Your account is not registered for SAM access.'
    );
  end if;

  if not v_user.active then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'inactive_account',
      'error', 'Your SAM account has been deactivated.'
    );
  end if;

  select role_key into v_role
  from mts_sam.user_role_assignments
  where user_id = v_user.id
    and revoked_at is null
  order by (case when role_key = 'administrator' then 1 else 2 end)
  limit 1;

  if v_role is null or v_role != 'administrator' then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'insufficient_role',
      'error', 'Your account does not have administrator permissions.'
    );
  end if;

  v_source_role := coalesce(v_user.metadata->>'source_role', 'admin');
  v_is_owner := (v_source_role = 'owner');

  return jsonb_build_object(
    'ok', true,
    'user_id', v_user.id,
    'auth_user_id', v_user.auth_user_id,
    'display_name', v_user.display_name,
    'active', v_user.active,
    'role', v_role,
    'source_role', v_source_role,
    'is_owner', v_is_owner
  );
end;
$$;

-- 2. Get SAM User Management List RPC
create or replace function mts_sam.get_sam_user_management_list(
  p_caller_auth_uid uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller mts_sam.app_users%rowtype;
  v_result jsonb;
begin
  if p_caller_auth_uid is null then
    return jsonb_build_object('ok', false, 'error', 'Unauthorized');
  end if;

  select * into v_caller
  from mts_sam.app_users
  where auth_user_id = p_caller_auth_uid
    and active = true
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Unauthorized caller');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', u.id,
        'display_name', u.display_name,
        'source_user_id', u.source_user_id,
        'active', u.active,
        'auth_user_id', u.auth_user_id,
        'is_linked', (u.auth_user_id is not null),
        'source_role', coalesce(u.metadata->>'source_role', 'admin'),
        'role', coalesce(r.role_key, 'administrator'),
        'is_owner', (coalesce(u.metadata->>'source_role', 'admin') = 'owner'),
        'installed', coalesce((u.metadata->>'installed')::boolean, false),
        'install_date', u.metadata->>'install_date',
        'created_at', u.created_at
      )
      order by (case when coalesce(u.metadata->>'source_role', 'admin') = 'owner' then 0 else 1 end), u.display_name
    ),
    '[]'::jsonb
  ) into v_result
  from mts_sam.app_users u
  left join mts_sam.user_role_assignments r on r.user_id = u.id and r.revoked_at is null
  where u.source_system = 'google_sheets';

  return jsonb_build_object(
    'ok', true,
    'users', v_result,
    'caller_is_owner', (coalesce(v_caller.metadata->>'source_role', 'admin') = 'owner')
  );
end;
$$;

-- 3. Set SAM User Active RPC (Owner Only, with Last-Owner Protection)
create or replace function mts_sam.set_sam_user_active(
  p_caller_auth_uid uuid,
  p_target_user_id uuid,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller mts_sam.app_users%rowtype;
  v_target mts_sam.app_users%rowtype;
  v_active_owner_count integer;
begin
  if p_caller_auth_uid is null then
    return jsonb_build_object('ok', false, 'error', 'Unauthorized');
  end if;

  select * into v_caller
  from mts_sam.app_users
  where auth_user_id = p_caller_auth_uid
    and active = true
  limit 1;

  if not found or coalesce(v_caller.metadata->>'source_role', 'admin') != 'owner' then
    return jsonb_build_object('ok', false, 'error', 'Only active owners can modify user authorization.');
  end if;

  select * into v_target
  from mts_sam.app_users
  where id = p_target_user_id
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'User not found.');
  end if;

  -- Protect against deactivating the last active owner
  if not p_active and coalesce(v_target.metadata->>'source_role', 'admin') = 'owner' then
    select count(*) into v_active_owner_count
    from mts_sam.app_users
    where active = true
      and coalesce(metadata->>'source_role', 'admin') = 'owner';

    if v_active_owner_count <= 1 then
      return jsonb_build_object(
        'ok', false,
        'error_code', 'last_owner_protection',
        'error', 'Cannot deactivate the last remaining active owner.'
      );
    end if;
  end if;

  update mts_sam.app_users
  set active = p_active,
      updated_at = clock_timestamp()
  where id = p_target_user_id;

  return jsonb_build_object(
    'ok', true,
    'user_id', p_target_user_id,
    'active', p_active
  );
end;
$$;

-- Revoke all by default, grant execute to anon, authenticated, service_role
revoke all on function mts_sam.verify_sam_authorization(uuid) from public;
revoke all on function mts_sam.get_sam_user_management_list(uuid) from public;
revoke all on function mts_sam.set_sam_user_active(uuid, uuid, boolean) from public;

grant execute on function mts_sam.verify_sam_authorization(uuid) to anon, authenticated, service_role;
grant execute on function mts_sam.get_sam_user_management_list(uuid) to anon, authenticated, service_role;
grant execute on function mts_sam.set_sam_user_active(uuid, uuid, boolean) to anon, authenticated, service_role;
