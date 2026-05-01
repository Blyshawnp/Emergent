# Admin Notification Sheet Configuration

The Notification Sheet CSV URL is no longer editable from the normal app Settings UI.

Admin configuration location:

- `C:\Emergent Back up mock\APP-main\backend\config\runtime_config.json`

Current key:

```json
{
  "notification_sheet_url": "https://docs.google.com/spreadsheets/d/1OkDE9SxnNA0WEHa-TeiZ3b2j5AZ9qiJi1Hv4Lmn8YSE/edit?gid=0#gid=0"
}
```

## How it works

- The frontend does not need the sheet URL directly.
- The app UI calls the backend `/api/notifications` endpoint.
- The backend reads `notification_sheet_url` from `backend/config/runtime_config.json`.
- If that key is blank, the backend falls back to the stored backend settings value if one exists.

## How to change it

1. Open `backend/config/runtime_config.json`
2. Replace the `notification_sheet_url` value
3. Restart the backend or restart the desktop app

## Normal user behavior

- Normal users only see `Ticker Speed` in Settings.
- They do not see or edit the notification sheet URL.
