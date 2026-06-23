# RC Performance and Polish Audit

## Scope

- Base branch: `integration-final-release-candidate`
- Audit branch: `rc-performance-polish-audit`
- Date: 2026-06-23
- Objective: final low-risk performance, UI polish, consistency, and release-safety cleanup after successful GUI QA.

No major features or data-model changes were added.

## Performance Findings

| Area | Finding | Result |
| --- | --- | --- |
| Local CSV/Markdown defaults | Local defaults load once synchronously and the background Google refresh reuses the in-memory snapshot. No repeated bundled-file scan remains. | Verified existing optimization. |
| Gemini prompts | Prompt text is read from in-memory content/defaults, but prompt-source messages were emitted for every summary. | Prompt-source logging now occurs only when a source changes; redundant combined logging was removed. |
| Backend ownership | `desktop/src/main.js` contained two `ensureBackendAvailable` declarations. The later declaration silently overrode the safer port/stale-owner implementation. | Removed the duplicate; one guarded startup path now handles port reuse, stale owned backends, and conflict reporting. |
| Duplicate processes | MTS and SAM retain separate single-instance locks, ports, and user-data directories. The current process snapshot showed no running app backend, Electron, Python backend, WebDriver process, or listener on the app backend ports. | No orphan app process found during this audit. |
| Polling | Ticker/notification intervals are cleared on unmount. Remote-content polling is attempt-limited. SAM backend retry is capped and uses one timer. | No runaway loop found. |
| SQLite | One locked connection is used; backup connections close in `finally`; the main connection closes during FastAPI shutdown. | No connection leak found. |
| Selenium/browser ownership | Failed form-fill launches call `driver.quit()`. Successful form fill intentionally leaves the populated browser open for user review/submission. | No automatic orphan/retry loop found; successful browser windows remain user-owned by design. |
| Renderer diagnostics | Settings, Calls, Supervisor Transfer, and the SAM notification editor emitted repetitive debug-only messages during normal navigation. | Removed repeated debug messages; warnings/errors and summary timing diagnostics remain. |
| Idle memory | No unbounded collection, interval, executor, or connection lifecycle was found in the audited paths. | Code audit passed; a long-duration packaged idle soak was not repeated because GUI QA was already completed. |

## UI Polish Findings and Fixes

- MTS Help used two synchronized search boxes. The duplicate middle search card was removed; the hero search remains the single search control.
- Long Help pages now use `content-visibility: auto` for offscreen topic cards, reducing initial layout/paint work without changing topic content.
- Payment card, routing, and account numbers now use larger tabular digits and consistent spacing for readability.
- SAM Candidate Tracking header actions are grouped and aligned. Row actions wrap inside a smaller dedicated column, reducing unnecessary horizontal width.
- SAM Headset Review now has its own surfaced panel and table sizing instead of inheriting notification-table widths. Notes wrap and action space remains stable.
- SAM table scroll containers reserve scrollbar space, and status text can wrap rather than force panel overflow.

## Release Consistency Review

- Help covers current setup, tutorial replay, denied-headset behavior, final readiness, payment options, Discord tools, updates, and support.
- Tutorial copy matches the current Settings, payment, headset, Review, and Discord workflows.
- Settings exposes the current welcome voice, sound volume, ticker speed, payment, Gemini, Discord, update, calendar, and theme controls.
- Configured support email/Discord values are displayed when present, with visible packaged fallbacks.
- No outdated workflow wording requiring a release-candidate change was found.

## Build and Repository Cleanliness

- Removed the empty root `package-lock.json`; there is no root `package.json` or root `main.js` runtime entry.
- Generated build directories, installers, SQLite files, logs, `node_modules`, `production-ready`, and credentials are excluded from this change set.
- The base branch already contains legacy tracked generated/package archives, including `production-ready` artifacts, a SQLite file, and packaged credential copies. They were not modified or staged because this pass explicitly prohibits committing those paths. Credential rotation/history cleanup should be handled as a separate security operation.
- Dated tutorial backup directories and restore scripts also predate this branch. They were left unchanged because some restore scripts still reference them; deleting that legacy recovery set is outside a low-risk RC polish pass.

## Validation

- `node --check desktop/src/main.js` — passed.
- `.venv/Scripts/python.exe -m py_compile backend/server.py backend/packaged_backend.py` — passed. The repo interpreter was used to avoid the WindowsApps Python launcher.
- `.venv/Scripts/python.exe -m unittest backend.test_rc_workflow_logic` — passed, 11 tests.
- Focused frontend regression suites — passed, 20 tests across Help, Settings/payment, Headset Review, and SAM release polish.
- `npm run build:react` from `desktop` — passed. Optimized main JavaScript decreased by 661 bytes gzip; CSS increased by 132 bytes gzip for dedicated layout/readability rules.
- `dev-tools/clean-rebuild-main-app.bat` — passed in desktop-only mode. It rebuilt the frontend/backend, packaged MTS and SAM, verified both unpacked executables and bundled backends, and validated both `latest.yml` files against their installer/blockmap output.
- `production-ready` — not touched by the rebuild.
- Rendered Browser recheck — blocked before tab acquisition by missing sandbox-policy metadata in the in-app Browser runtime. No standalone Playwright dependency is installed; prior GUI QA remains the rendered evidence for this RC.
- Optional Chrome/Edge driver binaries are not bundled. The existing Selenium Manager/runtime-driver fallback remains active.
