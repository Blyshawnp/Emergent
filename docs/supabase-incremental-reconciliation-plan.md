# MTS/SAM incremental reconciliation plan

Status: execution framework deployed and verified; two controlled production
reconciliation attempts were rolled back exactly. The latest retry proved a remaining
stable-candidate versus shadow-projection identity mismatch and is blocked pending
investigation plus a new approval cycle.

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

## 2026-08-09 headset-review identity investigation

The blocked current review is an `orphaned_source_review`. Its source row contains a
review ID and one UUID-shaped `source_session_id`, but that parent identity does not
exist in current Candidate Sessions, canonical `candidate_sessions`, any of the four
planned session inserts, immutable staging evidence, or lineage. It also does not match
an alternate canonical ID or deterministic session ID. The review postdates the latest
historical import snapshot and therefore cannot be reclassified as one of the eleven
expected historical exceptions. One candidate-name correlation exists, but its stable
session identity differs; name-only reassociation is prohibited and unsafe.

No planner/importer correction or hosted metadata/lineage correction is justified. The
planner already resolves legitimate stable parents in the same plan and existing stable
parents, orders sessions before reviews, and fails closed on this missing parent. The
authoritative source row requires its correct stable source session ID, if that identity
can be established by an authorized source owner; no ID was inferred or written.

The final zero-write dry run used a one-fetch, zero-retry snapshot at
`2026-08-10T02:47:59.366137+00:00`, generated at
`2026-08-10T02:48:01.361132+00:00`, and expiring at
`2026-08-10T03:03:01.361132+00:00`. Snapshot checksum
`ff3ab5ad96aa38563d3cb3c5234ec3caf112d71a2a808cd809e8ca004ad754a7` and plan
checksum `49c06943dafbb0942a4e0f02c1165a278bf2f9281db1f229fbf9315dffba6456`
produce 27 inserts, one update, 27 new and 155 reused lineage mappings, one ambiguous
parent, one unresolved lineage outcome, zero conflicts, and blocker
`headset_reviews:parent_session_identity_unresolved`. Hosted before/after counts were
identical. No live reconciliation, canonical write, lineage write, or Sheet write was
performed. Sheets remains authoritative; Apps Script remains active; provider `sheets`,
shadow disabled, and dual writes disabled are unchanged.

## 2026-08-10 headset-review source correction and fresh plan

At `2026-08-10T09:27:33.783148+00:00`, one explicitly authorized source correction
changed only `headset-review-log.source_session_id` for the uniquely matched review.
The reason was: transient session identity replaced by proven stable Candidate Sessions
identity.
The review ID hash remained
`8b2d0d64e1ece8e809f779e2997d8a7e84a407a8f81dee94257401dbbf5e00fc`; the prior
parent hash was `f67d2a7b2ab32f6e0df1281d8ae50eca351c85b3842d6696f71a7aab9225ec59`
and the verified Candidate Sessions parent hash is
`17b158e19a07f680bf62c012a305ad48ce4c50009a9677f8a2451baca1c6ea09`.
Pre- and post-write checks proved one review match, one parent match, zero duplicate
reviews, and unchanged review identity, non-parent fields, and Candidate Sessions row.
The planner source checksum changed from
`941d6231bd4074dbdeba8915ae38ef7d3b15332a212d1bfb5d2f29f14f3afceb` to
`6b9eb57f153fad0478f3c7f983a0c9b64615549e0d6976f5a160a39c4bcf508e`.

The committed Apps Script guard was deployed to the existing web app as version 24,
retaining its endpoint. Live safe probes confirmed both role endpoints remain reachable,
MTS cannot call the SAM-only action, missing parents are rejected, and the corrected
exact parent is accepted as an already-resolved no-op. Duplicate-parent and deletion
protection remain covered by the local authorization harness rather than unsafe live
mutation probes.

The fresh one-fetch, zero-retry snapshot at `2026-08-10T09:37:03.802905+00:00`
contains 226 physical source rows and has checksum
`a4fefd89d2f33dcdc205e8ad38c0bcd9ec606f5a8d278f217298013ab6576fbe`.
The dry-run plan checksum is
`a79592d5d40416e8411883c3c66d2226d7e1ee86727733fd0d88f391d369522d`:
28 inserts, one update, 28 new and 155 reused lineage mappings, with zero ambiguity,
unresolved relationships, conflicts, unsupported operations, or blockers. Hosted
before/after counts were identical. No live reconciliation was executed, and no hosted
canonical or lineage data changed. Sheets remains authoritative; provider `sheets`,
shadow disabled, and dual writes disabled are unchanged.

## 2026-08-10 controlled reconciliation retry and exact rollback

Fresh source and target checks generated the approved plan from snapshot timestamp
`2026-08-10T10:30:40.682416+00:00`, snapshot checksum
`a4fefd89d2f33dcdc205e8ad38c0bcd9ec606f5a8d278f217298013ab6576fbe`, and plan
checksum `a79592d5d40416e8411883c3c66d2226d7e1ee86727733fd0d88f391d369522d`.
The plan contained exactly 28 inserts, one allowlisted session update, 28 new and 155
reused lineage mappings, one before-image, and zero ambiguity, unresolved relationships,
conflicts, unsupported handlers, or blockers. Provider `sheets`, shadow disabled, and
dual writes disabled were reverified before execution.

