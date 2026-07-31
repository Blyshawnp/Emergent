# MTS / SAM Project Context

> This is the living technical and release handoff document for MTS and SAM. Update it whenever a major workflow, fallback, release rule, build command, security decision, or architecture detail changes. Repository code and validated runtime behavior remain the final source of truth.

## 2026-07-30 candidate outcome and scheduling contract

- Headset catalog identity remains exact `Brand` plus `Model`. Only normalized active approved rows are MTS-selectable; denied, archived, deleted, inactive, and unsupported statuses are excluded without headset-name special cases.
- Candidate display status uses the active authorized readiness override first, then final/required-component outcomes. Passed mock calls cannot override a failed required Supervisor Transfer on a final attempt.
- Candidate Tracking status changes target the exact session. Mark Passed/Failed reuse `readiness_override_*` audit fields and preserve `calculated_result`; Grant Extra Attempt increments `extra_attempts_granted` and `allowed_attempt_count` without rewriting prior outcomes.
- Attempt state distinguishes `current_attempt_number`, `allowed_attempt_count`, and `extra_attempts_granted`. A newly authorized fourth certification attempt is `4 of 4`; derivative Supervisor Transfer, Newbie Shift, reschedule, and form workflows do not create a new certification sequence.
- `newbie_shift_number` is the sole canonical optional shift-number key. It is stored as trimmed text, preserves leading zeroes, follows exact request/session identity, and is omitted from displays when blank.
- The Apps Script source adds these workflow columns through the existing compatible header-extension path. Source changes require a new immutable deployment; this repository task does not deploy or mutate live data.

Last verified: 2026-07-15 by final content synchronization, static repository inspection, all 20 frontend suites (166 tests), backend compile plus all release/feature suites, frontend production build, process-ownership checks, and sequential SAM/MTS 1.0.1 package builds. Current conclusion is blocked: the shared Apps Script token does not separate routine client actions from destructive admin actions, and fixed-port backend reuse does not prove listener identity. Service-account packaging and deployment-path logging were fixed locally. Live managed content, workflow round trips, Form dry runs, high-DPI UI, lifecycle, updater, and installed-app checks remain manual. See `docs/RELEASE_CHECKLIST_v1.0.1.md`.
Active branch: `feature/newbie-shift-request-workflows`
Release target: `v1.0.1`
Release stage: Release Candidate stabilization. Some current RC fixes are uncommitted.

## 1. Project Overview

Mock Testing Suite (MTS) is a desktop certification workflow application for trainers who run mock calls, evaluate candidates, handle technical issues, complete Supervisor Transfer steps, generate coaching/fail summaries, and prepare Microsoft Form submissions.

Smart Alert Manager (SAM) is the companion desktop operations application for supervisors/admins. It manages shared notifications, candidate tracking, pending Supervisor Transfers, headset review queues, version/update messaging, and operational diagnostics used by MTS.

The two applications share the same React frontend, FastAPI backend, Google Sheets data model, packaged backend executable, local defaults, and Electron packaging setup. MTS is the trainer-facing certification tool. SAM is the supervisor/admin-facing control surface for shared operational data that MTS consumes.

Current work is `v1.0.1` Release Candidate stabilization. The project is feature-complete for this release. Changes on this branch should be targeted release fixes, regression fixes, documentation updates, and validation work only. Broad redesigns and new feature work belong after release unless the project owner explicitly reclassifies them as blockers.

Commercial desktop expectations for this release:

- MTS and SAM must launch as packaged Windows desktop apps.
- Trainer-facing copy must be polished and non-technical.
- Workflows must degrade safely when Google, Gemini, Selenium, or network dependencies are unavailable.
- Release artifacts must not include accidental source-only files, generated build churn in commits, logs, or runtime databases.

## 2. Current Branch / Release State

Verified branch:

```text
feature/newbie-shift-request-workflows
```

Verified Git status at the start of the 2026-07-15 Pending Requests completion task showed no file changes. The task intentionally leaves the source, tests, styles, and documentation changes listed in the final report uncommitted and unstaged. Do not describe the tree as clean unless a fresh `git status --short --branch` proves it.

Current release target:

- Desktop application version: `1.0.1` in `desktop/package.json`.
- Electron default version constants: `1.0.1` in `desktop/src/main.js` and `desktop/src/preload.js`.
- React package version: `0.1.0` in `frontend/package.json`; this is the React app package version, not the shipped desktop release version.

Release Candidate status:

- Feature freeze is in effect for `v1.0.1`.
- Direct targeted RC fixes on `release/v1.0.1` are allowed because the project owner established that workflow.
- Do not create or switch branches during stabilization tasks unless explicitly instructed.
- Feature branches may be used for future development after release or when the project owner explicitly requests branch isolation.

Verified recent tags:

- `mts-sam-v1.0.1-rc1`
- `v1.0.1-rc1`
- `sam-redesign-sprint2`

Verified recent history includes `Stabilize v1.0.1 release workflows and UI polish`, `Stabilize supervisor transfer override and release UI fixes`, and Discord/SAM productivity commits. Current uncommitted RC stabilization work should be treated as active release work, not committed history.

## 3. Tech Stack

Verified technologies and libraries:

- Electron desktop shell: `desktop/package.json`, `desktop/src/main.js`, `desktop/src/notification-main.js`.
- Electron Builder packaging: `electron-builder` in `desktop/package.json`; MTS config in `desktop/package.json`; SAM config in `desktop/notification-manager-builder.json`.
- Electron Updater: `electron-updater` in `desktop/package.json`, used by `desktop/src/main.js`.
- React: React 19 in `frontend/package.json`.
- CRACO/react-scripts: frontend scripts in `frontend/package.json`.
- FastAPI: `fastapi==0.115.6` in `backend/requirements.txt`.
- Uvicorn: `uvicorn==0.34.0` in `backend/requirements.txt`.
- Python backend packaging: `backend/build-backend.ps1` uses PyInstaller and `backend/backend.spec`.
- SQLite: backend local persistence in `backend/server.py`; dev/runtime data under `backend/data/` and packaged/user-data paths.
- Google Sheets / Google APIs: `google-api-python-client`, `google-auth`, `google-auth-oauthlib`, `google-auth-httplib2` in `backend/requirements.txt`.
- Google Apps Script: Apps Script web-app support is documented in `docs/apps-script-api-web-app.gs` and config docs.
- Selenium form fill: `selenium` and `webdriver-manager` in `backend/requirements.txt`; implementation in `backend/services/form_filler.py`.
- Gemini summaries: `google-generativeai==0.8.3` and summary generation in `backend/server.py`.
- React icons/components: `lucide-react`, Radix packages, `cmdk`, `react-joyride`, `date-fns`, `dompurify` in `frontend/package.json`.
- Frontend tests: CRACO/Jest via `craco test`; React Testing Library dependencies in `frontend/package.json`.

State management is primarily React component state, persisted session/settings data through backend APIs, local storage for some UI preferences, Electron Store for desktop-side state, and SQLite for backend persistence. No Redux store was found in the inspected dependency files.

## 4. Repository Architecture

Primary source paths:

- Frontend entry: `frontend/src/index.js`.
- MTS application shell: `frontend/src/App.js`.
- SAM application shell: `frontend/src/NotificationManagerApp.jsx`.
- Frontend API client: `frontend/src/api.js`.
- MTS pages: `frontend/src/pages/`.
- Shared React components: `frontend/src/components/`.
- Frontend utilities and mappings: `frontend/src/utils/`.
- Frontend tests: `frontend/src/**/*.test.js`, `frontend/src/**/*.test.jsx`.
- Frontend static assets and screenshot images: `frontend/public/`.
- Frontend production build output: `frontend/build/` generated by `npm run build` from `frontend/`.

Backend source paths:

- FastAPI entry point and most backend business logic: `backend/server.py`.
- Selenium Microsoft Form filler: `backend/services/form_filler.py`.
- Backend build script: `backend/build-backend.ps1`.
- Backend PyInstaller spec: `backend/backend.spec`.
- Backend requirements: `backend/requirements.txt`.
- Backend tests: `backend/test_*.py`.
- Backend local defaults: `backend/defaults/`.
- Backend content fallback: `backend/content/app_content.json` when present.
- Backend drivers: `backend/drivers/`.
- Backend executable output: `backend/dist/backend.exe`.
- Development SQLite data location: `backend/data/`.

Electron/desktop paths:

- Main process: `desktop/src/main.js`.
- Preload bridge: `desktop/src/preload.js`.
- SAM mode entry point: `desktop/src/notification-main.js`.
- MTS package/build config: `desktop/package.json`.
- SAM package/build config: `desktop/notification-manager-builder.json`.
- Desktop assets/icons: `desktop/assets/`.
- MTS installer output: `desktop/dist/`.
- SAM installer output: `desktop/dist-notification-manager/`.

Documentation and tooling:

- Release/security/build docs: `docs/`.
- Admin/default content package: `docs/admin-content-package/`.
- Default CSV tabs for admin package: `docs/admin-content-package/csv-tabs/`.
- Developer maintenance docs: `dev-tools/docs/`.
- Discord screenshot maintenance guide: `dev-tools/docs/discord-posts-and-screenshots-defaults.md`.
- Help/FAQ fallback maintenance guide: `dev-tools/docs/help-faq-defaults.md`.

Runtime data patterns:

- Electron sets per-app user data paths for MTS and SAM in `desktop/src/main.js`.
- The packaged backend receives app mode, app user-data paths, backend port, and admin token from Electron.
- MTS uses backend port `8600`; SAM mode uses backend port `8601`.
- Packaged backend resources are copied via Electron Builder `extraResources`.
- Runtime SQLite databases, logs, generated installers, blockmaps, `latest.yml`, `app.asar`, and build outputs are not source architecture and should not be committed.

Process ownership and lifecycle requirements:

