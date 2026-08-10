# MTS/SAM Supabase data foundation

Status: implementation foundation only. Google Sheets remains the active provider. No production cutover or dual write is enabled.

## Source inventory

The live inventory was collected read-only through the existing SAM-authorized Apps Script API on 2026-07-31. Counts below are aggregate data-row counts; no production records are included.

| Exact tab | Rows | Purpose | Exact identity / important contract |
|---|---:|---|---|
| `Candidate Sessions` | 67 | Shared session, History, readiness, attempt, form-fill, and Newbie Shift projection | `session_id`; 71 live headers; 9 expected trailing workflow headers are lazy and absent |
| `Pending Sup Transfers` | 13 | Pending and completed Supervisor Transfers | `pending_id`; foreign `original_session_id` |
| `newbie-shift-requests` | 12 | Newbie Shift requests and reschedule state | `request_id`; foreign `session_id`; 30 live headers; `newbie_shift_number` is lazy and absent |
| `candidate-information-correction-requests` | 7 | Candidate/session correction approval requests | `request_id`; exact foreign `source_session_id`; `changes_json` |
| `candidate-deletion-requests` | 3 | Local History deletion approval/audit | `request_id`; exact foreign `session_id` |
| `headset-review-log` | 10 | Candidate headset review workflow | `review_id`; foreign `source_session_id`; V2 `Brand` and `Model` are separate |
| `headsets` | 96 | Approved-headset catalog | `Brand`, `Model`, `Status`, `Note`; separate from review history; source row is retained as immutable import identity |
| `sam-notifications` | 4 | Ticker, popup, banner, and persistent notification definitions | `ID`; mixed Yes/No or boolean-like display fields |
| `sam-authorized-users` | 6 | Current SAM PIN/role installation authorization | no stable database identity beyond source row; PIN is not imported into ordinary application tables |
| `mts-tutorial-videos` | 0 | MTS Help video metadata | `VideoKey` within the MTS audience |
| `sam-tutorial-videos` | 0 | SAM Help video metadata | `VideoKey` within the SAM audience |
| `discord-posts` | 28 | Discord template content | `Category`, `Title`; exported/fallback CSV mirror exists |
| `screenshots` | 25 | Help/reference image metadata | `Category`, `Title`, `ImagePath` |
| `callers` | 22 | New, Existing, and Increase caller scenarios | no durable person identity; `Category` controls grouping |
| `shows` | 8 | Show and donation scenario configuration | `ShowName` is a mutable content label, not a relational identity |
| `call-types` | 5 | Call-type options | `CallType` content label |
| `sup-reasons` | 7 | Supervisor Transfer reasons | `SupervisorReason` content label |
| `call-coaching` | 7 | Call coaching hierarchy | `ID`; pipe-delimited children |
| `sup-coaching` | 8 | Supervisor coaching hierarchy | label-based legacy content; pipe-delimited children |
| `call-fail-reasons` | 8 | Call failure reason options | `FailReason` content label |
| `sup-fail-reasons` | 6 | Supervisor failure reason options | `FailReason` content label |
| `gemini-coaching-prompt` | 1 | Managed coaching prompt | single `prompt` row; private content is not logged |
| `gemini-fail-prompt` | 1 | Managed fail prompt | single `prompt` row; private content is not logged |
| `update-MTS` | 5 | MTS release/update metadata | version fields and URL |
| `update-SAM` | 4 | SAM release/update metadata | version fields and URL |

Allowed but not currently materialized live: `callers-new`, `callers-existing`, `callers-increase`, `settings`, and `notification-recipients`. Split caller tabs are legacy/alternative inputs to `callers`. Missing optional tabs are not imported as empty fabricated sources.

All Apps Script tabs use header row 1 and data row 2. Reads are routed through the allowlisted `getSheetRange`, `batchGetSheetRanges`, or workflow-specific GET actions. Generic writes are SAM-only; MTS writes are limited to headset-review submission, candidate-tracking updates, and pending-request upserts. Archive/delete operations use exact workflow IDs or exact physical catalog row identity; names and headset text are never matching keys.

### Candidate Sessions headers

The live 71-column prefix is:

`session_id`, `candidate_name`, `candidate_first_name`, `candidate_last_initial`, `tester_name`, `session_type`, `attempt_number`, `final_attempt`, `status`, `created_at`, `completed_at`, `mock_calls_completed`, `sup_transfers_completed`, `call_1_result`, `call_2_result`, `call_3_result`, `sup_transfer_1_result`, `sup_transfer_2_result`, `coaching_summary`, `fail_summary`, `review_notes`, `needs_sup_transfer`, `pending_sup_transfer_id`, `withdrawn`, `withdrawn_at`, `extra_attempt_granted`, `extra_attempt_reason`, `retention_until`, `archived`, `headset_usb`, `noise_cancel`, `headset_brand`, `vpn_on`, `vpn_off`, `chrome_default`, `extensions_disabled`, `popups_allowed`, `skills`, `final_notes_strengths`, `final_notes_needs_coaching`, `final_notes_other`, `final_notes_history_only`, `evaluator_notes_summary`, `final_notes_created_at`, `calculated_result`, `final_result`, `readiness_override_applied`, `readiness_override_result`, `readiness_override_reason`, `readiness_override_explanation`, `form_fill_status`, `form_filled_at`, `newbie_shift_scheduled_at`, `newbie_shift_timezone`, `newbie_shift_request_id`, `newbie_shift_request_type`, `newbie_shift_request_status`, `newbie_shift_requested_by`, `newbie_shift_request_reason`, `newbie_shift_request_details`, `newbie_shift_request_created_at`, `newbie_shift_original_scheduled_at`, `newbie_shift_rescheduled_at`, `newbie_shift_within_24_hours`, `newbie_shift_counts_as_attempt`, `newbie_shift_admin_decision_at`, `newbie_shift_admin_decision_by`, `newbie_shift_denial_reason`, `deletion_request_id`, `deletion_request_status`, `deletion_request_created_at`.

The canonical PostgreSQL schema includes the absent lazy block immediately: `extra_attempts_granted`, `allowed_attempt_count`, `current_attempt_number`, `extra_attempt_last_action_id`, `extra_attempt_granted_by`, `extra_attempt_granted_at`, `readiness_override_by`, `readiness_override_at`, and `newbie_shift_number`. Import treats these as source-column-absent, not corrupt or explicitly blank.

### Headset review clarification

`headset-review-log` has V2 columns `review_id`, `source_session_id`, `candidate_name`, `tester_name`, `Brand`, `Model`, `Status`, `Note`, `created_at`, `updated_at`, `decision_at`, `decision_by`, and `denial_reason`. Brand is column E and Model is column F. Of 10 rows, 9 have blank Brand and a legacy combined value in Model. Comparing a whitespace/case-normalized legacy Model to the normalized catalog display `Brand + " " + Model` yields exactly 3 unique matches. Six rows have no unique match and remain unresolved with Brand null and the original Model preserved. The importer never changes `headsets`, creates a review, fabricates USB/noise-cancelling facts, or changes a decision.

## Local data contracts

The packaged backend SQLite file is a local document store, not a normalized shared authority. `kv_documents(collection, doc_id, data, updated_at)` stores settings and the active session. `history_documents(id, data, timestamp, created_at)` stores the local History mirror. It must remain available for startup, local settings, History, offline/cache behavior, and controlled synchronization. The optional `SQLITE_IMPORT_PATH` JSON seed is one-time and skipped when local data exists.

Packaged CSV files in `backend/defaults/` and `docs/admin-content-package/csv-tabs/` are fallback/configuration mirrors for callers, shows, call types, coaching/fail reasons, Discord posts, screenshots, headsets, and tutorials. They are not imported as production rows when a live Sheet source exists.

## Canonical schema

All new objects use the private `mts_sam` schema:

- identity/configuration: `app_users`, `app_roles`, `user_role_assignments`, `application_settings`, `sync_state`;
- candidate workflow: `candidates`, `candidate_sessions`, `session_attempts`, `candidate_status_actions`, `candidate_corrections`, `extra_attempt_grants`, `supervisor_transfers`, `newbie_shift_requests`, `newbie_shift_reschedules`;
- headset workflow: `headset_catalog`, `headset_reviews`, `headset_review_actions`;
- requests/activity: `pending_requests`, `activity_events`, `notifications`, `notification_deliveries`;
- lineage/audit: `audit_events`, `data_source_lineage`, `synchronization_events`;
- import/reconciliation: `import_batches`, `import_staging_rows`, `import_row_results`, `reconciliation_results`.

