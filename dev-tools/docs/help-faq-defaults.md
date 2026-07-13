# Help and FAQ Defaults

This document explains where the MTS Help and FAQ fallback content lives and how live Google Doc overrides interact with it.

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

Do not put credentials, private links, or service account values in fallback docs.
