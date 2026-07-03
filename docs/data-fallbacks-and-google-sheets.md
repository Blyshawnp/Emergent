# Data Fallbacks & Google Sheets Integration

Mock Testing Suite (MTS) and Smart Alert Manager (SAM) heavily rely on shared Google Sheets for remote content, candidate tracking, and headset review queues. This document outlines how the application falls back when Sheets are unreachable and how refresh operations behave.

## Connection Architecture

### 1. `google-service-account.json` (Primary Mode)
When `google-service-account.json` is present in the `backend/` directory (or app root), the application operates in **Authenticated Mode**.
- The backend initializes a `google.oauth2.service_account` client.
- MTS and SAM have full read/write access to the tracking sheets, review logs, and notification configurations.
- All candidate lookup, headset reviews, and SAM management tabs will load successfully provided the service account has editor access to the spreadsheets.

### 2. Public CSV Fetching (Secondary Mode)
If a sheet is published to the web (e.g., `export?format=csv`), some read-only systems like the SAM notification ticker will attempt a public HTTP GET request if authenticated mode is unavailable. This is generally discouraged for candidate tracking data due to privacy concerns.

### 3. Local Offline Fallbacks (Tertiary Mode)
When network access fails, Google API quota is exceeded, or the service account is missing, the system gracefully degrades to local/offline fallbacks.

---

## Component Fallback Behaviors

### Candidate Lookup (`/api/shared/candidates/lookup`)
- **Live Path:** The user types a candidate name. `BasicsPage.jsx` debounces the input for 650ms. It calls the backend endpoint. The backend reads the `Candidate Tracking` tab using the Sheets API, scores name matches, and returns results.
- **Error/Fallback Path:** If the Google Sheets read fails (no service account, network error, or missing tab), the backend returns `{"ok": false}`.
- **UI Behavior:** The frontend catches this and displays an amber warning message: *"Shared candidate lookup unavailable. Using local session mode."* The user can still proceed with their review, but previous history for that candidate will only include sessions conducted locally on that specific machine.

### Smart Alert Manager (SAM) Configuration
- **Live Path:** SAM loads `sam-notifications`, `sam-callers`, `sam-shows`, etc., via the `getManagedNotifications` endpoint.
- **Error/Fallback Path:** If the Sheets connection fails, SAM displays a *"Unable to read the master sam-notifications tab"* error message.
- **UI Behavior:** SAM will load local default built-in configuration if the remote connection fails completely, allowing the tester to continue working with basic alerts.

### Ticker (`/api/ticker`)
- **Live Path:** The backend calls `_fetch_notifications_from_sheet()` which queries the SAM notifications tab for active ticker messages. It caches the result.
- **Backend Fallback:** If the fetch fails, it returns a static `_notification_defaults` object and uses the `TICKER_MESSAGES` constant array, which provides 8 professional fallback messages (e.g., "Complete The Basics before beginning call review", "Review headset requirements...").
- **Frontend Fallback:** If the backend is completely unreachable (network disconnected, server crashed), `App.js` implements a last-resort `tickerContent` array with matching professional messages so the UI never appears broken.

---

## Refresh and Retry Operations

MTS and SAM implement safe retry loops and explicit refresh paths to recover from temporary network drops:

1. **SAM Refresh Button:**
   - Clicking "Refresh" in SAM calls `loadCandidateTracking()` or `loadSheetItems()`.
   - These hit the backend APIs `getSharedAdminCandidates()` or `getManagedNotifications()`.
   - **Important:** These endpoints always attempt a fresh read from Google Sheets. If successful, the new data immediately replaces any offline or fallback data in the UI. A failed refresh will simply show a transient error without breaking existing loaded state.

2. **Ticker Polling:**
   - The frontend polls `/api/ticker` every 30 seconds (`TICKER_REFRESH_INTERVAL_MS`).
   - The backend uses a brief cache (`NOTIFICATION_CACHE_TTL_SECONDS`) but will reach out to Google Sheets once expired.
   - If a previous fetch failed, a successful subsequent fetch will clear the fallback messages and show live data.

3. **Candidate Lookup Changes:**
   - Any change to the `candidate_name` input field triggers a new debounce timer and subsequent backend API call.
   - A previously failed lookup does not block future lookups.

---

## Troubleshooting

- **"Shared candidate lookup unavailable" in Development:** This is normal if you have not configured `google-service-account.json`. The app will function normally in local session mode.
- **Production Build Issues:** Packaged releases will have the credentials embedded. If errors occur in production, check `mts_stderr.log` and `sam_stderr.log` for authentication errors or quota limits.
- **VPN Issues:** The VPN check is separate from Google Sheets. If the VPN provider API fails, it marks the provider as failed and relies on consensus from other successful providers.

## What Not To Touch
- Do not modify, commit, or print `google-service-account.json`.
- Do not rewrite the Google Sheets integration logic or error handling, as the "graceful degradation" is heavily tested and required for offline usage.