Compatibility projections are security-invoker views: `current_headset_catalog_view`, `headset_review_queue_view`, `current_candidate_status_view`, `candidate_history_view`, `pending_requests_view`, and `recent_activity_view`.

Transactional functions require exact IDs and expected state: `grant_extra_attempt`, `apply_candidate_status_override`, `decide_headset_review`, and `correct_candidate_information`. Candidate correction allowlists only candidate/session fields. It cannot mutate the headset catalog or headset reviews.

## Security

RLS is enabled and forced on every canonical and staging table. `public`, `anon`, and `authenticated` receive no schema access by default. The service role receives access only for the trusted backend; it must never appear in React/Electron variables, bundles, source maps, logs, or documentation. The future authenticated role projection is limited to self/role reads; privileged workflow mutations remain backend RPC operations. Views use PostgreSQL 17 `security_invoker` semantics.

`.env.example` contains placeholders only. The frontend uses only `REACT_APP_BACKEND_URL`; no Supabase service credential is referenced by frontend or Electron source.

## Migration workflow

Create a migration with `supabase migration new <name>`. Validate locally with a running Supabase stack, then inspect `supabase db diff` and `supabase db lint`. Link only with the correct organization account and project reference. Apply with `supabase db push --linked` so `supabase_migrations.schema_migrations` stays authoritative.

The unrelated legacy plan `20260614083525_shared_user_accounts_targeted_alerts.sql` is archived under `docs/archived-migration-plans/` and is not part of the active migration chain. The active directory contains only the five approved `mts_sam` migrations. Archiving did not apply the legacy SQL or mark it as applied.

## Import and reconciliation

The deterministic helpers live in `backend/tools/supabase_import/`. Every source row receives a SHA-256 checksum and exact source identity where present. When no durable ID exists, the fallback is source tab + physical row + checksum, and the reason is recorded. Names are never identities.

Recommended command lifecycle for the completed importer CLI is `inventory`, `extract`, `stage`, `validate`, `transform`, `load`, `reconcile`, `report`, then an exact-batch `rollback-batch` only for failed/test batches. Successful production staging batches are retained. The service-role key is supplied only to the backend process.

For a safe rerun, derive a deterministic batch key from the source snapshot, upsert staging rows on exact batch/tab/source-row identity, upsert canonical rows on their source IDs, and compare aggregate counts/checksums. A second run must add zero canonical duplicates. Every source row must be either normalized or have an explicit unresolved/rejected staging result.

## Backups, cutover, and recovery

Before any cutover:

1. take a final read-only Google Sheet snapshot and retain it;
2. create a Supabase logical backup/export and record migration state;
3. retain successful import batches, reconciliation output, and audit events;
4. enable `shadow_compare` with Sheets primary and aggregate-only mismatch logging;
5. require zero unexplained identity/status mismatches before a separate cutover approval;
6. keep `MTS_DATA_PROVIDER=sheets` as the immediate rollback flag;
7. preserve Apps Script and Sheet writes until a later freeze window is explicitly approved.

Apps Script retirement and Google Sheet deletion are outside this phase.

## Deployment state at checkpoint

The repository is linked to the intended hosted project `xyfhikikddcqcmzbdvbj` (MTS-SAM, East US).

The failed shadow-read audit found that the importer bypassed the RPC added by
`20260803000000_mts_sam_lineage_rpc.sql`, only 6 of 14 required logical domains were
compared, and readiness could therefore return a false positive. The corrective
checkpoint routes every normal lineage insertion through that RPC, implements all
14 comparison contracts, rejects direct lineage table upserts in the provider, and
requires current comparison evidence for readiness. Current evidence must identify the
expected project, use the RPC-only lineage capability, and carry a fresh complete
single-fetch Sheets snapshot contract.

Forward migration `20260804015610_harden_mts_sam_lineage_rpc_outcomes.sql` corrects
the original RPC's concurrent outcome ambiguity without rewriting prior migrations.
It is applied to the linked MTS-SAM project, local/remote history agrees, the hosted
RPC returns one of the four documented outcomes, and the pre/post lineage count is
264. The same forward migration replaces the two status/history views while
preserving their existing column prefixes for PostgreSQL compatibility.
The archived migration `20260614083525` was not applied and is not in the active chain.

