# MTS/SAM incremental reconciliation plan

Status: planning checkpoint only. No hosted synchronization has been executed.

Google Sheets remains authoritative. `MTS_DATA_PROVIDER=sheets`,
`MTS_SHADOW_COMPARE=false`, and `MTS_DUAL_WRITE_ENABLED=false` remain required.
Apps Script remains active. Shadow-read activation and provider cutover remain blocked.

## Why the prior incremental counter was unsafe

The former `sync-incremental` dry run scanned all current Sheet rows and compared
their `(source_system, source_tab, source_row_key)` lineage checksums. It reported
367 source rows as 262 new, 84 changed, and 21 unchanged. That was historical
lineage reinterpretation, not a safe current-drift plan: request identity rules had
changed, historical staging rows were not bounded by one approved snapshot, and the
command had no target identity/checksum preconditions, field allowlists, before-images,
dependency graph, created-by-batch evidence, or update-capable rollback. Its execution
path already failed closed; it remains unauthorized.

The replacement planner starts from one cached eight-tab Sheets snapshot, reads the
current hosted canonical state, and builds operations by canonical domain. It never
promotes historical staging rows. Derived domains are effects, not separate writes.

## Fresh read-only evidence

The 2026-08-07 ET read-only run used one Sheet batch fetch with zero retries and
snapshot checksum `ff3ab5ad96aa38563d3cb3c5234ec3caf112d71a2a808cd809e8ca004ad754a7`.
The snapshot contained 226 physical rows across the eight mapped tabs. All 14
comparisons completed and still reported 67 unexplained differences. Hosted
counts were identical before and after the run: import batches 3, candidates 54,
candidate sessions 69, attempts 137, lineage 264, catalog 96, reviews 11, transfers
14, Newbie Shift requests 9, corrections 7, and generic pending requests 0.

The exact planning projection is:

| Canonical target | Start | Planned inserts | Planned updates | Safe projected end |
|---|---:|---:|---:|---:|
| candidates | 54 | 0 | 0 | 54 |
| candidate_sessions | 69 | 4 | 1 | 73 |
| session_attempts | 137 | 8 | 0 | 145 |
| headset_catalog | 96 | 0 | 0 | 96 |
| headset_reviews | 11 | 1 | 0 | 12 |
| supervisor_transfers | 14 | 1 | 0 | 15 |
| newbie_shift_requests | 9 | 5 | 0 | 14 |
| candidate_corrections | 7 | 0 | 0 | 7 |
| pending_requests (candidate deletion only) | 0 | 3 | 0 | 3 |
| notifications | 4 | 0 | 0 | 4 |

The plan has 22 canonical inserts and one narrow session update. Four candidate rows
are blocked because the current Sheet provides no approved non-name candidate identity;
the four dependent session inserts therefore cannot execute. Two timestamp-less catalog
rows are also blocked because provenance and recency cannot be established. Resolving
candidate identity would add four candidate inserts and raise the candidate projection
to 58. Resolving catalog provenance could add up to two catalog inserts and raise its
projection to 98. Neither is assumed by the current safe plan.

The one canonical session update represents the source status change; its candidate
status, tracking, and history differences are derived effects. The five Newbie Shift
inserts preserve five distinct request IDs, including repeated-session relationships.
They are not collapsed by session ID. Pending requests and recent activity are derived
from those five canonical rows. The three candidate-deletion requests are the only
direct `pending_requests` inserts.

## Stable identity contract

| Entity | Identity |
|---|---|
| candidate | approved source candidate ID or existing canonical relationship/lineage; never a name |
| candidate session | source session ID |
| attempt | source session ID plus actual nonblank call slot/source action ID |
| headset catalog | normalized brand + model only when unique and provenance is safe |
| headset review | review ID |
| supervisor transfer | transfer/pending request ID |
| Newbie Shift request | request ID; session ID is a relationship only |
| correction | request ID |
| generic pending request | source tab + request ID |
| recent activity | derived canonical request/event identity |

