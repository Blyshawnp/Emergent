Mock Testing Suite 1.0.1 production package

Give this folder to regular agents.

Contents:
- Mock Testing Suite Setup 1.0.1.exe: Windows installer.
- Mock Testing Suite Setup 1.0.1.exe.blockmap: update/differential metadata.
- win-unpacked/: unpacked portable app output from electron-builder.
- BACKEND-REBUILD-INSTRUCTIONS.txt: backend and installer rebuild guide.
- TUTORIAL-FIX-DIFF.txt: full source diff for the tutorial fix files.

Security/distribution notes:
- The Notification Manager installer is not included in this folder.
- The regular app does not render the Notification Manager route unless launched in notification-manager mode.
- The package excludes loose backend/config/google-service-account.json, backend/config/service-account.json, .env files, and the local SQLite database file.

Verification performed:
- Frontend production build completed successfully.
- Electron Windows packaging completed successfully.
- Current packaged frontend bundle: main.be262dc4.js.
- Current packaged frontend stylesheet: main.39f4c1db.css.
- Editable Gemini prompt defaults included in backend/defaults.
- Help screen includes beginner-friendly Gemini setup instructions.
- Discord screenshot Copy Image layout fix included.
- Sticky bottom action bar fix included for Basics, Calls, Supervisor Transfer, and Review.
- Tutorial grouping, review example, and viewport-safe popover fix included.
- Ticker diagnostics and Google-sheet refresh fix included in packaged backend/frontend.
- Installer SHA256: 45DB1D643843A53CF3C1BD9789F09985348351F90CBE016940C0BBB4418FA9E6.
