-- Migration: 20260906000000_harden_sam_admin_rpc_permissions.sql
-- Purpose: Harden SAM administrative RPC permissions and enforce strict caller derivation.
-- Revokes execute permissions from anon for administrative RPCs.
-- Enforces that caller identity is derived strictly from verified JWT claims (request.jwt.claim.sub / auth.uid()).
-- Rejects any client-supplied p_caller_auth_uid that does not match the verified token.
-- Forward-only. Does not modify or reapply previous migrations.

set search_path = '';

-- 1. get_sam_user_management_list
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
        'email', u.metadata->>'email',
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
            when u.active and u.auth_user_id is not null then 'Active / Enrolled'
            when u.active and (u.metadata->>'email') is not null and (u.metadata->>'invited_at') is not null then 'Active / Setup Sent'
            when u.active and (u.metadata->>'email') is not null then 'Active / Setup Not Sent'
            when u.active then 'Active / Enrollment Required'
            when not u.active and u.auth_user_id is not null then 'Inactive / Enrolled'
            when not u.active and (u.metadata->>'email') is not null then 'Inactive / Enrollment Ready'
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
  left join mts_sam.user_role_assignments r on r.user_id = u.id and r.revoked_at is null
  where u.source_system = 'google_sheets' or u.source_system = 'supabase';

  return jsonb_build_object(
    'ok', true,
    'users', v_result,
    'caller_is_owner', v_is_owner
  );
end;
$$;

-- 2. update_sam_user
create or replace function mts_sam.update_sam_user(
  p_target_user_id uuid,
  p_email text default null,
  p_role text default null,
  p_active boolean default null,
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
  v_target mts_sam.app_users%rowtype;
  v_target_role text;
  v_active_owner_count integer;
  v_norm_email text;
  v_existing_email_user_id uuid;
  v_new_metadata jsonb;
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
    return jsonb_build_object('ok', false, 'error', 'Only administrators can update user configuration.');
  end if;

  select * into v_target
  from mts_sam.app_users
  where id = p_target_user_id
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Target user not found.');
  end if;

  select role_key into v_target_role
  from mts_sam.user_role_assignments
  where user_id = v_target.id
    and revoked_at is null
  order by (case when role_key = 'administrator' then 1 else 2 end)
  limit 1;

  -- Protect last active owner from being deactivated
  if coalesce(v_target.metadata->>'source_role', 'admin') = 'owner' and p_active = false then
    select count(*) into v_active_owner_count
    from mts_sam.app_users
    where active = true
      and coalesce(metadata->>'source_role', 'admin') = 'owner';

    if v_active_owner_count <= 1 then
      return jsonb_build_object(
        'ok', false,
        'error_code', 'last_owner_protection',
        'error', 'Cannot deactivate the last active owner account.'
      );
    end if;
  end if;

  -- Protect last active owner from being demoted
  if coalesce(v_target.metadata->>'source_role', 'admin') = 'owner' and p_role is not null and p_role != 'administrator' then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'last_owner_protection',
      'error', 'Cannot demote the owner account.'
    );
  end if;

  -- Email normalization and duplicate check
  if p_email is not null then
    v_norm_email := lower(btrim(p_email));
    if v_norm_email != '' then
      if v_norm_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        return jsonb_build_object('ok', false, 'error', 'Invalid email address format.');
      end if;

      select id into v_existing_email_user_id
      from mts_sam.app_users
      where lower(btrim(coalesce(metadata->>'email', ''))) = v_norm_email
        and id != p_target_user_id
      limit 1;

      if found then
        return jsonb_build_object('ok', false, 'error', 'Another user is already configured with this email address.');
      end if;
    else
      v_norm_email := null;
    end if;
  else
    v_norm_email := v_target.metadata->>'email';
  end if;

  -- Update metadata
  v_new_metadata := coalesce(v_target.metadata, '{}'::jsonb);
  if v_norm_email is not null then
    v_new_metadata := jsonb_set(v_new_metadata, '{email}', to_jsonb(v_norm_email));
  else
    v_new_metadata := v_new_metadata - 'email';
  end if;

  -- Role assignment update
  if p_role is not null and p_role != '' then
    if p_role not in ('administrator', 'evaluator', 'viewer') then
      return jsonb_build_object('ok', false, 'error', 'Unsupported application role.');
    end if;

    -- Update or insert role assignment
    insert into mts_sam.user_role_assignments (user_id, role_key, assigned_by)
    values (v_target.id, p_role, v_caller.id)
    on conflict (user_id, role_key) do update
      set revoked_at = null, assigned_at = clock_timestamp();

    -- Revoke other roles
    update mts_sam.user_role_assignments
    set revoked_at = clock_timestamp()
    where user_id = v_target.id
      and role_key != p_role
      and revoked_at is null;
  end if;

  -- Update app_users
  update mts_sam.app_users
  set active = coalesce(p_active, active),
      metadata = v_new_metadata,
      updated_at = clock_timestamp()
  where id = p_target_user_id;

  return jsonb_build_object(
    'ok', true,
    'user_id', p_target_user_id,
    'email', v_norm_email,
    'active', coalesce(p_active, v_target.active),
    'role', coalesce(p_role, v_target_role)
  );
