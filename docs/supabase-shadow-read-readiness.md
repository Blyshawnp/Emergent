# MTS/SAM Supabase shadow-read readiness

Status: corrective shadow-read checkpoint in progress; shadow mode **NOT** activated.
Google Sheets remains the authoritative data provider.

## 2026-08-08 execution-framework checkpoint

The backend now has a deployed, plan-bound reconciliation and exact rollback framework.
`20260809025333_reconciliation_execution_engine.sql` is applied and its runtime probe,
security contract, synthetic transactions, and exact rollback were verified on the
linked hosted project. The CLI ignores serialized payloads and
reconstructs one fresh Sheets snapshot before checking the exact project, snapshot and
plan checksums, expiry, provider flags, zero-conflict state, approved 28-insert/one-update
shape, explicit acknowledgement, and task-level guard.

The migration contains only fixed entity RPC handlers, database locking, exact ownership,
lineage attribution, before-images, terminal accounting, rollback preview, and child-first
exact rollback. Only isolated synthetic reconciliation batches were executed and rolled
back; no production reconciliation, shadow activation, dual write, or provider cutover
occurred. Google Sheets and Apps Script remain authoritative.

## Failed-audit finding and correction

The implementation at `5f614af`, followed by test corrections `b9ee7b5` and
`c927a8b`, incorrectly reported mapped-domain readiness. The final read-only audit
proved that the lineage RPC existed but the importer bypassed it, and that only 6
of the 14 required logical comparison domains were implemented. That readiness
result was invalid.

This corrective checkpoint makes the RPC the only normal lineage insertion path,
implements an explicit comparison contract for all 14 domains, and refuses mapped
readiness without a current same-process comparison. Live parity and the corrective
migration deployment must still be recorded before this document may claim readiness.

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
| `20260803000000` | `mts_sam_lineage_rpc.sql` | Applied |
| `20260804015610` | `harden_mts_sam_lineage_rpc_outcomes.sql` | Applied and verified |
| `20260807000000` | `mts_sam_incremental_reconciliation.sql` | Applied planning/audit foundation |
| `20260809025333` | `reconciliation_execution_engine.sql` | Applied; hosted security/transaction/rollback verified |
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

`safe_upsert_lineage` now calls the narrow backend provider method
`insert_lineage_if_absent()`, which invokes the fixed PostgREST route
`/rest/v1/rpc/insert_lineage_if_absent` in schema `mts_sam`. Direct table upsert is
rejected by the provider, is not a normal lineage path, and there is no client-side
precheck correctness gate. The provider advertises the explicit `rpc_only` lineage
capability; comparison and production verification both fail closed without it.

The original `20260803000000` RPC could emit an extra race outcome or surface an
entity-side unique violation. Forward migration `20260804015610` replaces the
function without rewriting migration history and makes both unique identities
database-authoritative. The corrected RPC:

- Is atomic (single transaction)
- Uses `SECURITY DEFINER` with `SET search_path = ''`
- Is restricted to `service_role` only (revoked from public, anon, and authenticated)

The RPC returns one of:

| Result code | Meaning |
|---|---|
| `inserted` | Row successfully inserted |
| `already_exists_same_mapping` | Exact duplicate, safe to ignore |
| `conflict_source_maps_to_different_entity` | Source key already maps to a different entity |
| `conflict_entity_maps_to_different_source` | Entity already maps to a different source key |

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
| `env_shadow_mode` | ERROR | `MTS_SHADOW_COMPARE` remains disabled |
| `lineage_rpc_provider_method` | ERROR | Trusted RPC-only importer path is present |
| `shadow_comparison_current` | ERROR | Same-process comparison completed for all 14 domains with zero unexplained differences |
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
- Exits nonzero for any missing domain, domain error, incomplete run, quota exhaustion,
  or unexplained required-domain difference
- Requires the expected hosted project reference, the RPC-only lineage capability, and
  a same-process snapshot timestamp no more than 15 minutes old with a 64-character
  aggregate checksum, exactly one batch fetch, and no snapshot errors

### Required logical domains

| Domain | Sheets projection | Supabase projection |
|---|---|---|
| `candidates` | Latest candidate grouped from Candidate Sessions | candidates + latest candidate history + lineage |
| `candidate_sessions` | Candidate Sessions | candidate_sessions |
| `session_attempts` | Nonblank call result slots | session_attempts |
| `authoritative_candidate_status` | MTS/SAM authority rule | current_candidate_status_view |
| `candidate_tracking` | Tracking category projection | candidate_history_view category projection |
| `history` | Candidate Sessions history projection | candidate_sessions + current status |
| `headset_catalog` | headsets | headset_catalog |
| `headset_reviews` | headset-review-log | headset_reviews |
| `supervisor_transfers` | Pending Sup Transfers | supervisor_transfers |
| `newbie_shift_requests` | newbie-shift request projection | newbie_shift_requests |
| `candidate_corrections` | correction request projection | candidate_corrections |
| `pending_requests` | aggregate request projection | logical union of generic, Newbie Shift, and correction request tables |
| `recent_activity` | deterministic request activity projection | activity derived from the same canonical request union |
| `notifications` | sam-notifications | notifications |

