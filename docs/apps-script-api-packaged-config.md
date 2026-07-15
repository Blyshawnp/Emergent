# Packaged Apps Script API configuration

MTS and SAM use a packaged Apps Script web-app endpoint for Google Sheet reads and writes. This replaces distribution of a Google service-account JSON and its long-lived private key.

The application does not expose the API token in Settings, API status payloads, logs, error messages, or the user interface. The token is still a packaged shared secret and can be extracted by a determined local user, so the Apps Script deployment must validate it, limit its capabilities to the required sheets/actions, and support rapid rotation.

## Config locations

The build-local config is:

`backend/config/apps-script-api.json`

It is ignored by Git and must not be committed. Start from:

`backend/config/apps-script-api.example.json`

The packaged copies are placed at:

- MTS: `resources/backend/config/apps-script-api.json`
- SAM: `resources/backend/config/apps-script-api.json`

The backend resolves an explicit `APPS_SCRIPT_API_CONFIG_FILE` first, then the packaged resource path, then the config directory next to a frozen backend executable, and finally `backend/config/apps-script-api.json` during development.

## Preparing a build

1. Copy `backend/config/apps-script-api.example.json` to `backend/config/apps-script-api.json`.
2. Replace `DEPLOYMENT_ID` with the active Apps Script web-app deployment ID.
3. Replace `TOKEN` with the deployment token.
4. Keep `enabled` set to `true`.
5. Run the normal clean rebuild. The rebuild validates that the config is enabled and has a Google Apps Script `/exec` URL and a non-empty token without printing either value.

The config shape is:

```json
{
  "enabled": true,
  "base_url": "https://script.google.com/macros/s/DEPLOYMENT_ID/exec",
  "token": "TOKEN"
}
```

Do not put this token in `runtime_config.json`, frontend code, screenshots, support logs, or documentation.

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
3. In Project Settings > Script Properties, confirm `API_TOKEN` and `MASTER_SPREADSHEET_ID` already exist. Add them only if missing; never paste either value into source, logs, screenshots, or documentation.
4. Confirm the three pending-request tabs and headers above already exist. Setup verification should happen during deployment/setup, not during every polling request.
5. Select Deploy > Manage deployments, edit the existing Web app deployment, choose New version, add a deployment description, and deploy. Do not create a second deployment when the packaged endpoint must remain stable.
6. Confirm the deployment still executes as the owner and retains its existing access policy. Do not publish the deployment URL in tickets or documentation.
7. Using the protected configured client or admin diagnostics, verify `ping`, `getSheetMetadata`, `getPendingRequests`, `getSamAdmins`, `getTickerMessages`, `getCandidateTracking`, and existing content reads.
8. In safe test data, verify `upsertPendingRequest` and `decidePendingRequest` with `expected_status=pending`; confirm approve/deny normalization, required denial reason, Candidate Sessions synchronization by source session ID, and non-destructive candidate-deletion approval.
9. Rebuild only after the protected checks pass. If deployment access is unavailable, mark the live validation `REQUIRES MANUAL VERIFICATION`; repository source readiness is not proof of live deployment.

The real tabs are `sam-authorized-users`, `sam-notifications`, `Candidate
Sessions`, and `Pending Sup Transfers`; the deployment must not substitute a
new `candidate-tracking` tab.

Selenium certification-form filling is independent of this transport and remains unchanged.

## Token rotation

1. Generate a new high-entropy token.
2. Update the Apps Script deployment to accept the new token. A short overlap with the old token may be used only during a coordinated rollout.
3. Update the ignored `backend/config/apps-script-api.json` on the controlled build machine.
4. Rebuild and redistribute MTS and SAM.
5. Confirm the new builds pass `ping` and sheet read/write checks.
6. Remove the old token from Apps Script immediately after rollout.
7. Delete obsolete installers and unpacked folders containing the old token.

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
