# Packaged Apps Script API configuration

MTS and SAM use a packaged Apps Script web-app endpoint for Google Sheet reads and writes. This replaces distribution of a Google service-account JSON and its long-lived private key.

The application does not expose API credentials in Settings, API status payloads, logs, error messages, or the user interface. Packaged credentials can still be extracted by a determined local user, so MTS and SAM use separate credentials with role/action-scoped authorization. The MTS credential cannot invoke SAM decisions, notification administration, generic sheet writes, or candidate-administration operations.

## Config locations

The ignored build-local configs are:

- MTS: `backend/config/apps-script-api-mts.json`
- SAM: `backend/config/apps-script-api-sam.json`

They are ignored by Git and must not be committed. Start from:

- `backend/config/apps-script-api-mts.example.json`
- `backend/config/apps-script-api-sam.example.json`

The packaged copies are placed at:

- MTS: `resources/backend/config/apps-script-api.json`
- SAM: `resources/backend/config/apps-script-api.json`

The backend resolves an explicit `APPS_SCRIPT_API_CONFIG_FILE` first, then the packaged resource path, then the config directory next to a frozen backend executable. During development it selects `apps-script-api-mts.json` or `apps-script-api-sam.json` from the active application role. The legacy unscoped `apps-script-api.json` is accepted only as an MTS migration fallback; SAM fails closed on an unscoped config.

## Preparing a build

1. Copy the MTS and SAM example files to their corresponding ignored config paths.
2. Put the same existing stable Web app endpoint in both files.
3. Put the MTS credential only in the MTS file and the SAM credential only in the SAM file.
4. Keep `enabled` set to `true` and preserve the exact `role`.
5. Run the normal clean rebuild. The rebuild validates the expected role, an Apps Script `/exec` URL, and a non-empty credential without printing either secret or the deployment path.

The config shape is:

```json
{
  "enabled": true,
  "role": "mts",
  "base_url": "https://script.google.com/macros/s/DEPLOYMENT_ID/exec",
  "token": "MTS_TOKEN"
}
```

The SAM file uses `"role": "sam"` and the separate SAM credential. Do not put either credential in `runtime_config.json`, frontend code, screenshots, support logs, or documentation.

## Authorization boundary

MTS is authorized for ordinary content reads, candidate/session synchronization, pending-request submission, and unknown-headset submission. Candidate synchronization must use the named `candidateRow` and optional `pendingRow` payload; MTS cannot submit an admin `operation`.

SAM can perform the MTS operations plus headset decisions, pending-request decisions, candidate-administration commands, notification administration, and the allowlisted generic sheet operations required by SAM. Unknown actions, blank credentials, ambiguous cross-role credentials, and role-mismatched packaged configs fail closed.

## Apps Script request contract

MTS/SAM use encoded HTTPS GET requests for read actions and JSON HTTPS POST requests for write actions. The deployment must return JSON and must never echo the token. Client errors redact both raw and URL-encoded forms of the token.

Supported actions:

- `ping`
- `getHeadsets`
- `getScreenshots`
- `getDiscordPosts`
- `getCandidateTracking`
- `getPendingRequests`
- `getHeadsetReviewLog`
- `submitHeadsetReview`
- `approveHeadset`
- `denyHeadset`
- `updateCandidateTracking`
- `upsertPendingRequest`
- `decidePendingRequest`
- `getSamAdmins` / `getAdminPins` (`sam-authorized-users`)
- `getTickerMessages` / `getAlerts` (`sam-notifications`)
- `getSharedCandidates` (`Candidate Sessions` and `Pending Sup Transfers`)
- `getSheetMetadata`
- `getSheetRange`
- `batchGetSheetRanges`
- `updateSheetRange`
- `appendSheetRows`
- `batchUpdateSheetRanges`
- `batchUpdateSpreadsheet`

The compatibility actions are allowlisted in
[`apps-script-api-web-app.gs`](./apps-script-api-web-app.gs). The desktop/backend
adapter translates Google Sheets client calls to these names; it never sends
`spreadsheets.get` or `spreadsheets.values.*` to Apps Script.

Successful read responses should use a `rows` array:

```json
{ "ok": true, "rows": [] }
```

Successful write responses may include action-specific status fields:

```json
{ "ok": true, "updated": true }
```

Rejected requests should use a generic message that contains no token or private data:

```json
{ "ok": false, "error": "Request rejected." }
```

The endpoint should implement only the operations required by the configured spreadsheets. It should not accept arbitrary URLs, script source, formulas, or file-system paths from clients.

## Pending request sheet contract

The current repository source uses the following exact tab names. Do not rename deployed tabs or headers. The Apps Script adapter accepts the documented `source_session_id` request alias while preserving the deployed `session_id` header.

