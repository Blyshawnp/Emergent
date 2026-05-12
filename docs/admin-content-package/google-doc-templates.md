# Google Doc admin templates — FAQ and Help

The Mock Testing Suite reads Help, FAQ, and optional Gemini prompt Google Docs as live admin overrides:

- **FAQ doc** — URL key `admin_faq_doc_url` in `backend/config/runtime_config.json`
- **Help doc** — URL key `admin_help_doc_url`
- **Gemini coaching prompt doc** — URL key `admin_gemini_coaching_prompt_doc_url`
- **Gemini fail prompt doc** — URL key `admin_gemini_fail_prompt_doc_url`

The backend fetches each via `https://docs.google.com/document/d/<id>/export?format=md`, with a `format=txt` fallback. **Both formats are accepted** for the FAQ — you can author either way and the backend converts it to canonical markdown before serving.

If a remote doc fetch succeeds but produces zero recognizable FAQ entries, the backend logs a warning and falls back to the local `backend/defaults/faq.md`. The same applies to Help. So a malformed remote will never break the app — it will quietly fall back.

---

## FAQ doc — recommended format

You can use either of these two styles. Mix is fine. Pick whichever is easier to maintain in Google Docs.

### Option A — `Q:` / `A:` paragraphs (easiest in Google Docs)

Type questions and answers as plain paragraphs. Each question line must start with `Q:` (case-insensitive). Each answer must start with `A:`. **Bold** is OK and will be stripped automatically.

```
Mock Testing Suite FAQ Content

Q: What if the candidate stops responding?
A: Click the red "Stopped Responding" button. This instantly ends the session as a fail.

Q: What if the candidate has technical issues?
A: Click "Tech Issue". The app walks you through troubleshooting: check DTE status, clear browsing data, re-login.

Q: Can I go back and change something?
A: Yes — click "Back" on any screen. Your data is saved as you go.

Q: Where is my data stored?
A: In the local app database.
```

### Option B — Markdown headings (only if you author the doc as raw markdown)

```
# Mock Testing Suite FAQ

## What if the candidate stops responding?
Click the red "Stopped Responding" button. This instantly ends the session as a fail.

## What if the candidate has technical issues?
Click "Tech Issue". The app walks you through troubleshooting: check DTE status, clear browsing data, re-login.

## Where is my data stored?
In the local app database.
```

Either format produces the same FAQ list in the app.

### Rules

1. **One question per `Q:` line.** Don't combine multiple questions into one line.
2. **The `A:` line follows the `Q:` line directly** (blank lines between are fine). Only the first non-blank paragraph after a `Q:` is treated as the answer; subsequent paragraphs become additional answer body text until the next `Q:`.
3. **Don't use list bullets for the questions themselves** (`- Q: ...`). Use plain paragraphs.
4. **The doc must produce at least one valid Q/A entry.** If it produces zero, the app falls back to the local `backend/defaults/faq.md`.
5. **Avoid tables for FAQ content.** Tables don't reliably round-trip through the markdown export.

---

## Help doc — recommended format

The Help page is grouped into sections by `## Heading` lines, with optional `### Subheading` lines inside. Use markdown-style structure when possible (Google Docs heading styles map to `#` / `##` / `###` in the markdown export).

```
# Mock Testing Suite Help Center

The Help Center summarises the live workflows, integrations, and review steps in one place.

## Session Flow
Use this section to describe how a tester moves through Home → Basics → Calls → Sup Transfers → Review.
- Start New Session begins the standard flow.
- Supervisor Transfer Only skips Mock Calls.

### Final Attempt
Toggle on the Basics screen when the candidate is on their last allowed attempt.

## Settings
Describe what each Settings tab does.
- Call Types tab — edit the call type list.
- Shows tab — edit show data.
- Discord tab — edit Discord templates and screenshots.

## Integrations
- **Gemini AI** — generates clean coaching and fail summaries from the checkbox selections.
- **Google Calendar** — the "Add to Google Calendar" button creates a calendar event.

## Support
For help, email blyshawnp@gmail.com or message shawnbly on Discord.
```

### Rules

1. **`#` is the page title** — there should only be one.
2. **`## Section` becomes a tab/section heading** in the Help page sidebar.
3. **`### Subsection`** becomes an inline subheading under a section.
4. **Use bullet lists** (`-` or `*`) for lists. Numbered (`1.`) lists are also supported.
5. **Inline formatting supported:** `**bold**`, `` `code` ``, `[link text](url)`.
6. **Tables and images** in the Google Doc do not export cleanly via the markdown route. Use bullet lists and inline formatting instead.

---

## Gemini prompt docs — recommended format

Use one Google Doc for the coaching prompt and one Google Doc for the fail prompt. Keep them plain and direct.

### Coaching prompt example

```
You are writing an internal certification test call results summary for management.

Rules:
- Be objective, professional, and suitable for internal documentation.
- Include the selected coaching items directly.
- Do not address the candidate.
- Do not invent coaching items that were not selected.
```

### Fail prompt example

```
You are writing an internal certification test call failure summary for management.

Rules:
- Be objective, professional, and suitable for internal documentation.
- Include the selected fail reasons directly.
- Do not address the candidate.
- Do not invent fail reasons that were not selected.
```

### Prompt rules

1. Do not put a Gemini API key in the prompt doc.
2. Do not include private candidate data in the prompt doc.
3. The backend still appends the actual session notes at runtime.
4. Restart the backend/app after editing the Google Doc so the new prompt is loaded.

---

## How the override priority works

For each section, the backend serves content from the highest-priority source that supplied valid data:

1. **SQLite saved settings** — anything the user has explicitly saved in Settings (settings-backed sections only: callers, shows, coaching, fails, discord templates/screenshots, etc.).
2. **Google Sheet / Google Doc remote override** — the Google Sheet tabs listed in `backend/defaults/admin-setup.md` plus the FAQ and Help Google Docs.
3. **Local packaged master defaults** — the files in `backend/defaults/`.
4. **Built-in code fallback** — hardcoded constants in `backend/server.py`.

For non-settings sections (FAQ, Help, headsets, admin setup), there is no SQLite layer — priority starts at remote.

The runtime source for every section is reported by `GET /api/config-status` under the `sections` key. Run that endpoint to verify which source is actually serving each piece of content.

---

## Verifying your edits took effect

After editing a Google Doc:

1. Restart the backend (the doc is fetched once at startup).
2. Open `http://127.0.0.1:8000/api/config-status` in a browser.
3. Look for `sections.faq_markdown.defaultsSource` (and the equivalent for `help_markdown`):
   - `google` = your doc was used.
   - `local` = your doc had no recognizable structure (FAQ specifically) or could not be fetched, so `backend/defaults/faq.md` was used instead.
   - `builtin` = both remote and local failed; the in-code fallback was used.
4. Check the backend log for lines beginning `[CONTENT]`:
   - `[CONTENT] Loaded N FAQ entries from Google Doc` — success.
   - `[CONTENT] Google Doc faq_markdown had no recognizable Q&A entries; using local defaults` — your doc parsed but produced zero entries; check that your `Q:` / `A:` lines are paragraphs, not bullets.
   - `[CONTENT] Failed to load Google Doc override for faq_markdown` — the doc URL is wrong or the doc is not publicly readable.
