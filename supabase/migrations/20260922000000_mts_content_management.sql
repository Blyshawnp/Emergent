-- Migration: 20260922000000_mts_content_management.sql
-- Purpose: Content management for Callers and Discord Posts domains.
--   Creates discord_post_library working-draft table.
--   Creates content_publications versioned-snapshot table.
--   Creates RPCs for per-item draft editing, atomic publishing,
--   version restoration, and secure published-content retrieval.
--   Reuses existing mts_sam.caller_roster as the callers working-draft table.
--   All RPCs are SECURITY DEFINER with safe search_path.
--   No anonymous or public access is granted.
-- Forward-only. DO NOT DEPLOY without explicit Owner authorization.

set search_path = '';

-- ============================================================
-- 1. Discord Post Library — Working Draft Table
-- ============================================================

create table if not exists mts_sam.discord_post_library (
  id uuid primary key default extensions.gen_random_uuid(),
  category text not null default 'General',
  title text not null,
  message text not null,
  suggested_screenshots jsonb not null default '[]'::jsonb,
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint uq_discord_post_library_identity unique (category, title)
);

alter table mts_sam.discord_post_library enable row level security;

revoke all on mts_sam.discord_post_library from public, anon, authenticated;
grant select, insert, update on mts_sam.discord_post_library to service_role;

-- ============================================================
-- 2. Content Publications — Versioned Snapshots
-- ============================================================

create table if not exists mts_sam.content_publications (
  id uuid primary key default extensions.gen_random_uuid(),
  domain text not null check (domain in ('callers', 'discord_posts')),
  version_id text not null unique,
  content_json jsonb not null,
  content_hash text not null,
  item_count integer not null default 0,
  published_at timestamptz not null default clock_timestamp(),
  published_by text not null,
  published_by_user_id uuid,
  notes text not null default '',
  is_current boolean not null default false
);

alter table mts_sam.content_publications enable row level security;

-- Partial-unique index: only one current publication per domain
create unique index if not exists uq_content_publications_current
  on mts_sam.content_publications (domain)
  where is_current = true;

-- Lookup index for version history
create index if not exists idx_content_publications_domain_published
  on mts_sam.content_publications (domain, published_at desc);

revoke all on mts_sam.content_publications from public, anon, authenticated;
grant select, insert, update on mts_sam.content_publications to service_role;

-- ============================================================
-- 3. Helper: Verify JWT administrator identity
--    Reusable internal function for content management RPCs.
--    Returns (user_id uuid, display_name text) or raises error via jsonb.
-- ============================================================

create or replace function mts_sam._verify_content_admin()
returns table(user_id uuid, display_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_jwt_uid uuid;
  v_user mts_sam.app_users%rowtype;
  v_is_admin boolean := false;
begin
  v_jwt_uid := coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
    auth.uid()
  );

  if v_jwt_uid is null then
    raise exception 'UNAUTHENTICATED: Authentication required.'
      using errcode = 'P0001';
  end if;

  select * into v_user
  from mts_sam.app_users
  where auth_user_id = v_jwt_uid and active = true
  limit 1;

  if not found then
    raise exception 'UNAUTHORIZED_CALLER: Active SAM membership required.'
      using errcode = 'P0001';
  end if;

  select exists (
    select 1
    from mts_sam.user_role_assignments
    where mts_sam.user_role_assignments.user_id = v_user.id
      and role_key = 'administrator'
      and revoked_at is null
  ) into v_is_admin;

  if not v_is_admin then
    raise exception 'INSUFFICIENT_ROLE: Administrator role required.'
      using errcode = 'P0001';
  end if;

  return query select v_user.id, coalesce(v_user.display_name, '')::text;
end;
$$;

revoke all on function mts_sam._verify_content_admin() from public, anon, authenticated;
grant execute on function mts_sam._verify_content_admin() to service_role;

-- ============================================================
-- 4. RPC: save_content_item
--    Upserts a single working-draft row with optimistic concurrency.
--    Identity derived exclusively from auth.uid().
-- ============================================================

