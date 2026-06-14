# Supabase Setup for MTS and SAM

## Purpose

This guide documents the manual Supabase setup needed for the planned shared account system. The current branch only adds schema and planning docs. It does not connect MTS or SAM to Supabase yet.

## Create or Select a Supabase Project

Use one Supabase project for both MTS and SAM so the two apps share users, roles, alerts, and acknowledgements.

Recommended project settings:

- Enable email/password Auth.
- Keep email confirmation based on the production support model.
- Keep JWT expiry reasonably short for admin-heavy workflows.
- Do not put service role keys in Electron, React, or any packaged app artifact.

## Apply the Migration

From this repo, after linking a Supabase project:

```powershell
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

For local development:

```powershell
supabase start
supabase migration up
```

The migration file is:

```text
supabase/migrations/20260614083525_shared_user_accounts_targeted_alerts.sql
```

## First Admin User

After creating the first Auth user, promote that user manually in Supabase SQL Editor:

```sql
update public.profiles
set role = 'admin',
    updated_at = now()
where email = 'admin@example.com';
```

Replace `admin@example.com` with the real admin email. Do not paste passwords, tokens, private keys, or service role keys into docs or chat.

## Values Needed Later in App Environment

Later implementation branches will need these non-secret client values:

- Supabase project URL
- Supabase publishable key or anon key

Later backend/admin-only tooling may need a secret value, but it must never be bundled into Electron or frontend code:

- Supabase service role key, only for trusted server-side maintenance if a later branch explicitly needs it

Do not commit any `.env` file containing real secrets.

## Auth and Profile Flow

Planned flow:

1. User signs up or is invited with email/password.
2. Supabase Auth creates `auth.users` row.
3. Migration trigger creates `public.profiles` row.
4. Admin updates role when needed.
5. MTS and SAM later read the profile using the signed-in user's session.

Authorization should use `public.profiles.role`. Do not trust user-editable metadata for role decisions.

## SAM Targeted Alert Flow

Planned SAM alert flow:

1. Admin or trainer creates a row in `sam_alerts`.
2. Target rows are inserted into `sam_alert_targets`.
3. SAM clients read only alerts visible through RLS:
   - everyone
   - current user id
   - current user's role
4. User acknowledges the alert.
5. SAM writes `sam_alert_acknowledgements`.

Future device support can use `sam_devices` for desktop and PWA/mobile tracking.

## MTS Session Association Flow

The existing local and Google Sheet workflows stay active.

Later branches can add optional Supabase association:

1. If logged in, attach `auth.uid()` to a session payload.
2. Store summarized session data in `mts_sessions`.
3. Keep local history and Google Sheet candidate tracking unchanged until a separate migration plan replaces or supplements them.

## Security Notes

- RLS is enabled on every table created by the migration.
- Private helper functions are in `app_private`.
- The service role key must not be exposed in Electron or frontend code.
- Users can update their own profile row, but a trigger prevents self-promotion or active/email changes.
- Admin/trainer alert creation is allowed by policy, but UI should still validate title, body, audience, targets, and expiration.

## Rollout Notes

Recommended rollout:

1. Apply migration in a Supabase test project.
2. Create two test users.
3. Promote one user to admin.
4. Confirm each user can read their own profile only.
5. Confirm admin can read profiles.
6. Insert alert targeted to everyone.
7. Insert alert targeted to one user.
8. Insert alert targeted to a role.
9. Confirm visibility from each test user.
10. Confirm acknowledgement insert works only for visible alerts.

No app UI should depend on this until a later branch explicitly wires optional login.
