# Mock Testing Suite Admin Content Package

This folder is a starter admin-content package for moving editable defaults out of code over time.

## What is in this folder

- `mock-testing-suite-admin-content.xml`
  - Excel-compatible Spreadsheet 2003 XML workbook
  - Contains multiple worksheets for structured content
- `csv-tabs/`
  - One CSV per worksheet/tab
  - Easier to import or paste into Google Sheets
- `help-content.rtf`
  - Word-compatible rich text document with the current Help content
- `faq-content.rtf`
  - Word-compatible rich text document with the current FAQ content
- `admin-master-guide.rtf`
  - Word-compatible guide describing what is runtime today and how to manage it safely

## Important runtime note

These files are **not wired into the app yet**.

Current runtime sources are:

- `backend/content/app_content.json`
  - Structured default content:
    - Discord posts
    - Discord screenshots
    - Call types
    - Shows
    - Callers
    - Coaching checkboxes
    - Fail reasons
    - Supervisor reasons
    - Supervisor coaching
    - Supervisor fail reasons
- `frontend/src/pages/HelpPage.jsx`
  - Current Help screen content
  - Current FAQ content
- Google Doc export URL in `backend/server.py`
  - Approved headsets list

## Why `docs/default-content/*.md` did not change the app

The files under:

- `docs/default-content/`

are reference docs only. They are not read by the frontend or backend at runtime.

## Workbook sheets

The workbook contains:

- `Discord Posts`
- `Screenshots`
- `Call Coaching`
- `Call Fails`
- `Callers New`
- `Callers Existing`
- `Callers Increase`
- `Call Types`
- `Shows`
- `Sup Reasons`
- `Sup Coaching`
- `Sup Fails`
- `Approved Headsets`

The `csv-tabs/` folder contains matching files:

- `discord-posts.csv`
- `screenshots.csv`
- `call-coaching.csv`
- `call-fails.csv`
- `callers-new.csv`
- `callers-existing.csv`
- `callers-increase.csv`
- `call-types.csv`
- `shows.csv`
- `sup-reasons.csv`
- `sup-coaching.csv`
- `sup-fails.csv`
- `approved-headsets.csv`

## Headset limitation

The approved headset list is **not stored locally in the repo**. The app fetches it live from a Google Doc and parses it at runtime.

Because of that, the `Approved Headsets` worksheet in the workbook is a structured template plus source note, not a guaranteed current snapshot from the live Google Doc.

## Recommended use

1. Open `mock-testing-suite-admin-content.xml` in Excel.
2. Review or edit each worksheet.
3. If you want a simpler import path, use the files in `csv-tabs/` instead of the XML workbook.
4. In Google Sheets, create one tab per CSV and import each file into its matching tab.
5. Use `help-content.rtf` and `faq-content.rtf` as the starting point for Google Docs versions of Help and FAQ.
6. Use `admin-master-guide.rtf` as the starting point for the admin-only Google Doc.
7. Keep `backend/content/app_content.json` as the safest current runtime-editable master until a Google-backed import path is implemented.

## Google Sheets import notes

1. Create one Google Sheet workbook.
2. Create one worksheet tab for each CSV file.
3. Import each CSV into its own tab using `File -> Import`.
4. Keep the header row exactly as provided.
5. Do not rename columns unless the future import code is updated to match.
6. For multi-line Discord post messages, keep line breaks inside the cell.
7. `ChildrenPipeDelimited` means multiple child items are stored in one cell separated by `|`.

## Google Docs notes

1. Upload `help-content.rtf` into Google Docs for the Help source.
2. Upload `faq-content.rtf` into Google Docs for the FAQ source.
3. Upload `admin-master-guide.rtf` into Google Docs for the admin guide source.
4. After you create the Google Docs and Google Sheet, send me:
   - the Google Sheet URL
   - each worksheet/tab name
   - the Google Doc URLs for Help, FAQ, and Admin Guide

## Files inspected during audit

- `backend/server.py`
- `backend/content/app_content.json`
- `backend/config/runtime_config.json`
- `frontend/src/pages/HelpPage.jsx`
- `frontend/src/pages/SettingsPage.jsx`
- `frontend/src/api.js`
- `docs/default-content/*.md`