create or replace function mts_sam.save_content_item(
  p_domain text,
  p_item_id uuid default null,
  p_item_data jsonb default '{}'::jsonb,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin record;
  v_domain text;
  v_now timestamptz := clock_timestamp();
  v_existing_updated_at timestamptz;
  v_result_id uuid;
  v_result_updated_at timestamptz;
begin
  -- Verify administrator
  select * into v_admin from mts_sam._verify_content_admin();

  v_domain := lower(btrim(coalesce(p_domain, '')));
  if v_domain not in ('callers', 'discord_posts') then
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_DOMAIN',
      'error', 'Supported domains: callers, discord_posts.');
  end if;

  if v_domain = 'callers' then
    -- === CALLERS DOMAIN ===
    if p_item_id is null then
      -- INSERT new caller
      insert into mts_sam.caller_roster (
        category, first_name, last_name, address, city, state, zip, phone, email,
        display_order, is_active, created_at, updated_at
      ) values (
        coalesce(p_item_data->>'category', 'New'),
        coalesce(p_item_data->>'first_name', ''),
        coalesce(p_item_data->>'last_name', ''),
        coalesce(p_item_data->>'address', ''),
        coalesce(p_item_data->>'city', ''),
        coalesce(p_item_data->>'state', ''),
        coalesce(p_item_data->>'zip', ''),
        coalesce(p_item_data->>'phone', ''),
        coalesce(p_item_data->>'email', ''),
        coalesce((p_item_data->>'display_order')::integer, 0),
        coalesce((p_item_data->>'is_active')::boolean, true),
        v_now, v_now
      )
      returning id, updated_at into v_result_id, v_result_updated_at;

      return jsonb_build_object('ok', true, 'item_id', v_result_id, 'updated_at', v_result_updated_at);

    else
      -- UPDATE existing caller with optimistic concurrency
      select updated_at into v_existing_updated_at
      from mts_sam.caller_roster
      where id = p_item_id
      for update;

      if not found then
        return jsonb_build_object('ok', false, 'error_code', 'ITEM_NOT_FOUND',
          'error', 'Caller not found.');
      end if;

      if p_expected_updated_at is not null
         and v_existing_updated_at != p_expected_updated_at then
        return jsonb_build_object('ok', false, 'error_code', 'CONCURRENT_EDIT',
          'error', 'This item was modified by another editor. Please refresh and retry.',
          'current_updated_at', v_existing_updated_at);
      end if;

      update mts_sam.caller_roster set
        category = coalesce(p_item_data->>'category', category),
        first_name = coalesce(p_item_data->>'first_name', first_name),
        last_name = coalesce(p_item_data->>'last_name', last_name),
        address = coalesce(p_item_data->>'address', address),
        city = coalesce(p_item_data->>'city', city),
        state = coalesce(p_item_data->>'state', state),
        zip = coalesce(p_item_data->>'zip', zip),
        phone = coalesce(p_item_data->>'phone', phone),
        email = coalesce(p_item_data->>'email', email),
        display_order = coalesce((p_item_data->>'display_order')::integer, display_order),
        is_active = coalesce((p_item_data->>'is_active')::boolean, is_active),
        updated_at = v_now
      where id = p_item_id
      returning id, updated_at into v_result_id, v_result_updated_at;

      return jsonb_build_object('ok', true, 'item_id', v_result_id, 'updated_at', v_result_updated_at);
    end if;

  elsif v_domain = 'discord_posts' then
    -- === DISCORD POSTS DOMAIN ===
    if p_item_id is null then
      -- INSERT new discord post
      insert into mts_sam.discord_post_library (
        category, title, message, suggested_screenshots,
        display_order, is_active, created_at, updated_at
      ) values (
        coalesce(p_item_data->>'category', 'General'),
        coalesce(p_item_data->>'title', ''),
        coalesce(p_item_data->>'message', ''),
        coalesce(p_item_data->'suggested_screenshots', '[]'::jsonb),
        coalesce((p_item_data->>'display_order')::integer, 0),
        coalesce((p_item_data->>'is_active')::boolean, true),
        v_now, v_now
      )
      returning id, updated_at into v_result_id, v_result_updated_at;

      return jsonb_build_object('ok', true, 'item_id', v_result_id, 'updated_at', v_result_updated_at);

    else
      -- UPDATE existing discord post with optimistic concurrency
      select updated_at into v_existing_updated_at
      from mts_sam.discord_post_library
      where id = p_item_id
      for update;

      if not found then
        return jsonb_build_object('ok', false, 'error_code', 'ITEM_NOT_FOUND',
          'error', 'Discord post not found.');
      end if;

      if p_expected_updated_at is not null
         and v_existing_updated_at != p_expected_updated_at then
        return jsonb_build_object('ok', false, 'error_code', 'CONCURRENT_EDIT',
          'error', 'This item was modified by another editor. Please refresh and retry.',
          'current_updated_at', v_existing_updated_at);
      end if;

      update mts_sam.discord_post_library set
        category = coalesce(p_item_data->>'category', category),
        title = coalesce(p_item_data->>'title', title),
        message = coalesce(p_item_data->>'message', message),
        suggested_screenshots = coalesce(p_item_data->'suggested_screenshots', suggested_screenshots),
        display_order = coalesce((p_item_data->>'display_order')::integer, display_order),
        is_active = coalesce((p_item_data->>'is_active')::boolean, is_active),
        updated_at = v_now
      where id = p_item_id
      returning id, updated_at into v_result_id, v_result_updated_at;

      return jsonb_build_object('ok', true, 'item_id', v_result_id, 'updated_at', v_result_updated_at);
    end if;
  end if;

  return jsonb_build_object('ok', false, 'error_code', 'INTERNAL_ERROR', 'error', 'Unexpected execution path.');
