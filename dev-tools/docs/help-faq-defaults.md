# Help and FAQ Defaults

This document explains where the MTS Help and FAQ fallback content lives and how live Google Doc overrides interact with it.

Trainer Help must contain user workflows, status meanings, safe troubleshooting, and support guidance only. Admin setup and developer implementation details remain in repository documentation such as `backend/defaults/admin-setup.md`, `PROJECT_CONTEXT.md`, and the data-source maintenance guides.

## Runtime source order

1. Google Doc override configured in `backend/config/runtime_config.json`.
2. Local packaged fallback markdown in `backend/defaults`.
3. Built-in backend fallback generated in `backend/server.py`.

If the Google Doc cannot be reached, returns empty content, or has no recognizable FAQ entries, the app falls back to local packaged markdown.

## FAQ fallback file

Edit:

```text
backend/defaults/faq.md
```

Use either heading format:

```markdown
## Question text

Answer text.
```

or Q/A format:

```markdown
Q: Question text
A: Answer text.
```

The backend normalizes both formats before returning FAQ content to the Help page.

## Help fallback file

Edit:

```text
backend/defaults/help.md
```

The Help page also has built-in topic cards in:

```text
frontend/src/pages/HelpPage.jsx
```

Keep frontend topic labels aligned with the markdown when renaming sections such as Tech Issues.

Do not add backend routes, API endpoints, SQLite/schema instructions, service-account setup, Apps Script deployment steps, repository paths, internal setting keys, or raw debugging instructions to either trainer-facing fallback.

## Google Doc override

Configured keys:

```text
admin_help_doc_url
admin_faq_doc_url
```

The backend exports the configured docs as markdown/text and serves them from:

```text
GET /api/help/content
```

The trainer Help UI applies a narrow compatibility filter to remote Help/FAQ text. Clearly internal sections and lines containing routes, credentials, schema instructions, repository paths, deployment instructions, or hidden setting keys are omitted. Safe trainer content still overrides packaged fallback sections normally.

Do not put credentials, private links, or service account values in fallback docs or remote trainer Help. Admin setup content must stay in the repository/admin documentation path and must not be used as the trainer Help document.