Shadow data was imported in two production runs (idempotency confirmed, zero duplicate canonical rows)
and one synthetic rollback batch. Google Sheets remains the active authoritative data provider.
No shadow mode, dual writes, or provider cutover was activated.

Verified canonical counts:
- candidates: 54
- candidate_sessions: 69
- session_attempts: 137
- headset_catalog: 96
- headset_reviews: 11 (10 historical standalone, 1 with unresolved `source_session_id` link)
- supervisor_transfers: 14
- newbie_shift_requests: 9 (14 current source rows; four distinct requests were
  historically misclassified as duplicates and one additional row postdates import)
- candidate_corrections: 7
- notifications: 4

Source accounting (batch 1, 358 rows): 220 valid + 128 unresolved + 4 duplicate + 6 rejected = 358.

Nine required configuration tabs remain staging-only (66 rows total, not 100 as incorrectly
stated in earlier reports). These block full data-provider cutover. They are warnings
for a complete 14-domain shadow comparison but do not permit readiness when any
required comparison is missing, errored, incomplete, or unexplained.

### Caller ZIP correction overlay

The authoritative `callers` Sheet already contains ZIP `19130` for the unique Sam Smith
and Susan Miller-Smith rows. Repository caller defaults and admin-content templates use
the same corrected ZIP. Because callers remain a staging-only configuration domain with
no durable caller identity or canonical caller table, the hosted current representation
uses the `caller_roster_zip_corrections_v1` application setting as an exact-row overlay.
Each entry records the latest successful import batch, staging-row UUID, physical source
row, source-row key, verified caller name, prior ZIP, and corrected ZIP. The matching
audit event is immutable and idempotent.

Historical `import_staging_rows`, checksums, import batches, reconciliation results, and
lineage remain unchanged. The overlay changes only the current ZIP view; it does not
rewrite an import snapshot, infer identity from a name alone, map the caller domain,
enable shadow reads or dual writes, change `MTS_DATA_PROVIDER=sheets`, retire Apps Script,
or authorize a provider cutover.

Six `sam-authorized-users` rows were rejected per import batch (auth UUID mismatch with
Supabase Auth). SAM authorization cutover remains blocked until a user-mapping process is
implemented.

Exact current test totals are recorded only from the final validation run; previous
copied totals are not treated as current evidence.

The current importer now keys request tabs by `request_id`, projects candidate and
session relationships only when the referenced canonical entity exists, and routes
candidate-deletion requests into the existing generic `pending_requests` table.
No production synchronization was executed at this checkpoint. Exact target accounting,
fixed insert/update handlers, lineage attribution, database locking, and deterministic
rollback are implemented by applied forward migration
`20260809025333_reconciliation_execution_engine.sql`. Execution remains fail-closed and
separately approval-gated by fresh checksums and explicit operator/task acknowledgements.

The engine adds exact batch ownership to the eight approved canonical targets, extends
the sole lineage RPC with reconciliation attribution, and exposes fixed service-role RPCs
for begin, per-item transactional insert/update, failure/finalization, rollback preview,
and exact rollback. The CLI never trusts a saved payload: it refetches one Sheets snapshot
and reproduces the approved plan. Partial batches retain exact ownership and can be
previewed and rolled back without deleting pre-existing rows or lineage.

Hosted verification on 2026-08-09 used only UUIDv5 synthetic identities and the isolated
`__mts_sam_reconciliation_synthetic__` source namespace. Candidate, session, attempt,
narrow session update, locking, lineage outcomes, finalization, rollback preview, exact
rollback, and a controlled partial batch were exercised. All synthetic canonical and
lineage effects were removed by the exact rollback engine; canonical/lineage counts were
restored to 54 candidates, 69 sessions, 137 attempts, and 264 mappings. Five synthetic
batch records, ten plan items, and one narrow before-image remain as designed audit
evidence. No active batch remains.