- `newbie-shift-requests`: `request_id`, `session_id`, `candidate_name`, `candidate_first_name`, `candidate_last_initial`, `tester_name`, `request_type`, `request_status`, `requested_by`, `request_reason`, `request_details`, `request_created_at`, `original_scheduled_at`, `rescheduled_at`, `scheduled_at`, `timezone`, `within_24_hours`, `counts_as_attempt`, `final_attempt`, `admin_decision_at`, `admin_decision_by`, `denial_reason`, `updated_at`.
- `candidate-deletion-requests`: `request_id`, `session_id`, `candidate_name`, `candidate_first_name`, `candidate_last_initial`, `tester_name`, `created_at`, `status`, `local_history_deleted`, `reason`, `session_status`, `completed_at`, `audit_summary`, `admin_decision_at`, `admin_decision_by`, `denial_reason`, `updated_at`.
- `Candidate Sessions` request synchronization fields: `session_id`, `newbie_shift_scheduled_at`, `newbie_shift_timezone`, `newbie_shift_request_id`, `newbie_shift_request_type`, `newbie_shift_request_status`, `newbie_shift_requested_by`, `newbie_shift_request_reason`, `newbie_shift_request_details`, `newbie_shift_request_created_at`, `newbie_shift_original_scheduled_at`, `newbie_shift_rescheduled_at`, `newbie_shift_within_24_hours`, `newbie_shift_counts_as_attempt`, `newbie_shift_admin_decision_at`, `newbie_shift_admin_decision_by`, `newbie_shift_denial_reason`, `deletion_request_id`, `deletion_request_status`, `deletion_request_created_at`.

`decidePendingRequest` accepts only command values `approve` and `deny`, requires `expected_status` to be `pending`, and stores `approved` or `denied`. Denial requires a non-empty reason. Initial/reschedule decisions synchronize the matching `Candidate Sessions` row by source `session_id`. Candidate-deletion approval is non-destructive and returns `deletion_action_required=true`; it must not broadly delete candidate or session rows.

## Headset review sheet contract

New or blank `headset-review-log` tabs use the current V2 review headers:

`review_id`, `source_session_id`, `candidate_name`, `tester_name`, `Brand`, `Model`, `Status`, `Note`, `created_at`, `updated_at`, `decision_at`, `decision_by`, `denial_reason`.

`submitHeadsetReview` creates or updates one pending row by stable `review_id` or the same source-session/headset pair. It must preserve candidate, tester, brand, model, status, notes, and timestamps; it must not reset an already approved or denied row to pending.

Existing basic `Brand, Model, Status, Note` and legacy `headset_model, candidate_name, tester_name, entered_at, review_status, notes` tabs remain supported without rewriting their headers. V2 decisions target the exact `review_id`; basic and legacy rows use the existing headset identity fallback. Decisions also upsert the corresponding `headsets` row with `Status` set to `approved` or `denied`. Duplicate same-decision submissions are safe; conflicting decisions are rejected.

## Features using the API

The shared transport covers:

- Discord post reads
- screenshot metadata reads
- approved and denied headset reads
- `headset-review-log` reads and writes
- headset approval and denial updates
- Candidate Sessions and Pending Sup Transfers tracking
- Pending request listing, creation/update, approval, denial, and Candidate Sessions decision synchronization
- SAM authorized-user and notification sheet operations used by the existing shared-sheet workflows

## Deploying the Apps Script server

1. Open the controlled Apps Script project for the existing web-app deployment.
2. Replace the project code with the current `docs/apps-script-api-web-app.gs` repository source and save it.
3. In Project Settings > Script Properties, confirm `MASTER_SPREADSHEET_ID`, `MTS_API_TOKEN`, and `SAM_API_TOKEN` are configured. `MTS_API_TOKEN_PREVIOUS` and `SAM_API_TOKEN_PREVIOUS` are optional bounded-rotation values. `API_TOKEN` is an MTS-only migration fallback and should be removed after migration. Never paste property values into source, logs, screenshots, or documentation.
4. Do not manually create optional request or headset-review tabs solely for the application. Reads safely return empty results when those tabs are absent; the first authorized write creates a missing tab with the repository header contract. Existing non-empty basic or legacy headset headers are preserved.
5. Select Deploy > Manage deployments, edit the existing Web app deployment, choose New version, add a deployment description, and deploy. Do not create a second deployment when the packaged endpoint must remain stable.
6. Confirm the deployment still executes as the owner and retains its existing access policy. Do not publish the deployment URL in tickets or documentation.
7. Using the protected configured client or admin diagnostics, verify `ping`, `getSheetMetadata`, `getPendingRequests`, `getSamAdmins`, `getTickerMessages`, `getCandidateTracking`, and existing content reads.
8. In safe test data, verify `upsertPendingRequest` and `decidePendingRequest` with `expected_status=pending`; confirm approve/deny normalization, required denial reason, Candidate Sessions synchronization by source session ID, and non-destructive candidate-deletion approval.
9. In safe test data, submit one unique unknown headset from MTS, confirm exactly one `headset-review-log` row with stable `review_id`, restart MTS to confirm no duplicate, then approve and deny separate test rows from SAM.
10. Rebuild only after the protected checks pass. If deployment access is unavailable, mark the live validation `REQUIRES MANUAL VERIFICATION`; repository source readiness is not proof of live deployment.

