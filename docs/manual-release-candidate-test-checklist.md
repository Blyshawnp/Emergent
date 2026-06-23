# Manual Release Candidate Test Checklist

Use this checklist for final RC validation when GUI automation cannot complete the full click/type workflow. Record issues immediately and attach screenshots or screen recordings when possible.

## PDF Status

PDF was not generated in this branch because the repo does not currently include a supported Markdown-to-PDF or docs-to-PDF build command. Use this Markdown checklist as the source of truth, or generate a PDF outside the repo with an approved documentation tool before distribution.

## Test Run Info

Tester name:

Date:

App version:

Test environment:

Windows version:

Install type:

MTS build path:

SAM build path:

Google Sheet test mode or sheet used:

## Result Key

- [ ] Pass
- [ ] Fail
- [ ] Not tested
- [ ] Not applicable

Notes:

## Automation Coverage

Automated or semi-automated checks completed for this RC:

- [ ] Branch/status preflight
- [ ] Packaged MTS EXE launch smoke
- [ ] Packaged SAM EXE launch smoke
- [ ] MTS second-instance launch exits or focuses existing MTS
- [ ] SAM second-instance launch exits or focuses existing SAM
- [ ] MTS and SAM can run at the same time
- [ ] `node --check desktop\src\main.js`
- [ ] `python -m py_compile backend/server.py backend/packaged_backend.py`
- [ ] `npm run build:react`
- [ ] `dev-tools\clean-rebuild-main-app.bat`

Not tested by automation in this environment:

- Full click/type GUI workflows inside packaged Electron windows
- Visual overlap, wrapping, and modal interaction across every listed workflow
- Sound playback by listening to speakers
- Google Sheet write effects that require a live shared test sheet
- Actual certification form fill submission into a real browser profile
- Auto-dismiss timing that requires waiting the full configured duration in UI
- Tutorial video playback with real MP4 assets

Reason automation was limited:

Codex can launch packaged EXEs through shell commands, but Windows Computer Use could not connect to its native control pipe in this session. Antigravity was not available as a callable tool in this environment.

## Issue Reporting

For every failed item, record:

- App: MTS or SAM
- Screen or workflow
- Steps to reproduce
- Expected result
- Actual result
- Candidate/test data used
- Screenshot or screen recording filename
- Severity: Blocker, High, Medium, Low
- Whether the issue affects release readiness

Urgent issue instructions:

- Stop testing if a workflow deletes or corrupts shared test data unexpectedly.
- Stop testing if credentials, private keys, Sheet IDs, service-account emails, or tokens appear on screen.
- Stop testing if the app cannot launch, cannot save sessions, cannot write required history, or cannot open Review.
- Report urgent issues to the release owner before continuing.

## MTS Test Cases

### MTS-01 Fresh Install Reset

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Install or launch a clean RC build.
2. Confirm first-run state appears.
3. Confirm previous tester settings are not unexpectedly reused.

Notes:

### MTS-02 Setup Wizard

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Complete tester name and display name.
2. Set ticker speed.
3. Set welcome voice to Male, then Female.
4. Set sound volume to Off, Low, Medium, and High.
5. Confirm setup saves and returns to the app.

Notes:

### MTS-03 Short Tutorial and Video Fallback

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Confirm tutorial starts on first run when expected.
2. Confirm no video button appears when no local MTS tutorial video exists.
3. Confirm guided tutorial still works.
4. Confirm Skip closes the tutorial.
5. If a video exists, confirm Watch Tutorial Video opens local playback.

Notes:

### MTS-04 Settings

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Open Settings.
2. Confirm tester identity, form links, ticker speed, welcome voice, sound volume, payment settings, Gemini, Discord posts, screenshots, updates, and theme settings are visible as expected.
3. Confirm payment settings show 3 Credit Card defaults and 3 EFT defaults.
4. Add and remove a payment option.
5. Save and reopen Settings to confirm persistence.

Notes:

### MTS-05 Help Search and Quick Actions

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Open Help.
2. Search for headset, payment, Discord, Final Readiness, and updater.
3. Confirm Replay Tutorial, Basics Setup, Fill Form, and Troubleshooting actions still work.
4. Confirm current feature text is accurate.

Notes:

### MTS-06 Discord Posts

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Open Discord Post.
2. Confirm Templates and Screenshots tabs work.
3. Confirm category filtering and search work.
4. Confirm category pill appears above the blue title.
5. Confirm message body has room, wraps long URLs safely, and does not overlap.
6. Copy a post and confirm clipboard text is correct.

Notes:

### MTS-07 Screenshots

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Open Screenshots in Discord Post.
2. Confirm screenshot categories load.
3. Preview an image.
4. Copy image where supported.

Notes:

### MTS-08 Basics

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Start a new session.
2. Enter candidate and tester details.
3. Confirm required field warnings appear for missing data.
4. Confirm candidate lookup behaves safely.

