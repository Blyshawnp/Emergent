# Integration GUI Smoke Test Checklist

Use this checklist after building packaged MTS and SAM from the integration branch. Record pass, fail, or not tested for each item before release.

## Fresh Install Reset Before GUI Smoke

- Run `dev-tools\reset-local-app-data-for-fresh-install-test.ps1` first and confirm the dry-run target list is limited to local MTS/SAM app-data folders.
- To intentionally reset local testing state, run `dev-tools\reset-local-app-data-for-fresh-install-test.ps1 -Apply`, type `RESET` when prompted, then relaunch MTS/SAM.
- Use `-IncludeLocalCache` only when app-specific `%LOCALAPPDATA%` cache folders also need to be cleared.
- Confirm the reset target list does not include repo files, build outputs, `production-ready`, Google Sheets content, Supabase data, or credentials.
- After reset, MTS should behave like a fresh install: Setup Wizard appears, and the Tutorial can appear after setup completion.

## Build And Package Preconditions

- Confirm `node --check desktop\src\main.js` passed.
- Confirm `python -m py_compile backend/server.py backend/packaged_backend.py` passed.
- Confirm `npm run build:react` from `desktop` passed.
- Confirm `dev-tools\clean-rebuild-main-app.bat` passed.
- Confirm production-ready refresh passed if preparing release folders.
- Confirm generated output is not staged or committed.

## MTS GUI Checklist

- Launch packaged Mock Testing Suite.
- Confirm startup completes without backend error dialogs.
- Confirm ticker loads and displays current fallback or remote content.
- Open Discord Posts popup.
- Confirm Templates tab opens to All Templates.
- Confirm Screenshots tab opens to All Screenshots.
- Confirm category filtering works on templates.
- Confirm category filtering works on screenshots.
- Confirm search still works within selected category.
- Confirm Discord template copy buttons copy only template body.
- Confirm screenshot entries load and image copy controls are visible.
- Confirm `DTE-Disposition-Box.png` displays in screenshot content.
- Confirm callers load for New, Existing, and Increase call paths.
- Confirm payment simulation appears on Call screens.
- Confirm Card Option dropdown is upper right in credit card box on desktop width.
- Confirm EFT Option dropdown is upper right in EFT box on desktop width.
- Change Card Option and EFT Option on Call 1, then start Call 2 and confirm both reset to default.
- Change Card Option and EFT Option on Call 2, then start Call 3 and confirm both reset to default.
- Start Sup Transfer and confirm payment dropdowns start at default and remain visible.
- Confirm the centralized Phonetics reference opens from Discord Posts/Screenshots or Reference Library Preview.

## Fail And Coaching Checks

- On Call 1, check a fail reason other than Other.
- Confirm `+ Add detail` appears only after the reason is checked.
- Click `+ Add detail`, enter text, and confirm it stays tied to that reason.
- Uncheck the reason and confirm its detail is hidden or ignored.
- Confirm Other still uses the normal visible notes box.
- Repeat fail detail check on Sup Transfer fail reasons.
- Select `Search name for every call` and confirm helper text appears.
- Select `Do not volunteer information` and confirm helper text appears.
- Complete a failed session and confirm summaries include fail reason details.
- Confirm History displays saved fail reason details.

## Headset And VPN Checks

- Confirm Basics shows Brand Headset before USB and Noise Cancelling questions.
- Select an approved headset and confirm USB and Noise Cancelling auto-mark Yes.
- Type an unlisted headset and confirm USB and Noise Cancelling require answers.
- Trigger Headset Issue fail popup.
- Confirm the purple `Discord Post: Wrong Headset` button appears and copies `Wrong Headset`.
- Trigger VPN Issue fail popup.
- Confirm the purple `Discord Post: VPN Fail` button appears and copies `VPN Fail`.
- Confirm unavailable templates show a friendly message instead of copying labels.

## Workflow Copy Buttons