The real tabs are `sam-authorized-users`, `sam-notifications`, `Candidate
Sessions`, and `Pending Sup Transfers`; the deployment must not substitute a
new `candidate-tracking` tab.

Selenium certification-form filling is independent of this transport and remains unchanged.

## Token rotation

Rotate MTS and SAM independently:

1. Generate a new high-entropy credential for one role.
2. Move that role's current Script Property value to its `_PREVIOUS` property and put the new value in the current property.
3. Update only the matching ignored role config on the controlled build machine.
4. Rebuild and redistribute only the affected application, or both applications if the release requires it.
5. Confirm the new package passes `ping` and its authorized read/write checks; confirm an MTS package still receives `Forbidden` for SAM-only operations.
6. Remove the previous property after the bounded rollout window.
7. Delete obsolete installers and unpacked folders containing the retired credential.

Do not place the same value in MTS and SAM properties. If a value accidentally appears in both roles, authorization treats it as ambiguous and rejects it.

Rotation does not require any user-facing Settings change.

## Testing

Before distribution, use the packaged applications or the protected admin diagnostics to verify:

1. `ping` succeeds.
2. Headsets load and denied models do not appear in approved selections.
3. Screenshot metadata loads and each referenced packaged image opens.
4. Discord posts load, including Wrong Headset and VPN Fail.
5. A test candidate can be created, updated, and read through Candidate Sessions/Pending Sup Transfers.
6. A test unknown headset reaches `headset-review-log`, then approval and denial update both review and headset state.
7. An initial Newbie Shift request and a reschedule request round-trip through MTS, SAM, and MTS with Pending then Approved/Denied state.
8. Denial without a reason is rejected; denial with a reason persists and reconciles into MTS.
9. Candidate-deletion approval returns `deletion_action_required=true` without broad automatic candidate/session deletion.
10. No token appears in backend logs, frontend output, status payloads, or error messages.
11. Package scans find `apps-script-api.json` but no service-account file or private-key material.

## Fallback behavior

If the config is missing, disabled, malformed, uses a placeholder, has a non-HTTPS/non-Apps-Script URL, cannot be reached, or rejects authentication:

- the backend records a generic admin-friendly status;
- no token or endpoint is logged;
- MTS/SAM continue using packaged CSV/Markdown and built-in notification defaults where available;
- remote write operations return a controlled error instead of crashing;
- users are not prompted to enter configuration in Settings.

If the config is enabled and reachable but the deployment returns `Unknown
action` for a required route, the app reports a deployment-route error instead
of silently treating local defaults as live Google Sheet data.

Correct the build-local config or Apps Script deployment, rebuild if necessary, and restart the application to restore remote synchronization.

## Tutorial Video Help Tabs

Repository Apps Script source allowlists `mts-tutorial-videos` and `sam-tutorial-videos` and exposes `getTutorialVideos`, `getMtsTutorialVideos`, and `getSamTutorialVideos`. Both tabs use the exact header row in `docs/tutorial-video-setup.md`.

After deploying the updated Apps Script version, an authorized SAM administrator can create only the missing tutorial-video tabs with the SAM-only POST action `ensureTutorialVideoTabs`. The action is idempotent, preserves existing rows, validates the exact header order, and returns only created/existing tab names and counts. MTS credentials are forbidden from invoking it.

Invoke it with placeholders only from PowerShell:

```powershell
$body = @{
  action = 'ensureTutorialVideoTabs'
  token = 'REPLACE_WITH_CURRENT_SAM_TOKEN'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri 'REPLACE_WITH_STABLE_APPS_SCRIPT_EXEC_URL' `
  -ContentType 'application/json' `
  -Body $body
```

Run this once after deploying the new version. A successful repeat reports both tabs as existing and does not change their rows. If a tab already exists with incompatible headers, correct its header row manually before retrying; the setup action will not overwrite it.

Update the existing Web app deployment: open the Apps Script project, replace its source with the current `docs/apps-script-api-web-app.gs`, confirm the existing Script Properties remain configured without displaying their values, select **Deploy > Manage deployments**, edit the current Web app, choose **New version**, add a release description, and deploy. Keep the existing endpoint stable. Run read-only `ping` and tutorial-video reads before activating a video row.

Repository source is deployment-ready. This coding environment did not update the live deployment or workbook and does not claim that live work complete.
