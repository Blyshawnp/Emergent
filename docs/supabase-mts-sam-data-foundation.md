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

Five approved migrations were applied as of the previous checkpoint. A sixth forward migration
(`20260803000000_mts_sam_lineage_rpc.sql`) was added in this checkpoint to provide a
transactional, race-safe lineage RPC. Local and remote migration history agree.
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
- newbie_shift_requests: 9 (13 staged, 4 exact duplicates deduplicated)
- candidate_corrections: 7
- notifications: 4

Source accounting (batch 1, 358 rows): 220 valid + 128 unresolved + 4 duplicate + 6 rejected = 358.

Nine required configuration tabs remain staging-only (66 rows total, not 100 as incorrectly
stated in earlier reports). These block full data-provider cutover but do not block
mapped-domain shadow reads. See `docs/supabase-shadow-read-readiness.md` for full details.

Six `sam-authorized-users` rows were rejected per import batch (auth UUID mismatch with
Supabase Auth). SAM authorization cutover remains blocked until a user-mapping process is
implemented.

Current test totals: 236 backend unit + 300 frontend + 33 Apps Script + 11 desktop = 580,
plus new tests added in this checkpoint.

For complete shadow-read readiness details, deployment audit, and activation criteria
see `docs/supabase-shadow-read-readiness.md`.
