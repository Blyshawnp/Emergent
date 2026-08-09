# MTS/SAM incremental reconciliation plan

Status: execution framework implemented; forward execution migration is **not applied**; no hosted reconciliation has run.

Google Sheets remains authoritative. `MTS_DATA_PROVIDER=sheets`, `MTS_SHADOW_COMPARE=false`, and `MTS_DUAL_WRITE_ENABLED=false` are mandatory. Shadow-read activation, provider cutover, and Apps Script retirement remain blocked.

## Approved plan shape

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

Do not run it until the forward migration is separately reviewed, applied, and its runtime contract is verified. The task-level acknowledgement is intentionally not enabled by this checkpoint.

## Transaction and accounting contract

Unapplied forward migration `20260809025333_reconciliation_execution_engine.sql` adds a narrow RPC engine. It uses a project-scoped PostgreSQL advisory transaction lock plus a unique active-batch index. The eight fixed insert handlers allowlist fields for candidates, sessions, attempts, catalog rows, reviews, transfers, Newbie Shift requests, and candidate-deletion pending requests. The only update handler is for the existing session allowlist.

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

The dry run records aggregate-only plan evidence and compares hosted counts before and after. With the new migration unapplied, status must be `blocked` only by `reconciliation_execution_migration_not_applied`; that blocker is expected and proves execution is disabled. No reconciliation batch, plan item, before-image, lineage, or canonical mutation is created.

The 2026-08-08 ET post-implementation run used one Sheets fetch with zero retries at
`2026-08-09T03:22:51.437643+00:00`. Snapshot checksum was
`ff3ab5ad96aa38563d3cb3c5234ec3caf112d71a2a808cd809e8ca004ad754a7` and plan
checksum was `f017f69b61e7f6fb06c7cb0468a7dc8d4eeb1bdaea2752c974ddd72ae0a62cd2`.
It reproduced 28 inserts, one update, 28 new and 155 reused lineage mappings, zero
ambiguity/unresolved/conflicts, and the sole expected unapplied-migration blocker. All
canonical, lineage, import, and reconciliation-audit counts were checked unchanged.

After a later authorized execution, require a succeeded batch, exact expected counts, 28 acceptable lineage outcomes, one before-image, no orphans/duplicate identities, and a fresh 14-domain comparison. Sheets remains primary until a separate cutover decision.