- MTS and SAM must be able to run at the same time on the same Windows computer.
- Process ownership helper: `desktop/src/processOwnership.js`.
- Every externally spawned process must be classified as `MTS-owned`, `SAM-owned`, `Intentionally shared`, or `External / not owned`; the default assumption is not shared.
- Closing MTS must terminate only MTS-owned processes.
- Closing SAM must terminate only SAM-owned processes.
- If both apps are open, closing one must not affect the other app or its backend.
- If both apps launch `backend.exe`, each backend has its own PID and owner. MTS may terminate only the MTS backend PID, and SAM may terminate only the SAM backend PID.
- Current implementation registers the app-owned backend launcher `ChildProcess` and reconciles the actual FastAPI listener PID for the app port once backend health is ready.
- Listener-PID ownership is registered as `backend-listener` in `desktop/src/main.js`; PID-only cleanup is handled by `desktop/src/processOwnership.js` using exact-PID process-tree termination.
- Current owner values are `mts` and `sam`; app mode still selects port `8600` for MTS and `8601` for SAM.
- Current graceful cleanup timeout is `3000ms` before exact-PID process-tree termination.
- Windows forced cleanup uses `taskkill.exe /PID <exact-owned-pid> /T /F`; executable-name cleanup remains forbidden.
- If the app reuses a healthy backend already listening on its own port, that backend is treated as external/not owned and is not killed on quit.
- Stale backend cleanup uses per-app backend-owner metadata only. It does not enumerate or kill every `backend.exe` by image name.
- The same owner/PID rule applies to Electron helpers, Node helpers, Selenium helpers, browser drivers, updater processes, and any other spawned child processes.
- If the repository proves that a process is intentionally shared, ownership must be explicit and reference-counted so the shared process remains alive until every owning app exits.
- No intentional shared runtime process was verified for `v1.0.1`; do not introduce process sharing unless the architecture explicitly changes.
- Never clean up by executable name alone. Do not use commands such as `taskkill /IM node.exe`, `taskkill /IM backend.exe`, `taskkill /IM python.exe`, or `taskkill /IM electron.exe`.
- Acceptable cleanup patterns are retained `ChildProcess` objects, exact PID ownership registries, graceful shutdown, and PID-based process-tree termination after timeout.
- On final owned-app exit, owned child processes should stop gracefully, remaining owned process trees should be terminated by PID after timeout, ports `8600` and `8601` should be released, and owned PID/lock metadata should be removed.
- Electron lifecycle cleanup is coordinated through confirmed quit, `window-all-closed`, `before-quit`, updater restart, `SIGINT`, `SIGTERM`, and emergency `process.on('exit')` paths. `process.on('exit')` performs only synchronous exact-owned-PID cleanup and cannot wait for asynchronous work.
- Window close normally asks the React renderer to show the polished custom Exit Application confirmation. `desktop/src/main.js` waits up to `4000ms` for a renderer acknowledgement; if the renderer is crashed, black-screened, or unavailable, Electron shows a native fallback confirmation with `No` on the left/default/cancel and `Yes` on the right. Confirmed exit runs owned-process cleanup before quitting.
- 2026-07-11 shell validation after the listener-PID and renderer-fallback fixes showed no listeners on ports `8600` or `8601` before app launch. Full hands-on packaged Discord/open-close and normal-close process verification remains required before relying on process-lifecycle acceptance.

The repository root currently has no usable root `package.json`; frontend commands must be run from `frontend/`, and desktop packaging commands must be run from `desktop/`.

## 5. Critical Workflows

### Candidate Lookup

Candidate lookup is implemented through `frontend/src/pages/BasicsPage.jsx`, `frontend/src/api.js`, and backend endpoint logic in `backend/server.py` around `/api/shared/candidates/lookup` and `_lookup_shared_candidate_sessions`.

Verified behavior from docs and code:

- The shared lookup reads shared candidate session/tracking data through Google-backed backend logic when configured and reachable.
- The frontend can continue in local session mode if shared lookup is unavailable.
- Trainers may see warning copy such as `Shared candidate lookup unavailable. Using local session mode.` when the shared path fails.
- Recent stabilization work is intended to avoid permanent fallback after one temporary failure and to retry future lookups.
- Current source priority is shared/Google-backed history first, then local/offline session mode.
- Candidate lookup rows must not expose internal identifiers such as `mock_session`; `frontend/src/pages/BasicsPage.jsx` formats session types as trainer-facing labels such as `Mock Session`.

Verification needed: run live Google-backed lookup in a configured packaged or dev environment to confirm current retry logging and reconnect behavior after a transient failure.

### Candidate Eligibility

Candidate eligibility logic is split between `frontend/src/pages/BasicsPage.jsx`, shared candidate API responses in `frontend/src/api.js`, and backend candidate session/admin helpers in `backend/server.py`.

Current stabilization requirements and code areas indicate:

- Passed candidates should not be testable again unless archived or granted an extra attempt.
- Failed final-attempt candidates should not be testable again unless an admin grants an extra attempt.
- Shared candidate history should show the latest relevant session per candidate instead of stale rows.
- Blocking vs warning behavior is presented in Basics before a trainer proceeds.
- Selecting `Use typed name` must allow trainers to proceed without selecting a dropdown candidate.

Verification needed: confirm all edge cases with real or seeded shared candidate rows before final release.

### Archive / Extra Attempt Behavior

Archive and extra-attempt behavior is implemented in backend shared admin helpers in `backend/server.py` and SAM candidate actions in `frontend/src/NotificationManagerApp.jsx`.

Verified source locations:

- Auto-archive helpers: `_candidate_auto_archive_eligible` and `_auto_archive_candidate_rows` in `backend/server.py`.
- SAM shared candidate snapshot: `_shared_admin_candidate_snapshot` in `backend/server.py`.
- SAM candidate actions: `CandidateTrackingPanel` and action handlers in `frontend/src/NotificationManagerApp.jsx`.

Current release behavior:

- Completed terminal statuses should not stay in active pending Supervisor Transfer views.
- Archive hides closed history from active views.
- Extra Attempt allows a candidate to continue after admin approval.
- Completed pass/fail/final statuses are subject to archive-after-60-days behavior.

### SAM Pending Requests

SAM pending-request administration is implemented in:

- Backend snapshot/action APIs: `/api/shared/admin/pending-requests` and `/api/shared/admin/pending-requests/action` in `backend/server.py`.
- Frontend inbox, bell, alert banner, and dashboard wiring in `frontend/src/NotificationManagerApp.jsx`.
- Shared frontend API helpers in `frontend/src/api.js`.

Current feature-branch behavior:

- The Pending Requests inbox counts workflow requests only: initial Newbie Shift requests, Newbie Shift reschedule requests, and candidate-list deletion requests. Headset Review remains a separate queue and badge; Pending Requests may link to it but must not double-count it as a workflow request.
- Supported workflow filters are All Pending, Newbie Shifts, Reschedules, Candidate Deletions, Approved, and Denied. The Headset Reviews shortcut opens the separate review queue.
- The SAM header bell includes every unresolved actionable item even while its immediate alert is suppressed, and its summary separates Workflow Requests from Headset Reviews. One compact workflow alert is shown at a time, with the oldest unresolved eligible workflow request selected deterministically.
- Workflow `Remind Me in 30 Minutes` and `Dismiss` both suppress only the immediate workflow alert for exactly 30 minutes. They do not resolve the request, decrement counts, or remove its inbox row. `View` advances to the next eligible workflow request for the current refresh cycle, and Escape closes the immediate alert without resolving it.
- Headset Review reminders are grouped, repeat after about 2 hours while SAM remains open, and are eligible once per new SAM login/session when unresolved. Opening Headset Review acknowledges the immediate headset reminder for that session while the badge and bell count remain.
- Reminder/dismiss state is local per SAM installation/browser profile. Workflow entries contain only request ID, suppression type, and epoch expiry. Headset reminder state contains only a grouped signature and next eligible timestamp. Corrupt, invalid, expired, resolved, missing, and excess entries are removed. One nearest-expiry timer is used rather than one timer per request/headset.
- Approved/Denied workflow refresh results clear reminder/dismiss state and the active alert without a restart. Headset approve/deny clears grouped headset reminder state. Resolved workflow rows remain under the Approved/Denied filters, and successful decision paths force a shared snapshot refresh so stale Pending data cannot retain the bell or banner.
- Approve and Deny decisions are idempotent against the expected current request status. Denials require a readable reason. Decisions record admin identity when supplied by the SAM setup flow plus a UTC decision timestamp.
- Initial and reschedule approvals/denials update the shared Candidate Sessions Newbie Shift request fields so MTS History/Home/Smart Resume/Candidate Tracking can display Pending, Approved, or Denied from the shared contract.
- Candidate deletion requests target the single source session represented by Prompt 1's request contract. Approval is non-destructive and returns `deletion_action_required=true`; any authorized candidate-history deletion remains a separate explicit admin action. Denial leaves shared candidate history intact and records the reason.
- SAM Candidate Tracking displays distinct form-fill and Newbie Shift approval indicators. Form-fill labels remain Form Filled, Form Skipped, Not Yet Filled, Fill Failed, or Not Recorded and must not be described as submitted.
- Per-admin targeting cannot be reliably proven from the current admin identity source, so pending requests are visible to all authorized SAM admins. Duplicate decisions are prevented by status/version checks in the backend action.
- Google Sheet request tabs are `newbie-shift-requests` and `candidate-deletion-requests`; required columns are centralized in `backend/server.py` and are verified through the shared tracking setup path. Private sheet IDs and URLs must not be documented.
- Apps Script and direct Google Sheets transports implement the same request decision rules. If the configured Apps Script deployment does not yet expose the repository request routes, SAM shows sanitized temporary-unavailable copy rather than raw Google or credential details.

### Approved Headset Lookup

Approved headset lookup uses:

- Local defaults: `backend/defaults/headsets.csv`.
- Admin package defaults: `docs/admin-content-package/csv-tabs/approved-headsets.csv`.
- Backend parsing/fallback: `backend/server.py`.
- Trainer UI: `frontend/src/pages/BasicsPage.jsx`.

The lookup displays trainer-facing headset approval information and falls back to local packaged defaults if remote content is unavailable. Matching behavior should be verified against the headset parser and current UI before changing headset data.

### Research Headset Flow

Research Headset flow is implemented in MTS Basics and SAM headset review areas:

- MTS trainer entry point: `frontend/src/pages/BasicsPage.jsx`.
- Backend headset review endpoints: `/api/headsets/review-log`, `/api/headsets/reviews`, `/api/headsets/reviews/action` in `backend/server.py`.
- SAM review/admin UI: `frontend/src/NotificationManagerApp.jsx`.

Trainers can record headset research data for unknown or unclear headsets. SAM surfaces headset review/admin actions. Findings are persisted through backend Google/shared data paths when available, with fallback behavior dependent on backend configuration.

Unknown/unapproved headset review creation happens when the trainer confirms headset information and continues beyond Basics through the existing session-start workflow. The review identity is deterministic from source session plus normalized brand/model, so retries, resume, autosave, and repeated saves update or skip the same row instead of appending duplicates.

`headset-review-log` uses the V2 review contract when created or migrated: `review_id`, `source_session_id`, `candidate_name`, `tester_name`, `Brand`, `Model`, `Status`, `Note`, `created_at`, `updated_at`, `decision_at`, `decision_by`, and `denial_reason`. Direct Sheets and Apps Script paths must both preserve `review_id`, reject incomplete requests safely, and never reset an already approved/denied review back to pending. SAM decisions act on `review_id` first.

### VPN / Manual Verification

VPN/IP verification is implemented in:

- MTS UI component: `frontend/src/components/CandidateIpIntelligence.jsx`.
- Inactive internal backend endpoint: `/api/ip-intelligence/check` in `backend/server.py`.
- VPN docs: `docs/vpn-proxy-check.md`.

Current release decision:

- Automatic VPN/proxy lookup is not shipped in the MTS release UI. Basics does not call providers, require a saved candidate IP, or display an automatic result.
- The trainer answers `Has VPN?` and, when applicable, `Can turn off?` using the existing `vpn_on` and `vpn_off` mappings.
- Basics displays exactly three manual reference links: IP2Location, IPinfo, and ip.teoh.io. Each `Copy Link` action copies only the public site URL and never opens the browser or submits an IP.
- External lookup results do not fill either answer and never determine pass/fail. The existing explicit trainer workflow remains authoritative.
- There is no release Settings toggle for automatic VPN verification. Legacy `vpnProxyCheckMode` data and the backend provider endpoint are retained as inactive internal/future-development code only; the frontend has no call path to them and they do not run at startup.

### Calls

Call workflow is implemented in `frontend/src/pages/CallsPage.jsx`, backend defaults, and review/summary logic.

