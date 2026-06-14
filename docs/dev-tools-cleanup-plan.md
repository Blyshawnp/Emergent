# Dev Tools Cleanup Plan

This is an audit and replacement plan for `dev-tools/*.bat` and `dev-tools/*.ps1`. No scripts were deleted or changed in this branch.

The audit is static. Build scripts were not executed because most of them intentionally delete/rebuild generated outputs.

## Current Script Inventory

| Script | Status | Builds desktop dist? | Builds production-ready? | Builds Admin folder? | Builds Tester folder? | Notes |
|---|---|---:|---:|---:|---:|---|
| `dev-tools/clean-rebuild-all.bat` | Works as maintained wrapper | Yes | Yes | Yes, current SAM folder is `production-ready/ADMIN ONLY - SAM 1.0.1` | Yes, current MTS folder is `production-ready/Mock Testing Suite 1.0.1` | Thin wrapper for `clean-rebuild-all.ps1`. Supports `all`, `mts`, `sam`, and `dry-run` through the PowerShell script. |
| `dev-tools/clean-rebuild-all.ps1` | Works and is primary full pipeline | Yes | Yes | Yes | Yes | Builds React, backend.exe, MTS package, SAM package, validates `latest.yml`, syncs production-ready, copies runtime config, writes hash files. |
| `dev-tools/clean-rebuild-desktop-only.bat` | Works as maintained wrapper | Yes | No | No | No | Builds MTS and SAM desktop outputs but refuses to touch production-ready. |
| `dev-tools/clean-rebuild-desktop-only.ps1` | Works and is primary desktop-only pipeline | Yes | No | No | No | Builds `frontend/build`, `backend/dist`, `desktop/dist`, and `desktop/dist-notification-manager`. |
| `dev-tools/clean-rebuild-main-app.bat` | Works as alias wrapper | Yes | No | No | No | Delegates to `clean-rebuild-main-app.ps1`, which delegates to desktop-only build. Name is misleading because it also builds SAM desktop output. |
| `dev-tools/clean-rebuild-main-app.ps1` | Works as alias wrapper | Yes | No | No | No | Thin wrapper over `clean-rebuild-desktop-only.ps1`. |
| `dev-tools/clean-rebuild-production-ready.bat` | Works as maintained wrapper | No | Yes | Yes | Yes | Refreshes production-ready from existing desktop outputs only. |
| `dev-tools/clean-rebuild-production-ready.ps1` | Works as guard wrapper | No | Yes | Yes | Yes | Checks required desktop output exists, then delegates to `clean-rebuild-production-ready-only.ps1`. |
| `dev-tools/clean-rebuild-production-ready-only.bat` | Works but duplicate wrapper | No | Yes | Yes | Yes | Direct wrapper to production-ready-only implementation. Could be collapsed into clearer future naming. |
| `dev-tools/clean-rebuild-production-ready-only.ps1` | Works and is primary production-ready sync implementation | No | Yes | Yes | Yes | Syncs MTS and SAM win-unpacked folders and installers from desktop output into production-ready and writes hash files. |
| `dev-tools/clean-rebuild-mts.bat` | Works as shortcut | MTS only | MTS only | No | Yes | Delegates to `clean-rebuild-all.bat mts`. Keep until replacement names exist. |
| `dev-tools/clean-rebuild-sam.bat` | Works as shortcut | SAM only | SAM only | Yes | No | Delegates to `clean-rebuild-all.bat sam`. Keep until replacement names exist. |
| `dev-tools/full-clean-rebuild.bat` | Works as legacy wrapper | Yes | Yes | Yes | Yes | Delegates to `clean-rebuild-all.bat all`. Retain as compatibility wrapper or replace with a warning. |
| `dev-tools/clean-app-main-junk.bat` | Works as maintained wrapper | No | No | No | No | Supports dry run and delegates to cleanup PowerShell script. |
| `dev-tools/clean-app-main-junk.ps1` | Works as cautious cleanup helper | No | No | No | No | Plans/removes temporary junk with safeguards and explicit `CLEAN` confirmation unless dry-run. |
| `dev-tools/validate-latest-yml.ps1` | Works as validation helper | No | No | No | No | Validates `latest.yml` path/url/sha512 against installer and blockmap in a dist folder. Used by rebuild scripts. |
| `dev-tools/CLEAN-REBUILD-MAIN-APP-NO-PRODUCTION-TOUCH.bat` | Outdated duplicate | MTS only | No | No | Partial Tester only | Manual BAT implementation duplicates older main-app-only behavior, uses its own venv/PyInstaller flow, and does not build SAM. Replace with maintained desktop-only script. |
| `dev-tools/reset-dev.bat` | Outdated/risky utility | MTS only when option 3 selected | No | No | Partial Tester only | Resets packaged MongoDB/local storage and can rebuild MTS only through `npm run build:win`. Current app uses SQLite, so MongoDB reset wording and behavior are stale. |
| `dev-tools/create-tutorial-preview.bat` | Outdated and risky | No | No | No | No | Installs `react-joyride` and overwrites `src/App.js` or `src/App.jsx` in the current directory. Current tutorial lives in `frontend/src/tutorial/TutorialPreviewOverlay.jsx`. |
| `dev-tools/cleanup-tutorial-preview.bat` | Outdated companion | No | No | No | No | Deletes `src/TutorialPreview.jsx` in current directory and calls `restore-real-app.bat`. Only relevant to old preview workflow. |
| `dev-tools/restore-real-app.bat` | Outdated companion | No | No | No | No | Restores old `src/App.*.before-tutorial-preview.bak` files in current directory. Risky if run from wrong folder. |
| `dev-tools/start-tutorial-preview.bat` | Outdated companion | No | No | No | No | Assumes current directory has `package.json` and runs `npm start`. Not aligned to current app entry points. |

