-- Phase 1 schema plan for shared MTS/SAM Supabase accounts and targeted SAM alerts.
-- This migration is intentionally not wired into the Electron apps yet.

create extension if not exists pgcrypto;
create extension if not exists citext;

create schema if not exists app_private;

create or replace function app_private.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email citext not null unique,
  full_name text not null default '',
  tester_name text not null default '',
  role text not null default 'tester' check (role in ('admin', 'trainer', 'tester', 'viewer')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_settings (
  user_id uuid not null references public.profiles(id) on delete cascade,
  app_scope text not null default 'shared' check (app_scope in ('shared', 'mts', 'sam', 'sam-pwa')),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, app_scope)
);

create table if not exists public.mts_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  local_session_id text,
  candidate_name text not null default '',
  final_status text not null default '',
  session_started_at timestamptz,
  session_completed_at timestamptz,
  session_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sam_alerts (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references public.profiles(id) on delete set null,
  title text not null,
  body text not null default '',
  severity text not null default 'info' check (severity in ('info', 'success', 'warning', 'urgent')),
  audience text not null default 'everyone' check (audience in ('everyone', 'users', 'roles')),
  active boolean not null default true,
  publish_at timestamptz not null default now(),
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sam_alert_targets (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.sam_alerts(id) on delete cascade,
  target_type text not null check (target_type in ('everyone', 'user', 'role')),
  target_user_id uuid references public.profiles(id) on delete cascade,
  target_role text check (target_role in ('admin', 'trainer', 'tester', 'viewer')),
  created_at timestamptz not null default now(),
  constraint sam_alert_targets_shape check (
    (target_type = 'everyone' and target_user_id is null and target_role is null)
    or (target_type = 'user' and target_user_id is not null and target_role is null)
    or (target_type = 'role' and target_user_id is null and target_role is not null)
  )
);

create table if not exists public.sam_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  app_scope text not null default 'sam' check (app_scope in ('mts', 'sam', 'sam-pwa')),
  device_label text not null default '',
  platform text not null default '',
  push_endpoint_hash text,
  push_token_hash text,
  active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sam_alert_acknowledgements (
  alert_id uuid not null references public.sam_alerts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  device_id uuid references public.sam_devices(id) on delete set null,
  acknowledged_at timestamptz not null default now(),
  note text not null default '',
  primary key (alert_id, user_id)
);

create index if not exists profiles_role_idx on public.profiles(role);
create index if not exists profiles_active_idx on public.profiles(active);
create index if not exists mts_sessions_user_created_idx on public.mts_sessions(user_id, created_at desc);
create index if not exists sam_alerts_active_publish_idx on public.sam_alerts(active, publish_at desc);
create index if not exists sam_alert_targets_alert_idx on public.sam_alert_targets(alert_id);
create index if not exists sam_alert_targets_user_idx on public.sam_alert_targets(target_user_id) where target_type = 'user';
create index if not exists sam_alert_targets_role_idx on public.sam_alert_targets(target_role) where target_type = 'role';
create index if not exists sam_devices_user_idx on public.sam_devices(user_id, active);
create index if not exists sam_alert_ack_user_idx on public.sam_alert_acknowledgements(user_id, acknowledged_at desc);

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
for each row execute function app_private.set_updated_at();

drop trigger if exists set_user_settings_updated_at on public.user_settings;
create trigger set_user_settings_updated_at
before update on public.user_settings
for each row execute function app_private.set_updated_at();

drop trigger if exists set_mts_sessions_updated_at on public.mts_sessions;
create trigger set_mts_sessions_updated_at
before update on public.mts_sessions
for each row execute function app_private.set_updated_at();

drop trigger if exists set_sam_alerts_updated_at on public.sam_alerts;
create trigger set_sam_alerts_updated_at
before update on public.sam_alerts
for each row execute function app_private.set_updated_at();

drop trigger if exists set_sam_devices_updated_at on public.sam_devices;
create trigger set_sam_devices_updated_at
before update on public.sam_devices
for each row execute function app_private.set_updated_at();

create or replace function app_private.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select p.role
      from public.profiles p
      where p.id = auth.uid()
        and p.active = true
      limit 1
    ),
    ''
  );