Verified source paths:

- Call fail reasons: `backend/defaults/call-fail-reasons.csv`, `docs/admin-content-package/csv-tabs/call-fails.csv`, fallback constants and required-system merge logic in `backend/server.py`, and the defensive UI merge in `frontend/src/pages/CallsPage.jsx`.
- Call coaching reasons: `backend/defaults/call-coaching.csv`, `docs/admin-content-package/csv-tabs/call-coaching.csv`, UI defaults in `frontend/src/pages/CallsPage.jsx`.
- Calls tests: `frontend/src/pages/CallsPage.test.jsx`.

The flow tracks multiple calls, pass/fail state, fail reasons, coaching points, details, and preserved session state for Review. Current release work added and protected `Did not search for member` as a required call fail reason so stale remote/admin content cannot remove it from the runtime Fail Reasons panel.

### Fail Reasons

Fail reason and coaching display cleanup is centralized through:

- Backend summary builders: `build_clean_coaching`, `build_clean_fail`, and label helpers in `backend/server.py`.
- Frontend display labels: `frontend/src/utils/summaryDisplayLabels.json`.
- Frontend label helper: `frontend/src/utils/summaryDisplayLabels.js`.
- Review UI: `frontend/src/pages/ReviewPage.jsx`.

Current rules:

- Internal identifiers such as `Verification_Name` must not appear in trainer-facing summaries.
- Parent/child coaching labels should be grouped naturally.
- Trainer-entered details should be preserved and phrased professionally.
- Fail Summary should be `N/A` when the candidate did not actually fail certification, except where approved workflow explicitly preserves continuation details.
- Microsoft Form fail/coaching text should use the same readable label strategy where applicable.
- Valid remote admin content overrides packaged fallback content. Packaged defaults are used only when remote content is unavailable, invalid, or missing a required system item.
- `Did not search for member` is a supported required call fail reason. The live admin-content tab is `call-fail-reasons` with a `FailReason` column; aliases `fail reasons` and `call-fails` are also accepted by the loader. It is present in React defaults, backend defaults, local CSV defaults, admin CSV defaults, and the admin Excel XML package. `backend/server.py` merges required call fail reasons into remote/default/saved settings, and `frontend/src/pages/CallsPage.jsx` defensively merges the same required label before rendering so stale admin content cannot hide it. `frontend/src/utils/summaryDisplayLabels.json` maps both `Did not search for member` and `did_not_search_for_member` to trainer-facing text.
- Manual live admin-content update, when direct Google Sheet editing is required: add one row under `call-fail-reasons` with `FailReason` = `Did not search for member`. Do not add a duplicate if that label already exists.

### NC/NS vs Same Day Drop

Current workflow requirements:

- Clicking NC/NS first asks how to mark the session for the candidate.
- `NC/NS` summary wording: `[Name] was a No Call No Show.`
- `Same Day Drop` summary wording: `[Name] dropped the session within 24 hours.`
- Both still use the existing NC/NS autofail checkbox behavior for Microsoft Form autofill.

Relevant source areas:

- MTS workflow shell: `frontend/src/App.js`.
- Review/form payload logic: `frontend/src/pages/ReviewPage.jsx` and `backend/server.py`.
- Selenium field fill: `backend/services/form_filler.py`.

Verification needed: run both paths through Review payload generation and form-fill dry-run behavior without submitting production data.

### Supervisor Transfer

Supervisor Transfer workflow is implemented in:

- `frontend/src/pages/SupTransferPage.jsx`.
- Shared pending transfer backend helpers: `_get_shared_pending_sup_transfers`, `_candidate_needs_sup_transfer`, and related row helpers in `backend/server.py`.
- SAM pending transfer views/actions in `frontend/src/NotificationManagerApp.jsx`.

Current stabilization decisions:

- Candidates with latest terminal statuses such as Pass, Resumed-Pass, Passed Certification, Archived, Withdrawn, Failed Final Attempt, or other completed terminal states must not appear in pending Supervisor Transfer lists.
- Pending lists should use the latest relevant session per candidate, not stale older incomplete rows.
- If a resumed session completes successfully, older pending Supervisor Transfer rows should be excluded or cleaned up.

### Smart Resume

Smart Resume handles incomplete sessions that require continuation. Relevant files:

- MTS app shell and resume entry points: `frontend/src/App.js`.
- Basics/session state: `frontend/src/pages/BasicsPage.jsx`.
- Supervisor Transfer continuation: `frontend/src/pages/SupTransferPage.jsx`.
- Review/form logic: `frontend/src/pages/ReviewPage.jsx`, `backend/server.py`.
- Shared pending data: `backend/server.py`.

Current behavior:

- Smart Resume should be used when saved mock-call data exists.
- Resume sessions should preserve original history while separating current-session technical issue data.
- Microsoft Form technical issue fields should reflect the current session, not inherited original-session metadata.
- Temporary lookup failures should not permanently disable shared resume lookup.

### Supervisor Transfer Only

Supervisor Transfer Only is an admin/trainer override that launches the existing Supervisor Transfer workflow without requiring Smart Resume data.

Current release rules:

- Use when the candidate already completed calls, a technical issue occurred, an admin directs standalone Supervisor Transfer, or no resume data should be used.
- The UI must clearly indicate Supervisor Transfer Only mode.
- Smart Resume remains the recommended primary action when saved call data exists.
- Button hierarchy should make `Use Smart Resume` primary and `Start Supervisor Transfer Only` secondary/neutral.

Relevant files:

- `frontend/src/App.js`
- `frontend/src/pages/SupTransferPage.jsx`
- `frontend/src/pages/ReviewPage.jsx`
- `backend/server.py`

### Technical Issues

Technical issue handling is implemented in:

- Dialog component: `frontend/src/components/TechIssueDialog.jsx`.
- Tests: `frontend/src/components/TechIssueDialog.test.jsx`.
- Review summary/form logic: `frontend/src/pages/ReviewPage.jsx`, `backend/server.py`, `backend/services/form_filler.py`.

Current rules:

- Technical issue data must distinguish original-session history from the current session.
- If a current session has no technical issue, Microsoft Form technical issue fields should not be checked merely because a prior incomplete session had one.
- If a current technical issue prevents completion, Review should show professional incomplete/technical issue context and preserve trainer notes.
- Technical issues may affect Discord post suggestions and Newbie Shift continuation flows, depending on the workflow state.

### Newbie Shift

Newbie Shift workflow is implemented in:

- `frontend/src/pages/NewbieShiftPage.jsx`.
- Supervisor Transfer and Review integration in `frontend/src/pages/SupTransferPage.jsx` and `frontend/src/pages/ReviewPage.jsx`.
- Form payload fields in `backend/server.py` and `backend/services/form_filler.py`.

Current release behavior:

- Automatic Newbie Shift scheduling is the primary flow when a non-final-attempt session cannot complete Supervisor Transfer in the current session.
- Review page backup action may appear only when status is Incomplete, scheduling is allowed, and no Newbie Shift is already scheduled.
- Feature branch `feature/newbie-shift-request-workflows` adds MTS-side Newbie Shift rescheduling. Reschedule requests preserve the original scheduled timestamp, collect whether the tester or candidate requested the change, collect a structured reason/details, calculate the 24-hour rule from timezone-aware timestamps, and persist the new scheduled timestamp/timezone.
- Candidate-requested reschedules received less than 24 hours before the original Newbie Shift count as an attempt and map to NC/NS form behavior. Candidate-requested reschedules received exactly 24 hours or more before the shift do not count as an attempt. Tester-requested reschedules do not penalize the candidate.
- New shared contract fields include `form_fill_status`, `form_filled_at`, `newbie_shift_scheduled_at`, `newbie_shift_timezone`, `newbie_shift_request_id`, `newbie_shift_request_type`, `newbie_shift_request_status`, `newbie_shift_requested_by`, request reason/detail/timestamps, 24-hour flags, admin decision placeholders, and deletion request placeholders.
- Shared Google Sheet contract tabs for follow-up workflow are `newbie-shift-requests` and `candidate-deletion-requests`. Required columns are defined in `backend/server.py`; private sheet IDs and URLs must not be documented here.
- Form-fill state is tracked as `not_attempted`, `filled`, `skipped`, `failed`, or `not_recorded` for legacy display. The UI must say Form Filled, Form Skipped, Not Yet Filled, Fill Failed, or Not Recorded; it must not claim Form Submitted.
- History form fill treats Selenium/browser automation and metadata persistence as separate phases. If the Microsoft Form is filled but local/shared status persistence fails, the backend returns `form_filled=true`, `automation_completed=true`, `local_status_saved=false`, and `error_code=metadata_status_save_failed`; MTS must show a warning, keep the visible status as Form Filled, and warn trainers not to refill the Microsoft Form.
- The root regression fixed on this branch was a post-fill History status update failure caused by the SQLite history helper path calling missing JSON encode/decode helpers after Selenium completed. `SQLiteCollection.encode` and `SQLiteCollection.decode` now provide the same safe JSON serialization used by the local persistence layer.
- History stores a best-effort local recovery marker for the partial-success case so a refreshed History record still appears Form Filled until metadata can be reconciled. Any retry/recovery path must update metadata only and must not relaunch Chrome or refill the Microsoft Form without explicit trainer confirmation.
- Form, session-result, and follow-up approval chips use centralized semantic metadata in `frontend/src/utils/certificationWorkflow.js`. Form-empty/legacy states are neutral gray, Incomplete remains amber, and Pending approval is blue/violet so Home Recent Activity and History do not conflate Not Yet Filled, Incomplete, and Pending.
- Status-chip metadata must expose trainer-facing labels and accessibility text, not visible textual icon prefixes. Decorative dots/icons are rendered by CSS with `aria-hidden="true"`; visible labels should be clean forms such as `Resumed - Pass`, `Fail - Final Attempt`, `NC/NS`, `Form Filled`, and `Not Yet Filled`, never `OK`, `!`, `x`, `-`, or raw enum text.
- History uses a responsive grid-row layout rather than a rigid wide table. At practical desktop widths every row must keep Date, Candidate, Tester, Session Status, Follow-Up, Form Status, and Actions visible inside the app viewport. Restored/narrow widths collapse rows into compact card-like grids with actions still reachable and no required horizontal scrolling.
- The Newbie Shift reschedule modal uses radio-card grids for requester and reason selection. Reason cards should render as two columns at normal modal widths, one column at narrow/high-DPI widths, and may expand to three columns only when enough horizontal space exists. `Other` requires details before Continue.
- The canonical certification support email used by blocked/final-attempt reschedule wording is `certification@acdsupport.com`; the previous `certification` + `@acddirect.com` address is obsolete and is normalized out of managed text at runtime.
- The backend canonical value is `CERTIFICATION_SUPPORT_EMAIL` in `backend/server.py`; frontend deterministic reschedule text uses `CERTIFICATION_SUPPORT_EMAIL` in `frontend/src/utils/certificationWorkflow.js`. Packaged defaults and admin-content package CSVs have been updated. Live Google Sheet/admin-content rows must be checked manually when no safe admin-content writer is available; update the `discord-posts` row titled `VPN Fail` in place if the obsolete mailbox remains.
- Temporary Newbie Shift Discord posts for initial scheduling and rescheduling are temporary session UI text only. They are shown by default, remain editable while hidden, copy the current edited text, and contain no automatic mentions. Trainers add any required tags manually.
- Local History deletion offers History Only or History & Candidate List Request. The request path removes local history immediately and writes a pending SAM review request without deleting shared candidate records directly.
- Remote Newbie Shift decisions are reconciled into local SQLite History and the active session with resolved remote states taking precedence over local Pending. Remote Pending never downgrades local Approved or Denied. If both sides are resolved with different states, a remote state replaces the local state only when both decision timestamps are valid and the remote timestamp is newer; missing timestamps are handled conservatively.
- Reconciliation matches `newbie_shift_request_id` to `request_id` first, then uses exact `history_id`/`session_id`/`resume_source_history_id` to `source_session_id` only when the local request ID is absent. Conflicting request/session identifiers are skipped, and candidate names are never used as a reconciliation key.
- Existing lifecycle triggers perform reconciliation during current-session startup load, History load/refresh, Home Recent Activity refresh through History, and shared candidate lookup/Smart Resume refresh. Remote request reads use a short success cache and failure backoff; there is no per-session timer or aggressive polling.
- Local persistence patches only Newbie Shift request fields: request ID/type/status, requester/reason/details/timestamps, original/requested/rescheduled schedule and timezone, within-24-hours/counts-as-attempt flags, decision time/admin, denial reason, and request update timestamp. Calls, Supervisor Transfer results, Form Filled state, headset/technical/coaching/trainer data, candidate identity, and unrelated history fields are preserved.
- If remote request data is unavailable, reconciliation performs no local write, keeps the current local state, logs only a sanitized failure category, and retries at the next normal lifecycle refresh after backoff. Direct shared writes also reconcile against existing exact request/session rows so stale local Pending cannot overwrite a resolved shared decision.
- The scheduling workflow should not directly create duplicate appointments without trainer confirmation.