end;
$$;

revoke all on function mts_sam.save_content_item(text, uuid, jsonb, timestamptz) from public, anon;
grant execute on function mts_sam.save_content_item(text, uuid, jsonb, timestamptz) to authenticated, service_role;

-- ============================================================
-- 5. RPC: deactivate_content_item
--    Explicitly deactivates a single item with optimistic concurrency.
-- ============================================================

create or replace function mts_sam.deactivate_content_item(
  p_domain text,
  p_item_id uuid,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin record;
  v_domain text;
  v_now timestamptz := clock_timestamp();
  v_existing_updated_at timestamptz;
  v_result_id uuid;
  v_result_updated_at timestamptz;
begin
  select * into v_admin from mts_sam._verify_content_admin();

  v_domain := lower(btrim(coalesce(p_domain, '')));
  if v_domain not in ('callers', 'discord_posts') then
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_DOMAIN',
      'error', 'Supported domains: callers, discord_posts.');
  end if;

  if p_item_id is null then
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_REQUEST',
      'error', 'Item ID is required.');
  end if;

  if v_domain = 'callers' then
    select updated_at into v_existing_updated_at
    from mts_sam.caller_roster where id = p_item_id for update;

    if not found then
      return jsonb_build_object('ok', false, 'error_code', 'ITEM_NOT_FOUND', 'error', 'Caller not found.');
    end if;

    if p_expected_updated_at is not null and v_existing_updated_at != p_expected_updated_at then
      return jsonb_build_object('ok', false, 'error_code', 'CONCURRENT_EDIT',
        'error', 'This item was modified by another editor. Please refresh and retry.',
        'current_updated_at', v_existing_updated_at);
    end if;

    update mts_sam.caller_roster set is_active = false, updated_at = v_now
    where id = p_item_id
    returning id, updated_at into v_result_id, v_result_updated_at;

  elsif v_domain = 'discord_posts' then
    select updated_at into v_existing_updated_at
    from mts_sam.discord_post_library where id = p_item_id for update;

    if not found then
      return jsonb_build_object('ok', false, 'error_code', 'ITEM_NOT_FOUND', 'error', 'Discord post not found.');
    end if;

    if p_expected_updated_at is not null and v_existing_updated_at != p_expected_updated_at then
      return jsonb_build_object('ok', false, 'error_code', 'CONCURRENT_EDIT',
        'error', 'This item was modified by another editor. Please refresh and retry.',
        'current_updated_at', v_existing_updated_at);
    end if;

    update mts_sam.discord_post_library set is_active = false, updated_at = v_now
    where id = p_item_id
    returning id, updated_at into v_result_id, v_result_updated_at;
  end if;

  return jsonb_build_object('ok', true, 'item_id', v_result_id, 'updated_at', v_result_updated_at);
