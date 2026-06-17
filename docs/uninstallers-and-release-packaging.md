# Uninstallers and Release Packaging

Mock Testing Suite and Sam are packaged with Electron Builder NSIS installers.

## Current installer targets

- Mock Testing Suite uses appId `com.acddirect.mocktestingsuite` and builds `Mock-Testing-Suite-Setup-${version}.exe`.
- Sam uses appId `com.acddirect.mocktestingsuite.notificationmanager` and builds `Sam-Setup-${version}.exe`.
- Both configs use the `nsis` Windows target with per-machine install, Start menu shortcuts, desktop shortcuts, installer icons, and uninstaller icons.

## Uninstall support

NSIS creates uninstall support during installation. The release output contains the setup EXE. After the setup EXE is installed, Windows registers the app in Apps & Features and creates an uninstall executable in the installed application folder.

The standalone release folder is not expected to contain a separate uninstaller EXE before installation. The uninstaller is generated and registered by the installed NSIS package.

## Validation

To validate release packaging:

1. Run the normal release build from the repo root:

   ```powershell
   dev-tools\clean-rebuild-main-app.bat
   ```

2. Confirm both setup EXEs are produced in the release output.
3. Install Mock Testing Suite and Sam on a clean test machine or VM.
4. Confirm both apps appear separately in Windows Apps & Features.
5. Confirm uninstalling Mock Testing Suite does not uninstall Sam, and uninstalling Sam does not uninstall Mock Testing Suite.
6. Confirm the app IDs remain unchanged in `desktop/package.json` and `desktop/notification-manager-builder.json`.

Do not commit generated installers, `desktop/dist`, `desktop/dist-notification-manager`, or `production-ready` output.