- In Sup Transfer 1 fail reason box, confirm top-right Copy button appears.
- Confirm it copies `Failed 1st Sup Transfer`.
- On Newbie Shift screen, confirm Copy button appears next to Add to Google Calendar.
- Confirm it copies `Out of Time (Needs Sup)`.
- Confirm Add to Google Calendar still works or opens the expected calendar flow.

## Review, Final Notes, And Form Fill

- Complete a passing session with no override and confirm current behavior is unchanged.
- Confirm Final Evaluator Notes opens before summary generation.
- Confirm Gemini or fallback summary generation does not start while Final Evaluator Notes modal is open.
- Confirm Final Notes remain included after summary generation.
- Confirm Review page loads coaching and fail summaries.
- Confirm Finish & Fill Form opens and generates the expected payload.
- Confirm History/Home navigation still works after saving.

## Final Readiness Judgment

- Confirm Review shows `Final Readiness Judgment`.
- Confirm default option is `Yes, use calculated result`.
- Confirm calculated result shows Pass, Fail, or Incomplete.
- Override a passing session to Fail.
- Confirm final result changes to Fail and calculated result remains Pass.
- Override a failed session to Needs Retest / Additional Coaching.
- Confirm primary reason is required.
- Select Other and confirm explanation is required.
- Confirm summaries mention `Evaluator Override Applied` when active.
- Confirm History stores calculated and final result separately.
- Confirm Finish & Fill Form uses the final overridden result where appropriate.

## Welcome Audio And Sound Volume

- With setup incomplete, confirm default welcome audio is used.
- With Tester Name `Shawn Bly` and blank Display Name, confirm app tries `welcome-shawn.mp3`.
- With Display Name `Shawn`, confirm app tries `welcome-shawn.mp3`.
- With Tester Name `Debra Smith` and Display Name `Debbie`, confirm app tries `welcome-debbie.mp3`.
- Select Female voice and confirm app tries `welcome-debbie-f.mp3`.
- Confirm `welcome-gwen.mp3` and `welcome-gwen-f.mp3` are found if selected.
- Confirm missing personalized male file falls back to default male.
- Confirm missing personalized female file falls back to default female, then male fallback.
- Set Sound volume Off and confirm welcome and app sound effects are muted.
- Set Low, Medium, and High and confirm audible volume changes.

## SAM GUI Checklist

- Launch packaged SAM.
- Confirm startup completes without backend error dialogs.
- Confirm remote content loading status is visible and does not block local fallback behavior.
- Confirm candidate tracking loads.
- Confirm pending sup transfers load.
- Confirm search works for candidate tracking and pending sup transfers.
- Confirm notifications display and can be managed in the expected screens.
- Confirm update status visibility is still present.
- Confirm login is not required.
- Confirm no Supabase UI wiring appears in this Phase 1 integration.

## Updater And Manual Release Checks

- Confirm MTS `latest.yml` matches the MTS installer and blockmap from the same build.
- Confirm SAM `latest.yml` matches the SAM installer and blockmap from the same build.
- Confirm manual update copy opens the expected release/download path.
- Confirm app IDs were not changed.
- Confirm updater fallback behavior is unchanged.

## Packaging Stale-Artifact Check

- Inspect `production-ready/Mock Testing Suite 1.0.1`.
- Confirm only the intended current installer and matching blockmap are present before release.
- Inspect `production-ready/ADMIN ONLY - SAM 1.0.1`.
- Confirm only the intended current SAM installer and matching blockmap are present before release.
- Confirm `MAIN-APP-HASH.txt` and `NOTIFICATION-MANAGER-HASH.txt` were refreshed for release output.
- Confirm `production-ready/`, `desktop/dist/`, `desktop/dist-notification-manager/`, `frontend/build/`, installers, blockmaps, `latest.yml`, `app-update.yml`, `app.asar`, logs, SQLite files, and credentials are not staged for source commits.

## Result Summary

- MTS GUI result:
- SAM GUI result:
- Copy buttons result:
- Payment reset result:
- Final Notes timing result:
- Final Readiness Judgment result:
- Welcome audio result:
- Updater/manual release result:
- Packaging stale-artifact result:
- Remaining blockers:
