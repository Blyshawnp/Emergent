# MTS/SAM Production Provider Cutover Runbook

This document defines the authoritative, staged procedure for transitioning Mock Testing Suite (MTS) and Smart Alert Manager (SAM) from Google Sheets operational authority to Supabase.

---

## 0. Production Cutover Approval Record

- **Approval Decision**: **APPROVED FOR PRODUCTION CUTOVER**
- **Approval Timestamp**: `2026-08-31T02:05:00-04:00`
- **Approved Baseline Commit**: `b6160ac`
- **Branch**: `fix/history-sync-performance`
- **Baseline Readiness**:
  - Operational Domains: `14/14 READY`
  - Configuration Domains: `9/9 READY`
  - Total: `23/23 READY`
  - Unexplained Differences: `0`
  - Comparator Errors: `0`
- **Database Integrity**:
  - Duplicate Candidates: `0`
  - Duplicate Sessions: `0`
  - Duplicate Attempts: `0`
  - Orphan Sessions: `0`
  - Orphan Attempts: `0`
  - Unresolved Lineage: `0`
  - Pending Divergences: `0`
- **Full Regression Test Status**:
  - Backend Unit Suite: `562 / 562 PASS (100%)`
  - Frontend Test Suite: `358 / 358 PASS (100%)`
  - Desktop Test Suite: `16 / 16 PASS (100%)`
  - Apps Script Authorization Suite: `36 / 36 PASS (100%)`
  - Total Test Count: `972 / 972 PASS (100%)`
- **Approval Matrix (12 / 12 Gates Approved)**:
  - DATA: `APPROVED`
  - PROVIDER: `APPROVED`
  - AUTH: `APPROVED`
  - RLS: `APPROVED`
  - CONFIG: `APPROVED`
  - MTS: `APPROVED`
  - SAM: `APPROVED`
  - ROLLBACK: `APPROVED`
  - BACKUP: `APPROVED`
  - PACKAGING: `APPROVED`
  - RUNBOOK: `APPROVED`
  - STABILIZATION: `APPROVED`

---

## 1. Cutover Overview & Staged Transition Strategy

The production cutover is executed in distinct, verifiable stages to guarantee zero data loss, zero unaccounted drift, and a fast, deterministic rollback to Google Sheets if an abort condition is triggered.

```
[ Stage A: Pre-Cutover Sync & Drift Verification ]
                     │
                     ▼
[ Stage B: Authoritative Write Freeze Window ]
                     │
                     ▼
[ Stage C: Zero-Drift & Lineage Invariant Confirmation ]
                     │
                     ▼
[ Stage D: Runtime Provider Switch (MTS_DATA_PROVIDER=supabase) ]
                     │
                     ▼
[ Stage E: Post-Cutover Production Smoke Tests ]
                     │
                     ▼
[ Stage F: Monitored Production Stabilization Window (14-30 days) ]
                     │
                     ▼
[ Stage G: De-emphasize / Retire Sheets Authority Post-Stability ]
```

---

## 2. Pre-Cutover Prerequisites & Validation

Before initiating Stage A, all of the following preconditions must be verified:

1. **Git Repository State**:
   - Clean working tree, no uncommitted changes, branch `fix/history-sync-performance` (or release tag).
   - No sensitive credentials, service role keys, or `.env` files in repository tracking.
2. **Supabase Target Verification**:
   - Hosted Project Reference: `xyfhikikddcqcmzbdvbj` (MTS-SAM, East US / North Virginia).
   - All 6 approved migrations applied and verified.
3. **23-Domain Baseline Readiness**:
   - `python backend/tools/supabase_import/cli.py compare-shadow` returns:
     - Operational Domains: `14/14 READY`
     - Configuration Domains: `9/9 READY`
     - Total: `23/23 READY`
     - Unexplained Differences: `0`
     - Comparator Errors: `0`
4. **Database Integrity Confirmation**:
   - Duplicate candidates: 0
   - Duplicate sessions: 0
   - Duplicate attempts: 0
   - Orphan sessions: 0
   - Orphan attempts: 0
   - Unresolved lineage: 0
   - Pending divergences: 0
5. **Full Test Suite Status**:
   - Backend unit suite: 100% PASS
   - Frontend test suite: 100% PASS
   - Desktop test suite: 100% PASS
   - Apps Script authorization suite: 100% PASS

---

## 3. Pre-Cutover Backup & Snapshot Plan

Immediately prior to Stage D (provider switch):

1. **Google Sheets Master Backup**:
   - Perform a named version snapshot in Google Sheets version history (e.g., `Pre-Cutover Baseline - [YYYY-MM-DD]`).
   - Export an offline snapshot of all 23 tabs to CSV / JSON archive.
2. **Supabase Database Snapshot**:
   - Trigger a project-level backup in the Supabase Dashboard.
   - Record exact table row counts across all canonical and configuration tables.
3. **Lineage & Audit State Capture**:
   - Capture row counts for `data_source_lineage`, `import_batches`, and `audit_events`.

---

## 4. Post-Cutover Roles & Infrastructure Strategy

