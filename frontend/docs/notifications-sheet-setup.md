# Notification Sheet Setup

Use a published Google Sheet CSV as an optional notification source for Mock Testing Suite. The existing Google Doc ticker remains the fallback when the sheet URL is blank, has no active ticker rows, or fails to load.

## Required columns

Use this exact header row:

```csv
Enabled,ID,Type,Title,Message,ShowPopup,ShowBanner,Persistent,StartDate,StartTime,EndDate,EndTime,ActionText,ActionURL,CreatedAt,UpdatedAt
```

## Supported values

- `Enabled`: `TRUE` or `FALSE`
- `Type`: `ticker`, `info`, `warning`, `urgent`
- `ShowPopup`: `TRUE` to show a modal popup
- `ShowBanner`: `TRUE` to show a banner above page content
- `Persistent`: `TRUE` to keep a banner visible until the row is removed, disabled, or expires
- `StartDate`: use `YYYY-MM-DD` when possible
- `StartTime`: use `HH:MM AM/PM` or `HH:MM`
- `EndDate`: leave blank for no automatic expiration
- `EndTime`: if `EndDate` is set and `EndTime` is blank, the row expires at `12:00 AM`
- All sheet date/time values are interpreted as `America/New_York`

## Start and expiration defaults

- New notifications should default `StartDate` to today.
- New notifications should default `StartTime` to the current Eastern Time.
- Leave `EndDate` blank unless the notification should expire automatically.
- In any admin or mini-app UI, label the end datetime as `Expires At`.
- If `EndDate` is chosen and `EndTime` is left blank, default `EndTime` to `12:00 AM`.
- Validate that `Expires At` is after `Starts At` when both are present.

## Google Sheets read flow

1. Create a Google Sheet with the required header row.
2. Add notification rows using the sample CSV in [notifications-sheet-sample.csv](./notifications-sheet-sample.csv).
3. In `backend/config/runtime_config.json`, set `notification_sheet_url` to the normal Google Sheets URL for the target tab.
4. The backend converts that URL to a CSV export URL for reads.

## Behavior notes

- Sheet ticker rows override the Google Doc ticker only when active ticker rows exist.
- If the sheet has only banners or popups, the Google Doc ticker still runs underneath as the ticker fallback.
- Ticker speed is controlled only by the app user's `Ticker Speed` setting, not by the sheet.
- Non-persistent popups show once per notification `ID` after dismissal and are stored in local storage.
- Non-persistent banners can be dismissed locally by `ID`.
- Rows with invalid `Type`, missing `Message`, invalid date/time values, or reversed date windows are ignored safely.
- Older sheets that only include `StartDate` and `EndDate` still work. Missing start values are treated as active immediately.

## Google Sheets write flow

The notification mini app can now write directly to the configured sheet through the backend.

Required:

1. Google Sheets API enabled in the Google Cloud project
2. Service account JSON key available through:
   - `GOOGLE_SERVICE_ACCOUNT_FILE`, or
   - `GOOGLE_APPLICATION_CREDENTIALS`, or
   - `backend/config/google-service-account.json`
3. The sheet shared with the service account `client_email`

When the service account or sharing is missing, the backend returns a configuration error instead of pretending the write succeeded.