The fresh production dry run generated at `2026-08-09T09:43:40.820133+00:00` reproduced
the approved 28+1 scope with 28 new and 155 reused lineage mappings and zero ambiguity,
unresolved identity, or conflict. Its snapshot checksum is
`ff3ab5ad96aa38563d3cb3c5234ec3caf112d71a2a808cd809e8ca004ad754a7`; its plan checksum
is `f017f69b61e7f6fb06c7cb0468a7dc8d4eeb1bdaea2752c974ddd72ae0a62cd2`.
Google Sheets remains authoritative, Apps Script remains active, and shadow reads and
dual writes remain disabled.

### 2026-08-09 controlled reconciliation rollback

The first authorized production reconciliation batch,
`4be01417-b08f-4002-b0ef-8371ce73a876`, stopped on the new headset-review insert because
its source session did not resolve to a canonical parent. Eighteen earlier inserts and
their 18 lineage mappings were batch-owned and therefore eligible for exact rollback.
The preview had zero blockers and the rollback succeeded, restoring the canonical and
lineage baseline with no batch-owned artifacts remaining.

The planner now rejects child inserts whose session dependency is absent from both the
hosted canonical sessions and a non-blocked planned session. A fresh post-fix dry run
fails closed with 27 inserts, one update, one ambiguous/unresolved headset-review parent,
and no hosted writes. The current source relationship must be corrected or separately
reviewed before any new live reconciliation approval. Google Sheets and Apps Script
remain authoritative; provider `sheets`, shadow disabled, and dual writes disabled are
unchanged.

The subsequent identity investigation classified the row as an
`orphaned_source_review`: its UUID-shaped source parent has no exact stable match in the
current Sheet sessions, canonical sessions, planned session inserts, historical staging,
or lineage. The row postdates the historical import and cannot be hidden as an expected
historical exception. No planner/importer change and no hosted correction were justified;
the source requires an authorized, evidence-backed stable session ID correction. The
fresh blocked plan retains 27 inserts, one update, 27 new and 155 reused lineage mappings,
snapshot checksum `ff3ab5ad96aa38563d3cb3c5234ec3caf112d71a2a808cd809e8ca004ad754a7`,
and plan checksum `49c06943dafbb0942a4e0f02c1165a278bf2f9281db1f229fbf9315dffba6456`.

### 2026-08-10 controlled reconciliation retry rollback

After the authorized source relationship correction and Apps Script version 24 deployment,
a completely fresh plan reproduced the exact approved 28 inserts, one update, 28 new and
155 reused lineage scope with zero blockers. Production batch
`da4a24d2-3682-4dce-8851-ec0072ebb97e` committed and internally verified all 29 items,
including the corrected headset review and its exact stable parent.

The post-sync 14-domain comparison then exposed 27 unexplained differences rather than
complete parity. The newly inserted candidates use the reconciliation contract's stable
persisted/session identities, while the existing shadow compatibility projection derives
candidate identity from names. Four candidates consequently appeared missing on each side
and four sessions had relationship mismatches. Because parity could not be proven, the
zero-blocker exact rollback restored the session before-image, removed all 28 batch-owned
rows and 28 batch lineage mappings, and returned operational counts and lineage to the
pre-execution baseline. The immutable batch audit is retained as `rolled_back/succeeded`.

No provider, shadow, dual-write, Apps Script, Auth, or Google Sheets setting changed.
Further live reconciliation requires a reviewed alignment between stable reconciliation
identity and shadow comparison identity, followed by a new explicit approval.

### 2026-08-07 incremental reconciliation planning checkpoint

`sync-incremental` now defaults to a one-snapshot, aggregate-only, zero-write plan.
The former 367-row `262 new / 84 changed / 21 unchanged` lineage counter is retired
from the CLI because it broadly reinterpreted historical source keys and could not
prove target ownership or rollback.

The fresh run still found 67 logical comparison differences, but the canonical plan
is narrow: 22 inserts and one allowlisted session update. Four candidate identities,
their dependent sessions, and two timestamp-less catalog rows remain blocked. The run
created no import batch or lineage and verified all hosted counts unchanged.

Unapplied forward migration `20260807000000_mts_sam_incremental_reconciliation.sql`
adds private batch, plan-item, and narrow before-image accounting required before any
future execution approval. See `docs/supabase-incremental-reconciliation-plan.md`.

For complete shadow-read readiness details, deployment audit, and activation criteria
see `docs/supabase-shadow-read-readiness.md`.