Physical Sheet row numbers are never primary identities. Default output contains
only aggregate counts and blocker categories. `--diagnostic` adds SHA-256 identity
references and stable checksums, but never names, contact fields, notes, or raw Sheet rows.

## Plan and staleness contract

Every safe plan records its project ref, snapshot timestamp/checksum, 15-minute
expiration, plan checksum, provider state, source checksum, expected target checksum,
proposed checksum, dependencies, changed-field allowlist, lineage expectation, and
blocking reason. Execution must reproduce the plan checksum, current source snapshot,
every per-item source checksum, and every target before checksum. A missing insert
precondition, changed target, expired plan, duplicate identity, unresolved dependency,
or lineage conflict blocks the batch rather than overwriting newer data.

The execution CLI requires `--execute`, the exact project ref, a safe plan file, the
exact plan checksum, an exact confirmation token, and the separate
`MTS_SUPABASE_RECONCILIATION_EXECUTION_ACK` environment acknowledgement. That
acknowledgement was not set in this checkpoint. Even with it, execution remains
hard-blocked until the unapplied reconciliation migration is reviewed and deployed.

## Batch, lineage, and rollback contract

Forward migration `20260807000000_mts_sam_incremental_reconciliation.sql` defines
private `reconciliation_batches`, `reconciliation_plan_items`, and
`reconciliation_before_images` tables. It is not applied. The tables provide exact
plan/batch state, operation ordering, immutable narrow before-values, created-by-batch
evidence, post-write checksums, and rollback status. RLS is enabled and forced; public,
anon, and authenticated access is revoked; only the trusted service role receives the
required narrow privileges.

Future lineage creation must call `mts_sam.insert_lineage_if_absent()` and accept only:
`inserted`, `already_exists_same_mapping`,
`conflict_source_maps_to_different_entity`, or
`conflict_entity_maps_to_different_source`. Existing canonical rows are not replayed
merely to rewrite old lineage keys. The dry run predicts 22 new mappings, 155 exact
reuses, zero source/entity conflicts, and six unresolved mappings tied to the four
candidate and two catalog blockers.

Rollback is batch-exact. It first verifies batch eligibility, later dependencies, and
every current post-sync checksum. It restores only allowlisted fields from private
before-images, deletes only entities proven created by that batch, uses child-before-
parent FK order, preserves audit evidence, marks the batch rolled back, and reruns the
read-only comparison. It never deletes by timestamp, deletes rows merely absent from
Sheets, removes pre-existing lineage, or overwrites newer changes.

## Derived-domain accounting

`authoritative_candidate_status`, `candidate_tracking`, `history`, and
`recent_activity` are projections. `pending_requests` is a projection union except for
the generic candidate-deletion table. A canonical request/session operation may improve
several projections, but remains one canonical operation. This prevents the 67 logical
comparison differences from being misreported as 67 independent writes.

## Commands

Default zero-write dry run:

```powershell
.venv\Scripts\python.exe -m backend.tools.supabase_import.cli sync-incremental --dry-run
```

Aggregate output includes the snapshot and plan checksums, expiration, classifications,
canonical/lineage/derived counts, blockers, projected counts, and identical hosted
before/after counts. A blocked plan exits nonzero by design.

Future execution shape (not authorized and currently hard-blocked):

```powershell
.venv\Scripts\python.exe -m backend.tools.supabase_import.cli sync-incremental --execute `
  --plan-file <safe-plan.json> `
  --project-ref xyfhikikddcqcmzbdvbj `
  --plan-checksum <sha256> `
  --confirmation EXECUTE:xyfhikikddcqcmzbdvbj:<sha256>
```

## Post-sync verification required after future approval

Immediately after any future batch: require `succeeded`, unchanged source checksum,
all expected inserts and narrow updates, valid lineage outcomes, no orphans or duplicate
identities, exact expected canonical counts, no unrelated changes, and a fresh 14-domain
comparison. `verify-production` must remain fail-closed. Provider stays Sheets; shadow
and dual writes stay disabled. Synchronization does not authorize shadow activation or
full cutover.