end;
$$;

revoke all on function mts_sam.deactivate_content_item(text, uuid, timestamptz) from public, anon;
grant execute on function mts_sam.deactivate_content_item(text, uuid, timestamptz) to authenticated, service_role;

-- ============================================================
-- 6. RPC: get_content_management_state
--    Returns working draft items, current publication, and version history.
--    Administrator-only.
-- ============================================================

create or replace function mts_sam.get_content_management_state(
  p_domain text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin record;
  v_domain text;
  v_draft_items jsonb;
  v_current_pub jsonb;
  v_version_history jsonb;
begin
  select * into v_admin from mts_sam._verify_content_admin();

  v_domain := lower(btrim(coalesce(p_domain, '')));
  if v_domain not in ('callers', 'discord_posts') then
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_DOMAIN',
      'error', 'Supported domains: callers, discord_posts.');
  end if;

  -- Get draft items
  if v_domain = 'callers' then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', cr.id, 'category', cr.category,
        'first_name', cr.first_name, 'last_name', cr.last_name,
        'address', cr.address, 'city', cr.city, 'state', cr.state,
        'zip', cr.zip, 'phone', cr.phone, 'email', cr.email,
        'display_order', cr.display_order, 'is_active', cr.is_active,
        'created_at', cr.created_at, 'updated_at', cr.updated_at
      ) order by cr.display_order, cr.created_at
    ), '[]'::jsonb) into v_draft_items
    from mts_sam.caller_roster cr;

  elsif v_domain = 'discord_posts' then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', dp.id, 'category', dp.category,
        'title', dp.title, 'message', dp.message,
        'suggested_screenshots', dp.suggested_screenshots,
        'display_order', dp.display_order, 'is_active', dp.is_active,
        'created_at', dp.created_at, 'updated_at', dp.updated_at
      ) order by dp.display_order, dp.created_at
    ), '[]'::jsonb) into v_draft_items
    from mts_sam.discord_post_library dp;
  end if;

  -- Get current publication
  select jsonb_build_object(
    'version_id', cp.version_id,
    'content_hash', cp.content_hash,
    'item_count', cp.item_count,
    'published_at', cp.published_at,
    'published_by', cp.published_by,
    'notes', cp.notes
  ) into v_current_pub
  from mts_sam.content_publications cp
  where cp.domain = v_domain and cp.is_current = true
  limit 1;

  -- Get version history (last 20)
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'version_id', cp.version_id,
      'content_hash', cp.content_hash,
      'item_count', cp.item_count,
      'published_at', cp.published_at,
      'published_by', cp.published_by,
      'notes', cp.notes,
      'is_current', cp.is_current
    ) order by cp.published_at desc
  ), '[]'::jsonb) into v_version_history
  from (
    select * from mts_sam.content_publications
    where domain = v_domain
    order by published_at desc
    limit 20
  ) cp;

  return jsonb_build_object(
    'ok', true,
    'domain', v_domain,
    'draft_items', v_draft_items,
    'current_publication', coalesce(v_current_pub, 'null'::jsonb),
    'version_history', v_version_history
  );
end;
$$;

revoke all on function mts_sam.get_content_management_state(text) from public, anon;
grant execute on function mts_sam.get_content_management_state(text) to authenticated, service_role;

-- ============================================================
-- 7. RPC: publish_content_domain
--    Atomic publish with advisory lock, content hash dedup,
--    stale-version protection, and empty-content guard.
-- ============================================================