Every domain emits identity, value, status, relationship, attempt, duplicate,
expected-difference, unexplained-difference, error, and readiness counts. A category
that does not apply to a domain is reported as zero rather than omitted.

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
  "not_implemented": [],
  "completed": true,
  "overall_readiness": "ready"
}
```

`overall_readiness` values: `ready`, `not_ready`, `incomplete`, `blocked_by_quota`, `error`.

---

## Current test totals

Exact totals are recorded from the final validation run; prior copied totals are not
readiness evidence. Focused tests cover RPC routing/outcomes/fail-closed behavior,
the exact 14-domain contract, mismatch categories, snapshot cache reuse, quota
handling, current-comparison readiness, and CLI exit codes.

---

## Shadow-read activation criteria

Before activating mapped-domain shadow reads, all of the following must be true:

- [ ] `verify-production` returns `ok=true` with zero ERRORs in the current run
- [ ] `compare-shadow` returns `overall_readiness='ready'` for all 14 domains in the current run
- [ ] Google Sheets quota demonstrated sufficient for regular comparison runs
- [x] Shadow mode disabled in production environment (`MTS_SHADOW_COMPARE` not set or false)
- [x] Dual writes disabled (`MTS_DUAL_WRITE_ENABLED` not set or false)
- [x] Provider remains `sheets` (`MTS_DATA_PROVIDER=sheets`)
- [x] Forward correction migration (`20260804015610`) applied and local/remote parity verified

### 2026-08-06 live correction checkpoint

The linked project is `xyfhikikddcqcmzbdvbj`; local and remote migration history
agree through `20260804015610`. Deployment preserved all 264 lineage rows, and an
existing exact mapping returned `already_exists_same_mapping` through the hosted
RPC. The corrected status/history views removed all final-attempt mismatches and
reduced unexplained differences from 296 to 67.

The fresh single-fetch Sheet snapshot had no fetch errors or retries. Readiness
remains `not_ready`: source changes after the last import include four candidate
sessions (and their eight projected attempts), four candidates, one supervisor
transfer, one headset review, one Newbie Shift request, and two status changes.
Five Newbie Shift requests are absent canonically because four distinct requests
were previously misclassified as duplicates and one is new. Two headset catalog
rows lack canonical lineage and timestamps, so their age remains unresolved.
Candidate-correction relationships now match all seven canonical rows. Request
identity is scoped by source tab, so the one cross-tab request-ID collision remains
two distinct records; all 16 canonical pending/activity records match exactly.
Canonical synchronization is still required for eight missing Newbie Shift and
candidate-deletion request records.

The aggregate-only incremental dry run considered 367 rows and reported 262 new,
84 changed, and 21 unchanged. That broad delta is not approved for execution: the
identity correction changes historical lineage keys, and the existing command does
not yet provide deterministic per-target accounting and rollback. Its non-dry-run
path fails closed. A separate, reviewed synchronization plan and explicit approval
are required.

**A separate explicit prompt is required to activate shadow reads** after this checkpoint
is reviewed and the above criteria are verified live.

### 2026-08-07 reconciliation-planner checkpoint

A fresh one-fetch, zero-retry comparison reproduced the same 67 unexplained logical
differences. The replacement incremental planner reduced those differences to 22
canonical inserts and one narrow session update, while separately reporting derived
effects. It blocked four candidates because no approved non-name candidate identity is
available, blocked their dependent sessions, and kept both timestamp-less headset rows
ambiguous. Ten historical standalone reviews and one historical unresolved review
relationship remain untouched.

Before/after hosted counts were identical, including 3 import batches and 264 lineage
rows. No synchronization, batch creation, lineage mutation, status write, shadow
activation, dual write, provider switch, or migration application occurred.

At that checkpoint, exact rollback accounting still required deployment of forward
migration `20260807000000_mts_sam_incremental_reconciliation.sql` and resolution of the
identity/provenance blockers. Both the later planner correction and the current hosted
execution-engine status are recorded in `docs/supabase-incremental-reconciliation-plan.md`.

---

## Full cutover criteria (future work)

| Criterion | Status |
|---|---|
| All 9 required config tabs mapped to canonical tables | Pending |
| All 6 `sam-authorized-users` enrolled in Supabase Auth with role mappings | Pending |
| `compare-shadow` zero unexplained differences for ALL domains (including attempts, status, history) | Pending |
| Explicit prompt to change `MTS_DATA_PROVIDER` to `supabase` | Pending |
| End-to-end smoke test against Supabase provider | Pending |