$$;

create or replace function app_private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_private.current_user_role() = 'admin';
$$;

create or replace function app_private.is_admin_or_trainer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_private.current_user_role() in ('admin', 'trainer');
$$;

create or replace function app_private.alert_visible_to_current_user(alert_uuid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.sam_alerts a
    where a.id = alert_uuid
      and a.active = true
      and a.publish_at <= now()
      and (a.expires_at is null or a.expires_at > now())
      and (
        exists (
          select 1
          from public.sam_alert_targets t
          where t.alert_id = a.id
            and t.target_type = 'everyone'
        )
        or exists (
          select 1
          from public.sam_alert_targets t
          where t.alert_id = a.id
            and t.target_type = 'user'
            and t.target_user_id = auth.uid()
        )
        or exists (
          select 1
          from public.sam_alert_targets t
          join public.profiles p on p.id = auth.uid()
          where t.alert_id = a.id
            and t.target_type = 'role'
            and t.target_role = p.role
            and p.active = true
        )
      )
  );
$$;

create or replace function app_private.prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if app_private.is_admin() then
    return new;
  end if;

  if new.id <> auth.uid() then
    raise exception 'Only admins can update other profiles.';
  end if;

  if new.role is distinct from old.role
     or new.active is distinct from old.active
     or new.email is distinct from old.email then
    raise exception 'Only admins can update profile role, active status, or email.';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_profile_privilege_escalation on public.profiles;
create trigger prevent_profile_privilege_escalation
before update on public.profiles
for each row execute function app_private.prevent_profile_privilege_escalation();

create or replace function app_private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, tester_name, role, active)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.raw_user_meta_data ->> 'tester_name', ''),
    'tester',
    true
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_create_profile on auth.users;
create trigger on_auth_user_created_create_profile
after insert on auth.users
for each row execute function app_private.handle_new_auth_user();

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.mts_sessions enable row level security;
alter table public.sam_alerts enable row level security;
alter table public.sam_alert_targets enable row level security;
alter table public.sam_alert_acknowledgements enable row level security;
alter table public.sam_devices enable row level security;

drop policy if exists "profiles_read_own_or_admin" on public.profiles;
create policy "profiles_read_own_or_admin"
on public.profiles for select
to authenticated
using (id = auth.uid() or app_private.is_admin());

drop policy if exists "profiles_update_own_or_admin" on public.profiles;
create policy "profiles_update_own_or_admin"
on public.profiles for update
to authenticated
using (id = auth.uid() or app_private.is_admin())
with check (id = auth.uid() or app_private.is_admin());

drop policy if exists "profiles_admin_insert" on public.profiles;
create policy "profiles_admin_insert"
on public.profiles for insert
to authenticated
with check (app_private.is_admin());

drop policy if exists "profiles_admin_delete" on public.profiles;
create policy "profiles_admin_delete"
on public.profiles for delete
to authenticated
using (app_private.is_admin());

drop policy if exists "user_settings_read_own_or_admin" on public.user_settings;
create policy "user_settings_read_own_or_admin"
on public.user_settings for select
to authenticated
using (user_id = auth.uid() or app_private.is_admin());

drop policy if exists "user_settings_write_own_or_admin" on public.user_settings;
create policy "user_settings_write_own_or_admin"
on public.user_settings for all
to authenticated
using (user_id = auth.uid() or app_private.is_admin())
with check (user_id = auth.uid() or app_private.is_admin());

drop policy if exists "mts_sessions_read_own_or_admin" on public.mts_sessions;
create policy "mts_sessions_read_own_or_admin"
on public.mts_sessions for select
to authenticated
using (user_id = auth.uid() or app_private.is_admin());

