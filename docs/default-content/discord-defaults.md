# Discord Source Map

Last updated: 2026-07-16

The normal runtime source of truth is the configured live `discord-posts` admin tab when it is reachable through the application content loader. If live content is unavailable, the packaged app falls back to synchronized repository sources.

Do not place spreadsheet IDs, Apps Script deployment URLs, credentials, tokens, or private admin links in this document.

## Local Source Priority

1. Live admin `discord-posts` tab, loaded through the existing safe application content path.
2. `docs/admin-content-package/csv-tabs/discord-posts.csv`.
3. `backend/defaults/discord-posts.csv`.
4. `backend/content/app_content.json`.
5. Built-in emergency fallback constants only if packaged content is unavailable.

## Current Local Parity

The release-blocker parity test `ReleaseCandidateWorkflowLogicTests.test_release_discord_templates_are_exact_and_synchronized` compares active Discord post rows by stable title across:

- `backend/defaults/discord-posts.csv`
- `backend/content/app_content.json`
- `docs/admin-content-package/csv-tabs/discord-posts.csv`
- `docs/admin-content-package/mock-testing-suite-admin-content.xml`

Current local parity result: PASS, 28 active titles.

During this audit, the process reported local CSV/markdown defaults rather than a configured live admin-content read. No live Discord content was overwritten. If live content differs, update the existing live row by exact Title; do not append duplicate rows.

## Active Titles

- Welcome
- Out of Time (Needs Sup)
- Sup Intro
- Sup Intro Alt
- Sup-Logout of Playground
- Sup-Launch Simple Script
- Sup-Launch DTE #1
- Sup-Launch DTE #2
- Sup-Launch DTE #3
- Sup-Launch DTE #4
- Sup Instructions #1
- Sup Instructions #2
- Sup Request Instructions
- Transfer Instructions #1
- Transfer Instructions #2
- Change DTE Status
- DTE Status
- Stars Post-Sup Transfer
- You May Transfer
- Disposition
- Passed All
- Failed 1st Sup Transfer
- Failed Both Sup Transfers
- Fail Session
- Fail Final Attempt
- VPN Fail
- Wrong Headset
- No Candidate

## Whitespace Rules

- Preserve intentional single blank lines.
- Collapse accidental repeated blank lines before display.
- Preserve Markdown bullets, emphasis, and URLs.
- Normalize CRLF/LF safely.
- Do not concatenate separate lines.
- Do not render each newline as a separate paragraph with large margins.

## Manual Live Update Instructions

If a live row does not match the packaged approved source:

1. Use an authorized admin path to open the live `discord-posts` tab.
2. Find the existing row by exact Title.
3. Replace only that row's Message cell with the matching text from `backend/defaults/discord-posts.csv`.
4. Preserve the row's intended Category and any screenshot mapping.
5. Remove or deactivate exact-title duplicates according to the approved retention practice.
6. Restart or refresh MTS, search Discord Posts by exact title, and verify normal spacing plus complete text.
