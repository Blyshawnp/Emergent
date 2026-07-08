# Smart Alert Manager Tutorial Script

Audience: SAM administrators managing notifications, headset reviews, and candidate tracking.

Estimated runtime: 10-12 minutes.

## Scene 1 - Dashboard

Narration: "SAM opens on the dashboard with active notifications, pending headset reviews, pending supervisor transfers, and last sync."

Screen actions: Point out metric cards, quick actions, status chips, and System Health.

Callouts: Dashboard counts tell you where to work first.

Troubleshooting notes: If live data is temporarily unavailable, wait about 60 seconds and use Refresh.

## Scene 2 - Notifications

Narration: "Notifications manages ticker, banner, and popup rows from the shared notification sheet."

Screen actions: Select Current, Disabled / Expired, and All Notifications. Add, edit, enable, disable, duplicate, delete, and refresh a sample row.

Callouts: Save updates the shared sheet; MTS should pick up changes after refresh or the normal polling interval.

Troubleshooting notes: Export CSV before bulk edits. Raw Google errors should not be shown in the UI.

## Scene 3 - Live Preview

Narration: "Live Preview shows how a selected notification will appear before testers see it."

Screen actions: Select a notification, switch to Live Preview, review ticker, banner, and popup sections.

Callouts: Preview is visual only until changes are saved.

Troubleshooting notes: If the preview is blank, select a notification with message text and verify Show Banner or Show Popup settings.

## Scene 4 - Headset Review

Narration: "Headset Review keeps unknown headset submissions organized for administrator decisions."

Screen actions: Open Headset Review, filter pending/approved/denied, approve a confirmed model, deny a model, archive a completed row, and refresh.

Callouts: Approving syncs with MTS approval behavior. Denying prevents future use without replacement.

Troubleshooting notes: Confirm USB and noise-cancelling microphone support before approving. Use archive for cleanup and delete only for mistakes.

## Scene 5 - Candidate Tracking

Narration: "Candidate Tracking is the shared reading pane for pending transfers, incomplete candidates, failed attempts, withdrawn candidates, passed certifications, archived rows, and all active candidates."

Screen actions: Switch views, search candidate name, sort by Candidate, Status, Attempts, Tester, Date, and Results, select rows, open View Details, review grouped details, copy selected, print report, and export CSV.

Callouts: The reading pane shows details without leaving the table. Candidate names and dates should be readable. Header sorting and the Sort by menu make dense queues easier to scan.

Troubleshooting notes: If the table is crowded, use search and View Details instead of horizontal scrolling.

## Scene 6 - Pending Sup Transfers

Narration: "Pending Sup Transfers shows candidates who still need supervisor-transfer completion or correction."

Screen actions: Open Pending Sup Transfers, view details, cancel a pending transfer, or mark it incomplete after confirmation.

Callouts: Changes affect MTS resume and lookup behavior.

Troubleshooting notes: Confirm the candidate before changing shared status.

## Scene 7 - Candidate Admin Actions

Narration: "Archive, Withdraw, Delete, and Extra Attempt are administrator actions with shared workflow impact."

Screen actions: Demonstrate confirmation dialogs for Archive, Withdraw, Restore, Extra Attempt, and Delete without submitting real changes.

Callouts: Extra Attempt lets MTS continue a candidate after approval. Delete removes shared candidate history and should be rare.

Troubleshooting notes: Use Archive for normal cleanup. Use Withdraw only when certification status requires blocking further attempts.

## Scene 8 - Printing and Exporting

Narration: "Print and export support offline review and admin handoff."

Screen actions: Select candidates, use Copy Selected, Print Report, and Export CSV.

Callouts: Export visible rows for broad review, or selected rows for a focused handoff.

Troubleshooting notes: If nothing prints, select at least one candidate first.

## Scene 9 - Diagnostics and Offline Handling

Narration: "System Health and status banners explain sync state without interrupting normal work."

Screen actions: Expand System Health, review app version, sync state, source, help links, diagnostics, and retry options.

Callouts: Routine headset updates use a small status message instead of a modal interruption. Confirmation modals, close buttons, and action buttons should look centered and intentional.

Troubleshooting notes: Shared data temporary failures should show a simple retry message. Offline behavior should explain what can still be reviewed. Technical details belong in logs and diagnostics.

## Scene 10 - Help and Exit

Narration: "Help documents each major SAM workflow, and Exit confirms before closing the app."

Screen actions: Open Help, review sections, replay tutorial, then click Exit and cancel the confirmation.

Callouts: Exit is destructive because it closes SAM, so the confirmation uses clear red action styling with white text.

Troubleshooting notes: If Help is stale, refresh SAM after installing an update.

## Ending Checklist

- Dashboard counts were reviewed.
- Notifications were previewed before saving.
- Headset review decisions were confirmed before approval or denial.
- Candidate tracking actions were verified in the reading pane.
- Candidate Tracking sorting, Copy Selected, and Print Report were demonstrated.
- Copy, print, and export workflows were demonstrated.
- Diagnostics and offline handling were explained.
- Exit confirmation was shown and cancelled.
