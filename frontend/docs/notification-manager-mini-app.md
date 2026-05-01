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
- preview ticker, banner, and popup behavior
- import an existing notifications CSV
- export a clean CSV for Google Sheets or backup
- avoid hand-editing fragile CSV rows in the sheet

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

## Google Sheets flow

1. Open the mini app.
2. Create or import notifications.
3. Click `Export CSV`.
4. In Google Sheets, create a blank sheet.
5. Import the exported CSV into the sheet.
6. In Google Sheets, use `File` -> `Share` -> `Publish to web`.
7. Publish the sheet as `CSV`.
8. Paste the sheet URL into Mock Testing Suite `Settings` -> `General` -> `Notification Sheet CSV URL`.

## Notes

- All sheet times are interpreted as `America/New_York`.
- Ticker speed is not stored in the sheet. It is controlled only by Mock Testing Suite `Ticker Speed` in Settings.
- The manager stores unsaved draft rows in browser `localStorage`.
