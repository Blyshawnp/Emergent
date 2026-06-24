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
- `getHeadsetReviewLog`
- `submitHeadsetReview`
- `approveHeadset`
- `denyHeadset`
- `updateCandidateTracking`
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

## Features using the API

The shared transport covers:

- Discord post reads
- screenshot metadata reads
- approved and denied headset reads
- `headset-review-log` reads and writes
- headset approval and denial updates
- Candidate Sessions and Pending Sup Transfers tracking
- SAM authorized-user and notification sheet operations used by the existing shared-sheet workflows

## Deploying the Apps Script server

1. Copy `docs/apps-script-api-web-app.gs` into the Apps Script project attached
   to the controlled deployment.
2. Add Script Property `API_TOKEN` with the same secret used by the ignored
   build-local config. Never place the value in source or logs.
3. Add Script Property `MASTER_SPREADSHEET_ID` with the configured master Google
   Sheet ID.
4. Deploy a new version of the existing Web app deployment. Updating the
   existing deployment keeps the packaged `/exec` URL stable.
5. Verify `ping`, `getSheetMetadata`, `getSamAdmins`, `getTickerMessages`,
   `getCandidateTracking`, and the existing content actions before rebuilding.

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
7. No token appears in backend logs, frontend output, status payloads, or error messages.
8. Package scans find `apps-script-api.json` but no service-account file or private-key material.

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
