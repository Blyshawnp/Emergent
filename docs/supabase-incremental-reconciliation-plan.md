# MTS/SAM incremental reconciliation plan

Status: execution framework deployed and synthetically verified; the first controlled
production reconciliation attempt was rolled back exactly. Retry is blocked pending
resolution of a newly proven headset-review parent-session gap and a new approval cycle.

Google Sheets remains authoritative. `MTS_DATA_PROVIDER=sheets`, `MTS_SHADOW_COMPARE=false`, and `MTS_DUAL_WRITE_ENABLED=false` are mandatory. Shadow-read activation, provider cutover, and Apps Script retirement remain blocked.

## Previously approved plan shape (now blocked)

The approved read-only plan contains exactly 28 inserts, one narrow `candidate_sessions` update, and 28 new lineage mappings:

| Canonical target | Start | Insert | Update | Expected end |
|---|---:|---:|---:|---:|
| candidates | 54 | 4 | 0 | 58 |
| candidate_sessions | 69 | 4 | 1 | 73 |
| session_attempts | 137 | 8 | 0 | 145 |
| headset_catalog | 96 | 2 | 0 | 98 |
| headset_reviews | 11 | 1 | 0 | 12 |
| supervisor_transfers | 14 | 1 | 0 | 15 |
| newbie_shift_requests | 9 | 5 | 0 | 14 |
| pending_requests (candidate deletion only) | 0 | 3 | 0 | 3 |

The execution gate rejects any different entity/count shape. Candidate corrections, notifications, and derived projections are not direct writes in this batch.

The 2026-08-09 live attempt proved that the earlier planner classified one new headset
review as executable even though its referenced session was absent from both the source
session plan and hosted canonical sessions. The executor correctly rejected the row with
`parent_session_missing`, but only after 18 earlier inserts had committed. Exact rollback
removed those rows and their lineage. The repaired planner now classifies that review as
ambiguous with `parent_session_identity_unresolved`, producing a blocked 27+1 plan. The
28+1 shape above is historical approval evidence, not current execution authorization.

## Identity and plan binding

Candidate names are never identities. Candidates resolve through an existing canonical session, existing lineage, a persisted UUID, or a tab-aware UUIDv5 derived from a unique singleton history session UUID. Other identities are the source session ID, source action ID, normalized unique brand/model, review ID, transfer ID, or request ID (scoped by source tab where needed). Physical row numbers are not mutation identities.

`sync-incremental --execute` never accepts or trusts a serialized plan. It performs one fresh Sheets fetch, rereads current canonical and lineage state, reconstructs private payloads in memory, and recomputes both checksums. Execution requires:

- exact project `xyfhikikddcqcmzbdvbj`;
- the supplied fresh plan and snapshot checksums;
- an unexpired plan with zero ambiguous, unresolved, conflicting, or blocked items;
- exactly the approved 28-insert/one-update/28-lineage shape;
- Sheets primary, shadow false, dual-write false;
- the explicit CLI acknowledgement and task-level `MTS_SUPABASE_RECONCILIATION_EXECUTION_ACK` guard;
- the execution migration runtime probe and no active execution/rollback batch.

```powershell
.venv\Scripts\python.exe -m backend.tools.supabase_import.cli sync-incremental --execute `
  --project-ref xyfhikikddcqcmzbdvbj `
  --plan-checksum <sha256> `
  --snapshot-checksum <sha256> `
  --acknowledge-live-reconciliation
```

The migration and runtime contract are verified, but this command remains separately
approval-gated. The task-level acknowledgement was not enabled during hosted verification.

## Transaction and accounting contract

Applied forward migration `20260809025333_reconciliation_execution_engine.sql` adds a narrow RPC engine. It uses a project-scoped PostgreSQL advisory transaction lock plus a unique active-batch index. The eight fixed insert handlers allowlist fields for candidates, sessions, attempts, catalog rows, reviews, transfers, Newbie Shift requests, and candidate-deletion pending requests. The only update handler is for the existing session allowlist.

Each insert RPC transaction performs the canonical insert, calls `mts_sam.insert_lineage_if_absent()`, records its deterministic outcome, records batch ownership, and stores the post-write checksum before returning. The update RPC locks the exact target row, checks expected values, stores a narrow before-image, applies only the planned changed fields, verifies the result, and records the post-write checksum atomically. No caller-controlled table name or dynamic SQL is accepted.

Finalization verifies exact inserted/updated/before-image/lineage totals and expected canonical ending counts. A failed item leaves the batch `failed` or `partially_failed`; committed items retain exact ownership and remain rollback-eligible. Audit tables are private, forced-RLS evidence; public, anon, and authenticated execution is revoked. Service-role access is confined to the trusted backend and fixed RPCs.

## Rollback contract

Preview is read-only:

```powershell
.venv\Scripts\python.exe -m backend.tools.supabase_import.cli sync-incremental rollback-preview --batch-id <uuid>
```

Exact rollback requires both acknowledgements:

```powershell
.venv\Scripts\python.exe -m backend.tools.supabase_import.cli sync-incremental rollback --batch-id <uuid> --acknowledge-rollback
```

Preview and rollback reject missing/ineligible batches, later active/successful batch dependencies, changed post-sync checksums, missing batch ownership, external dependencies, or missing before-images. Rollback restores only recorded session fields, removes lineage attributed to that reconciliation batch, and deletes only rows carrying that exact batch UUID in child-before-parent order. It supports successful and partially failed batches, verifies no attributed artifacts remain, preserves all batch/item/before-image audit records, and records `rolled_back` or `rollback_failed`.

It never deletes by timestamp, by name, by Brand/Model, or merely because a row is absent from Sheets.

## Safe dry run