## Which Scripts Work

Keep as working current tooling:

- `clean-rebuild-all.bat`
- `clean-rebuild-all.ps1`
- `clean-rebuild-desktop-only.bat`
- `clean-rebuild-desktop-only.ps1`
- `clean-rebuild-main-app.bat`
- `clean-rebuild-main-app.ps1`
- `clean-rebuild-production-ready.bat`
- `clean-rebuild-production-ready.ps1`
- `clean-rebuild-production-ready-only.bat`
- `clean-rebuild-production-ready-only.ps1`
- `clean-rebuild-mts.bat`
- `clean-rebuild-sam.bat`
- `full-clean-rebuild.bat`
- `clean-app-main-junk.bat`
- `clean-app-main-junk.ps1`
- `validate-latest-yml.ps1`

Known caveat: in restricted/sandboxed shells, toolchain probes such as `python --version` can fail even when the script is valid. Run build scripts in a normal local PowerShell session or with appropriate approval before treating that as a script defect.

## Which Scripts Fail or Are Outdated

Outdated or risky by static audit:

- `CLEAN-REBUILD-MAIN-APP-NO-PRODUCTION-TOUCH.bat`
- `reset-dev.bat`
- `create-tutorial-preview.bat`
- `cleanup-tutorial-preview.bat`
- `restore-real-app.bat`
- `start-tutorial-preview.bat`

Reasons:

- They duplicate maintained workflows.
- Some assume old tutorial preview files.
- Some overwrite app entry files in the current directory.
- `reset-dev.bat` still references MongoDB reset paths while the backend now uses SQLite.
- The old main-app-only BAT does not build SAM and bypasses the maintained PowerShell checks.

## Which Scripts Build Desktop Dist

- `clean-rebuild-all.bat` / `.ps1`
- `clean-rebuild-desktop-only.bat` / `.ps1`
- `clean-rebuild-main-app.bat` / `.ps1`
- `clean-rebuild-mts.bat`
- `clean-rebuild-sam.bat`
- `full-clean-rebuild.bat`
- `CLEAN-REBUILD-MAIN-APP-NO-PRODUCTION-TOUCH.bat`, but MTS only and should be replaced
- `reset-dev.bat`, but only option 3 and MTS only, should be replaced

## Which Scripts Build Production-Ready

- `clean-rebuild-all.bat` / `.ps1`
- `clean-rebuild-production-ready.bat` / `.ps1`
- `clean-rebuild-production-ready-only.bat` / `.ps1`
- `clean-rebuild-mts.bat`, MTS only through all script mode
- `clean-rebuild-sam.bat`, SAM only through all script mode
- `full-clean-rebuild.bat`

## Which Scripts Build Admin and Tester Folders

Current folder mapping:

- Admin/SAM output: `production-ready/ADMIN ONLY - SAM 1.0.1`
- Tester/MTS output: `production-ready/Mock Testing Suite 1.0.1`

Scripts that currently populate both:

- `clean-rebuild-all.bat` / `.ps1`
- `clean-rebuild-production-ready.bat` / `.ps1`
- `clean-rebuild-production-ready-only.bat` / `.ps1`
- `full-clean-rebuild.bat`

Scripts that populate only one side:

- `clean-rebuild-mts.bat` populates Tester/MTS only.
- `clean-rebuild-sam.bat` populates Admin/SAM only.

## Duplicate or Unused Scripts

Duplicate wrappers:

- `full-clean-rebuild.bat` duplicates `clean-rebuild-all.bat all`.
- `clean-rebuild-main-app.bat` duplicates desktop-only behavior but remains a useful compatibility alias.
- `clean-rebuild-production-ready.bat` and `clean-rebuild-production-ready-only.bat` overlap. Keep one public name later.
- `clean-rebuild-mts.bat` and `clean-rebuild-sam.bat` are mode shortcuts.

Likely unused or obsolete:

- Tutorial preview helper group:
  - `create-tutorial-preview.bat`
  - `cleanup-tutorial-preview.bat`
  - `restore-real-app.bat`
  - `start-tutorial-preview.bat`
- Old no-production main app rebuild:
  - `CLEAN-REBUILD-MAIN-APP-NO-PRODUCTION-TOUCH.bat`
- Old reset/rebuild utility:
  - `reset-dev.bat`

## Recommended Future Script Set

Create these as explicit replacements:

- `build-all.bat` and `build-all.ps1`
- `build-mts-desktop.bat` and `build-mts-desktop.ps1`
- `build-sam-desktop.bat` and `build-sam-desktop.ps1`
- `build-production-ready-all.bat` and `build-production-ready-all.ps1`
- `build-production-ready-mts.bat` and `build-production-ready-mts.ps1`
- `build-production-ready-sam.bat` and `build-production-ready-sam.ps1`
- `build-admin-folder.bat` and `build-admin-folder.ps1`
- `build-tester-folder.bat` and `build-tester-folder.ps1`
- `clean-repo-junk.bat` and `clean-repo-junk.ps1`
- `clean-generated-builds.bat` and `clean-generated-builds.ps1`

Recommended mapping:

- `build-all` should run React build, backend build, MTS desktop package, SAM desktop package, production-ready sync, latest.yml validation, and hash validation.
- `build-mts-desktop` should build only `desktop/dist`.
- `build-sam-desktop` should build only `desktop/dist-notification-manager`.
- `build-production-ready-all` should sync both MTS and SAM from existing desktop output.
- `build-production-ready-mts` should sync only MTS to the Tester folder.
- `build-production-ready-sam` should sync only SAM to the Admin folder.
- `build-admin-folder` should be a readable alias for SAM production-ready output.
- `build-tester-folder` should be a readable alias for MTS production-ready output.
- `clean-repo-junk` should replace `clean-app-main-junk`.
- `clean-generated-builds` should remove only generated output folders with path safety checks.

## Required Future Behavior

Future scripts should enforce:

- Admin and Tester folders live under `production-ready`.
- Installers in Admin and Tester folders are copied from production-ready output, not directly from arbitrary local paths.
- Matching hash/check files are generated and copied with installers where applicable.
- `latest.yml`, installer, and blockmap are validated as one matching build set.
- Scripts never delete or sync credentials except through explicit protected runtime config copy logic.
- Scripts refuse to operate on computed paths outside the repo.
- Scripts report exactly which generated folders they remove.

## Test Local Updater Scripts

No current `dev-tools` script clearly implements a maintained local updater test flow. If there are external or historical Test Local Updater scripts, replace them with a small documented test harness that:

- Uses a local-only release folder under an ignored path.
- Clearly labels artifacts as not for distribution.
- Validates `latest.yml`, installer, and blockmap together.
- Does not alter production-ready release folders unless explicitly requested.

## Replacement Plan

1. Add new clearly named scripts as wrappers around the existing maintained PowerShell implementations.
2. Update docs and any shortcuts to use the new names.
3. Keep old wrappers for one release as compatibility aliases that print deprecation guidance.
4. Remove old tutorial preview scripts after confirming no one uses that workflow.
5. Remove `CLEAN-REBUILD-MAIN-APP-NO-PRODUCTION-TOUCH.bat` after `build-mts-desktop` and `build-sam-desktop` exist.
6. Replace `reset-dev.bat` with a SQLite-aware reset tool or remove it if no longer needed.

## Do Not Delete Yet

Per this audit prompt, do not delete any current script until a follow-up implementation request explicitly approves removal.
