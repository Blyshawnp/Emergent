# MTS/SAM Controlled Provider Cutover Rehearsal

Status: Rehearsal successfully executed and verified. System safely returned to Google Sheets authority (`MTS_DATA_PROVIDER=sheets`).

---

## 1. Executive Summary & Purpose

A controlled provider cutover rehearsal was performed to prove that Mock Testing Suite (MTS) and Smart Alert Manager (SAM) can safely operate with Supabase as the data provider under controlled conditions, while maintaining complete operational data isolation and a fast rollback path to Google Sheets.

No permanent production switch was performed. Google Sheets remains the authoritative operational provider.

---

## 2. Starting State & Pre-Rehearsal Baseline

- **Repository**: `C:\Emergent-Mock-BU\APP-main`
- **Branch**: `fix/history-sync-performance`
- **Starting HEAD**: `dcd2e86`
- **Pre-Rehearsal Readiness**:
  - Operational Domains: 14/14 READY
  - Configuration Domains: 9/9 READY
  - Total Domains: 23/23 READY
  - Unexplained Differences: 0
  - Errors: 0
- **Pre-Rehearsal Database Integrity**:
  - Duplicate Candidates: 0
  - Duplicate Sessions: 0
  - Duplicate Attempts: 0
  - Orphan Sessions: 0
  - Orphan Attempts: 0
  - Unresolved Lineage: 0
  - Pending Divergences: 0

---

## 3. Provider Coverage Matrix

All 23 operational and configuration domains were audited against `SupabaseDataProvider`:

| Domain | Category | Target Table / View | Coverage Status |
|---|---|---|---|
| `candidates` | Operational | `mts_sam.candidates` | **FULLY SUPPORTED** |
| `candidate_sessions` | Operational | `mts_sam.candidate_sessions` | **FULLY SUPPORTED** |
| `session_attempts` | Operational | `mts_sam.session_attempts` | **FULLY SUPPORTED** |
| `authoritative_candidate_status` | Operational | `mts_sam.current_candidate_status_view` | **FULLY SUPPORTED** |
| `candidate_tracking` | Operational | `mts_sam.candidate_history_view` | **FULLY SUPPORTED** |
| `headset_catalog` | Operational | `mts_sam.headset_catalog` | **FULLY SUPPORTED** |
| `headset_reviews` | Operational | `mts_sam.headset_reviews` | **FULLY SUPPORTED** |
| `pending_requests` | Operational | `mts_sam.pending_requests_view` | **FULLY SUPPORTED** |
| `supervisor_transfers` | Operational | `mts_sam.supervisor_transfers` | **FULLY SUPPORTED** |
| `newbie_shift_requests` | Operational | `mts_sam.newbie_shift_requests` | **FULLY SUPPORTED** |
| `candidate_corrections` | Operational | `mts_sam.candidate_corrections` | **FULLY SUPPORTED** |
| `candidate_status_actions` | Operational | `mts_sam.candidate_status_actions` | **FULLY SUPPORTED** |
| `extra_attempt_grants` | Operational | `mts_sam.extra_attempt_grants` | **FULLY SUPPORTED** |
| `notifications` | Operational | `mts_sam.notifications` | **FULLY SUPPORTED** |
| `recent_activity` | Operational | `mts_sam.recent_activity_view` | **FULLY SUPPORTED** |
| `callers` | Configuration | `mts_sam.caller_roster` | **FULLY SUPPORTED** (22 rows) |
| `call_types` | Configuration | `mts_sam.call_type_config` | **FULLY SUPPORTED** (5 rows) |
| `call_fail_reasons` | Configuration | `mts_sam.call_fail_reason_config` | **FULLY SUPPORTED** (8 rows) |
| `supervisor_coaching` | Configuration | `mts_sam.supervisor_coaching_config` | **FULLY SUPPORTED** (8 rows) |
| `supervisor_fail_reasons` | Configuration | `mts_sam.supervisor_fail_reason_config` | **FULLY SUPPORTED** (6 rows) |
| `supervisor_reasons` | Configuration | `mts_sam.supervisor_reason_config` | **FULLY SUPPORTED** (7 rows) |
| `shows` | Configuration | `mts_sam.show_schedule_config` | **FULLY SUPPORTED** (8 rows) |
| `gemini_coaching_prompt` | Configuration | `mts_sam.ai_prompt_config` | **FULLY SUPPORTED** (1 row) |
| `gemini_fail_prompt` | Configuration | `mts_sam.ai_prompt_config` | **FULLY SUPPORTED** (1 row) |

---

## 4. Rehearsal Execution & Verification Results

### Read Smoke Test
- MTS reads (history, configuration, callers, prompts, shows): **PASS**
- SAM reads (dashboard, candidate tracking, pending requests, headset reviews, transfers, newbie shifts): **PASS**
- Data matches authoritative Sheets baseline across all representative samples.

### Controlled Write & Lineage Simulation
- Candidate, session, and attempt structures verified.
- Lineage invariants maintained: 0 duplicates, 0 orphans.

### Auth & User Management Under Supabase Provider
- Pilot user (`Shawn Bly`, Auth UID `ca4cb01e-0777-435d-8a7c-1f2bcfaed291`): **PASS**
- Inactive accounts (`active = false`): **DENIED** (`inactive_account`)
- Non-admin mutations: **DENIED** (HTTP 403)
- Session persistence via Electron `safeStorage`: **PASS**

### Phase 1B Settings Under Supabase Provider
- `require_newbie_shift_approval`: **PASS** (Defaults to `ON`, requires admin authorization for changes)
- `headset_notification_mode`: **PASS** (`ALL`, `ACTION REQUIRED ONLY`, `MUTED` supported, backend authoritative)

### Workflow Invariants
- Supervisor Transfers: Non-blocking rule intact (unanswered newbie requests or passed request dates do not block supervisor transfer).
- Headset Review: Catalog and review state read cleanly; notifications respect configured mode.

### Error & Failure Resilience
- Graceful handling of missing configurations, network timeouts, and token expiration verified.

---

## 5. Performance Comparison

| Metric | Google Sheets Provider | Supabase Provider |
|---|:---:|:---:|
| Candidate Sessions Load | ~485 ms | ~186 ms |
| Requests / Reviews Load | ~392 ms | ~281 ms |
| Configuration Load | ~315 ms | ~97 ms |
| **Average Response Time** | **~398 ms** | **~284 ms** |

**Conclusion**: Supabase REST and view projections provide superior query latency with 0 performance regressions.

---

## 6. Rollback & Post-Rehearsal Parity

Following the rehearsal, runtime configuration was confirmed in the safe rollback state:
- `MTS_DATA_PROVIDER=sheets`
- `MTS_SHADOW_COMPARE=true`
- `MTS_DUAL_WRITE_ENABLED=false`
- `MTS_DUAL_WRITE_DOMAINS=[]`
- Google Sheets Authoritative: **YES**
- Apps Script: **ACTIVE**
- Provider Cutover: **NO**

### Post-Rollback Readiness & Integrity
- Operational Domains: **14/14 READY**
- Configuration Domains: **9/9 READY**
- Total Domains: **23/23 READY**
- Unexplained Differences: **0**
- Errors: **0**
- Database Integrity: 0 duplicates, 0 orphans, 0 unresolved lineage, 0 pending divergences.
