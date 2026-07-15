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
- `google-doc-templates.md`
  - Google Doc formatting examples for Help, FAQ, and editable Gemini prompt instructions
- `admin-master-guide.rtf`
  - Word-compatible guide describing what is runtime today and how to manage it safely

## Important runtime note

These files are now the source of truth for the Google Sheet worksheet names used by the backend content loader.

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
- `backend/defaults/gemini-coaching-prompt.md`
  - Primary bundled Gemini coaching prompt
- `backend/defaults/gemini-fail-prompt.md`
  - Primary bundled Gemini fail prompt
- `frontend/src/pages/HelpPage.jsx`
  - Current Help screen content
  - Current FAQ content
- Google Doc export URL in `backend/server.py`
  - Approved headsets list

## Why `docs/default-content/*.md` did not change the app

The files under:

- `docs/default-content/`

are reference docs only. They are not read by the frontend or backend at runtime.

## Exact Google Sheet tab names

The backend loader uses one canonical caller source. Caller records belong in a
single `callers` tab or `backend/defaults/callers.csv` file with a `Category`
column. Use `Category` values `New`, `Existing`, or `Increase`; the app splits
those rows internally into New, Existing, and Increase caller groups.

The backend loader uses these Google Sheet tab names:

- `discord-posts.csv`
- `screenshots.csv`
- `call-coaching.csv`
- `call-fails.csv`
- `callers.csv`
- `call-types.csv`
- `shows.csv`
- `sup-reasons.csv`
- `sup-coaching.csv`
- `sup-fails.csv`
- `approved-headsets.csv`

That means the worksheet/tab names must be:

- `discord-posts`
- `screenshots`
- `call-coaching`
- `call-fails`
- `callers`
- `call-types`
- `shows`
- `sup-reasons`
- `sup-coaching`
- `sup-fails`
- `approved-headsets`
- `gemini-coaching-prompt`
- `gemini-fail-prompt`

Do not replace these with display labels like `Discord Posts` or `Sup Reasons` unless the actual worksheet name matches exactly.

## Headset limitation

The approved headset list is **not stored locally in the repo**. The app fetches it live from a Google Doc and parses it at runtime.

Because of that, the `Approved Headsets` worksheet in the workbook is a structured template plus source note, not a guaranteed current snapshot from the live Google Doc.

## Recommended use

1. Open `mock-testing-suite-admin-content.xml` in Excel.
2. Review or edit each worksheet.
3. If you want a simpler import path, use the files in `csv-tabs/` instead of the XML workbook.
4. In Google Sheets, create one tab per CSV and import each file into its matching tab name exactly.

Tutorial metadata uses `mts-tutorial-videos.csv` and `sam-tutorial-videos.csv`. Keep the exact headers and Category values in `docs/tutorial-video-setup.md`. Placeholder Quick Start rows are inactive; set `Active` to `TRUE` only after adding and testing an approved YouTube URL.
5. Use `help-content.rtf` and `faq-content.rtf` as the starting point for Google Docs versions of Help and FAQ.
6. Use the Google Sheet tabs `gemini-coaching-prompt` and `gemini-fail-prompt` only if you need intentional remote Gemini prompt overrides.
7. Use `admin-master-guide.rtf` as the starting point for the admin-only Google Doc.
8. Keep `backend/content/app_content.json` as the safest current runtime-editable master until a Google-backed import path is implemented.

## Google Sheets import notes

1. Create one Google Sheet workbook.
2. Create one worksheet tab for each CSV file.
3. Import each CSV into its own tab using `File -> Import`.
4. Keep the header row exactly as provided.
5. Do not rename columns unless the future import code is updated to match.
6. For multi-line Discord post messages, keep line breaks inside the cell.
7. `ChildrenPipeDelimited` means multiple child items are stored in one cell separated by `|`.

## Runtime configuration

The backend can load this workbook from Google Sheets when `backend/config/runtime_config.json` contains either:

- `admin_content_sheet_url`
- `admin_content_sheet_id`

It also accepts the fallback names:

- `content_sheet_url`
- `content_sheet_id`

Each tab is fetched using the exact tab name with:

- `https://docs.google.com/spreadsheets/d/{GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet={URL_ENCODED_TAB_NAME}`

If a tab is missing or empty, the backend logs a warning and falls back to the local content defaults for that section.

Gemini prompt tabs are optional overrides. Local markdown files remain the primary source. To override remotely, create tabs named `gemini-coaching-prompt` and `gemini-fail-prompt`; each tab must use A1 `prompt` and A2 containing the full prompt text. The backend uses the Sheet prompt only when the normalized A2 text differs from the bundled markdown file.

## Google Docs notes

1. Upload `help-content.rtf` into Google Docs for the Help source.
2. Upload `faq-content.rtf` into Google Docs for the FAQ source.
3. Upload `admin-master-guide.rtf` into Google Docs for the admin guide source.
4. Do not create Google Docs for Gemini prompts; Gemini prompt overrides are Sheet-only.
5. After you create the Google Docs and Google Sheet, send me:
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