end;
$$;

-- 3. set_sam_user_active
create or replace function mts_sam.set_sam_user_active(
  p_caller_auth_uid uuid default null,
  p_target_user_id uuid default null,
  p_active boolean default null
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
  v_target mts_sam.app_users%rowtype;
  v_active_owner_count integer;
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

  if p_target_user_id is null or p_active is null then
    return jsonb_build_object('ok', false, 'error', 'Target user and active state are required.');
  end if;

  select * into v_caller
  from mts_sam.app_users
  where auth_user_id = v_effective_caller_uid
    and active = true
  limit 1;

  if not found or coalesce(v_caller.metadata->>'source_role', 'admin') != 'owner' then
    return jsonb_build_object('ok', false, 'error', 'Only account owners can modify user activation status.');
  end if;

  select * into v_target
  from mts_sam.app_users
  where id = p_target_user_id
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Target user not found.');
  end if;

  -- Protect last active owner from being deactivated
  if coalesce(v_target.metadata->>'source_role', 'admin') = 'owner' and p_active = false then
    select count(*) into v_active_owner_count
    from mts_sam.app_users
    where active = true
      and coalesce(metadata->>'source_role', 'admin') = 'owner';

    if v_active_owner_count <= 1 then
      return jsonb_build_object('ok', false, 'error', 'Cannot deactivate the last active owner account.');
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

-- 4. enroll_sam_user
create or replace function mts_sam.enroll_sam_user(
  p_target_user_id uuid,
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
  v_target mts_sam.app_users%rowtype;
  v_target_email text;
  v_auth_user_id uuid;
  v_existing_linked_app_user mts_sam.app_users%rowtype;
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
    return jsonb_build_object('ok', false, 'error', 'Only administrators can initiate user enrollment.');
  end if;

  select * into v_target
  from mts_sam.app_users
  where id = p_target_user_id
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Target user not found.');
  end if;

  v_target_email := lower(btrim(coalesce(v_target.metadata->>'email', '')));
  if v_target_email = '' then
    return jsonb_build_object('ok', false, 'error', 'User does not have an email address configured. Enter an email address first.');
  end if;

  -- Check if user is already linked
  if v_target.auth_user_id is not null then
    update mts_sam.app_users
    set metadata = jsonb_set(metadata, '{invited_at}', to_jsonb(clock_timestamp())),
        updated_at = clock_timestamp()
    where id = p_target_user_id;

    return jsonb_build_object(
      'ok', true,
      'status', 'already_linked',
      'user_id', p_target_user_id,
      'auth_user_id', v_target.auth_user_id,
      'email', v_target_email
    );
  end if;

  -- Check auth.users for existing identity
  select id into v_auth_user_id
  from auth.users
  where lower(btrim(coalesce(email, ''))) = v_target_email
  limit 1;

  if found then
    select * into v_existing_linked_app_user
    from mts_sam.app_users
    where auth_user_id = v_auth_user_id
      and id != p_target_user_id
    limit 1;

    if found then
      return jsonb_build_object(
        'ok', false,
        'error_code', 'AUTH_IDENTITY_ALREADY_EXISTS_CONFLICT',
        'error', 'An authentication identity with this email already exists and is linked to another application user.'
      );
    end if;

    update mts_sam.app_users
    set auth_user_id = v_auth_user_id,
        metadata = jsonb_set(metadata, '{invited_at}', to_jsonb(clock_timestamp())),
        updated_at = clock_timestamp()
    where id = p_target_user_id;

    return jsonb_build_object(
      'ok', true,
      'status', 'linked_existing',
      'user_id', p_target_user_id,
      'auth_user_id', v_auth_user_id,
      'email', v_target_email
    );
  else
    update mts_sam.app_users
    set metadata = jsonb_set(metadata, '{invited_at}', to_jsonb(clock_timestamp())),
        updated_at = clock_timestamp()
    where id = p_target_user_id;

    return jsonb_build_object(
      'ok', true,
      'status', 'ready_for_setup',
      'user_id', p_target_user_id,
      'email', v_target_email
    );
  end if;
end;
$$;

-- Revoke execute permissions from public and anon
revoke all on function mts_sam.get_sam_user_management_list(uuid) from public, anon;
revoke all on function mts_sam.update_sam_user(uuid, text, text, boolean, uuid) from public, anon;
revoke all on function mts_sam.set_sam_user_active(uuid, uuid, boolean) from public, anon;
revoke all on function mts_sam.enroll_sam_user(uuid, uuid) from public, anon;

-- Grant execute exclusively to authenticated and service_role
grant execute on function mts_sam.get_sam_user_management_list(uuid) to authenticated, service_role;
grant execute on function mts_sam.update_sam_user(uuid, text, text, boolean, uuid) to authenticated, service_role;
grant execute on function mts_sam.set_sam_user_active(uuid, uuid, boolean) to authenticated, service_role;
grant execute on function mts_sam.enroll_sam_user(uuid, uuid) to authenticated, service_role;