drop policy if exists "mts_sessions_write_own_or_admin" on public.mts_sessions;
create policy "mts_sessions_write_own_or_admin"
on public.mts_sessions for all
to authenticated
using (user_id = auth.uid() or app_private.is_admin())
with check (user_id = auth.uid() or app_private.is_admin());

drop policy if exists "sam_alerts_read_targeted_or_manager" on public.sam_alerts;
create policy "sam_alerts_read_targeted_or_manager"
on public.sam_alerts for select
to authenticated
using (app_private.is_admin_or_trainer() or app_private.alert_visible_to_current_user(id));

drop policy if exists "sam_alerts_admin_trainer_insert" on public.sam_alerts;
create policy "sam_alerts_admin_trainer_insert"
on public.sam_alerts for insert
to authenticated
with check (app_private.is_admin_or_trainer() and created_by = auth.uid());

drop policy if exists "sam_alerts_admin_trainer_update" on public.sam_alerts;
create policy "sam_alerts_admin_trainer_update"
on public.sam_alerts for update
to authenticated
using (app_private.is_admin_or_trainer())
with check (app_private.is_admin_or_trainer());

drop policy if exists "sam_alerts_admin_delete" on public.sam_alerts;
create policy "sam_alerts_admin_delete"
on public.sam_alerts for delete
to authenticated
using (app_private.is_admin());

drop policy if exists "sam_alert_targets_read_relevant_or_manager" on public.sam_alert_targets;
create policy "sam_alert_targets_read_relevant_or_manager"
on public.sam_alert_targets for select
to authenticated
using (
  app_private.is_admin_or_trainer()
  or target_type = 'everyone'
  or target_user_id = auth.uid()
  or target_role = app_private.current_user_role()
);

drop policy if exists "sam_alert_targets_manager_write" on public.sam_alert_targets;
create policy "sam_alert_targets_manager_write"
on public.sam_alert_targets for all
to authenticated
using (app_private.is_admin_or_trainer())
with check (app_private.is_admin_or_trainer());

drop policy if exists "sam_alert_ack_read_own_or_admin" on public.sam_alert_acknowledgements;
create policy "sam_alert_ack_read_own_or_admin"
on public.sam_alert_acknowledgements for select
to authenticated
using (user_id = auth.uid() or app_private.is_admin());

drop policy if exists "sam_alert_ack_insert_own_visible" on public.sam_alert_acknowledgements;
create policy "sam_alert_ack_insert_own_visible"
on public.sam_alert_acknowledgements for insert
to authenticated
with check (user_id = auth.uid() and app_private.alert_visible_to_current_user(alert_id));

drop policy if exists "sam_alert_ack_update_own_or_admin" on public.sam_alert_acknowledgements;
create policy "sam_alert_ack_update_own_or_admin"
on public.sam_alert_acknowledgements for update
to authenticated
using (user_id = auth.uid() or app_private.is_admin())
with check (user_id = auth.uid() or app_private.is_admin());

drop policy if exists "sam_devices_read_own_or_admin" on public.sam_devices;
create policy "sam_devices_read_own_or_admin"
on public.sam_devices for select
to authenticated
using (user_id = auth.uid() or app_private.is_admin());

drop policy if exists "sam_devices_write_own_or_admin" on public.sam_devices;
create policy "sam_devices_write_own_or_admin"
on public.sam_devices for all
to authenticated
using (user_id = auth.uid() or app_private.is_admin())
with check (user_id = auth.uid() or app_private.is_admin());

grant usage on schema public to authenticated;
grant usage on schema app_private to authenticated;
grant select, insert, update, delete on
  public.profiles,
  public.user_settings,
  public.mts_sessions,
  public.sam_alerts,
  public.sam_alert_targets,
  public.sam_alert_acknowledgements,
  public.sam_devices
to authenticated;

grant execute on function app_private.current_user_role() to authenticated;
grant execute on function app_private.is_admin() to authenticated;
grant execute on function app_private.is_admin_or_trainer() to authenticated;
grant execute on function app_private.alert_visible_to_current_user(uuid) to authenticated;
