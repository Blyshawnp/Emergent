# Backend Performance Audit

## Scope

Reviewed Electron backend ownership/startup, frontend polling, remote-content loading, Gemini execution, SQLite lifecycle, Selenium form fill, file scanning, and logging.

## Findings

- Duplicate MTS/SAM launches: each desktop application has a single-instance lock, checks its assigned localhost port before starting a backend, and reuses a healthy process on that port. MTS and SAM intentionally use separate ports and application-data directories. No unsafe consolidation was made.
- Remote content: bundled CSV and Markdown defaults were scanned twice during startup. The background Google refresh now reuses the already-loaded local snapshot, removing the duplicate file scan.
- Polling: ticker and notification refreshes are bounded, cleared on component unmount, and perform different reads. Startup content polling has an attempt limit and clears its timer. No runaway polling loop was found.
- Google Sheets: remote content refresh runs once in the backend lifespan. Candidate, notification, and headset reads occur on startup or explicit admin refresh/action. No continuous backend Sheet refresh loop was found.
- Gemini: summary work uses a two-worker executor with request timeouts; the executor is cancelled and shut down during backend shutdown. No retry loop was found.
- SQLite: the application uses one locked connection, closes backup connections in `finally`, and closes the main connection during FastAPI shutdown. No connection leak was found.
- Selenium: failed form-fill launches call `driver.quit()`. Successful form fill intentionally leaves the populated browser open so the evaluator can review and submit it; this is expected user-owned browser state, not an automatic retry/orphan loop.
- Screenshot serving: per-request success/path logging was excessive. Normal lookups now log only at debug level; missing assets still log an error.
- Backend process cleanup: owned child process trees are terminated on normal shutdown unless the companion application is active. Stale owned packaged backends are detected before relaunch.

## Remaining Operational Risk

- A force-killed desktop process can leave a browser opened by a successful form-fill operation. The browser is intentionally detached for form review and must not be killed automatically while the user may still be submitting the form.
- MTS and SAM remain independent backend processes by design. Their memory usage should be measured separately if production telemetry shows pressure.