### Google Sheets Role Post-Cutover
- **Classification**: **Read-Only Archive & Emergency Fallback**.
- Sheets access remains active during the stabilization window.
- The Google Sheets workbook is retained as an operational fallback in the event of an unforeseen disaster recovery scenario.

### Apps Script Role Post-Cutover
- **Classification**: **Retained Non-Authoritative / Legacy Support**.
- Apps Script is NOT disabled during cutover or the initial stabilization window.
- It remains available as a secondary integration interface.

### Dual-Write Strategy Post-Cutover
- **Setting**: `MTS_DUAL_WRITE_ENABLED=false`, `MTS_DUAL_WRITE_DOMAINS=[]`.
- *Note*: The existing `DualWriteManager` is specifically engineered as a forward Sheets-first mirror. No reverse dual-write exists or should be enabled.

### Shadow Comparator Post-Cutover
- After Supabase becomes authoritative, the comparator is retained for manual / diagnostic audits and historical reconciliation analysis.

---

## 5. Auth & User Management Cutover Policy

1. **Pilot Administrator**:
   - Shawn Bly (`ca4cb01e-0777-435d-8a7c-1f2bcfaed291`, `blyshawnp@gmail.com`) is verified with `owner` / `administrator` roles.
2. **Inactive Accounts (Waiting for Email)**:
   - 5 historical admin accounts (`Ashley Shealey`, `Becky Sowles`, `Lisa Byrd`, `Kristi Green`, `Kimberly O'brien`) remain `active = false` with `auth_user_id = null`.
   - Inactive accounts cannot log in via Supabase Auth or Legacy PIN fallback.
3. **Future Enrollment Policy**:
   - An Admin activates the user record in SAM User Management.
   - A valid email is provided and verified.
   - The user receives an onboarding password setup link (`smartalertmanager://reset-password`).
   - No legacy PINs are converted to passwords. No emails are fabricated.

---

## 6. Runtime Configuration & Cutover Execution Steps

### Step 1: Minimum Write Freeze
- Notify testers/admins of a brief 5-minute maintenance window.
- Verify no active test sessions are running.

### Step 2: Final Parity Confirmation
- Execute `python backend/tools/supabase_import/cli.py compare-shadow` to confirm 23/23 domains ready with 0 differences.

### Step 3: Provider Configuration Switch
- Apply runtime environment variables:
  ```bash
  MTS_DATA_PROVIDER=supabase
  MTS_SHADOW_COMPARE=false
  MTS_DUAL_WRITE_ENABLED=false
  MTS_DUAL_WRITE_DOMAINS=[]
  ```

### Step 4: Service Restart
- Restart MTS and SAM backend processes to bind to `SupabaseDataProvider`.

---

## 7. Post-Cutover Production Smoke Tests

Execute the following smoke test plan immediately after restart:

1. **SAM Dashboard & Navigation**:
   - Open SAM -> verify Dashboard loads candidate tracking, pending requests, and notifications without errors.
   - Verify Admin Settings panel loads `require_newbie_shift_approval` and `headset_notification_mode`.
   - Verify User Management loads current user roster with accurate activation states.
2. **MTS Startup & Configuration**:
   - Open MTS -> verify caller roster (22 callers), shows (8 shows), call types (5), and AI prompts load from Supabase.
   - Verify Candidate History loads existing completed sessions.
3. **Controlled Single Test Candidate Lifecycle**:
   - Enter candidate name `CUTOVER-TEST-CANDIDATE`.
   - Complete Call 1 -> Result: PASS.
   - Finalize Session -> verify session appears in History and SAM Candidate Tracking.
   - Verify 0 duplicate records and 0 orphan attempts in Supabase database.
4. **Controlled SAM Workflow Action**:
   - Execute one test notification acknowledgment or workflow status verification.

---

## 8. Cutover Abort Criteria & Immediate Rollback Procedure

### Abort Criteria (Hard STOP)
If any of the following occur during cutover or smoke testing, abort immediately:
- Baseline comparator reveals unexpected drift or errors prior to switch.
- MTS or SAM backend fails to initialize with Supabase provider.
- Supabase Auth fails for valid Admin credentials.
- Inactive user bypasses security controls.
- Any runtime candidate/session write fails or produces duplicate/orphan rows.
- High latency / database timeouts exceed 5 seconds.

### Immediate Rollback Procedure
To return immediately to Google Sheets authority:
1. Revert environment variables:
   ```bash
   MTS_DATA_PROVIDER=sheets
   MTS_SHADOW_COMPARE=true
   MTS_DUAL_WRITE_ENABLED=false
   MTS_DUAL_WRITE_DOMAINS=[]
   ```
2. Restart backend processes.
3. Verify Sheets authority is active and operational.

---

## 9. Stabilization & Retirement Roadmap

1. **Stabilization Window**:
   - Maintain a 14-to-30 day stabilization window.
   - Monitor query latencies, audit logs, and workflow completion.
   - Retain full rollback capability to Google Sheets throughout this period.
2. **Final Sheets Retirement Criteria**:
   - 30 consecutive days of error-free Supabase operations.
   - Zero rollbacks or data integrity failures.
   - Formal sign-off on database backups and operational stability.
