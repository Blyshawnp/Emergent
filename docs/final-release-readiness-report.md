# Final Release Readiness Report

> Historical audit record from 2026-06-23. For the current branch and evidence, use `docs/RELEASE_CHECKLIST_v1.0.1.md`; do not treat the package-content or tracked-file counts below as current.

## Audit identity

- Product: Mock Testing Suite (MTS) and Sam (SAM)
- Version: 1.0.1
- Base branch: `integration-final-release-candidate`
- Audit branch: `final-release-readiness-audit`
- Audit date: 2026-06-23
- Release recommendation: **Not ready**

The application builds and the tested release workflows pass, but the release must not be distributed while service-account credentials are embedded in both installers and tracked packaged output remains in the repository. No credential values, account identifiers, sheet identifiers, tokens, or private-key material were read into this report.

## Critical release blockers

| ID | Blocker | Evidence | Required release gate |
| --- | --- | --- | --- |
| FRR-001 | Both MTS and SAM distributables contain a Google service-account credential file. | Both Electron Builder configurations include the credential in `extraResources`; the clean rebuild copied it into both unpacked packages; post-build checks confirmed it is present in both packages. | Stop shipping a client-extractable long-lived service-account key, rotate/revoke the exposed key, rebuild both packages, and verify no credential file or private-key material exists in installers/unpacked output. |
| FRR-002 | Generated release output containing credential copies is already tracked in Git. | The base branch tracks 351 paths under `production-ready`, including two packaged credential copies. `.gitignore` does not remove already tracked files or history. | Remove generated release output from the Git index, purge sensitive historical objects and hosted artifacts, rotate/revoke affected credentials, and complete a clean secret scan of the rewritten repository. |
| FRR-003 | A runtime SQLite database is tracked in Git. | `backend/data/mock_testing_suite.sqlite3` is tracked on the base branch. | Confirm retention requirements, remove it from tracking, purge it from history if it contains non-public data, and replace any required seed data with a schema/migration or sanitized fixture. |

These blockers were not auto-fixed in this audit. Removing the packaged credential without replacing the current Google Sheets authentication path would break required MTS/SAM behavior, while credential rotation and Git-history rewriting require coordinated operational approval.

## Packaging results

| Check | MTS | SAM |
| --- | --- | --- |
| NSIS installer built | Pass | Pass |
| Installer blockmap present and non-empty | Pass | Pass |
| `latest.yml` matches installer and blockmap | Pass | Pass |
| Unpacked executable present | Pass | Pass |
| `resources/app.asar` present | Pass | Pass |
| Packaged `backend.exe` present | Pass | Pass |
| Packaged runtime defaults present | Pass | Pass |
| Screenshot manifest files present | 18 of 18 | 18 of 18 |
| Packaged sound files | 63 | 63 |
| Optional tutorial MP4 | Not included; guided tutorial fallback remains active | Not included; guided tutorial fallback remains active |
| Authenticode installer signature | Not signed | Not signed |

`dev-tools/clean-rebuild-main-app.bat` completed successfully in desktop-only mode. It rebuilt the frontend and backend, produced both installers, validated updater metadata, and did not touch `production-ready`.

Uninstall behavior is configured through separate NSIS app IDs and documented in `docs/uninstallers-and-release-packaging.md`. A clean-machine install/uninstall cycle was not repeated in this session.

## Fresh-install findings

| Check | Finding |
| --- | --- |
| Setup wizard | Existing GUI QA records a successful first-run setup and save. `SetupPage` tests pass. A new destructive app-data reset was not applied. |
| Tutorial | Existing GUI QA records first-run/replay success. Tutorial overlay and Help fallback tests pass. |
| Settings save | Existing GUI QA records persistence success; settings regression tests pass. |
| Reset tool | Dry-run passed. It targeted only the MTS and SAM roaming app-data directories, refused repository/build/credential paths, and deleted nothing. |
| MTS single instance | Static verification passed: the shared Electron entry requests a mode-specific single-instance lock and uses the MTS runtime identity. |
| SAM single instance | Static verification and regression test passed; existing GUI QA also records SAM single-instance success. |
| MTS and SAM coexistence | Static verification passed: separate app IDs, user-data directories, update repositories, backend ports, and lock metadata are configured. |

