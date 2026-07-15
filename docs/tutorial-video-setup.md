# Tutorial Video Maintenance

MTS and SAM written Help remains complete without video. Videos are optional, click-to-load supplements under Help > Tutorial Videos and matching Help articles.

## Tabs and exact headers

Create `mts-tutorial-videos` and `sam-tutorial-videos` in the configured admin content workbook. Use this exact header row on both:

```text
Category,VideoKey,Title,Description,YouTubeURL,Duration,HelpTopicKey,SortOrder,Active,Audience,Notes
```

The established master-content setup action can create a missing tab and write this header once. Help refresh and polling never create or verify tabs. If setup cannot run safely, create the tabs and headers manually.

## Row maintenance

- `Category`: one exact app value below.
- `VideoKey`: stable unique key.
- `Title`, `Description`, `Duration`, `Audience`: trainer-facing card text.
- `YouTubeURL`: an HTTPS YouTube watch, `youtu.be`, or embed URL. Never paste iframe HTML.
- `HelpTopicKey`: matching article key, such as `candidate-lookup`, `history`, or `pending-requests`.
- `SortOrder`: whole number; lower values display first.
- `Active`: only `TRUE` rows display.
- `Notes`: admin maintenance notes; never shown in normal Help.

Blank YouTubeURL displays `Video Coming Soon`. Invalid/non-YouTube URLs are skipped. Unknown categories appear under `Other Tutorials`.

## MTS categories

`Quick Start`, `Getting Started`, `Candidate Lookup`, `Approved Headsets`, `Mock Calls`, `Supervisor Transfers`, `Smart Resume`, `Technical Issues`, `Newbie Shifts`, `Rescheduling`, `Review and Form Fill`, `History`, `Discord Posts`, `Settings`, `Help and Shortcuts`, `Troubleshooting`.

## SAM categories

`Quick Start`, `Dashboard`, `Notifications`, `Live Preview`, `Candidate Search`, `Candidate Tracking`, `Pending Supervisor Transfers`, `Pending Requests`, `Headset Review`, `Reports`, `Updates`, `Settings`, `Help`, `Troubleshooting`.

## Source priority

Valid remote rows replace the packaged list. Missing, unavailable, or malformed remote content falls back to `backend/defaults/mts-tutorial-videos.csv` and `backend/defaults/sam-tutorial-videos.csv`, mirrored in `docs/admin-content-package/csv-tabs/`. Placeholder Quick Start rows ship inactive.

## Apps Script and acceptance

Repository source allowlists both tabs and reads them through `getTutorialVideos`, `getMtsTutorialVideos`, and `getSamTutorialVideos`. For Apps Script installations, update the existing deployment using `docs/apps-script-api-packaged-config.md`; keep its URL stable and private.

Add one active test row per tab, refresh Help, verify app/category placement and playback, deactivate each row, then verify it disappears. Also verify Open in Browser and packaged fallback during a safe remote failure test.