```powershell
.venv\Scripts\python.exe -m backend.tools.supabase_import.cli sync-incremental --dry-run
```

The dry run records aggregate-only plan evidence and compares hosted counts before and after.
It does not create a batch, plan item, before-image, lineage mapping, or canonical mutation.

The 2026-08-08 ET post-implementation run used one Sheets fetch with zero retries at
`2026-08-09T03:28:44.376169+00:00`. Snapshot checksum was
`ff3ab5ad96aa38563d3cb3c5234ec3caf112d71a2a808cd809e8ca004ad754a7` and plan
checksum was `f017f69b61e7f6fb06c7cb0468a7dc8d4eeb1bdaea2752c974ddd72ae0a62cd2`.
It reproduced 28 inserts, one update, 28 new and 155 reused lineage mappings, zero
ambiguity/unresolved/conflicts, and the sole expected unapplied-migration blocker. All
canonical, lineage, import, and reconciliation-audit counts were checked unchanged.

## 2026-08-09 hosted execution-engine verification

Migration `20260809025333` was deployed to project `xyfhikikddcqcmzbdvbj` during the
2026-08-09 verification window before `09:37:13Z`. Local and remote migration history
match through that version. Deployment changed no canonical, lineage, staging, import,
or audit row count. Hosted metadata confirmed forced RLS on all three reconciliation
audit tables, no anon/authenticated DML or RPC execution, narrow service-role grants,
empty function search paths, fixed indexes/triggers, and no broadened canonical access.

Synthetic UUIDv5 identities under source tab `__mts_sam_reconciliation_synthetic__`
verified candidate -> session -> attempt inserts in batch
`72c4ee53-51ab-467c-a40d-8eee200eb0dd`, a narrow `raw_status` update and immutable
before-image in batch `53bd501c-e82b-4347-a7f9-60f713496b35`, active-batch rejection,
plan-item immutability, both lineage conflict outcomes without overwrite, finalization
guards, eligible rollback previews, child-first exact rollback, and retained audit
evidence. A provider response-contract defect found during this test was corrected so
rollback previews validate `eligible` and `blockers` rather than requiring a nonexistent
`result` field. Post-fix batch `b1ad75cf-0eea-423f-83ac-66d94aaeffc4` verified that path.

Partial batch `96f5c4b4-5662-4292-8163-098895a433b6` committed one synthetic candidate,
rejected its invalid dependent session, became `partially_failed`, previewed only the
committed effect, and rolled back exactly. Canonical and lineage counts returned to
`54 / 69 / 137 / 264`; five synthetic batch records, ten plan items, and one before-image
remain as intentional immutable audit evidence. No active batch or synthetic canonical or
lineage row remains.

The post-verification production dry run used one zero-retry Sheets fetch at
`2026-08-09T09:43:39.064606+00:00`, generated at
`2026-08-09T09:43:40.820133+00:00`, and expires at
`2026-08-09T09:58:40.820133+00:00`. Snapshot checksum
`ff3ab5ad96aa38563d3cb3c5234ec3caf112d71a2a808cd809e8ca004ad754a7` and plan
checksum `f017f69b61e7f6fb06c7cb0468a7dc8d4eeb1bdaea2752c974ddd72ae0a62cd2`
reproduced the approved 28 inserts, one update, 28 new and 155 reused lineage mappings,
and zero ambiguity, unresolved identities, or conflicts. Runtime readiness is true; the
task execution guard remains false; hosted before/after counts were identical.

## 2026-08-09 controlled production attempt and rollback

The authorized execution used a fresh one-fetch, zero-retry source snapshot at
`2026-08-09T10:48:24.579773+00:00`, snapshot checksum
`ff3ab5ad96aa38563d3cb3c5234ec3caf112d71a2a808cd809e8ca004ad754a7`, and plan
checksum `f017f69b61e7f6fb06c7cb0468a7dc8d4eeb1bdaea2752c974ddd72ae0a62cd2`.
Batch `4be01417-b08f-4002-b0ef-8371ce73a876` committed 4 candidates, 2 headset
catalog rows, 4 sessions, 8 attempts, and 18 attributed lineage mappings before the
headset-review insert failed with `parent_session_missing`. The batch became
`partially_failed`; no session update or before-image occurred.

Rollback preview reported `eligible=true`, zero blockers, no later batch, and exact
restoration targets. The batch-scoped rollback succeeded at
`2026-08-09T10:49:24.654206+00:00`. It restored candidates/sessions/attempts/catalog to
`54 / 69 / 137 / 96`, lineage to 264, and left zero canonical rows or lineage mappings
owned by the batch. Immutable audit evidence remains: 6 reconciliation batches, 39 plan
items, and 1 prior synthetic before-image.

The planner defect was corrected to require every child insert's session dependency to
resolve either to an existing hosted session or to a non-blocked planned session. A
post-fix zero-write run at `2026-08-09T10:53:39.304292+00:00` reported 27 inserts, one
update, 27 new and 155 reused lineage mappings, one unresolved/ambiguous headset-review
parent, `status=blocked`, and unchanged hosted counts. No retry occurred. A corrected
source relationship or an explicitly reviewed alternative is required before a new
execution approval cycle.

Post-rollback validation passed backend compilation, 387 backend unittest tests, 408
pytest tests plus 103 subtests, 150 focused Supabase tests, 32 frontend suites with 311
tests, the frontend production build, the backend executable build, 33 Apps Script
authorization tests plus syntax validation, and 11 desktop lifecycle/package tests plus
main/preload syntax checks. Local/remote migration parity still matches through
`20260809025333`; database lint retains only the pre-existing unused `v_count` warning
in `rollback_reconciliation_batch`.

Sheets remains primary until a separate cutover decision.
