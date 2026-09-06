# Smart Alert Manager (SAM) Supabase Auth Enrollment & User Management

Status: Post-cutover stabilization active. Authoritative data and identity provider is **Supabase** (`MTS_DATA_PROVIDER=supabase`).

---

## 1. Overview & Security Architecture

SAM uses Supabase Auth email and password authentication with persistent session encryption via Electron `safeStorage`, password recovery through deep links (`smartalertmanager://reset-password`), and fallback legacy PIN authorization for emergency recovery.

### Zero Packaged Service-Role Key Guarantee
The packaged SAM application (including its local FastAPI backend `backend/server.py` and React UI) runs on client Windows machines and is treated as an **untrusted client runtime boundary**.

- `SUPABASE_SERVICE_ROLE_KEY` is **NEVER** bundled with SAM, written to `runtime_config.json`, placed in packaged environment defaults, written to disk, or exposed to Electron/React.
- Automated packaging tests (`backend/test_packaged_security.py`) assert that `SUPABASE_SERVICE_ROLE_KEY` is completely absent from packaged configuration and codebases.

### Remote Security Boundary & JWT-Derived Authorization
All privileged administrative operations are executed within the hosted Supabase database and Edge Function boundary:
- Hosted Supabase Edge Function `sam-admin-enroll-user`: Securely executes first-time GoTrue Auth user creation via GoTrue Admin API (`adminClient.auth.admin.inviteUserByEmail`), collision verification, safe linking to `mts_sam.app_users.auth_user_id`, and setup invitation dispatch.
- PostgreSQL `security definer` RPCs (restricted to `authenticated` and `service_role`; revoked from `anon`):
  - `mts_sam.get_sam_user_management_list(p_caller_auth_uid)`
  - `mts_sam.update_sam_user(p_target_user_id, p_email, p_role, p_active, p_caller_auth_uid)`
  - `mts_sam.set_sam_user_active(p_caller_auth_uid, p_target_user_id, p_active)`
  - `mts_sam.enroll_sam_user(p_target_user_id, p_caller_auth_uid)`

**Caller identity is derived exclusively from the verified Supabase Auth JWT (`auth.uid()`)**. Client-supplied caller IDs cannot be used to spoof an administrator or bypass authorization checks; mismatched client IDs are rejected with `CALLER_IDENTITY_MISMATCH`.

---

## 2. Canonical Authority

To avoid authorization drift and race conditions, authority is strictly segregated:
1. **Active / Inactive Status**: `mts_sam.app_users.active` is the single authoritative source of truth.
2. **Application Role**: `mts_sam.user_role_assignments.role_key` (`owner`, `administrator`) is the single authoritative source of truth.
3. **Contact Email & Timestamps**: `mts_sam.app_users.metadata->>'email'` stores normalized contact email; `metadata->>'invited_at'` tracks setup invitation dispatch timestamp.
4. **Auth Linkage**: `mts_sam.app_users.auth_user_id` links the local application user to `auth.users.id`.

---

## 3. Current User Inventory & Classification

All 6 application users are cataloged in `mts_sam.app_users` with role assignments in `mts_sam.user_role_assignments`:

| Safe User ID | Display Name | Role | Active | Email Stored | Auth Linked | Enrollment Status | Classification / Operational State |
|---|---|---|:---:|:---:|:---:|---|---|
| `c6cdf86b-9624-dc61-cfc9-acd33d4aee9a` | Shawn Bly | owner | YES | YES | YES | `Active / Enrolled` | **AUTH ACTIVE / ENROLLED (OWNER)** |
| `3b6adb57-c87d-bd76-f5de-da6a177b8226` | Ashley Shealey | administrator | NO | NO | NO | `Inactive / No Email` | **AWAITING TWO OWNER-PROVIDED EMAIL MAPPINGS** |
| `6f650f78-3912-2ebc-d056-8ab70f6e72ae` | Becky Sowles | administrator | NO | NO | NO | `Inactive / No Email` | **AWAITING TWO OWNER-PROVIDED EMAIL MAPPINGS** |
| `31b16aca-e998-faa9-6f62-7dc34856ec3f` | Lisa Byrd | administrator | NO | NO | NO | `Inactive / No Email` | **LEGACY INACTIVE / NOT ENROLLED** |
| `dacfcf7b-add6-93a6-c9ae-cacfd8f262b8` | Kristi Green | administrator | NO | NO | NO | `Inactive / No Email` | **LEGACY INACTIVE / NOT ENROLLED** |
| `3a5b1c6f-8d17-50ef-9b4f-a39b70fc13cb` | Kimberly O'brien | administrator | NO | NO | NO | `Inactive / No Email` | **LEGACY INACTIVE / NOT ENROLLED** |

