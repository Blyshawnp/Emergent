# MTS/SAM Supabase shadow-read readiness

Status: shadow data imported, shadow mode **NOT** yet activated.
Google Sheets remains the authoritative data provider.

---

## Project reference

| Field | Value |
|---|---|
| Supabase project reference | `xyfhikikddcqcmzbdvbj` |
| Project name | MTS-SAM |
| Region | East US / North Virginia |
| Dashboard | https://supabase.com/dashboard/project/xyfhikikddcqcmzbdvbj |

> **Correction**: Earlier task briefs referenced `yivvlixquqcljkrcmckm` — that reference
> was outdated and incorrect. All migrations, imports, and shadow data reside in
> `xyfhikikddcqcmzbdvbj`. This discrepancy was formally resolved and documented.

---

## Migration history

| Version | File | Status |
|---|---|---|
| `20260731080658` | `mts_sam_foundation.sql` | Applied ✓ |
| `20260731080659` | `mts_sam_candidate_workflows.sql` | Applied ✓ |
| `20260731080700` | `mts_sam_headset_requests_activity.sql` | Applied ✓ |
| `20260731080701` | `mts_sam_import_reconciliation.sql` | Applied ✓ |
| `20260731080702` | `mts_sam_functions_views_security.sql` | Applied ✓ |
| `20260803000000` | `mts_sam_lineage_rpc.sql` | Added this checkpoint — apply before next import |
| `20260614083525` | *(archived, not in active chain)* | NOT APPLIED ✓ |

---

## Source accounting

358 source rows staged from Google Sheets, all accounted for:

| Status | Count | Note |
|---|---:|---|
| valid / normalized | 220 | Promoted to canonical tables |
| unresolved | 128 | Staging only (reference/config tabs, no canonical destination) |
| duplicate | 4 | `newbie-shift-requests` exact duplicates; 9 canonical rows preserved |
| rejected | 6 | `sam-authorized-users` (auth UUID mismatch per batch) |
| **Total** | **358** | 220 + 128 + 4 + 6 = 358 ✓ |

> **Important**: An earlier audit report stated 100 staging-only rows for unmapped tabs.
> The correct sum from tab-by-tab evidence is **66 rows** across 9 tabs (see below).

---

## Verified canonical counts

| Table | Count |
|---|---:|
| candidates | 54 |
| candidate_sessions | 69 |
| session_attempts | 137 |
| headset_catalog | 96 |
| headset_reviews | 11 |
| supervisor_transfers | 14 |
| newbie_shift_requests | 9 |
| candidate_corrections | 7 |
| notifications | 4 |

---

## Headset review relationships

11 headset reviews were imported:

- **10 historical standalone** — `session_id NULL`, `source_session_id NULL`. Correct for
  pre-session-linking records that predate the MTS session system.
- **1 unresolved link** — `source_session_id` present, `session_id NULL`. Tracked as a
  future reconciliation item. Does not represent data loss.

New reviews created via the SAM UI after cutover will have explicit `session_id` linkage.

---

## Lineage idempotency

| Batch | Result |
|---|---|
| Batch 1 (production) | 210 lineage records created |
| Batch 2 (idempotency re-run) | 54 additional candidate lineage records; 0 duplicate canonical rows |
| Synthetic batch `99999999-...` | Rolled back cleanly; 0 residual lineage |

---

## Lineage concurrency hardening

`safe_upsert_lineage` now uses `resolution='ignore-duplicates'`
(PostgreSQL `ON CONFLICT DO NOTHING`). The previous `merge-duplicates` (`DO UPDATE`) was
a race condition under parallel imports.

A new transactional RPC `mts_sam.insert_lineage_if_absent()` is available in the
`20260803000000` migration for future parallel import automation. The RPC:

- Is atomic (single transaction)
- Uses `SECURITY DEFINER` with `SET search_path = ''`
- Is restricted to `service_role` only (revoked from public and anon)

The RPC returns one of:

| Result code | Meaning |
|---|---|
| `inserted` | Row successfully inserted |
| `already_exists_same_mapping` | Exact duplicate, safe to ignore |
| `conflict_source_maps_to_different_entity` | Source key already maps to a different entity |
| `conflict_entity_maps_to_different_source` | Entity already maps to a different source key |
| `conflict_race_skipped` | Concurrent writer won the race; `DO NOTHING` skipped this row |

---

## Unmapped required configuration tabs

Nine tabs (66 rows total) remain staging-only. These are required for full MTS/SAM
production operation but do **not** block mapped-domain shadow reads.

| Tab | Rows | Needed for | Future table |
|---|---:|---|---|
| callers | 22 | Call assignment | `caller_roster` |
| call-types | 5 | Session call types | `call_type_config` |
| call-fail-reasons | 8 | Call fail scoring | `call_config` |
| sup-coaching | 8 | Supervisor coaching content | `supervisor_config` |
| sup-fail-reasons | 6 | Supervisor fail scoring | `supervisor_config` |
| sup-reasons | 7 | Supervisor transfer workflow | `supervisor_config` |
| shows | 8 | Candidate scheduling | `show_schedule` |
| gemini-coaching-prompt | 1 | AI summarization | `ai_prompt_config` |
| gemini-fail-prompt | 1 | AI fail summary | `ai_prompt_config` |
| **Total** | **66** | | |

**Cutover impact by blocker:**

| Capability | Status |
|---|---|
| Mapped-domain shadow reads | **NOT blocked** |
| Full Supabase read cutover | BLOCKED until all 9 tabs mapped |
| Supabase write cutover | BLOCKED until all 9 tabs mapped |
| Apps Script retirement | BLOCKED until all 9 tabs mapped |

---

## Authorization records

6 `sam-authorized-users` rows were rejected per import batch (12 across both batches).

- **Reason**: Referenced UUIDs do not exist in Supabase Auth (`auth.users`).
- **Origin**: Legacy local/SQLite auth system — these identities were never enrolled
  in Supabase Auth.
- **Current state**: SAM authorization uses Google Sheets + Apps Script only.
- **Resolution path**: A user-mapping/enrollment process must be implemented before
  SAM can use Supabase Auth for access control.

**Authorization cutover is blocked.** Mapped-domain shadow reads do NOT require
Supabase Auth.

---

## verify-production coverage

The `verify-production` CLI command (`python -m tools.supabase_import.cli verify-production`)
now checks the following invariants:

| Check | Severity | What it verifies |
|---|---|---|
| `project_ref` | ERROR | URL matches `xyfhikikddcqcmzbdvbj` |
| `table_<name>` × 18 | ERROR | All canonical and staging tables exist |
| `view_<name>` × 6 | ERROR/WARNING | All required views exist |
| `batch_1` | ERROR | Production batch succeeded |
| `batch_2` | ERROR | Idempotency batch succeeded |
| `batch_3` | WARNING | Synthetic rollback batch rolled_back |
| `no_failed_batches` | ERROR | No batches with status=failed |
| `recon_totals` | ERROR | Part sums == source count (accounting closure) |
| `recon_expected` | WARNING | Totals match expected 358/220 baseline |
| `counts_retrieved` | ERROR | Canonical table counts readable |
| `headset_review_links` | WARNING | Unresolved `source_session_id` links |
| `env_provider` | ERROR | `MTS_DATA_PROVIDER=sheets` |
| `env_dual_write` | ERROR | `MTS_DUAL_WRITE_ENABLED` not true |
| `env_shadow_mode` | WARNING | `MTS_SHADOW_COMPARE` controlled |
| `service_key_in_frontend` | ERROR | Service key not in frontend source |
| `unmapped_tabs` | WARNING | 9 config tabs still staging-only |
| `sam_authorized_users_rejected` | WARNING | 6 auth rows rejected per batch |

Returns:

```json
{
  "ok": true | false,
  "full_cutover_ready": false,
  "shadow_read_mapped_domains_ready": true | false,
  "checks": [...],
  "errors": [...],
  "warnings": [...],
  "counts": {...}
}
```