Verification needed: after redeploying the current Apps Script, complete live initial-request approval and reschedule denial tests, refresh History/Home/Smart Resume, inspect denial details and Form Filled preservation, restart MTS, and confirm the resolved state persists with no duplicate sessions. External calendar integration and duplicate-prevention behavior also remain to be confirmed in a configured runtime environment.

### Review

Review is implemented primarily in `frontend/src/pages/ReviewPage.jsx` with backend summary/form support in `backend/server.py`.

Review responsibilities:

- Display session data before submission.
- Allow trainer review of final status/readiness judgment.
- Show Coaching Summary and Fail Summary with centralized trainer-facing labels.
- Preserve manual edits and avoid overwriting existing summaries unless Regenerate is clicked.
- Separate historical issues from current-session issues.
- Validate required fields before form fill.
- Trigger Gemini/fallback summary generation and Microsoft Form autofill payload generation.

### Coaching Summary

Coaching Summary behavior:

- Gemini generation is handled by `/api/gemini/summaries` and `/api/gemini/regenerate` in `backend/server.py`.
- Fallback generation uses backend summary builders and frontend Review fallback handling.
- Central labels live in `frontend/src/utils/summaryDisplayLabels.json` and are loaded by both frontend helper code and backend summary code.
- Fallback summaries should appear automatically when Review data is ready, even if Gemini is disabled or unavailable.
- Manual trainer edits must not be overwritten by automatic generation.

### Fail Summary

Fail Summary behavior:

- Backend builder: `build_clean_fail` in `backend/server.py`.
- Final result checks determine when Fail Summary is `N/A`.
- Failed Certification should populate fail details normally.
- Passed, Incomplete, Withdrawn, and non-failure continuation states should not produce a failure summary unless an approved existing workflow explicitly requires preserved Supervisor Transfer failure details.
- Evaluator Override explanation should not be duplicated across summaries.

### Gemini / Fallback Behavior

Gemini integration:

- Dependency: `google-generativeai` in `backend/requirements.txt`.
- Endpoints: `/api/gemini/summaries` and `/api/gemini/regenerate` in `backend/server.py`.
- Prompt defaults: `backend/defaults/gemini-coaching-prompt.md` and `backend/defaults/gemini-fail-prompt.md`.

Fallback behavior:

- If Gemini is disabled, unavailable, slow, or errors, fallback summaries should populate automatically.
- Trainers should not need to click Regenerate to get the first summary.
- Technical errors should not be shown as raw stack traces in normal trainer UI.
- Gemini output may replace fallback output after successful generation only when doing so does not overwrite manual edits or existing saved summaries.

### Microsoft Form Autofill

Microsoft Form autofill is implemented in:

- Form payload generation: `backend/server.py`.
- Selenium browser automation: `backend/services/form_filler.py`.
- Frontend Review trigger: `frontend/src/pages/ReviewPage.jsx`.

Verified field categories in `form_filler.py`:

- Tester name.
- Candidate name.
- Skills.
- Mock complete.
- Supervisor Transfer complete.
- All complete.
- Newbie Shift.
- Automatic Fail.
- Headset.
- Technical issue.
- Coaching.
- Fail reason.

Selenium behavior:

- Uses Chrome/Edge resolution and bundled/system drivers.
- Detects browser availability.
- Opens the form in a browser and fills fields.
- Should not submit unintended production data during smoke tests.

Current release rules:

- Incomplete sessions must not be classified as Failed.
- Current-session technical issue data controls technical issue form fields.
- NC/NS and Same Day Drop both use the existing NC/NS autofail checkbox behavior but different fail summary/reason text.
- Manual recovery remains required if Selenium/browser automation fails.

### Discord Posts

Discord Posts are implemented mostly in `frontend/src/App.js` with utilities in:

- `frontend/src/utils/discordProductivity.js`.
- `frontend/src/utils/discordFavorites.js`.
- `frontend/src/utils/discordScreenshotSuggestions.js`.
- Settings integration in `frontend/src/pages/SettingsPage.jsx`.
- Backend/default rows in `backend/defaults/discord-posts.csv`.
- Admin package rows in `docs/admin-content-package/csv-tabs/discord-posts.csv`.
- Live admin-content tab `discord-posts` when the configured Google Sheet is reachable. Valid remote rows replace packaged Discord post defaults; fallback rows are not appended behind valid remote content. A local settings override is used only when `discord_override` is enabled.

Current features:

- Search-first Discord Posts modal.
- Category filter.
- Favorites and Recent filter chips, not inline sections.
- Live post preview.
- Copy row/post behavior.
- Double-click copy.
- Screenshot tab and suggested screenshot preview.
- Keyboard shortcut help.
- Local persistence for favorites and recent posts.

### Screenshot Suggestions

Screenshot suggestions are implemented in:

- `frontend/src/utils/discordScreenshotSuggestions.js`.
- `backend/defaults/discord-posts.csv` via `SuggestedScreenshots`.
- `backend/defaults/screenshots.csv`.
- Settings UI in `frontend/src/pages/SettingsPage.jsx`.
- Maintenance doc `dev-tools/docs/discord-posts-and-screenshots-defaults.md`.

Current behavior:

- Each Discord post can have 0 to 3 suggested screenshots.
- Explicit row fields override built-in fallback mappings.
- Supported formats include pipe-delimited `SuggestedScreenshots` and separate `SuggestedScreenshot1`, `SuggestedScreenshot2`, `SuggestedScreenshot3`.
- Screenshot images live in `frontend/public/`.
- Admins can assign suggestions in Settings using Screenshot 1, Screenshot 2, Screenshot 3 selectors.

### Command Palette / Shortcuts

Command Palette and shortcuts are implemented in:

- `frontend/src/App.js`.
- `frontend/src/utils/discordProductivity.js`.
- Settings UI in `frontend/src/pages/SettingsPage.jsx`.

Verified defaults:

- `Ctrl+D`: Open Discord Posts.
- `Ctrl+Shift+D`: Open Screenshot Library.
- `Ctrl+Shift+P`: Open Command Palette.
- `Ctrl+F`: Focus Search.
- `Ctrl+Shift+F`: Show Favorites.
- `Esc`: Close.
- `Alt+1` through `Alt+8`: category shortcuts from Calls through Favorites.
- Favorite shortcut defaults include `Ctrl+1` Wrong Headset, `Ctrl+2` VPN Failed, `Ctrl+3` Change DTE, `Ctrl+4` Supervisor Failed, and `Ctrl+5` Technical Issue.

Accessibility considerations:

- The palette uses dialog/listbox semantics in `frontend/src/App.js`.
- Search input is autofocus-oriented.
- Global shortcuts open Discord Posts, Screenshot Library, Favorites, Search, Command Palette, and favorite-post shortcut actions from `frontend/src/App.js`.
- Discord modal shortcuts are registered on `window` while the modal is mounted so they do not depend on the modal container retaining focus.
- Discord modal startup must not reference shortcut copy handlers before those callbacks are initialized; `DiscordModal` keeps the shortcut handoff effect after `copyTemplate` is declared to avoid temporal-dead-zone renderer crashes.
- Arrow navigation and Enter copy behavior are implemented in the modal/palette handlers.
- Shortcut customization includes conflict detection in `frontend/src/utils/discordProductivity.js`.

### SAM Candidate Tracking

SAM Candidate Tracking is implemented in:

- `frontend/src/NotificationManagerApp.jsx`.
- Backend shared admin endpoints and helpers in `backend/server.py`.

Current behavior:

- Displays shared candidate statuses, pending Supervisor Transfers, incomplete candidates, final failures, withdrawn candidates, passed certifications, archived candidates, and active candidates.
- Supports search, filtering, sorting, View Details, Copy Selected, Print Report, Archive, Withdraw, Extra Attempt, Delete, and manual correction actions.
- Pending Supervisor Transfer lists must exclude candidates whose latest state is terminal/completed.
- Refresh behavior uses the shared SAM snapshot coordinator with a safe automatic interval; `SAM_AUTO_REFRESH_INTERVAL_MS` is currently `60000`.
- Candidate Tracking refreshes are deduplicated in `frontend/src/NotificationManagerApp.jsx` with a short successful-data cache and a `60000ms` backoff after Google Sheets quota/rate-limit failures.
- Cold-start Candidate Tracking loads use a bounded startup retry before surfacing an unavailable warning, which avoids false first-launch errors while the backend/shared-data path is still settling.
- During temporary Google Sheets failures, SAM preserves the last visible candidate data where possible and shows a trainer-safe message instead of raw Google API payloads, spreadsheet IDs, service-account email, schema/setup diagnostics, JSON, or `[object Object]`.
- Candidate row actions use a compact hierarchy: `View Details` remains the first visible action, status-changing actions live under `Update Status`, and archive/withdraw/delete style actions live under `More Actions`.
- Candidate table text is constrained to two-line previews with ellipsis and accessible `title`/label text. `Show More` / `Show Less` expands only the current row's Results/Notes preview and does not open the full-record view.
- `View Details` remains the authoritative full-record/history view and is intentionally distinct from row preview expansion.

### SAM Notifications

SAM notification management is implemented in:

- `frontend/src/NotificationManagerApp.jsx`.
- Frontend notification utilities: `frontend/src/utils/notificationManager.js`, `frontend/src/utils/notifications.js`.
- Backend notification endpoints in `backend/server.py`: `/api/notifications`, `/api/notifications/manage`, and ticker-related logic.

Current behavior:

- SAM manages notification rows used by MTS ticker/banner/popup display.
- New notification rows default to Ticker only in the SAM editor.
- SAM generates internal notification IDs with `createNotificationId()` in `frontend/src/utils/notificationManager.js` when a new draft or duplicate draft is created. The ID is preserved through save; duplicate notifications receive a new ID and do not copy the source row ID.
- Notification IDs are not trainer-entered fields in the editor. Edit mode preserves the existing row ID, and duplicate validation excludes the current row while still blocking real duplicate IDs.
- Saving a notification shows trainer/admin-facing status copy that MTS should update within about a minute.
- Notifications can target display modes such as ticker, popup, banner, persistent, and action URLs depending on row data.
- SAM header controls are consolidated in the top-right header area: live status, Add Notification, Refresh, Help, and a dark-red Exit button. The dashboard quick-action toolbar uses balanced Data, Workflow, and System groups; notification Edit and Duplicate are row-level actions.
- SAM dedication/logo branding is intentionally larger in the header while preserving aspect ratio and header control access.
- SAM navigation tabs use restrained visual identities: Notifications cyan/blue, Live Preview violet, Headset Review teal, Candidate Tracking green, and Pending Sup Transfers amber.

### SAM Auto-Update / Version Checks

SAM update/version behavior is implemented in:

- Desktop update wiring: `desktop/src/main.js`.
- SAM UI: `frontend/src/NotificationManagerApp.jsx`.
- Backend metadata endpoint: `/api/update` and `/api/update/status` in `backend/server.py`.
- Packaging config: `desktop/notification-manager-builder.json`.

Current behavior:

- SAM can run startup update checks and manual `Search for updates`.
- Update modal supports required updates, manual download mode, and signed-auto-update status.
- Electron updater is present, but unsigned/manual installer behavior is documented in UI copy.
- Update metadata is app-specific; SAM package publishes to the SAM release repo configured in `desktop/notification-manager-builder.json`.

Verification needed: packaged-app update behavior must be smoke-tested in the installed app environment because updater behavior differs between dev, unpacked, and installed builds.

## 6. UI/UX Conventions

Established conventions:

- Dark theme across MTS and SAM.
- MTS cat branding must remain.
- SAM dedication/logo branding should be visible, readable, and professional.
- Trainer-facing language should be plain English and should not expose internal identifiers.
- Normal UI should not show raw stack traces, raw API errors, credentials, or implementation details.
- Confirmation modals should require explicit action; backdrop click should not dismiss important modals.
- Confirmation action order should be safe: Cancel/Back/No on the left or secondary, Continue/OK/Confirm on the right or primary.
- Destructive actions should be red/destructive and not placed where users expect Cancel.
- Complex form/data-entry modals may remain left-aligned.
- Informational/confirmation modals should center icon, title, message, divider, and buttons.
- Sticky footers for long dialogs should remain visible.
- High-DPI scaling targets: 100%, 125%, 150%, 200%.
- Search-first workflows should make search fields visually obvious with one clean focus ring.
- Focus states should be visible.
- Empty/loading/error states should be readable and non-alarming.
- Keyboard workflows should preserve Escape, Enter, arrow navigation, and configured shortcuts where implemented.

Implementation paths:

- MTS styles: `frontend/src/App.css`, `frontend/src/polish-mts.css`.
- SAM styles: `frontend/src/notification-manager.css`, `frontend/src/polish-sam.css`.
- Shared MTS modal provider: `frontend/src/components/ModalProvider.jsx`.
- SAM modal/status UI: `frontend/src/NotificationManagerApp.jsx` and SAM styles.
- SAM dashboard conventions: one Help control and one far-right dark-red Exit control in the header; global toolbar actions should apply globally, while row-specific notification and candidate actions should remain on the row or in row menus.

Do not claim full accessibility compliance without a dedicated audit. Current accessibility work is implementation-level support for roles, aria labels, focus indicators, keyboard handlers, and readable contrast.

## 7. Data Sources and Fallbacks

| Feature | Primary Source | Runtime Override | Local Fallback | Failure Behavior |
| ------- | -------------- | ---------------- | -------------- | ---------------- |
| Candidate lookup | Shared Google Sheets candidate/session tabs through `backend/server.py` | Runtime config and service-account access | Local session mode and local history | Non-blocking warning; trainer can continue locally |
| Shared candidate history | Shared Candidate Sessions / Pending Sup Transfers via backend helpers | SAM admin actions | Local SQLite/session history | Shared views unavailable or stale until reconnect |
| Approved headsets | Google/admin content when configured | Settings/admin sheet override | `backend/defaults/headsets.csv`, `docs/admin-content-package/csv-tabs/approved-headsets.csv` | Falls back to packaged list |
| Headset research | SAM/headset review Google-backed rows | SAM admin review action | Backend/local persistence where configured | Review queue may be unavailable; trainer flow should continue |
| VPN verification | Three manual external lookup links on Basics | None; no release Settings toggle | Manual trainer decision using IP2Location, IPinfo, or ip.teoh.io | Copy-only reference links; MTS does not call providers or classify the result |
| Google Sheets | Authenticated Google service-account client | Apps Script/public CSV for selected content where configured | Packaged CSV/Markdown/default constants | Feature-specific fallback or warning |
| Google Apps Script | Apps Script config/docs and backend adapter | Role-specific ignored `backend/config/apps-script-api-mts.json` or `apps-script-api-sam.json` when configured | Direct Sheets/local defaults | Should degrade to direct/fallback paths |
| Help/FAQ | Trainer-focused Google Doc override via runtime config | `admin_help_doc_url`, `admin_faq_doc_url` | `backend/defaults/help.md`, `backend/defaults/faq.md`, backend fallback, `frontend/src/pages/HelpPage.jsx` topic cards | Falls back to local markdown; clearly internal remote sections/lines are filtered before rendering |
| Call fail reasons | Google Sheet tab `call-fail-reasons` or aliases `fail reasons` / `call-fails` | Customized settings only when marked customized | `backend/defaults/call-fail-reasons.csv`, `docs/admin-content-package/csv-tabs/call-fails.csv`, backend constants | Uses local defaults; required system fail reasons are merged when missing |
| Call coaching reasons | Google Sheet tab `call-coaching` | Customized settings only when marked customized | `backend/defaults/call-coaching.csv`, `docs/admin-content-package/csv-tabs/call-coaching.csv`, backend constants | Uses local defaults; workflow-required coaching rows may be merged where explicitly coded |
| Discord posts | Google/admin rows from `discord-posts` when configured | Settings Discord override only when `discord_override` is enabled | `backend/defaults/discord-posts.csv`, `docs/admin-content-package/csv-tabs/discord-posts.csv`, backend constants | Valid remote rows replace fallback rows; local defaults are used only when remote load fails or parses no usable rows |
| Screenshot suggestions | Discord post suggestion fields | Settings Screenshot 1/2/3 selectors | `frontend/src/utils/discordScreenshotSuggestions.js`, `backend/defaults/screenshots.csv` | Uses built-in mapping or no suggestions |
| Ticker | SAM notifications sheet via backend | SAM notification editor | Backend notification defaults and frontend ticker fallback | Shows safe fallback ticker messages |
| Grading/default mappings | Backend settings/defaults and content sheets | Settings | `backend/defaults/*.csv`, backend constants | Uses packaged defaults |
| Summary display labels | `frontend/src/utils/summaryDisplayLabels.json` | Source update only | Automatic natural-English conversion in helper code | Should never show underscores/internal keys |
| Gemini configuration | Settings/runtime API key and prompt config | Settings/admin prompt tabs | Fallback summary builders | Fallback summaries shown without raw errors |
| Microsoft Form mappings | Backend payload + Selenium question IDs | Settings form URL/browser preference | Manual browser recovery | Selenium errors should be recoverable manually |
| SAM data | Master Google Sheets tabs | SAM editor/admin actions | Backend defaults for notifications/setup where possible | SAM deduplicates candidate refreshes, backs off after quota/rate limits, shows sanitized warning/error copy, and preserves loaded state when safe |
| Runtime config | `backend/config/runtime_config.json` and Electron-provided environment | User/settings writes | Built-in defaults | Missing config should not block basic local workflows |

Fallback maintenance references:

- `docs/data-fallbacks-and-google-sheets.md`.
- `docs/defaults-and-editable-content-map.md`.
- `dev-tools/docs/help-faq-defaults.md`.
- `dev-tools/docs/discord-posts-and-screenshots-defaults.md`.

Do not include private spreadsheet IDs, private URLs, credentials, tokens, or service-account contents in this document.

Editable managed-content source rule:

- Valid remote Google/admin content updates backend in-memory defaults and is the normal source for managed lists.
- Saved local Settings values for managed lists such as `call_fails`, `call_coaching`, `discord_templates`, and `discord_screenshots` are honored only when the matching `<section>_customized` marker is present.
- Legacy saved managed lists without that marker are treated as stale cache and follow the current remote/default source instead of silently overriding it.
- Required system reasons are merged before Other, and Other is always the final option. For `call_fails`, `Did not search for member` must appear exactly once even when remote or local content is stale.
- Settings > Fail Reasons shows a compact source line (`Google Sheet`, `Local override`, or `Packaged fallback`). If Call Fail Reasons or Supervisor Fail Reasons are locally overridden, the targeted `Use Google/admin content` action removes only that section override and leaves unrelated Settings untouched.

## 8. Security / Sensitive Files

Rules:

- Never print, inspect for contents, copy, move, rename, modify, or expose `google-service-account.json` unless the project owner explicitly instructs it.
- Never expose credentials, tokens, private keys, API keys, service-account data, connection strings, secret environment values, candidate private data, or private notification content.
- Never hardcode API keys.
- Never log secret values.
- Sanitize error messages before showing them to trainers.
- Keep least-privilege access for Google service accounts.
- Validate external data from Google Sheets, Google Docs, Apps Script, notification rows, and settings.
- Avoid exposing raw backend errors to trainers.
- Do not commit runtime databases.
- Do not commit logs.
- Do not commit `.env` files or secret config.
- Do not commit generated installers, blockmaps, `latest.yml`, packaged `app.asar`, or generated build directories.

Verified security decision:

- `docs/service-account-packaging-risk.md` prohibits packaging `google-service-account.json`; both package definitions and production-ready synchronization scripts exclude it.
- Previously distributed or retained packages that contained the credential require owner-coordinated rotation/revocation and artifact cleanup.
- Apps Script authorization is role/action scoped in repository source: ordinary MTS synchronization is separated from SAM decisions and administration. Live deployment/version and independently packaged role credentials remain acceptance gates.
- Future architecture should use admin-provided OAuth or a secure backend proxy.

## 9. Git Safety Rules

Before changes:

- Run `git status --short --branch`.
- Verify the expected branch.
- Stop during merge, rebase, cherry-pick, revert, or unresolved conflict states.
- Never discard unrelated working-tree changes.
- Never reset a shared release branch casually.

During changes:

- Do not create or switch branches unless explicitly instructed.
- Do not stage or commit unless explicitly instructed.
- Never use `git add .`.
- Stage only explicit files when staging is authorized.
- Inspect diffs before any authorized commit.

Never commit:

- Credentials or secret config.
- `google-service-account.json`.
- `.env` files.
- Installers.
- Blockmaps.
- `latest.yml`.
- Packaged `app.asar`.
- `node_modules/`.
- `frontend/build/`.
- `desktop/dist/`.
- `desktop/dist-notification-manager/`.
- `backend/dist/`.
- Generated build directories.
- SQLite databases.
- Logs.
- Temporary exports.
- `production-ready/` generated release output.

`release/v1.0.1` currently allows targeted RC fixes directly because the project owner explicitly established that workflow. That does not remove the no-stage/no-commit rule for tasks where staging or committing was not requested.

## 10. Testing / Build Commands

Run commands from the listed working directory. Do not use root-level `npm run build`; the repository root currently does not contain a usable root `package.json`.

### Frontend tests

Working directory: `frontend/`

Targeted RC regression tests:

```powershell
npm test -- --runTestsByPath src/pages/SupTransferPage.test.jsx src/pages/HomePage.test.jsx src/pages/ReviewPage.test.jsx src/components/TechIssueDialog.test.jsx --watchAll=false
```

Broader MTS workflow tests used during RC work:

```powershell
npm test -- --runTestsByPath src/pages/ReviewPage.test.jsx src/pages/CallsPage.test.jsx src/pages/SupTransferPage.test.jsx src/components/TechIssueDialog.test.jsx src/AppDiscordLayout.test.js src/pages/SettingsAndGradingConfig.test.jsx --watchAll=false
```

Help/SAM release polish tests:

```powershell
npm test -- --runTestsByPath src/pages/HelpPage.test.jsx src/NotificationManagerApp.releasePolish.test.js --watchAll=false
```

SAM startup and exit-modal regression test:

```powershell
npm test -- --runTestsByPath src/NotificationManagerApp.releasePolish.test.js --watchAll=false
```

### Frontend production build

Working directory: `frontend/`

```powershell
npm run build
```

This runs `craco build` and writes `frontend/build/`.

### Backend workflow tests

Working directory: repository root

```powershell
.venv\Scripts\python.exe backend\test_rc_workflow_logic.py
```

Additional backend tests exist under `backend/test_*.py`; select the relevant file for the workflow being changed.

### Backend compile checks

Working directory: repository root

```powershell
.venv\Scripts\python.exe -m py_compile backend\server.py
```

If form fill changes:

```powershell
.venv\Scripts\python.exe -m py_compile backend\services\form_filler.py
```

### Desktop lifecycle checks

Working directory: repository root

```powershell
node --check desktop\src\processOwnership.js
node --check desktop\src\main.js
node desktop\test\processOwnership.test.js
```

These validate syntax and the mocked ownership registry behavior. They do not replace packaged-app process verification.

### Electron / MTS build

Working directory: `desktop/`

Verified script in `desktop/package.json`:

```powershell
npm run build:win
```

This runs:

```text
npm run build:react && npm run build:backend && electron-builder --win --x64
```

Expected generated output includes `frontend/build/`, `backend/dist/backend.exe`, and `desktop/dist/`.

### SAM build

Working directory: `desktop/`

Verified script in `desktop/package.json`:

```powershell
npm run build:notification-manager
```

This runs:

```text
npm run build:react && npm run build:backend && electron-builder --win --x64 --config notification-manager-builder.json
```

Expected generated output includes `frontend/build/`, `backend/dist/backend.exe`, and `desktop/dist-notification-manager/`.

Build sequencing note:

- Run `npm run build:notification-manager` and `npm run build:win` sequentially, not in parallel, because both scripts rebuild shared frontend/backend outputs.
- If an existing packaged MTS/SAM instance is running from `desktop/dist*`, electron-builder may fail while clearing generated files such as `desktop/dist/win-unpacked/*.dll`. Close the packaged app normally and rerun the build; do not kill processes by executable name.

### Packaged-app smoke testing

Automated validation and production build validation are not the same as packaged-app validation. Before release, smoke test installed and unpacked builds where applicable:

- Launch packaged MTS.
- Confirm bundled backend startup and no startup error modal.
- Confirm main navigation works.
- Confirm candidate lookup and local fallback behavior.
- Confirm candidate eligibility warnings/blocks.
- Confirm archive/extra-attempt behavior.
- Confirm approved headset lookup.
- Confirm research headset workflow.
- Confirm VPN/manual verification panel and copy/open actions.
- Confirm calls workflow.
- Confirm NC/NS and Same Day Drop.
- Confirm Smart Resume.
- Confirm Supervisor Transfer.
- Confirm Supervisor Transfer Only.
- Confirm technical issue dialog.
- Confirm Newbie Shift scheduling flow.
- Confirm Review, Gemini summary, fallback summary, and manual edit preservation.
- Confirm Microsoft Form autofill opens and fills without submitting unintended production data.
- Confirm Discord Posts, screenshot suggestions, command palette, favorites, recent, and shortcut customization.
- Confirm Help/FAQ and Settings.
- Confirm update/version UI.
- Review app logs for errors.
- Close and relaunch to confirm persistence.
- Launch packaged SAM.
- Confirm SAM backend mode, dashboard, candidate tracking, pending Supervisor Transfers, notifications, search, reports, headset review, refresh, version check, and update behavior.
- Start MTS, start SAM, close MTS, and confirm MTS-owned processes stop, port `8600` is released, and SAM continues working with port `8601` alive.
- Start MTS, start SAM, close SAM, and confirm SAM-owned processes stop, port `8601` is released, and MTS continues working with port `8600` alive.
- Start and close MTS alone; confirm no orphaned MTS-owned backend, Electron, Node, Selenium, driver, updater, lock, or PID metadata remains.
- Start and close SAM alone; confirm no orphaned SAM-owned backend, Electron, Node, Selenium, driver, updater, lock, or PID metadata remains.
- Repeat launch/close cycles for both apps and confirm no stale PID files, stale lock files, backend already running errors, port conflicts, or accumulated helper processes.
- Verify packaged Exit Application confirmations in MTS and SAM: safe action on the left, affirmative exit action on the right, Escape keeps the app open, and Enter does not exit unless the exit action is explicitly focused.

## 11. Known Accepted Limitations

Accepted limitations for `v1.0.x`:

- No service-account credential may be packaged. Live Google access must use an approved service boundary and must fail safely when it is unavailable.
- Automatic VPN/provider lookup is not shipped. The packaged MTS uses three manual Copy Link actions and requires the trainer to open a site separately and enter the candidate IP there.
- Manual lookup requires no saved candidate IP in MTS, does not populate VPN answers, and cannot automatically determine pass/fail.
- Gemini availability depends on configuration, network access, API availability, and prompt/model behavior. Fallback summaries are required.
- Google Sheets/Docs access can fail due to network, quota, permissions, missing tabs, or service-account configuration. Local fallbacks must remain safe.
- Selenium form fill is sensitive to browser availability, driver availability, Microsoft Form structure, and environment. Manual recovery remains necessary.
- Update behavior differs between dev, unpacked, installed, signed, and unsigned builds; packaged-app smoke testing is required.
- 2026-07-11 packaged verification from the shell was limited: MTS and SAM launch/ports were verified, but visual navigation and Exit Application modal interaction still require hands-on packaged-app verification.

Unresolved blocker vs future enhancement must be decided from current validation. Do not move a genuine release blocker into this section to make release status look healthier.

## 12. Release Checklist

### 2026-07-30: Manual-only VPN/proxy lookup release correction

- Removed the experimental integrated VPN/proxy checker from active MTS frontend paths: no `Check IP`, provider progress/results, saved-IP warning, Review result block, frontend provider request, or Settings toggle remains.
- Restored the three repository-verified original manual sites on Basics: IP2Location, IPinfo, and ip.teoh.io. Each row has a copy-only `Copy Link` action with temporary feedback; MTS does not open the site or include an IP in copied text.
- Preserved `Has VPN?`, conditional `Can turn off?`, session/history mappings, explicit trainer confirmation, summary behavior, and form-fill mappings.
- Retained the backend provider endpoint and legacy setting parsing only as inactive internal/future-development code. The release frontend has no invocation or startup path for it.
- Updated Help, user/admin guides, tutorial scripts, training inventory/map, recording-impact notes, screenshot plan, and the VPN release decision document for manual-only behavior.

### Repository safety

- [ ] Correct branch is `feature/newbie-shift-request-workflows` for Pending Requests completion work.
- [ ] No merge/rebase/cherry-pick/revert state.
- [ ] No unresolved conflicts.
- [ ] Working tree reviewed and understood.
- [ ] No accidental generated files.
- [ ] No credentials staged.
- [ ] Git status is clean or every dirty file is intentionally understood.

### Automated validation

- [ ] Frontend targeted tests run from `frontend/`.
- [ ] Frontend broader regression tests run from `frontend/`.
- [ ] Backend workflow tests run from repository root.
- [ ] Python compile checks run.
- [ ] Frontend production build run from `frontend/`.
- [ ] Electron MTS build run from `desktop/`.
- [ ] SAM build run from `desktop/`.

### MTS smoke testing

- [ ] Startup.
- [ ] Candidate lookup.
- [ ] Candidate eligibility.
- [ ] Archive/extra attempt.
- [ ] Approved headset lookup.
- [ ] Research headset.
- [ ] VPN/manual verification.
- [ ] Calls.
- [ ] NC/NS.
- [ ] Same Day Drop.
- [ ] Smart Resume.
- [ ] Supervisor Transfer.
- [ ] Supervisor Transfer Only.
- [ ] Technical issue.
- [ ] Newbie Shift.
- [ ] Review.
- [ ] Gemini summary.
- [ ] Fallback summary.
- [ ] Form autofill.
- [ ] Discord Posts.
- [ ] Screenshot suggestions.
- [ ] Command palette.
- [ ] Help/FAQ.
- [ ] Settings.
- [ ] Restart/persistence.

### SAM smoke testing

- [ ] Startup.
- [ ] Dashboard.
- [ ] Candidate tracking.
- [ ] Pending Supervisor Transfers.
- [ ] Notifications.
- [ ] Search.
- [ ] Reports.
- [ ] Headset review.
- [ ] Refresh.
- [ ] Version check.
- [ ] Update behavior.

### Display validation

Test at 100%, 125%, 150%, and 200%:

- [ ] Modal visibility.
- [ ] Sticky footer visibility.
- [ ] No clipped actions.
- [ ] No horizontal overflow.
- [ ] Readable text.
- [ ] Keyboard navigation.
- [ ] Focus behavior.

### Release completion

- [ ] Installer smoke test.
- [ ] Installed-app launch.
- [ ] Logs reviewed.
- [ ] Version confirmed.
- [ ] Release notes prepared.
- [ ] Tag created only after explicit approval.
- [ ] Installer published only after explicit approval.

## 13. Current Backlog / v1.1 Ideas

### `v1.0.1` blockers

Verification needed from current packaged-app smoke testing:

- Confirm pending Supervisor Transfer cleanup with real shared data.
- Confirm Microsoft Form behavior for NC/NS, Same Day Drop, Incomplete, Supervisor Transfer Only, and Smart Resume technical issue separation.
- Confirm candidate lookup reconnect behavior after temporary shared lookup failures.
- Confirm SAM startup update popup behavior in installed app mode.
- Confirm MTS/SAM process ownership cleanup: both apps run simultaneously, closing one does not terminate or interrupt the other, and closing both leaves no owned processes or stale PID/lock metadata.
- Confirm packaged MTS Discord Posts opens visibly, closes normally, supports repeated open/close, and does not black-screen after the temporal-dead-zone fix in `frontend/src/App.js`.
- Confirm renderer-failure close fallback in packaged MTS/SAM: if the renderer does not acknowledge the custom exit confirmation within `4000ms`, the native fallback appears and confirmed exit releases the owned backend port.
- Confirm high-DPI display at 100%, 125%, 150%, and 200%.

### Post-release polish

- Continue tightening non-blocking SAM/MTS modal alignment after release if any minor visual issues remain.
- Add more focused tests around candidate eligibility edge cases and shared pending Supervisor Transfer cleanup.
- Expand Help/FAQ coverage as trainers report repeated questions.
- Improve diagnostics wording while keeping normal UI trainer-friendly.

### `v1.1` ideas

- Replace packaged service-account distribution with admin-provided credentials, OAuth, or a secure backend proxy.
- Make updater behavior more robust after signing and release-hosting decisions settle.
- Broaden automated end-to-end packaged-app smoke testing.
- Consider stronger schema/version validation for Google Sheet tabs.
- Improve observability for live-vs-fallback data source selection without exposing sensitive details.

## 14. Recent Major Changes

### 2026-07-15: Searchable Help, post-setup Quick Start, and tutorial videos

- Expanded MTS and SAM Help into searchable user guides with trainer/admin workflow articles, consistent What this is / When to use it / Steps / What happens next / Common mistakes / Related topics structure, and a session/follow-up/form status glossary. Normal Help continues filtering developer, storage, deployment, credential, route, and schema content.
- Replaced forced first-run walkthrough startup with a one-time, skippable post-setup choice in both apps. Users can watch the established guided Quick Start, open the app-specific user guide, or continue directly to Home/Dashboard; setup values remain saved and Help can replay the choice screen.
- Added one reusable click-to-load YouTube player/library. It accepts only strict YouTube IDs or HTTPS URLs from the approved YouTube hosts, constructs `youtube-nocookie.com` embeds internally, mounts one selected iframe, supports fullscreen when permitted, and uses the existing safe external-browser bridge as fallback.
- Added managed `mts-tutorial-videos` and `sam-tutorial-videos` content with exact shared headers, approved app categories, HelpTopicKey article linking, Active filtering, deterministic SortOrder, Other Tutorials placement, inactive packaged Quick Start placeholders, and valid-remote-over-packaged-fallback precedence.
- The explicit master-content setup path can create the tutorial tabs and write blank headers once; normal Help refresh and polling never creates/verifies tabs. Apps Script source allowlists both tabs and adds tutorial read actions. The live workbook and deployment were not changed by repository work and require the manual steps in `docs/tutorial-video-setup.md` and `docs/apps-script-api-packaged-config.md`.

### 2026-07-15: Pending Requests reminder lifecycle and deployment readiness

- Replaced the unversioned ad hoc SAM alert map with one bounded, versioned per-install suppression store containing only request ID, suppression type, and epoch expiry. Remind Me and Dismiss suppress immediate alerts for 30 minutes while bell/category counts and inbox rows remain unchanged.
- Added deterministic oldest-first single-alert selection, current-cycle advancement after View/Remind/Dismiss, Escape close without resolution, one nearest-expiry timer, remount/restart persistence, and idempotent cleanup for expired, corrupt, missing, Approved, and Denied requests.
- Fixed the successful SAM decision refresh to invalidate its 15-second pending-request cache before reload, preventing stale Pending state from retaining the alert or bell count after approval/denial.
- Aligned the direct-Sheets candidate-deletion approval fallback with Apps Script: approval records the decision and returns `deletion_action_required=true` without automatically deleting candidate/session rows.
- Documented the exact pending-request Apps Script routes, existing-deployment update process, request tab/header contract, and manual MTS -> SAM -> MTS acceptance checklist in `docs/apps-script-api-packaged-config.md` and `docs/pending-requests-admin.md`.
- Final-source validation passed: focused SAM release-polish tests (30), full frontend tests (152), backend RC workflow tests (48), pending-request reconciliation tests (14), backend Python compile, Apps Script syntax checking, frontend production build, SAM Windows package build, and MTS Windows package build. The in-app Browser could not acquire a session because the environment did not provide the required sandbox metadata, so rendered/high-DPI claims remain manual.
- Live deployment and configured packaged-app round-trip validation are not claimed by repository changes and remain `REQUIRES MANUAL VERIFICATION` until the controlled Apps Script deployment is updated and the documented checklist passes.

### 2026-07-14: Remote pending-request decision reconciliation into MTS

- Added exact-ID reconciliation from shared Newbie Shift request decisions into local SQLite History and the active MTS session. Request ID is authoritative; source session ID is the fallback only when the local request ID is absent. Name-only matching is forbidden.
- Added remote precedence rules so Approved/Denied replaces local Pending, Pending cannot downgrade a resolved state, and conflicting resolved decisions require a strictly newer valid remote decision timestamp.
- Wired reconciliation into existing current-session, History/Home, and shared-candidate lookup lifecycles with a short cache/backoff. Shared candidate rows retain request fields so Smart Resume/shared details receive current approval state and denial reason.
- History, Home Recent Activity, Review details, and shared candidate details use existing trainer-facing status labels. Denial reason remains available in details, and Smart Resume carries the reconciled request fields without changing Form Filled or unrelated session data.
- Focused backend reconciliation tests, the existing backend workflow suite, the full frontend suite, frontend production build, and sequential SAM/MTS package builds pass. SQLite reopen coverage verifies local persistence; live Apps Script redeployment, approval/denial refresh, and packaged-app restart verification remain manual and are not yet claimed complete.

### 2026-07-14: Hidden internal reschedule mention and trainer Help separation

- Removed the internally managed Newbie Shift reschedule admin mention from normal MTS Settings. The final temporary-post behavior now uses no automatic mention in either initial scheduling or reschedule mode; trainers add any required tags manually.
- Reworked MTS trainer Help copy around Newbie Shift rescheduling, form-fill states, approval states, History actions, and Supervisor Transfer NC/NS so it explains trainer actions without exposing storage, route, schema, or transport implementation details.
- Added a narrow trainer Help compatibility filter for configured remote Help/FAQ overrides. Clearly internal sections and lines containing routes, credentials, service-account setup, schema instructions, repository paths, deployment instructions, or hidden setting keys are omitted; safe remote trainer content continues to override fallback content.
- Kept technical setup and source-priority guidance in repository-only admin/developer documentation. SAM Help/tutorial wording remains operational and no longer names internal notification tabs.
- Manual verification remains required for every MTS Settings tab, all MTS Help sections/search, SAM Help/tutorial copy, remote Help override behavior, and editable/copyable reschedule post generation.

### 2026-07-14: Current uncommitted MTS History layout and clean status-label fix

- Replaced the History page's rigid table presentation with a responsive grid-row layout so Date, Candidate, Tester, Session Status, Follow-Up, Form Status, and Actions remain inside the visible MTS viewport. Restored-width layouts collapse into compact card-like rows without requiring horizontal scrolling.
- Removed visible textual status-icon prefixes from History and Home Recent Activity. Centralized status metadata now provides clean trainer-facing labels and accessible text, while CSS renders decorative dots/icons with `aria-hidden="true"`.
- Follow-Up display now separates scheduled date/time, timezone, and approval chip so long combined values do not force History rows wider than the app shell.
- Temporary Newbie Shift Discord posts for initial scheduling and rescheduling now show by default with no automatic mention. Trainer edits remain temporary, survive Hide/Show, Copy uses the current edited text, and Reset restores generated wording.
- Validation for this change must include History at maximized/restored/practical narrow widths and 100%, 125%, 150%, and 200% display scaling; Recent Activity clean chip labels; and temporary Discord post edit/copy behavior.

### 2026-07-13: Current uncommitted History form-fill and reschedule UI regression fix

- Fixed a false History Form Fill failure where Selenium could complete Microsoft Form automation but the backend returned HTTP 500 during post-fill status persistence. The backend now separates automation completion from metadata persistence and returns partial-success fields instead of collapsing the result into Form Fill Failed.
- Added SQLite JSON encode/decode helpers used by the History status update path so old and new local history rows can be updated safely after form fill.
- Updated History and Review form-fill handling so `form_filled`/`automation_completed` is treated as Form Filled even when metadata synchronization reports a warning. History keeps a best-effort local recovery marker and requires explicit confirmation before refilling an already-filled record.
- Centralized semantic status-chip metadata in `frontend/src/utils/certificationWorkflow.js` and applied it to History and Home Recent Activity. Not Yet Filled/Not Recorded are neutral, Pending follow-up is blue/violet, and Incomplete remains amber.
- Reworked the Newbie Shift reschedule modal requester/reason controls into accessible radio-card grids with better spacing, selected/focus states, required `Other` details, and Cancel/Discard/Continue ordering.
- Validation for this change must include History form-fill dry-run behavior, partial metadata failure behavior, chip layout at restored/maximized widths, and reschedule modal spacing at 100%, 125%, 150%, and 200% display scaling.

### 2026-07-12: Current uncommitted MTS Settings source-priority stabilization

- Hardened managed Settings content so legacy saved lists without an explicit `<section>_customized` marker cannot silently override active Google/admin content.
- `sanitize_settings` now returns managed customization flags for UI source display while still redacting sensitive settings.
- Settings > Fail Reasons shows the effective source and can disable only the Call Fail Reasons or Supervisor Fail Reasons local override through the existing targeted reset route.
- Required system fail reasons are still merged after source selection, so `Did not search for member` survives stale remote or local content and is deduplicated.

### 2026-07-12: Current uncommitted SAM startup sanitization and required call fail reason merge

- Added bounded cold-start retry behavior for SAM Candidate Tracking in `frontend/src/NotificationManagerApp.jsx` so temporary backend/shared-data readiness races do not immediately show an outage warning.
- Removed normal UI rendering of Candidate Tracking setup/schema diagnostics; persistent Google Sheets failures now show sanitized trainer/admin copy without raw tab names, column lists, JSON, service-account-oriented setup text, or `[object Object]`.
- Rebalanced the SAM dashboard quick-action area into Data, Workflow, and System groups and slightly enlarged the SAM logo in `frontend/src/polish-sam.css`.
- Protected `Did not search for member` as a required MTS call fail reason at both backend content normalization/settings sanitization and Calls page render time. Relevant files: `backend/server.py`, `frontend/src/pages/CallsPage.jsx`.
- Verified source-priority behavior for admin content: valid Google Sheet rows replace packaged fallbacks; runtime customized settings override managed lists only when explicitly marked customized; required system fail reasons are merged back only when missing. The live `call-fail-reasons` tab must contain a `FailReason` row for `Did not search for member`; if direct Google Sheet editing is needed, add that row manually without duplicating it.
- Added focused regression coverage in `frontend/src/NotificationManagerApp.releasePolish.test.js` and `frontend/src/pages/CallsPage.test.jsx`.

### 2026-07-12: Current uncommitted Candidate Tracking preview and call fail reason polish