### Current State Summary:
- **Total Users**: 6
- **Active Enrolled Owner**: 1 (Shawn Bly)
- **Inactive Legacy Users**: 5
- **Awaiting Owner-Provided Emails**: Ashley Shealey and Becky Sowles (ready for direct entry in `Settings -> User Management`).
- **No Fabricated Emails**: Inactive users have no fabricated or placeholder emails assigned.

---

## 4. Two-Step User Preparation Lifecycle (Hard Invariant)

User preparation and email invitation are strictly decoupled into two discrete steps:

### Step 1: Prepare Account (No Email Sent)
- The Owner or Administrator opens `Settings -> User Management`.
- Clicking **Edit** opens a dialog to configure the user's real contact email and application role.
- Clicking **Activate** or **Deactivate** updates the account status.
- **Invariant**: Saving updates in Step 1 strictly persists the data via `update_sam_user` or `set_sam_user_active` **WITHOUT sending any email** (no welcome, invite, setup, or recovery email is dispatched).

### Step 2: Send Account Setup (Explicit Email Dispatch)
- Once an email address is configured, the **Send Setup** button becomes enabled.
- Account setup email is dispatched **ONLY** when the Owner/Admin explicitly clicks **Send Setup** (or **Reset PW**).
- Clicking **Send Setup** executes the hosted Edge Function `sam-admin-enroll-user` with caller JWT verification.
  - If the user does not exist in `auth.users`, it calls `adminClient.auth.admin.inviteUserByEmail`, creating the new authentication identity and dispatching an invitation email to set their password.
  - If the user already exists in `auth.users`, it verifies no conflicting application user is linked, links `auth_user_id`, and dispatches password recovery.
  - Sets `invited_at` timestamp in `mts_sam.app_users.metadata`.
- The user receives an email inviting them to set their password on first login.

---

## 5. Sole Active Owner Protection

To prevent accidental lockout:
- `mts_sam.update_sam_user` and `mts_sam.set_sam_user_active` enforce a database-level constraint preventing the sole active Owner from being deactivated or demoted to administrator.
- The UI proactively disables deactivation and demotion when only one active Owner exists.

---

## 6. Dedicated Settings Interface

SAM provides a dedicated first-class `SettingsModal` accessible via a dedicated header toolbar button with gear icon and visible `Settings` text:
- **General**: Device preferences (volume, status banner duration, default candidate filter, search archive toggle, update check).
- **Workflow**: `require_newbie_shift_approval` policy control.
- **Notifications**: `headset_notification_mode` alert policy control.
- **Account & Security**: Signed-in operator profile, password update subform, email update subform, and logout.
- **User Management**: Authorized SAM operator roster, status badges, edit email/role dialog, activate/deactivate toggle, and setup invitation triggers.

`HelpModal` is dedicated pure documentation with an informative notice and button redirecting users to Settings.

---

## 26. Class B Rollback Warning (Post-Cutover)

> [!WARNING]
> **CLASS B ROLLBACK WARNING: POST-CUTOVER GOOGLE SHEETS FALLBACK**
>
> Because production cutover is complete and Supabase is actively authoritative (`MTS_DATA_PROVIDER=supabase`), Google Sheets is classified as **STALE RELATIVE TO SUPABASE**.
>
> In the event that a rollback to Google Sheets is ever required:
> 1. **DO NOT** blindly set `MTS_DATA_PROVIDER=sheets`.
> 2. Quiesce active writes across MTS and SAM.
> 3. Perform a full Supabase mutation inventory of all candidate sessions, attempt logs, call outcomes, form corrections, supervisor transfers, and newbie shift requests created since cutover (`2026-08-31T03:01:15-04:00`).
> 4. Run reverse reconciliation to backfill all post-cutover mutations into Google Sheets.
> 5. Verify 100% data parity between Supabase and Google Sheets.
> 6. Only after parity is verified may `MTS_DATA_PROVIDER=sheets` be activated.
