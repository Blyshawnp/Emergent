# Google Content and Installer Update Notes

## Google Drive Rename Safety

Renaming the Google Doc or Google Sheet file title in Google Drive is safe. The app uses Google document and spreadsheet URLs/IDs from configuration, not the Drive file title.

Copying a Google Doc or Google Sheet is risky unless configuration is updated. A copy gets a new document ID or spreadsheet ID, so any configured URL or ID must be changed to point at the copy.

Do not rename Google Sheet tabs or headers casually. The app reads specific worksheets and columns, and changing those schemas can break content loading, update checks, SAM access, notifications, or session data.

## Configured Google Content

The app is expected to use configured Google URLs or IDs such as:

- `admin_content_sheet_url` / `admin_content_sheet_id`
- `content_sheet_url` / `content_sheet_id`
- `admin_help_doc_url` / `admin_help_doc_id`
- `admin_faq_doc_url` / `admin_faq_doc_id`
- `notification_sheet_url` as a legacy fallback

Drive file titles can change. These configured URLs and IDs must keep pointing to the intended Doc or Sheet.

## Required Tabs

Content/admin tabs:

- `callers`
- `shows`
- `call-types`
- `sup-reasons`
- `call-coaching`
- `sup-coaching`
- `call-fail-reasons`
- `sup-fail-reasons`
- `discord-posts`
- `screenshots`
- `headsets`
- `gemini-coaching-prompt`
- `gemini-fail-prompt`

Master/SAM/update tabs:

- `Candidate Sessions`
- `Pending Sup Transfers`
- `headset-review-log`
- `sam-authorized-users`
- `sam-notifications`
- `update-MTS`
- `update-SAM`

Update metadata is stored on the Google Sheet, not in a Google Doc. The `update-MTS` and `update-SAM` tabs are the source for release version, required version, installer URL, release title, release date, and notes.

## Strict Headers

`update-MTS` and `update-SAM`:

- `Version`
- `RequiredVersion`
- `Release Date`
- `Release Title`
- `URL`
- `Notes`

`sam-authorized-users`:

- `name`
- `pin`
- `role`
- `enabled`
- `installed`
- `install_date`
- `device_name`
- `notes`

`sam-notifications`:

- `Enabled`
- `ID`
- `Type`
- `Title`
- `Message`
- `ShowTicker`
- `ShowPopup`
- `ShowBanner`
- `Persistent`
- `StartDate`
- `StartTime`
- `EndDate`
- `EndTime`
- `ActionText`
- `ActionURL`
- `CreatedAt`
- `UpdatedAt`

`headset-review-log`:

- `headset_model`
- `candidate_name`
- `tester_name`
- `entered_at`
- `review_status`
- `notes`

`Candidate Sessions`:

- `session_id`
- `candidate_name`
- `candidate_first_name`
- `candidate_last_initial`
- `tester_name`
- `session_type`
- `attempt_number`
- `final_attempt`
- `status`
- `created_at`
- `completed_at`
- `mock_calls_completed`
- `sup_transfers_completed`
- `call_1_result`
- `call_2_result`
- `call_3_result`
- `sup_transfer_1_result`
- `sup_transfer_2_result`
- `coaching_summary`
- `fail_summary`
- `review_notes`
- `needs_sup_transfer`
- `pending_sup_transfer_id`
- `withdrawn`
- `withdrawn_at`
- `extra_attempt_granted`
- `extra_attempt_reason`
- `retention_until`
- `archived`
- `headset_usb`
- `noise_cancel`
- `headset_brand`
- `vpn_on`
- `vpn_off`
- `chrome_default`
- `extensions_disabled`
- `popups_allowed`
- `skills`

`Pending Sup Transfers`:

- `pending_id`
- `candidate_name`
- `candidate_first_name`
- `candidate_last_initial`
- `original_tester_name`
- `original_session_id`
- `created_at`
- `status`
- `final_attempt`
- `mock_call_summary`
- `call_1_result`
- `call_2_result`
- `call_3_result`
- `needed_reason`
- `completed_by`
- `completed_at`
- `completed_status`
- `notes`
- `headset_usb`
- `noise_cancel`
- `headset_brand`
- `vpn_on`
- `vpn_off`
- `chrome_default`
- `extensions_disabled`
- `popups_allowed`
- `skills`

`gemini-coaching-prompt` and `gemini-fail-prompt`:

