# Service Account Packaging Security Decision

`google-service-account.json` must not be included in MTS or SAM installers, unpacked application resources, production-ready output, updater artifacts, Git, logs, screenshots, or support bundles.

The earlier v1.0.x exception is closed. Both Electron Builder definitions and the production-ready synchronization scripts now exclude the credential without reading or modifying the local source file.

## Release requirements

1. Rotate or revoke any credential that was present in a previously distributed or retained package.
2. Rebuild MTS and SAM after the packaging change.
3. Inspect artifact file-name inventories and run an approved secret scan without printing credential values.
4. Confirm required live workflows through a service boundary that does not distribute a reusable privileged credential.
5. Do not restore the credential to packaging as a fallback.

## Supported direction

The repository Apps Script boundary now uses separate MTS and SAM credentials with role/action-scoped authorization. MTS cannot invoke SAM decisions, notification administration, generic sheet writes, or candidate-administration commands. Live acceptance still requires the controlled deployment and independently packaged role credentials to match that source. Admin-provided OAuth remains a possible future replacement.