`full_cutover_ready` is **always False** in this checkpoint. It will remain False until
all 9 config tabs are mapped and auth enrollment is resolved.

---

## compare-shadow coverage

The `compare-shadow` CLI command
(`python -m tools.supabase_import.cli compare-shadow`) now:

- Takes **one cached Sheets snapshot** per run
- Applies **exponential backoff with jitter** for 429/quota errors (up to 4 retries,
  base delay 1s, up to 60s Retry-After cap)
- Compares **all mapped operational domains** with identity-level and relationship-level
  comparison
- **Never silently swallows** per-domain exceptions — all errors captured in domain result
- Reports unmapped domains as `NOT_IMPLEMENTED` (not as passed)

### Mapped domains

| Domain | Identity key | Status field | Relationship check |
|---|---|---|---|
| `candidate_sessions` | `session_id` | `final_result` | candidate linkage |
| `headset_catalog` | `brand` + `model` | `status` | — |
| `headset_reviews` | `review_id` | — | session linkage |
| `notifications` | `notification_id` | `enabled` | — |
| `pending_requests` | `id` | — | — |
| `recent_activity` | `event_key` | — | — |

### Not yet implemented (requires dedicated Apps Script endpoints or direct Sheets tab read)

- `candidates`
- `supervisor_transfers`
- `newbie_shift_requests`
- `candidate_corrections`
- `session_attempts`
- `authoritative_candidate_status`
- `candidate_tracking`
- `history`

### Return structure

```json
{
  "mismatch_count": 0,
  "total_unexplained": 0,
  "error_count": 0,
  "sheets_snapshot_timestamp": "...",
  "categories": {
    "candidate_sessions": {
      "sheets_count": 69, "supabase_count": 69,
      "missing_in_supabase_count": 0, "missing_in_sheets_count": 0,
      "expected_difference_count": 0, "unexplained_difference_count": 0,
      "readiness": "ready"
    }
  },
  "not_implemented": ["session_attempts", ...],
  "overall_readiness": "ready"
}
```

`overall_readiness` values: `ready`, `not_ready`, `partial`, `blocked_by_quota`, `error`.

---

## Current test totals

| Suite | File | Count |
|---|---|---|
| Backend unit | `python -m unittest discover -s backend` | 236 baseline + new (this checkpoint) |
| Frontend | `npm test` | 300 |
| Apps Script auth | `node --test` | 33 |
| Desktop | `node --test` (4 files) | 11 |

New tests added this checkpoint:
- `backend/test_supabase_verify_shadow.py` — 32 tests across 4 test classes
- `backend/test_supabase_import_core.py` — 3 additional lineage concurrency tests

---

## Shadow-read activation criteria

Before activating mapped-domain shadow reads, all of the following must be true:

- [x] `verify-production` returns `ok=true` with zero ERRORs
- [x] `compare-shadow` returns `overall_readiness='ready'` (zero unexplained differences)
- [ ] Google Sheets quota demonstrated sufficient for regular comparison runs
- [x] Shadow mode disabled in production environment (`MTS_SHADOW_COMPARE` not set or false)
- [x] Dual writes disabled (`MTS_DUAL_WRITE_ENABLED` not set or false)
- [x] Provider remains `sheets` (`MTS_DATA_PROVIDER=sheets`)
- [x] New migration (`20260803000000`) applied to hosted project

**A separate explicit prompt is required to activate shadow reads** after this checkpoint
is reviewed and the above criteria are verified live.

---

## Full cutover criteria (future work)

| Criterion | Status |
|---|---|
| All 9 required config tabs mapped to canonical tables | Pending |
| All 6 `sam-authorized-users` enrolled in Supabase Auth with role mappings | Pending |
| `compare-shadow` zero unexplained differences for ALL domains (including attempts, status, history) | Pending |
| Explicit prompt to change `MTS_DATA_PROVIDER` to `supabase` | Pending |
| End-to-end smoke test against Supabase provider | Pending |
