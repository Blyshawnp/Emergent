# Notification Manager Mini App

This repo now includes a standalone notification manager surface inside the existing frontend bundle.

## Launch

Run the normal frontend and open either of these:

- `http://localhost:3000/?notification-manager=1`
- `http://localhost:3000/#/notification-manager`

In a packaged or deployed build, append the same query or hash to the frontend URL.

## Purpose

Use the mini app to:

- create and edit notification rows safely
- load the current notification rows from the configured Google Sheet
- submit a row directly to the configured Google Sheet
- preview ticker, banner, and popup behavior
- import an existing notifications CSV
- export a clean backup CSV if needed
- avoid hand-editing fragile CSV rows in the sheet or doing manual CSV imports

## Final CSV schema

```csv
Enabled,ID,Type,Title,Message,ShowPopup,ShowBanner,Persistent,StartDate,StartTime,EndDate,EndTime,ActionText,ActionURL,CreatedAt,UpdatedAt
```

## Defaults

When creating a new notification:

- `StartDate` defaults to today in Eastern Time
- `StartTime` defaults to the current Eastern Time
- `EndDate` stays blank
- if `EndDate` is selected and `EndTime` is left blank, the exported value defaults to `12:00 AM`
- `Expires At` must be after `Starts At`

## Direct Google Sheets flow

1. Open the mini app.
2. Click `Refresh from Sheet` to load the current rows.
3. Create or edit a notification.
4. Click `Submit to Sheet`.

If the notification `ID` already exists in the configured sheet, the backend updates that row. If the `ID` is new, the backend appends a row.

## Direct-write requirements

The mini app now writes through the backend. For that to work:

1. `backend/config/runtime_config.json` must contain the target `notification_sheet_url`
2. Google Sheets API must be enabled in the Google Cloud project
3. A Google service account JSON key must exist at one of:
   - env `GOOGLE_SERVICE_ACCOUNT_FILE`
   - env `GOOGLE_APPLICATION_CREDENTIALS`
   - `backend/config/google-service-account.json`
4. The target spreadsheet must be shared with the service account `client_email`

If any of those are missing, the mini app shows a real error and does not fake success.

## Notes

- All sheet times are interpreted as `America/New_York`.
- Ticker speed is not stored in the sheet. It is controlled only by Mock Testing Suite `Ticker Speed` in Settings.
- The manager stores unsaved draft rows in browser `localStorage`.