create or replace function mts_sam.publish_content_domain(
  p_domain text,
  p_notes text default '',
  p_expected_current_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin record;
  v_domain text;
  v_content_json jsonb;
  v_content_hash text;
  v_item_count integer;
  v_current_version text;
  v_current_hash text;
  v_next_seq integer;
  v_new_version_id text;
  v_lock_key bigint;
  v_pub_id uuid;
begin
  select * into v_admin from mts_sam._verify_content_admin();

  v_domain := lower(btrim(coalesce(p_domain, '')));
  if v_domain not in ('callers', 'discord_posts') then
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_DOMAIN',
      'error', 'Supported domains: callers, discord_posts.');
  end if;

  -- Advisory lock per domain to serialize concurrent publishes
  -- Use a stable hash of the domain name as the lock key
  v_lock_key := case v_domain when 'callers' then 8001 when 'discord_posts' then 8002 end;
  perform pg_advisory_xact_lock(v_lock_key);

  -- Check stale version if caller provided an expectation
  select version_id, content_hash into v_current_version, v_current_hash
  from mts_sam.content_publications
  where domain = v_domain and is_current = true
  limit 1;

  if p_expected_current_version is not null
     and v_current_version is not null
     and v_current_version != p_expected_current_version then
    return jsonb_build_object('ok', false, 'error_code', 'STALE_PUBLISH',
      'error', 'Another administrator published a newer version. Please refresh and review before publishing.',
      'current_version', v_current_version);
  end if;

  -- Snapshot active working-draft rows
  if v_domain = 'callers' then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', cr.id, 'category', cr.category,
        'first_name', cr.first_name, 'last_name', cr.last_name,
        'address', cr.address, 'city', cr.city, 'state', cr.state,
        'zip', cr.zip, 'phone', cr.phone, 'email', cr.email,
        'display_order', cr.display_order
      ) order by cr.display_order, cr.created_at
    ), '[]'::jsonb) into v_content_json
    from mts_sam.caller_roster cr
    where cr.is_active = true;
  elsif v_domain = 'discord_posts' then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', dp.id, 'category', dp.category,
        'title', dp.title, 'message', dp.message,
        'suggested_screenshots', dp.suggested_screenshots,
        'display_order', dp.display_order
      ) order by dp.display_order, dp.created_at
    ), '[]'::jsonb) into v_content_json
    from mts_sam.discord_post_library dp
    where dp.is_active = true;
  end if;

  v_item_count := coalesce(jsonb_array_length(v_content_json), 0);

  -- Guard against accidental empty publication
  if v_item_count = 0 then
    return jsonb_build_object('ok', false, 'error_code', 'EMPTY_CONTENT',
      'error', 'Cannot publish an empty ' || v_domain || ' roster. Add items first.');
  end if;

  -- Compute canonical content hash
  v_content_hash := encode(
    extensions.digest(v_content_json::text::bytea, 'sha256'),
    'hex'
  );

  -- Reject unchanged content
  if v_current_hash is not null and v_current_hash = v_content_hash then
    return jsonb_build_object('ok', false, 'error_code', 'CONTENT_UNCHANGED',
      'error', 'No changes to publish. The current publication is identical.');
  end if;

  -- Compute next version number
  select coalesce(max(
    nullif(regexp_replace(version_id, '^' || v_domain || '-v', ''), version_id)::integer
  ), 0) + 1
  into v_next_seq
  from mts_sam.content_publications
  where domain = v_domain;

  v_new_version_id := v_domain || '-v' || v_next_seq::text;

  -- Retire current publication
  update mts_sam.content_publications
  set is_current = false
  where domain = v_domain and is_current = true;

  -- Insert new publication
  insert into mts_sam.content_publications (
    domain, version_id, content_json, content_hash, item_count,
    published_at, published_by, published_by_user_id, notes, is_current
  ) values (
    v_domain, v_new_version_id, v_content_json, v_content_hash, v_item_count,
    clock_timestamp(), v_admin.display_name, v_admin.user_id,
    coalesce(btrim(p_notes), ''), true
  )
  returning id into v_pub_id;

  return jsonb_build_object(
    'ok', true,
    'version_id', v_new_version_id,
    'content_hash', v_content_hash,
    'item_count', v_item_count,
    'published_at', clock_timestamp()
  );
end;
$$;

revoke all on function mts_sam.publish_content_domain(text, text, text) from public, anon;
grant execute on function mts_sam.publish_content_domain(text, text, text) to authenticated, service_role;

