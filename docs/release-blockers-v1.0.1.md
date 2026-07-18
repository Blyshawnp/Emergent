# Release Blockers for v1.0.1

> Status update, 2026-07-16: this earlier blocker record is retained for audit history. Current `HEAD` tracks no `production-ready` paths, runtime database, or service-account credential path. Service-account packaging was removed, repository Apps Script authorization is role/action scoped, and stale loopback backend ownership is classified by mode/PID/heartbeat. Controlled role-config provisioning, live deployment update, credential rotation/revocation, artifact scanning, and live unknown-headset/request round trips remain tracked in `docs/RELEASE_CHECKLIST_v1.0.1.md`.

Release status: **Blocked — Not ready**

## FRR-001: Client-distributed service-account credential

Severity: Critical  
Applies to: MTS installer, SAM installer, unpacked application folders

Both packaging definitions and the clean rebuild place a long-lived Google service-account credential in the desktop application resources. Desktop package contents are extractable, so this must be treated as credential disclosure even if the installer is distributed only to internal users.

Required remediation:

1. Revoke/rotate the affected credential.
2. Remove credential JSON files from both packaging configurations and rebuild scripts.
3. Move privileged Google Sheets operations behind an authenticated service boundary, or adopt another design that does not distribute a reusable private key to clients.
4. Rebuild MTS and SAM from a clean workspace.
5. Scan installers, unpacked output, logs, and updater artifacts for credential filenames and private-key material.
6. Re-run Google Sheets read/write, SAM headset review, and MTS denied-headset workflow tests through the replacement authentication path.

Exit criteria: both installers work without containing a service-account private key, the old key is revoked, and required Google Sheets workflows pass.

## FRR-002: Sensitive generated output tracked in Git

Severity: Critical  
Applies to: repository history, generated release folders, hosted clones/artifacts

The base branch tracks 351 generated paths under `production-ready`, including two packaged credential copies. Adding ignore rules does not remove tracked files or historical objects.

Required remediation:

1. Freeze release distribution and credential use while scope is assessed.
2. Remove generated release output from Git tracking without deleting the authoritative release records needed elsewhere.
3. Purge sensitive blobs from repository history using a coordinated history-rewrite procedure.
4. Invalidate or replace affected remote artifacts, caches, clones, and release bundles.
5. Rotate/revoke every credential found in current or historical generated output.
6. Run a repository-wide secret scan on the rewritten history and the release artifacts.

Exit criteria: no generated `production-ready` output or credential file is tracked at `HEAD`, sensitive historical blobs are removed, affected credentials are revoked, and a clean secret scan is recorded.

## FRR-003: Tracked runtime SQLite database

Severity: Critical until contents are classified  
Applies to: repository and history

`backend/data/mock_testing_suite.sqlite3` is tracked. Runtime databases can contain tester, candidate, session, or local configuration data and should not be used as a source fixture without explicit sanitization.

Required remediation:

1. Classify the database contents without copying sensitive rows into tickets or logs.
2. Remove the database from Git tracking.
3. Purge it from history if it contains non-public or personal data.
4. Replace required initialization state with migrations, schema creation, or a reviewed synthetic fixture.
5. Verify a fresh install creates its runtime database under the application user-data directory.

Exit criteria: no runtime SQLite file is tracked, any sensitive history is purged, and fresh-install database creation passes.

## Release warnings after blocker closure

- MTS and SAM installers are not Authenticode-signed.
- Browser driver executables are not bundled; runtime resolution is required.
- Repeat clean-VM install, simultaneous MTS/SAM launch, update, and independent uninstall testing.
- Compare live Google Sheet tab contents with packaged fallbacks and refresh the older admin-content CSV import bundle.

## Mandatory revalidation

After all blockers are closed:

```powershell
node --check desktop/src/main.js
.\.venv\Scripts\python.exe -m py_compile backend/server.py backend/packaged_backend.py
.\.venv\Scripts\python.exe -m unittest backend.test_rc_workflow_logic
Set-Location desktop
npm run build:react
Set-Location ..
dev-tools\clean-rebuild-main-app.bat
```

Then verify both packages contain the expected application assets and **no credentials**, run a clean-VM first-launch/install/uninstall smoke, and record a new release recommendation.