Controlled production batch `da4a24d2-3682-4dce-8851-ec0072ebb97e` initially finalized
successfully with all 29 items, exact ending counts, 28 batch-owned canonical inserts,
28 attributed lineage mappings, and the single verified update. The corrected headset
review inserted successfully against exactly one stable canonical session parent, with
no name heuristic and no missing-parent result.

The mandatory post-sync comparison nevertheless returned 29 mismatches and 27
unexplained differences. Four newly reconciled candidates appeared missing on each side,
and their sessions produced four relationship mismatches. The reconciliation planner
intentionally resolves these candidates through persisted or stable session identity,
while the current shadow candidate/session compatibility projection still derives its
candidate identity from candidate names. Complete mapped parity therefore could not be
proven, so the result was treated as an integrity failure rather than suppressing or
reclassifying the differences.

Rollback preview was eligible with zero blockers, no later batches, exact batch ownership,
one restorable before-image, and child-before-parent delete order. Exact rollback completed
at `2026-08-10T10:36:54.810848+00:00`: the session update checksum returned to
`d17b36b30a5f405157519605aa25feb7fe566a43e1bcabb37c405dfbcc25a671`, all 28
batch-created rows and 28 batch-attributed lineage mappings were removed, and canonical
counts returned to 54 candidates, 69 sessions, 137 attempts, 96 catalog rows, 11 reviews,
14 transfers, 9 Newbie Shift requests, 0 physical pending requests, and 264 lineage
mappings. The batch, its 29 plan items, and before-image remain immutable audit evidence
with `status=rolled_back` and `rollback_status=succeeded`.

The final post-rollback comparison restored the prior 69 mismatches and 67 unexplained
differences. `verify-production` remains `ok=false`, mapped shadow readiness remains
false, and full cutover remains false. No shadow activation, provider cutover, dual write,
Auth migration, or Sheet change occurred. A new live reconciliation is blocked until the
stable reconciliation identity and shadow comparison identity contracts are aligned and
separately reviewed.

Post-rollback validation passed backend compilation, 395 backend unittest tests, 416
root pytest tests, 228 focused headset/reconciliation/execution/rollback/shadow/session
tests, 32 frontend suites with 312 tests, the frontend production build, the backend
executable build, 36 Apps Script authorization tests plus syntax/package validation, and
11 desktop lifecycle/package tests plus main/preload syntax checks. Local/remote migration
parity remains exact through `20260809025333`; linked database lint retains only the
pre-existing unused `v_count` warning in `rollback_reconciliation_batch`.

The earlier 2026-08-09 post-rollback validation passed backend compilation, 387 backend
unittest tests, 408
pytest tests plus 103 subtests, 150 focused Supabase tests, 32 frontend suites with 311
tests, the frontend production build, the backend executable build, 33 Apps Script
authorization tests plus syntax validation, and 11 desktop lifecycle/package tests plus
main/preload syntax checks. Local/remote migration parity still matches through
`20260809025333`; database lint retains only the pre-existing unused `v_count` warning
in `rollback_reconciliation_batch`.

Sheets remains primary until a separate cutover decision.

### 2026-08-10 stable-identity comparison checkpoint

No live reconciliation was run in this checkpoint. The comparison layer now resolves
candidate identity through the exact reconciliation contract: an existing canonical
session relationship, existing candidate lineage, a persisted candidate UUID, or the
approved deterministic UUIDv5 legacy-session identity. Candidate display names are
values only. A row that cannot satisfy that contract is reported as
`legacy_identity_unresolved`; it is not grouped or deduplicated by name.

The fresh one-fetch snapshot at `2026-08-11T01:09:20.157607+00:00` retained source
checksum `a4fefd89d2f33dcdc205e8ad38c0bcd9ec606f5a8d278f217298013ab6576fbe`.
The zero-write dry-run remained exactly 28 inserts plus one narrow update, 28 new and 155
reused lineage mappings, zero ambiguity/unresolved/conflicts/blockers, plan checksum
`f0e1d29adf6b9185d5fd7508c81987bbba3bda22329471b77be3170e0f1d6d19`, and expiration
`2026-08-11T01:24:22.789956+00:00`.

`sync-incremental --dry-run --projected-comparison` applies those planned effects only to
an in-memory provider and then invokes the same production comparator. It cannot write
canonical tables or lineage and labels its evidence `simulation_only`. The projection
reached the expected 58 candidates, 73 sessions, 145 attempts, 98 catalog rows, 12
reviews, 15 transfers, 14 Newbie Shift requests, 7 corrections, 24 combined pending
requests, 4 notifications, and 292 lineage mappings.

Across the five identity/status-sensitive domains, the projected comparison reduced the
rolled-back live result from 27 to 2 unexplained differences. Candidate false positives
fell from 9 to 0; candidate sessions from 5 to 1; authoritative status from 1 to 0;
candidate tracking from 6 to 0; and History from 6 to 1. Stable checking separately
exposed five historical correction relationships, leaving 7 unexplained differences in
the projected all-domain result. The remaining session/History difference is one exact stable session whose hosted
`session_type` and `completed_at` differ from Sheets; neither field is in the authorized
narrow update. Stable correction relationship checking also exposed five historical
`candidate_corrections.candidate_id` foreign keys that disagree with the candidate reached
through their exact `source_session_id`. These seven differences remain unexplained and
mapped readiness remains false. A future live retry requires separate review and a safe
canonical correction/update plan; this checkpoint authorizes neither.
