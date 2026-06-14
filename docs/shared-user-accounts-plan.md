# Shared User Accounts Plan for MTS and SAM

## Scope

This is a Phase 1 planning and schema branch for a shared Supabase account system used by Mock Testing Suite and SAM. It does not wire login into either app, does not make login required, and does not replace the current local database or Google Sheet workflows.

The feature is intentionally isolated and easy to abandon. Removing the `supabase/` directory and these docs removes the branch impact.

## Goals

- Use one shared account system for MTS and SAM.
- Support Supabase Auth email/password login later.
- Store one profile per Supabase Auth user.
- Allow MTS to later use the logged-in profile as evaluator identity.
- Allow MTS sessions and history to later associate records with a logged-in user.
- Allow SAM to later send alerts to everyone, selected users, or selected roles.
- Allow SAM to later track alert acknowledgements.
- Keep SAM PWA/mobile support in the schema through device records.
- Never expose the Supabase service role key in Electron, React, or any frontend bundle.

## Roles

Supported roles:

- `admin`
- `trainer`
- `tester`
- `viewer`

Authorization decisions should come from `public.profiles.role`, not user-editable Auth metadata.

## Phase 1 Tables

### profiles

Stores account profile data for both MTS and SAM.

Columns:

- `id`
- `email`
- `full_name`
- `tester_name`
- `role`
- `active`
- `created_at`
- `updated_at`

Notes:

- `id` references `auth.users(id)`.
- A private trigger creates a default `tester` profile when a new Auth user is created.
- Non-admin users can update their own profile row, but a trigger blocks them from changing `email`, `role`, or `active`.

### user_settings

Stores user-specific settings by app scope.

App scopes:

- `shared`
- `mts`
- `sam`
- `sam-pwa`

This table can later hold preferences such as default view, notification preferences, or MTS identity overrides.

### mts_sessions

Reserved for future MTS session/history association with logged-in users.

The existing local history and Google Sheet flows remain the source of truth until a later branch explicitly wires this table.

### sam_alerts

Stores SAM alert content and lifecycle fields.

Alert audience modes:

- `everyone`
- `users`
- `roles`

Alerts are visible only when active, published, not expired, and targeted to the current user or role.

### sam_alert_targets

Stores target rows for each SAM alert.

Target types:

- `everyone`
- `user`
- `role`

### sam_alert_acknowledgements

Stores one acknowledgement per alert and user.

This supports future SAM acknowledgement reporting without changing the alert content table.

### sam_devices

Stores future device registrations for SAM desktop and PWA/mobile.

The schema stores hashed endpoint/token values for planning. The future implementation should avoid storing raw push tokens unless there is a clear encrypted-at-rest design.

## RLS Policy Plan

RLS is enabled on all public tables in the migration.

Policy goals implemented in the migration:

- Users can read their own profile.
- Users can update their own profile, with a trigger blocking privilege escalation.
- Admins can manage profiles.
- Users can read and update their own settings.
- Admins can manage user settings.
- Users can read and write their own future MTS session rows.
- Admins can manage future MTS session rows.
- Users can read active SAM alerts targeted to everyone, their user id, or their role.
- Admins and trainers can create and update SAM alerts.
- Only admins can delete SAM alerts.
- Users can acknowledge alerts visible to them.
- Admins can read acknowledgement and device rows for management.
- Users can manage their own device rows.

Private helper functions live in `app_private` so RLS checks can avoid recursive profile-table policy issues.

## Not Included in Phase 1

- No login UI.
- No account creation UI.
- No Supabase client wiring.
- No replacement for local settings, local history, Google Sheet lookup, or Google Sheet candidate tracking.
- No service role key in frontend or Electron.
- No SAM targeted alert UI.
- No push notification implementation.

## Future Implementation Order

1. Add environment loading for a Supabase URL and publishable key only.
2. Add an optional account status panel that does not block app use.
3. Add email/password login and logout.
4. Add profile read-only display in MTS and SAM.
5. Add optional tester identity mapping from `profiles.tester_name`.
6. Associate future MTS sessions with `auth.uid()` while preserving local and Sheet workflows.
7. Add SAM alert list read path using RLS.
8. Add admin/trainer alert creation UI.
9. Add acknowledgement actions.
10. Add SAM PWA/mobile device registration.

## Abandon Plan

To abandon this Phase 1 work before it is applied to a Supabase project:

1. Delete `supabase/migrations/20260614083525_shared_user_accounts_targeted_alerts.sql`.
2. Delete this document.
3. Delete `docs/supabase-setup-for-mts-sam.md`.
4. No app runtime code needs to be reverted because this branch does not wire Supabase into MTS or SAM.

If the migration has already been applied to a Supabase project, create a separate rollback migration after confirming no production data has been written.