Notes:

### MTS-09 Headset Search H390 and H650e

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Type `H390` in headset search.
2. Confirm matching approved headset appears.
3. Select it and confirm USB and Noise Cancelling auto-mark Yes.
4. Repeat with `H650e`.

Notes:

### MTS-10 VPN Fail Popup and Discord Button

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Mark VPN as on and unable to turn off.
2. Confirm VPN fail modal appears.
3. Confirm the purple button says `Discord Post: VPN Fail`.
4. Click it and confirm the correct Discord template copies.
5. Confirm no duplicate Copy label appears.

Notes:

### MTS-11 Headset Fail Popup and Discord Button

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Mark headset as not USB or not noise cancelling.
2. Confirm headset fail modal appears.
3. Confirm the purple button says `Discord Post: Wrong Headset`.
4. Click it and confirm the correct Discord template copies.

Notes:

### MTS-12 Calls

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Complete Call 1, Call 2, and Call 3.
2. Confirm call type is required.
3. Confirm No Coaching Selected warning appears when expected.
4. Confirm coaching helper text appears.
5. Confirm Other is last and custom notes enable only when Other is selected.

Notes:

### MTS-13 Payment Readability

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Open a payment simulation in Calls.
2. Confirm card and EFT labels are readable.
3. Confirm dropdowns are not clipped or overlapping.

Notes:

### MTS-14 Payment Reset

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Change payment dropdowns during a call.
2. Start the next Call or Sup Transfer.
3. Confirm dropdowns reset to Default.

Notes:

### MTS-15 Pass Session

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Pass enough calls and supervisor transfer to pass.
2. Open Review.
3. Confirm Final Readiness uses calculated Pass.
4. Confirm summaries are generated or fallback summaries appear.

Notes:

### MTS-16 Fail Session

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Fail enough calls to fail.
2. Confirm fail reasons and Add Detail behavior.
3. Open Review.
4. Confirm Fail summary is not incorrectly N/A.

Notes:

### MTS-17 Newbie Shift

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Trigger or route to Newbie Shift.
2. Confirm date/time fields validate.
3. Confirm Google Calendar link is created.
4. Confirm purple button says `Discord Post: Out of Time (Needs Sup)`.

Notes:

### MTS-18 Sup Transfer Pass

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Complete Supervisor Transfer 1 as Pass.
2. Confirm payment simulation displays correctly.
3. Confirm coaching and review output are correct.

Notes:

### MTS-19 Sup Transfer Fail

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Fail Supervisor Transfer 1.
2. Confirm fail reasons appear.
3. Confirm `Discord Post: Failed 1st Sup Transfer` copies the correct template.
4. Confirm Add Detail works.

Notes:

### MTS-20 NC/NS

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Use NC/NS auto-fail.
2. Confirm Review opens.
3. Confirm NC/NS status and form mapping are correct.

Notes:

### MTS-21 Stopped Responding

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Use Stopped Responding.
2. Confirm warning sound plays if sound is enabled.
3. Confirm Review and summaries reflect stopped responding.

Notes:

### MTS-22 Tech Issue

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Open Tech Issue.
2. Record a safe test issue.
3. Confirm issue appears in Review or History as designed.

Notes:

### MTS-23 Discard Session

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Start a draft session.
2. Click Discard Session.
3. Confirm warning/error sound plays if sound is enabled.
4. Confirm confirmation can be canceled.
5. Confirm confirmed discard clears the draft.

Notes:

### MTS-24 Review

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Complete a session to Review.
2. Confirm Final Evaluator Notes modal does not appear before Review.
3. Confirm Final Readiness Judgment appears on Review.
4. Confirm summaries are editable and copy buttons work.

Notes:

### MTS-25 Final Readiness Override

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Complete a calculated Pass session.
2. Override to Fail and enter reason/explanation.
3. Confirm fail summary includes reason/explanation.
4. Confirm Mock Complete = No and Sup Complete = No in form payload.
5. Override to Needs Retest / Additional Coaching and confirm it is not treated as clean Pass.
6. Confirm calculated Fail or Incomplete cannot be overridden to Pass.

Notes:

### MTS-26 Gemini Status and Fallback

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Open Review while summaries are generating.
2. Confirm inline status says summaries are generating.
3. Disable or remove Gemini config in a safe test setup.
4. Confirm fallback summary appears and app does not look frozen.

Notes:

### MTS-27 Finish and Fill Form

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Click Finish & Fill Form.
2. Confirm missing form warning appears when appropriate.
3. Confirm Pass completion maps normally.
4. Confirm Final Readiness Fail/Needs Retest override maps Mock Complete and Sup Complete to No.

Notes:

### MTS-28 History

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Finish a session.
2. Open History.
3. Confirm new session appears.
4. Open older saved sessions with legacy notes if available.
5. Confirm History remains read-only where expected.

Notes:

### MTS-29 Single Instance Lock

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Launch MTS.
2. Launch MTS a second time.
3. Confirm the second instance is blocked or exits.
4. Confirm the first MTS remains usable.

Notes:

## SAM Test Cases

### SAM-01 Startup

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Launch SAM.
2. Confirm setup/login gate appears if required.
3. Confirm status chips and backend status are understandable.

Notes:

### SAM-02 Short Tutorial and Video Fallback

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Confirm SAM guided tutorial appears on first run when expected.
2. Confirm no video button appears when no local SAM tutorial video exists.
3. If a video exists, test before, after, instead, and disabled modes.
4. Confirm users can skip the video.

Notes:

### SAM-03 Help and Settings

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Open Help.
2. Confirm settings include sounds, status banner duration, default candidate filter, archived search default, and tutorial video settings.
3. Confirm help section links jump or scroll correctly.

Notes:

### SAM-04 Add Notification

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Add a notification.
2. Validate required fields.
3. Save using safe test data.
4. Confirm success banner and sound behavior.

Notes:

### SAM-05 Live Preview

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Select a notification.
2. Confirm ticker, banner, and popup previews match selected settings.

Notes:

### SAM-06 Candidate Tracking

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Open Candidate Tracking.
2. Confirm current, pending, incomplete, failed, withdrawn, passed, archived, and all active views where data exists.
3. Confirm row actions fit at normal window size.

Notes:

### SAM-07 Candidate Search

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Open Candidate Search.
2. Search by candidate name.
3. Confirm active candidates appear by default.

Notes:

### SAM-08 Include Archived Search

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Search for an archived candidate with Include archived off.
2. Confirm archived candidate is excluded.
3. Turn Include archived on.
4. Confirm archived candidate appears and is labeled Archived.

Notes:

### SAM-09 Manual Archive

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Choose a safe test candidate.
2. Click Archive.
3. Confirm action before updating shared state.
4. Confirm candidate moves to Archived Candidates.

Notes:

### SAM-10 Auto-Archive Display Logic

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Use safe test rows with closed statuses older than 60 days.
2. Confirm clearly closed Pass, Withdrawn, and Fail-Final Attempt rows are eligible.
3. Confirm active, incomplete, ambiguous, or already archived rows are not auto-archived.

Notes:

### SAM-11 Pending Sup Transfers

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Open Pending Sup Transfers.
2. Confirm pending rows show candidate, tester, date, call results, and actions.
3. Move or remove a safe test row only with confirmation.

Notes:

### SAM-12 Mark Passed

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Mark a safe test candidate passed.
2. Confirm status updates and success banner/sound appear.

Notes:

### SAM-13 Mark Withdrawn

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Mark a safe test candidate withdrawn.
2. Confirm shared state update requires confirmation.
3. Confirm MTS would block that candidate after refresh.

Notes:

### SAM-14 Import CSV

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Import a safe test CSV.
2. Confirm validation errors for bad files.
3. Confirm success banner/sound for valid import.

Notes:

### SAM-15 Export CSV

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Export a backup CSV.
2. Confirm file downloads.
3. Confirm success banner/sound.

Notes:

### SAM-16 Refresh From Sheet

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Click Refresh from Sheet.
2. Confirm rows reload or a useful error appears.
3. Confirm error banner is dismissible.

Notes:

### SAM-17 Status Banners

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Trigger a success banner.
2. Dismiss it manually.
3. Trigger another success banner and confirm it auto-dismisses after the configured duration.
4. Trigger a safe error and confirm it remains visible longer but is dismissible.

Notes:

### SAM-18 Success and Error Sounds

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Set SAM sounds to Medium or High.
2. Trigger a success action and listen for `success-sam.mp3`.
3. Trigger a safe error and listen for `error-sam.mp3`.
4. Set sounds to Off and confirm sounds do not play.

Notes:

### SAM-19 Update Check

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Click Check for Updates.
2. Confirm updater status is understandable.
3. Confirm manual updater behavior still works if no automatic download is available.

Notes:

### SAM-20 Exit App

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Click Exit App.
2. Confirm warning/error sound plays if sound is enabled.
3. Confirm cancel keeps SAM open.
4. Confirm Exit closes SAM.

Notes:

### SAM-21 Single Instance Lock

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Launch SAM.
2. Launch SAM a second time.
3. Confirm the second instance is blocked or exits.
4. Confirm first SAM remains usable.

Notes:

### SAM-22 SAM and MTS Open Together

- [ ] Pass
- [ ] Fail
- [ ] Not tested

Steps:

1. Launch MTS.
2. Launch SAM.
3. Confirm both apps remain open and usable.
4. Confirm MTS does not block SAM and SAM does not block MTS.

Notes:

## Final Sign-Off

Release candidate result:

- [ ] Approved
- [ ] Approved with known non-blocking issues
- [ ] Blocked

Blocking issues:

Non-blocking issues:

Tester signature:
