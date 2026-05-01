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

## Google Sheets publish flow

1. Create a Google Sheet with the required header row.
2. Add notification rows using the sample CSV in [notifications-sheet-sample.csv](./notifications-sheet-sample.csv).
3. In Google Sheets, open `File` -> `Share` -> `Publish to web`.
4. Publish the sheet as `CSV`.
5. Copy the published CSV URL, or use the normal Google Sheets link. The app can normalize a standard `.../edit?gid=0#gid=0` sheet URL into a CSV export automatically.
6. In Mock Testing Suite, open `Settings` -> `General`.
7. Paste the URL into `Notification Sheet CSV URL`.
8. Save settings.

## Behavior notes

- Sheet ticker rows override the Google Doc ticker only when active ticker rows exist.
- If the sheet has only banners or popups, the Google Doc ticker still runs underneath as the ticker fallback.
- Ticker speed is controlled only by the app user's `Ticker Speed` setting, not by the sheet.
- Non-persistent popups show once per notification `ID` after dismissal and are stored in local storage.
- Non-persistent banners can be dismissed locally by `ID`.
- Rows with invalid `Type`, missing `Message`, invalid date/time values, or reversed date windows are ignored safely.
- Older sheets that only include `StartDate` and `EndDate` still work. Missing start values are treated as active immediately.