-- ============================================================
-- 8. RPC: restore_published_content_version
--    Creates a NEW publication from a historical version.
--    Optionally replaces working draft (explicit opt-in).
-- ============================================================

create or replace function mts_sam.restore_published_content_version(
  p_domain text,
  p_version_id text,
  p_notes text default '',
  p_also_restore_draft boolean default false,
  p_expected_current_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin record;
  v_domain text;
  v_source_pub mts_sam.content_publications%rowtype;
  v_current_version text;
  v_next_seq integer;
  v_new_version_id text;
  v_lock_key bigint;
  v_item record;
begin
  select * into v_admin from mts_sam._verify_content_admin();

  v_domain := lower(btrim(coalesce(p_domain, '')));
  if v_domain not in ('callers', 'discord_posts') then
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_DOMAIN',
      'error', 'Supported domains: callers, discord_posts.');
  end if;

  -- Advisory lock
  v_lock_key := case v_domain when 'callers' then 8001 when 'discord_posts' then 8002 end;
  perform pg_advisory_xact_lock(v_lock_key);

  -- Look up the historical publication
  select * into v_source_pub
  from mts_sam.content_publications
  where version_id = btrim(coalesce(p_version_id, ''))
    and domain = v_domain;

  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'VERSION_NOT_FOUND',
      'error', 'Publication version not found.');
  end if;

  -- Check stale version
  select version_id into v_current_version
  from mts_sam.content_publications
  where domain = v_domain and is_current = true
  limit 1;

  if p_expected_current_version is not null
     and v_current_version is not null
     and v_current_version != p_expected_current_version then
    return jsonb_build_object('ok', false, 'error_code', 'STALE_RESTORE',
      'error', 'Another administrator published a newer version. Please refresh and review.',
      'current_version', v_current_version);
  end if;

  -- Guard: don't restore to identical content
  if v_current_version is not null then
    declare v_current_hash text;
    begin
      select content_hash into v_current_hash
      from mts_sam.content_publications
      where domain = v_domain and is_current = true;

      if v_current_hash = v_source_pub.content_hash then
        return jsonb_build_object('ok', false, 'error_code', 'CONTENT_UNCHANGED',
          'error', 'The selected version is identical to the current publication.');
      end if;
    end;
  end if;

  -- Compute next version number
  select coalesce(max(
    nullif(regexp_replace(version_id, '^' || v_domain || '-v', ''), version_id)::integer
  ), 0) + 1
  into v_next_seq
  from mts_sam.content_publications
  where domain = v_domain;

  v_new_version_id := v_domain || '-v' || v_next_seq::text;

  -- Retire current publication
  update mts_sam.content_publications
  set is_current = false
  where domain = v_domain and is_current = true;

  -- Insert new publication record from historical content
  insert into mts_sam.content_publications (
    domain, version_id, content_json, content_hash, item_count,
    published_at, published_by, published_by_user_id,
    notes, is_current
  ) values (
    v_domain, v_new_version_id,
    v_source_pub.content_json, v_source_pub.content_hash, v_source_pub.item_count,
    clock_timestamp(), v_admin.display_name, v_admin.user_id,
    coalesce(btrim(p_notes), 'Restored from ' || v_source_pub.version_id),
    true
  );

  -- Optionally restore working draft
  if p_also_restore_draft then
    if v_domain = 'callers' then
      -- Deactivate all current callers
      update mts_sam.caller_roster set is_active = false, updated_at = clock_timestamp();
      -- Re-insert from publication content
      insert into mts_sam.caller_roster (
        category, first_name, last_name, address, city, state, zip, phone, email,
        display_order, is_active, created_at, updated_at
      )
      select
        item->>'category',
        item->>'first_name',
        item->>'last_name',
        coalesce(item->>'address', ''),
        coalesce(item->>'city', ''),
        coalesce(item->>'state', ''),
        coalesce(item->>'zip', ''),
        coalesce(item->>'phone', ''),
        coalesce(item->>'email', ''),
        coalesce((item->>'display_order')::integer, 0),
        true,
        clock_timestamp(),
        clock_timestamp()
      from jsonb_array_elements(v_source_pub.content_json) as item;

    elsif v_domain = 'discord_posts' then
      update mts_sam.discord_post_library set is_active = false, updated_at = clock_timestamp();
      insert into mts_sam.discord_post_library (
        category, title, message, suggested_screenshots,
        display_order, is_active, created_at, updated_at
      )
      select
        item->>'category',
        item->>'title',
        item->>'message',
        coalesce(item->'suggested_screenshots', '[]'::jsonb),
        coalesce((item->>'display_order')::integer, 0),
        true,
        clock_timestamp(),
        clock_timestamp()
      from jsonb_array_elements(v_source_pub.content_json) as item;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'version_id', v_new_version_id,
    'content_hash', v_source_pub.content_hash,
    'item_count', v_source_pub.item_count,
    'draft_restored', p_also_restore_draft,
    'restored_from', v_source_pub.version_id
  );
