# MTS/SAM Production Provider Cutover Runbook & Execution Record

This document defines the authoritative record and ongoing operational runbook for Mock Testing Suite (MTS) and Smart Alert Manager (SAM) following the production cutover from Google Sheets to Supabase.

---

## 0. Production Cutover Execution Record

- **Cutover Status**: **PRODUCTION SUPABASE CUTOVER COMPLETE — STABILIZATION ACTIVE**
- **Cutover Start Window**: `2026-08-31T03:01:15-04:00` (`2026-08-31T07:01:15Z`)
- **Cutover Completion Timestamp**: `2026-08-31T03:05:00-04:00` (`2026-08-31T07:05:00Z`)
- **Approved Baseline Commit**: `09b6cdd`
- **Branch**: `fix/history-sync-performance`
- **Active Authoritative Provider**: **Supabase** (`MTS_DATA_PROVIDER=supabase`)
- **Steady-State Runtime Configuration**:
  - `MTS_DATA_PROVIDER=supabase`
  - `MTS_SHADOW_COMPARE=false`
  - `MTS_DUAL_WRITE_ENABLED=false`
  - `MTS_DUAL_WRITE_DOMAINS=[]`
- **Pre-Cutover Baseline Parity**:
  - Operational Domains: `14/14 READY`
  - Configuration Domains: `9/9 READY`
  - Total: `23/23 READY`
  - Unexplained Differences: `0`
  - Comparator Errors: `0`
- **Post-Cutover Database Integrity**:
  - Duplicate Candidates: `0`
  - Duplicate Sessions: `0`
  - Duplicate Attempts: `0`
  - Orphan Sessions: `0`
  - Orphan Attempts: `0`
  - Unresolved Lineage: `0`
  - Pending Divergences: `0`
- **Post-Cutover Smoke Test Results**:
  - 23-Domain Supabase Reads: `PASS (2.5s across 23 domains)`
  - Pilot Admin Auth Verification: `PASS (Shawn Bly / Owner / Active)`
  - Inactive User Denial: `PASS (5 inactive accounts blocked)`
  - Controlled MTS Candidate Lifecycle Write: `PASS`
  - Controlled Session & Attempt Persistence: `PASS`
  - Clean Entity Tear-Down: `PASS (Zero residue)`
- **Full Regression Test Status**:
  - Backend Unit Suite: `562 / 562 PASS (100%)`
  - Frontend Test Suite: `358 / 358 PASS (100%)`
  - Desktop Test Suite: `16 / 16 PASS (100%)`
  - Apps Script Authorization Suite: `36 / 36 PASS (100%)`
  - Total Test Count: `972 / 972 PASS (100%)`

---

## 1. Post-Cutover Operational Architecture & Infrastructure Roles

### Supabase Role (Production Authority)
- **Classification**: **Authoritative Production Data Store & Identity Provider**.
- All live MTS candidate sessions, attempt logs, call outcomes, form corrections, supervisor transfers, and newbie shift requests persist directly to Supabase via `SupabaseDataProvider`.
- Row-Level Security (RLS) is forced across all 23 canonical and configuration tables. Public/anonymous DML is revoked.

### Google Sheets Role (Post-Cutover)
- **Classification**: **Read-Only Archive & Emergency Fallback Reference**.
- Sheets access remains active during the stabilization window.
- The Google Sheets workbook is retained as an operational fallback in the event of an unforeseen disaster recovery scenario.
- **Rollback Rule**: Once Supabase accepts new production writes, Sheets is classified as `STALE RELATIVE TO SUPABASE`. Switching provider back to Sheets requires reverse reconciliation (Class B rollback) to prevent data loss.

### Apps Script Role (Post-Cutover)
- **Classification**: **Retained Non-Authoritative / Legacy Support**.
- Apps Script is NOT disabled during cutover or the initial stabilization window.
- It remains available as a secondary integration interface for legacy maintenance.

### Dual-Write Role (Post-Cutover)
- **Setting**: `MTS_DUAL_WRITE_ENABLED=false`, `MTS_DUAL_WRITE_DOMAINS=[]`.
- *Note*: The existing `DualWriteManager` is specifically engineered as a forward Sheets-first mirror. No reverse dual-write exists or should be enabled.

---

## 2. Post-Cutover Rollback Procedures

### Class A — Immediate Pre-Write Rollback
If cutover rollback is required BEFORE any Supabase-only production writes occur:
1. Revert environment variables:
   ```bash
   MTS_DATA_PROVIDER=sheets
   MTS_SHADOW_COMPARE=true
   MTS_DUAL_WRITE_ENABLED=false
   MTS_DUAL_WRITE_DOMAINS=[]
   ```
2. Restart backend processes.
3. Google Sheets immediately resumes operational authority with zero data loss.

### Class B — Post-Write Rollback (Reconciliation Required)
If Supabase has accepted new production writes after cutover:
1. **DO NOT** blindly switch `MTS_DATA_PROVIDER=sheets`.
2. Quiesce active writes.
3. Identify all Supabase mutations created since `2026-08-31T03:01:15-04:00`.
4. Export and apply those mutations to Google Sheets via reconciliation script.
5. Confirm Sheets parity.
6. Only then switch `MTS_DATA_PROVIDER=sheets`.

---

## 3. Stabilization Window & Monitoring (14–30 Days)

A 14-to-30 day stabilization window is now active.

### Monitoring Objectives
- Monitor Supabase query latencies, connection pool health, and RPC execution times.
- Observe natural event-based canaries when real production events occur:
  - `candidate_corrections`
  - `extra_attempt_grants`
  - `candidate_status_actions`
- Retain full rollback capability and backup snapshots throughout this period.

---

## 4. Final Sheets Retirement Criteria

Google Sheets operational fallback may be decommissioned only when:
- 30 consecutive days of error-free Supabase operations are completed.
- Zero data loss incidents or rollbacks occur.
- All event-based canaries have been observed in live production.
- Formal sign-off on database backups and operational stability is granted.
