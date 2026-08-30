# Smart Alert Manager (SAM) Supabase Auth Enrollment

Status: Controlled Supabase Auth enrollment verified. Operational provider remains Google Sheets (`MTS_DATA_PROVIDER=sheets`). No provider cutover.

---

## 1. Overview & Architecture

SAM supports Supabase Auth email/password authentication alongside persistent session encryption via Electron `safeStorage`, password recovery through deep links (`smartalertmanager://reset-password`), and fallback legacy PIN authorization.

Operational data authority remains 100% Google Sheets. Supabase Auth is isolated to application identity, authorization, and administrative user management.

---

## 2. Current User Inventory & Classification

All 6 known application users are cataloged in `mts_sam.app_users` with role assignments in `mts_sam.user_role_assignments`:

| Safe User ID | Display Name | Role | Active | Email Available | Auth Linked | Classification |
|---|---|---|:---:|:---:|:---:|---|
| `c6cdf86b-9624-dc61-cfc9-acd33d4aee9a` | Shawn Bly | owner / administrator | YES | YES | YES | **AUTH ACTIVE / ENROLLED** |
| `3b6adb57-c87d-bd76-f5de-da6a177b8226` | Ashley Shealey | admin / administrator | NO | NO | NO | **LEGACY INACTIVE / NOT ENROLLED (WAITING FOR EMAIL)** |
| `6f650f78-3912-2ebc-d056-8ab70f6e72ae` | Becky Sowles | admin / administrator | NO | NO | NO | **LEGACY INACTIVE / NOT ENROLLED (WAITING FOR EMAIL)** |
| `31b16aca-e998-faa9-6f62-7dc34856ec3f` | Lisa Byrd | admin / administrator | NO | NO | NO | **LEGACY INACTIVE / NOT ENROLLED (WAITING FOR EMAIL)** |
| `dacfcf7b-add6-93a6-c9ae-cacfd8f262b8` | Kristi Green | admin / administrator | NO | NO | NO | **LEGACY INACTIVE / NOT ENROLLED (WAITING FOR EMAIL)** |
| `3a5b1c6f-8d17-50ef-9b4f-a39b70fc13cb` | Kimberly O'brien | admin / administrator | NO | NO | NO | **LEGACY INACTIVE / NOT ENROLLED (WAITING FOR EMAIL)** |

### Classification Totals:
- **Total Application Users**: 6
- **Active Users**: 1
- **Inactive Users**: 5
- **Supabase Auth Enrolled**: 1
- **Not Enrolled**: 5
- **Waiting for Email**: 5

---

## 3. Inactive-User Security Policy

- **No Usable Credentials**: Inactive users have no usable credentials in Supabase Auth.
- **Login Blocked**: `verify_sam_authorization` RPC inspects `v_user.active` and immediately rejects inactive accounts (`inactive_account`).
- **PIN Fallback Blocked**: `_complete_sam_setup` and Apps Script `completeSamSetup` verify the `enabled` flag; inactive records return `setup_authorization_failed` and are strictly denied.
- **JWT Protection**: Tokens for inactive users cannot access SAM endpoints.
- **Recovery Protection**: Password recovery does not activate inactive accounts.
- **Last Owner Guard**: `set_sam_user_active` RPC prevents deactivating the last active owner account.

---

## 4. Pilot User Verification

- **Pilot User**: Shawn Bly
- **Auth UID**: `ca4cb01e-0777-435d-8a7c-1f2bcfaed291`
- **App User ID**: `c6cdf86b-9624-dc61-cfc9-acd33d4aee9a`
- **Email**: `blyshawnp@gmail.com`
- **Linkage Status**: Verified (app_users <-> auth.users <-> user_role_assignments)
- **Role**: `owner` / `administrator`
- **Session Lifecycle**: Normal sign-in, encrypted session persistence, app restart, role validation, and logout tested and passing.

---

## 5. Least-Privilege & Row-Level Security (RLS)

- **Anon Role**: Anon has zero direct table access and zero DML privileges on `mts_sam` tables. Operational DML is strictly denied.
- **Authenticated Role**: Authenticated users can read their own user record (`app_users`) and assigned roles (`app_roles`, `user_role_assignments`) via RLS policies (`app_users_read_self_or_admin`, etc.).
- **Service Role**: Granted full privileges for trusted server-side API execution only. The service-role key is never packaged in frontend or desktop assets.

---

## 6. Email Enrollment & Password Rules

- **No Fabricated Emails**: Inactive legacy users without verified emails remain classified as `WAITING FOR EMAIL`.
- **No PIN Conversion**: Legacy PINs are never converted into passwords or used as temporary credentials.
- **Activation Flow**: When an Admin activates a user and associates a verified email, the user sets their password through the secure password reset/onboarding flow (`smartalertmanager://reset-password`).