end;
$$;

revoke all on function mts_sam.restore_published_content_version(text, text, text, boolean, text) from public, anon;
grant execute on function mts_sam.restore_published_content_version(text, text, text, boolean, text) to authenticated, service_role;

-- ============================================================
-- 9. RPC: get_published_content
--    Returns current published content for a domain.
--    SERVICE_ROLE ONLY — called by mts-content-read Edge Function
--    after installation credential verification.
-- ============================================================

create or replace function mts_sam.get_published_content(
  p_domain text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_domain text;
  v_pub mts_sam.content_publications%rowtype;
begin
  v_domain := lower(btrim(coalesce(p_domain, '')));
  if v_domain not in ('callers', 'discord_posts') then
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_DOMAIN',
      'error', 'Unsupported content domain.');
  end if;

  select * into v_pub
  from mts_sam.content_publications
  where domain = v_domain and is_current = true
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'NO_PUBLICATION',
      'error', 'No published content available for domain: ' || v_domain);
  end if;

  return jsonb_build_object(
    'ok', true,
    'domain', v_domain,
    'version_id', v_pub.version_id,
    'content_hash', v_pub.content_hash,
    'item_count', v_pub.item_count,
    'published_at', v_pub.published_at,
    'content', v_pub.content_json
  );
end;
$$;

-- SERVICE_ROLE ONLY — no anon, no authenticated
revoke all on function mts_sam.get_published_content(text) from public, anon, authenticated;
grant execute on function mts_sam.get_published_content(text) to service_role;

-- ============================================================
-- 10. Update get_shadow_domain_data to include discord_post_library
-- ============================================================

-- Add discord_posts as a recognized domain in the shadow data RPC.
-- This is a CREATE OR REPLACE that adds the new domain case while preserving all existing ones.
-- We only add the new WHEN clause; existing function body is preserved by the migration tool.
-- NOTE: The full function replacement is needed because PL/pgSQL does not support partial CASE additions.

-- We'll use a simpler approach: create a small wrapper that handles the new domain
-- and delegates to the existing function for everything else.

create or replace function mts_sam.get_shadow_domain_data_v2(
  p_domain text,
  p_limit integer default 5000,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
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

  if v_norm_domain in ('discord_posts', 'discord_post_library') then
    select coalesce(jsonb_agg(sub.item), '[]'::jsonb) into v_result
    from (
      select to_jsonb(dp.*) as item
      from mts_sam.discord_post_library dp
      order by dp.display_order, dp.id
      limit v_limit offset v_offset
    ) sub;

    return jsonb_build_object('ok', true, 'domain', 'discord_post_library',
      'rows', v_result, 'count', coalesce(jsonb_array_length(v_result), 0));
  end if;

  -- Delegate to existing function for all other domains
  return mts_sam.get_shadow_domain_data(p_domain, p_limit, p_offset);
end;
$$;

revoke all on function mts_sam.get_shadow_domain_data_v2(text, integer, integer) from public, anon, authenticated;
grant execute on function mts_sam.get_shadow_domain_data_v2(text, integer, integer) to service_role;

-- ============================================================
-- End of migration
-- ============================================================