- Cell `A1` must be `prompt`.
- Cell `A2` contains the prompt text.

The content tabs also depend on recognizable header names. For example, show content needs a show/name/title column, caller content needs category plus first/last name fields, and Discord/screenshot content needs the columns referenced by the app. Treat those headers as part of the schema and update code/config before renaming them.

## Installer and Update Behavior

MTS:

- appId: `com.acddirect.mocktestingsuite`
- productName: `Mock Testing Suite`
- installer: `Mock-Testing-Suite-Setup-1.0.1.exe`
- release assets for `v1.0.1`: `latest.yml`, `Mock-Testing-Suite-Setup-1.0.1.exe`, `Mock-Testing-Suite-Setup-1.0.1.exe.blockmap`

SAM:

- appId: `com.acddirect.mocktestingsuite.notificationmanager`
- productName: `Sam`
- installer: `Sam-Setup-1.0.1.exe`
- release assets for `v1.0.1`: `latest.yml`, `Sam-Setup-1.0.1.exe`, `Sam-Setup-1.0.1.exe.blockmap`

MTS and SAM remain separate apps because their appIds differ. Updating MTS should not overwrite SAM, and updating SAM should not overwrite MTS.

Do not change an appId after release unless the intent is to create a separate install identity. Changing appId can cause duplicate installs and may require a one-time uninstall or migration note for users.

Changing productName is safer than changing appId, but it still affects user-visible naming such as installer names, shortcuts, executable names, and install folders. Avoid casual renaming after release.

The current update flow checks GitHub Releases first through `electron-updater`. MTS uses `Blyshawnp/mts-releases` and SAM uses `Blyshawnp/sam-releases`, so each app reads its own `latest.yml` file without sharing an update feed.

The Google Sheet update tabs remain a fallback/manual release path. The app checks `update-MTS` or `update-SAM`, not a Google Doc, and opens the configured installer URL only when the GitHub/electron-updater path is unavailable or fails. The user then runs the NSIS installer, which should update over the matching installed app when appId/install identity remains stable.

## Code Signing and Updater Testing Requirements

1. **GitHub Release Repositories**: The public release repositories (`Blyshawnp/mts-releases` for MTS and `Blyshawnp/sam-releases` for SAM) are used strictly to host compiled installers, blockmaps, and update metadata (`latest.yml`). The source repository remains entirely private.
2. **Version Formats**: 
   - Application versions in `package.json` use standard semver notation (e.g., `1.0.1`).
   - GitHub release tags use a `v` prefix (e.g., `v1.0.1`).
3. **Release Metadata Integrity**: Packaged release assets must match the generated `latest.yml` metadata (file names, sizes, and SHA-512 hashes) exactly for `electron-updater` to successfully locate and process updates. Upload `latest.yml`, the `.exe`, and the `.exe.blockmap` from the same build at the same time. Do not replace only one asset after upload; rebuilding changes the installer hash and requires replacing all three release assets together.
4. **Code Signing and Signature Verification**: 
   - By default, `electron-updater` enforces signature verification on Windows when a `publisherName` is specified in the application configuration (`Shawn P. Bly` for both MTS and SAM).
   - If the downloaded update installer is unsigned, the automatic update process will fail with a signature verification error (e.g., "New version is not signed by the application owner").
5. **Local Unsigned Testing**: 
   - To test the updater flow locally or internally without a paid code-signing certificate, verification can be bypassed by setting any of the following environment variables to `true`:
     - `MTS_ALLOW_UNSIGNED_UPDATES_FOR_TESTING=true`
     - `SAM_ALLOW_UNSIGNED_UPDATES_FOR_TESTING=true`
     - `ALLOW_UNSIGNED_UPDATES_FOR_TESTING=true`
   - Bypassing verification will output a warning log: `[GITHUB UPDATE] WARNING: Unsigned update verification is disabled for local/internal testing only. Do not use this for public distribution.`
6. **Public Distribution**: For public or production distribution, all installers must eventually be digitally signed with a valid, trusted code-signing certificate. Bypassing signature verification is strictly forbidden in production.
7. **App ID Warning**: Never change the configured `appId` (`com.acddirect.mocktestingsuite` or `com.acddirect.mocktestingsuite.notificationmanager`) once a version has been distributed. Changing the App ID will break shortcut resolution, create duplicate side-by-side installations, and disrupt automated updates.