- Added row-level `Show More` / `Show Less` preview expansion to SAM Candidate Tracking so long Results/Notes can be read without opening `View Details`. `View Details` remains the separate full-record/history modal.
- Kept Candidate Tracking actions compact with `View Details`, `Update Status`, and `More Actions`; dropdown content renders in-flow to avoid clipping inside the table scroller.
- Restored `Did not search for member` across the remaining stale admin package source and display-label mapping. Relevant files: `docs/admin-content-package/mock-testing-suite-admin-content.xml`, `frontend/src/utils/summaryDisplayLabels.json`.
- Improved the Review fallback fail summary path so selected fail reasons appear in trainer-facing fallback/form text when Gemini/backend summary generation is unavailable.
- Validation completed for this change: targeted SAM/Calls/Review frontend tests, frontend production build, and SAM packaged build. MTS packaged build reached React/backend build successfully but electron-builder could not clear `desktop/dist/win-unpacked/d3dcompiler_47.dll` because a local packaged MTS process was still running from generated output; close the app normally and rerun `npm run build:win`.

### 2026-07-12: Current uncommitted SAM notification and operations polish

- Fixed the SAM notification ID race by generating an internal UUID-style ID when a new notification draft or duplicate draft is created. Relevant files: `frontend/src/utils/notificationManager.js`, `frontend/src/NotificationManagerApp.jsx`.
- Removed the editable Notification ID field and trainer-facing sheet/ID sidecard content from the SAM notification editor; IDs remain internal, stable through save, and duplicate notifications receive a new ID.
- Consolidated SAM header controls so Help appears once and Exit appears once as a far-right dark-red header action. Global toolbar actions are limited to true global actions; notification Edit/Duplicate now live on each notification row.
- Added compact SAM operations cards for Add Notification and Candidate Tracking and combined current/last sync into a single Sync Status card.
- Updated SAM section tabs with restrained color identities for Notifications, Live Preview, Headset Review, Candidate Tracking, and Pending Sup Transfers.
- Reworked SAM Candidate Tracking row actions into `View Details`, `Update Status`, and `More Actions`, and constrained long candidate text to two-line previews with accessible full-text attributes.
- Validation completed for this change: `npm test -- --runTestsByPath src/NotificationManagerApp.releasePolish.test.js --watchAll=false`, frontend production build, and SAM packaged build. MTS packaged build reached React/backend build successfully but electron-builder could not clear `desktop/dist/win-unpacked/d3dcompiler_47.dll` because a local packaged MTS process was still running from generated output; close the app normally and rerun `npm run build:win`.

### 2026-07-11: Final RC UI polish and Google Sheets stability

- Removed visible manual IP entry controls from `frontend/src/components/CandidateIpIntelligence.jsx`; this older entry was later superseded by the 2026-07-30 manual-only release correction documented below.
- Adjusted MTS Home Quick Actions in `frontend/src/polish-mts.css` so normal desktop widths keep five cards on one row and smaller widths fall back to a balanced `3+2` layout instead of `4+1`.
- Tightened SAM Candidate Tracking action layout in `frontend/src/NotificationManagerApp.jsx` and `frontend/src/polish-sam.css`; `View Details` is a full-width first action and remaining buttons use a readable two-column layout.
- Hardened Google Sheets quota handling for SAM Candidate Tracking in `frontend/src/NotificationManagerApp.jsx` and `backend/server.py`: concurrent loads are deduplicated, successful data is briefly cached, quota/rate-limit failures trigger a `60000ms` backoff, previous data stays visible when possible, and trainer-facing messages are sanitized.
- Added regression coverage in `frontend/src/pages/HomePage.test.jsx`, `frontend/src/NotificationManagerApp.releasePolish.test.js`, `frontend/src/pages/SettingsAndGradingConfig.test.jsx`, and `backend/test_rc_workflow_logic.py`.

### 2026-07-11: MTS Discord Posts black-screen and exit fallback fix

- Fixed an MTS renderer crash when opening Discord Posts. `DiscordModal` in `frontend/src/App.js` had a shortcut handoff effect whose dependency array referenced `copyTemplate` before that callback was initialized, causing a temporal-dead-zone exception during modal mount.
- Stabilized Discord modal derived state with memoized templates/screenshots/active items so window-level shortcut listeners do not churn unnecessarily while preserving search, favorites, recent, screenshot library, command palette, and shortcut copy behavior.
- Wrapped MTS in the shared renderer error boundary in `frontend/src/index.js`, matching SAM behavior, so renderer exceptions show a recoverable trainer-facing fallback instead of a blank/black app window.
- Added a bounded Electron close fallback in `desktop/src/main.js`: if the renderer does not acknowledge the custom exit confirmation within `4000ms`, Electron shows a native `No`/`Yes` confirmation and confirmed exit still runs owned-process cleanup.
- Added regression coverage in `frontend/src/AppDiscordLayout.test.js`, `frontend/src/NotificationManagerApp.releasePolish.test.js`, and `desktop/test/processOwnership.test.js`.
- Validation completed: targeted Discord frontend test, broader RC frontend test set, desktop syntax checks, desktop process-ownership test, frontend production build, MTS package build, and SAM package build. Hands-on packaged Discord click/exit verification was blocked by local GUI automation bootstrap failure and remains required.

### 2026-07-11: Remaining v1.0.1 RC regression fixes

- Backend cleanup now tracks the actual FastAPI listener PID separately from the backend launcher/wrapper PID. Relevant files: `desktop/src/main.js`, `desktop/src/processOwnership.js`, `desktop/test/processOwnership.test.js`.
- Confirmation dialogs corrected safe-left/affirmative-right ordering for No Coaching, NC/NS choices, and related save/exit flows. Relevant files: `frontend/src/pages/CallsPage.jsx`, `frontend/src/pages/BasicsPage.jsx`, `frontend/src/pages/SupTransferPage.jsx`, `frontend/src/pages/ReviewPage.jsx`, `frontend/src/App.js`.
- Candidate lookup no longer exposes raw `mock_session`; Basics formats session types as trainer-facing labels.
- Discord shortcuts now use window-level modal handling plus global handoff for Search, Favorites, Command Palette, Screenshot Library, and favorite shortcut copy actions. Duplicate shortcut display was removed from Settings.
- VPN/proxy checking restored automatic lookup as the default while preserving manual lookup links and `Copy URL` actions. This older release-candidate decision was superseded by the 2026-07-30 manual-only correction below.
- Validation completed: targeted frontend regression tests, backend compile/RC/IP tests, desktop process ownership checks, frontend production build, SAM package build, and MTS package build. Hands-on packaged close/port cleanup remains required.

### 2026-07-11: SAM packaged startup regression fix

- Fixed a production-only SAM startup crash where the auto-refresh effect referenced `loadSheetItems` before the callback was initialized in `frontend/src/NotificationManagerApp.jsx`. The old optimized bundle minified that callback to `Le`, producing `Cannot access 'Le' before initialization`.
- Updated `frontend/src/index.js` so the SAM error boundary keeps raw JavaScript/minified errors in developer logs instead of rendering them to users.
- Corrected Exit Application ordering in `frontend/src/App.js` and the Electron fallback in `desktop/src/main.js`: safe/no action is left/default/cancel, affirmative exit is right.
- Added regression coverage in `frontend/src/NotificationManagerApp.releasePolish.test.js`.
- Validation completed: targeted SAM release-polish test, broader RC frontend tests, `node --check` for desktop lifecycle files, process-ownership unit test, frontend production build, SAM package build, and MTS package build. Limited packaged launch check verified both apps can run with ports `8600` and `8601`; full visual exit-modal and process-lifecycle close testing remains required.

### 2026-07-11: MTS/SAM process ownership cleanup

- Added `desktop/src/processOwnership.js` to register app-owned child processes by exact PID and owner.
- Wired `desktop/src/main.js` so MTS and SAM clean up only their own backend process and do not preserve or kill backends based on companion-app heartbeat state.
- Removed active-code stale backend cleanup based on `backend.exe` image-name discovery; stale cleanup now relies on per-app backend-owner metadata.
- Added mocked lifecycle coverage in `desktop/test/processOwnership.test.js`.
- Limited packaged simultaneous-run verification confirmed both apps can launch together on ports `8600` and `8601`; normal-close cleanup verification remains required before release.

### 2026-07-11: Current uncommitted RC stabilization work

- Pending Supervisor Transfer cleanup excludes terminal/completed latest statuses from MTS/SAM pending lists.
- Supervisor Transfer Only modal hierarchy was made safer so Smart Resume remains the recommended action.
- Centralized summary display labels were added through `frontend/src/utils/summaryDisplayLabels.json` and `frontend/src/utils/summaryDisplayLabels.js`, with backend loading in `backend/server.py`.
- Fallback coaching/fail summaries were cleaned up to avoid internal identifiers, duplicate parent/child labels, and duplicate Evaluator Override text.
- Help/FAQ fallback maintenance was documented in `dev-tools/docs/help-faq-defaults.md`.
- Relevant areas: `backend/server.py`, `frontend/src/pages/ReviewPage.jsx`, `frontend/src/pages/SupTransferPage.jsx`, `frontend/src/components/ModalProvider.jsx`, `frontend/src/NotificationManagerApp.jsx`, `frontend/src/polish-sam.css`.

### 2026-07: SAM release polish

- SAM Candidate Tracking gained clearer admin actions, candidate details presentation, sorting/filtering support, safer button coloring, auto-refresh, and update/version UI polish.
- Relevant files: `frontend/src/NotificationManagerApp.jsx`, `frontend/src/polish-sam.css`, `frontend/src/NotificationManagerApp.releasePolish.test.js`.

### 2026-07: Discord productivity and screenshot suggestions

- Discord Posts became search-first with favorites, recent filters, command palette, configurable shortcuts, preview, and screenshot suggestions.
- Suggested screenshots support 0 to 3 images per Discord post through defaults, Settings, and fallback mappings.
- Relevant files: `frontend/src/App.js`, `frontend/src/utils/discordProductivity.js`, `frontend/src/utils/discordScreenshotSuggestions.js`, `frontend/src/pages/SettingsPage.jsx`, `backend/defaults/discord-posts.csv`, `backend/defaults/screenshots.csv`, `dev-tools/docs/discord-posts-and-screenshots-defaults.md`.

### 2026-07: Release workflow and Review stabilization

- Review summary timing, Gemini fallback behavior, Fail Summary/Incompletion separation, Newbie Shift continuation behavior, and Microsoft Form payload handling were hardened.
- Relevant files: `frontend/src/pages/ReviewPage.jsx`, `backend/server.py`, `backend/services/form_filler.py`, `frontend/src/pages/SupTransferPage.jsx`.

### 2026-07: Help/FAQ and content fallback stabilization

- Help/FAQ content uses Google Doc overrides when configured and packaged markdown fallbacks when unavailable.
- Troubleshooting content was renamed toward Tech Issues in Help surfaces.
- Relevant files: `frontend/src/pages/HelpPage.jsx`, `backend/defaults/help.md`, `backend/defaults/faq.md`, `backend/server.py`, `dev-tools/docs/help-faq-defaults.md`.

### 2026-07: Service-account packaging risk documented

- `docs/service-account-packaging-risk.md` records the prohibition on packaged service-account credentials, required rotation/artifact gates, and the supported service-boundary direction.
- This matters because release agents must not mistake accepted internal-tester distribution risk for a long-term security recommendation.
