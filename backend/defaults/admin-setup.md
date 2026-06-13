# Mock Testing Suite Admin Setup

The files in `backend/defaults/` are the packaged master defaults used when a user has not overridden that section in SQLite.

## Priority Order
1. User-saved SQLite settings
2. Google Sheets or Google Docs remote admin overrides, if available
3. Packaged local master files in `backend/defaults/`
4. Built-in code fallback only as a final safety

## What Each File Controls
- `callers.csv`: all caller records. Use `Category` values `New`, `Existing`, or `Increase`.
- `shows.csv`: show name, donation amounts, and thank-you gift text.
- `call-types.csv`: call type dropdown options.
- `sup-reasons.csv`: supervisor reason dropdown options.
- `call-coaching.csv`: call coaching checkboxes.
- `sup-coaching.csv`: supervisor-transfer coaching checkboxes.
- `call-fail-reasons.csv`: call fail reason checkboxes.
- `sup-fail-reasons.csv`: supervisor-transfer fail reason checkboxes.
- `discord-posts.csv`: reusable Discord post templates with optional Category, Title, and Message columns.
- `screenshots.csv`: screenshot entries with optional Category plus Title and ImagePath columns.
- `headsets.csv`: approved headset brands and models.
- `help.md`: packaged help document fallback.
- `faq.md`: packaged FAQ fallback.
- `gemini-coaching-prompt.md`: Gemini coaching summary prompt instructions.
- `gemini-fail-prompt.md`: Gemini fail summary prompt instructions.

## CSV Editing Rules
- Keep the header row exactly as provided.
- Preserve the existing column order.
- In coaching CSV files, keep multiple sub-items in `ChildrenPipeDelimited` separated by `|`.
- In `callers.csv`, keep the `Category` column populated so records route to the correct caller group.

## Google Overrides
- The Google Sheet tab names must match the local file base names exactly.
- Use tabs named `callers`, `shows`, `call-types`, `sup-reasons`, `call-coaching`, `sup-coaching`, `call-fail-reasons`, `sup-fail-reasons`, `discord-posts`, `screenshots`, and `headsets`.
- Help and FAQ can be overridden by Google Docs.
- Gemini prompt instructions use the bundled markdown files as the primary source.
- Gemini prompt instructions can be overridden only by Google Sheet tabs named `gemini-coaching-prompt` and `gemini-fail-prompt`. Each tab must use A1 `prompt` and A2 containing the full prompt text. The override activates only when the normalized A2 text differs from the bundled markdown file.
- If a tab or doc is missing or unavailable, the app logs a warning and falls back to packaged local files.

## Editing Gemini Prompts
- Edit `gemini-coaching-prompt.md` to change how Gemini writes coaching summaries.
- Edit `gemini-fail-prompt.md` to change how Gemini writes fail summaries.
- For remote admin edits, use the Google Sheet prompt tabs only. Do not configure Google Docs for Gemini prompts.
- Keep instructions clear and specific.
- Do not paste private data, API keys, candidate personal notes, or secrets into prompt files.
- After editing local prompt files, rebuild the backend/package so the new defaults are included.
- If using Google overrides, restart the backend/app after editing the Google Sheet or Google Doc because defaults are loaded at startup.

## SQLite Overrides
User-saved SQLite settings always win over both packaged defaults and Google overrides. Saving in Settings does not modify these master files.