New interactive fresh-install/coexistence testing was blocked before application control because the Windows UI automation runtime lacked required sandbox metadata. This report therefore relies on the existing successful GUI QA record, code inspection, dry-run safety checks, and automated tests; it does not claim a new clean-VM install.

## Data consistency findings

- The backend content map has explicit Google Sheet tab names and packaged fallback filenames for callers, shows, call types, supervisor reasons, coaching, fail reasons, Discord posts, screenshots, headsets, and Gemini prompts.
- Packaged runtime defaults include the current CSV/Markdown files. Live Google Sheet contents were not queried during this audit, so remote-row equality is not claimed.
- All 18 screenshot rows resolve to source files and to files in both packaged frontend resource trees.
- The Discord fallback contains the required VPN Fail and Wrong Headset templates.
- `headsets.csv` uses `Brand,Model,Status,Note`. The backend remains compatible with the old three-column layout and migrates it by inserting `Status` without deleting rows.
- Approved headset normalization excludes rows marked denied. Denied entries remain available to MTS for the unacceptable-headset prompt, reason display, replacement question, and mapped auto-fail path.
- SAM review logic supports pending, approved, and denied states, denial reasons, review-later behavior, and in-place Google Sheet updates.
- Coaching, fail reasons, and technical-issue options load from current fallbacks; the complete frontend regression suite passed.
- The older admin-content CSV bundle is not byte-for-byte synchronized with several current backend defaults. Packaged runtime output uses `backend/defaults`, so this is not a release blocker, but the documentation/import bundle should be refreshed after the security blockers are resolved.

## Security findings

- **Fail:** credentials are present in both newly built distributable packages.
- **Fail:** two packaged credential copies are tracked under generated `production-ready` output.
- **Fail:** one SQLite database is tracked.
- **Fail:** 351 generated `production-ready` paths are tracked on the base branch.
- **Pass:** no tracked `.log` files were found.
- **Pass for this audit commit:** generated builds, installers, blockmaps, logs, SQLite, `production-ready`, credentials, and `node_modules` are not included in the audit change set.
- `.gitignore` contains relevant exclusions, but ignore rules cannot remediate already tracked content or repository history.

## Warnings

1. Both installers are unsigned. Windows reputation and SmartScreen friction should be expected until Authenticode signing is added.
2. Chrome/Edge driver executables are not bundled. Selenium Manager/runtime resolution remains the fallback and may require network access on a new machine.
3. No new clean-VM install, uninstall, or simultaneous-launch smoke was completed because GUI automation was unavailable in this environment.
4. Live Google Sheet rows were not compared with packaged fallbacks during this audit.
5. The admin-content documentation/import CSV bundle should be synchronized with the current runtime defaults.

## Validation results

- `node --check desktop/src/main.js` — passed.
- `.venv/Scripts/python.exe -m py_compile backend/server.py backend/packaged_backend.py` — passed. This is the repository-interpreter equivalent of the requested Python command.
- `.venv/Scripts/python.exe -m unittest backend.test_rc_workflow_logic` — passed, 11 tests.
- Additional backend suites — passed, 16 tests total across RC workflow, coaching defaults, and shared candidate archive behavior.
- Complete frontend regression suite — passed, 47 tests across 12 suites.
- `npm run build:react` from `desktop` — passed.
- `dev-tools/clean-rebuild-main-app.bat` — passed for both MTS and SAM.
- Fresh-install reset tool dry-run — passed; nothing was deleted.
- New interactive GUI smoke — blocked by unavailable Windows UI automation metadata; existing GUI QA remains the rendered evidence.

## Release decision

**Not ready.** Do not publish version 1.0.1 installers or update metadata until FRR-001 through FRR-003 are closed and both rebuilt installers pass a credential scan. Packaging correctness and workflow tests do not override the credential-exposure blockers.
