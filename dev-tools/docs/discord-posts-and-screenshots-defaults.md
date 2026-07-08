# Discord Posts and Screenshot Defaults

This document explains how to update the bundled Discord Posts and suggested screenshot defaults.

## Default Files

- Default Discord posts: `backend/defaults/discord-posts.csv`
- Default screenshot rows: `backend/defaults/screenshots.csv`
- Screenshot image files: `frontend/public/`
- JSON fallback content: `backend/content/app_content.json`

## Screenshot Files

Place screenshot images in `frontend/public/`.

Use app-relative paths in defaults, for example:

```csv
/Discord-Instructions.png
/queue.png
/transfer.png
```

Keep file names stable. If a path is referenced by a Discord post, the file should exist in `frontend/public/`.

## Add a Screenshot

Add a row to `backend/defaults/screenshots.csv`:

```csv
"Category","Title","ImagePath"
"Sup Transfer","Queue","/queue.png"
```

Then place the image file at:

```text
frontend/public/queue.png
```

## Link Screenshots to a Discord Post

`backend/defaults/discord-posts.csv` supports a pipe-delimited `SuggestedScreenshots` column.

Each post can link 0 to 3 screenshots. Order is preserved in the Discord Posts preview as Screenshot 1, Screenshot 2, and Screenshot 3.

One screenshot:

```csv
Sup Transfer Process,Transfer Instructions #1,"Message text here",/click-transfer.png
```

Two screenshots:

```csv
Sup Transfer Process,Transfer Instructions #2,"Message text here","/queue.png|/transfer.png"
```

Three screenshots:

```csv
Example,Three Screenshots,"Message text here","/one.png|/two.png|/three.png"
```

No screenshot:

```csv
Failure Outcomes,Fail Session,"Message text here",
```

## Alternate Column Format

The backend also accepts separate columns:

```csv
SuggestedScreenshot1,SuggestedScreenshot2,SuggestedScreenshot3
```

Prefer `SuggestedScreenshots` for compact default rows.

## Settings

Admins can edit suggested screenshots in:

```text
Settings -> Discord -> Posts
```

Each Discord post has Screenshot 1, Screenshot 2, and Screenshot 3 selectors that use the existing screenshot list. Leave all three blank for no suggested screenshots.

## Restore Defaults

`Reset Posts to Defaults` restores default Discord posts and their default screenshot suggestions from the bundled defaults.

`Reset Screenshots to Defaults` restores default screenshot rows.

If screenshot suggestions reference a path that is not in the screenshot list, the Discord preview still uses the path directly, but admins should add a matching screenshot row for discoverability in Settings.

## Google Sheets and Fallbacks

If Google Sheets provides `discord-posts` rows with suggestion fields, those values override the bundled defaults.

If Google Sheets or older local settings have no suggestion fields, the app uses the built-in fallback mapping for known Discord post titles.

If a row includes suggestion fields but leaves them blank, that post intentionally has no suggested screenshots.
