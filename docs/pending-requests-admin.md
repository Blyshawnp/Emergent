# Pending Requests administration and acceptance

This is the administrator/release checklist for the MTS/SAM Pending Requests subsystem. It intentionally omits deployment URLs, spreadsheet IDs, credentials, tokens, and private request details.

## SAM alert lifecycle

- SAM selects at most one immediate workflow alert at a time, deterministically preferring the oldest unresolved eligible workflow request.
- `View` opens the appropriate Pending Requests filter and advances to the next eligible workflow request during the current refresh cycle.
- `Remind Me in 30 Minutes` suppresses only that workflow request's immediate alert until the exact 30-minute expiry.
- `Dismiss` uses the same 30-minute immediate-alert suppression. It does not approve, deny, delete, or permanently hide a workflow request.
- Headset Review reminders are grouped, repeat after about 2 hours while SAM remains open, and are eligible once per new SAM login/session when unresolved.
- Opening Headset Review acknowledges the immediate headset reminder for that SAM session. The Headset Review badge and bell count remain until approve/deny resolves the rows.
- The bell count, category counts, Headset Review badge, and Pending Requests inbox continue to include every unresolved actionable item while immediate alerts are suppressed.
- Escape closes the immediate alert for the current refresh cycle without resolving or persistently suppressing a workflow request. No focus trap is retained.
- A normal successful refresh starts a new alert cycle. Expired workflow suppressions and eligible headset reminders become available again without requiring a restart.

Suppression state is local to the SAM installation/browser profile. Workflow suppression records contain only `request_id`, suppression type (`remind` or `dismiss`), and an epoch expiry timestamp. Headset reminder state contains only a grouped signature and next eligible timestamp. It never stores candidate names, headset brand/model, notes, denial reasons, request objects, spreadsheet identifiers, or transport details. Corrupt, invalid, expired, resolved, or missing entries are removed, and the collection is bounded.

When a workflow request refresh reports Approved or Denied, SAM removes that request's suppression state and immediate alert, decrements the workflow and bell counts from the refreshed server snapshot, and keeps the resolved record available under Approved or Denied filters. When a headset review is approved or denied, SAM clears the grouped headset reminder state and decrements the Headset Review count from the refreshed snapshot. Cleanup is safe to repeat.

## Repository and deployment status

As of 2026-07-15, repository source contains and routes `getPendingRequests`, `upsertPendingRequest`, and `decidePendingRequest`. The request tabs are allowlisted, decision commands are `approve`/`deny`, stored statuses are `approved`/`denied`, `expected_status=pending` is required, denial requires a reason, and initial/reschedule synchronization targets `Candidate Sessions` by source session ID. Candidate-deletion approval is non-destructive and reports that a separate deletion action is required.

Repository readiness does not prove that the controlled live Apps Script deployment has been updated. Follow `docs/apps-script-api-packaged-config.md` and classify the live round-trip as `REQUIRES MANUAL VERIFICATION` until the configured deployment and packaged applications complete the checklist below.

## Live MTS -> SAM -> MTS acceptance

Use safe test records in the configured environment after updating the existing Apps Script deployment.

### Initial request

1. Create an initial Newbie Shift request in MTS and confirm MTS shows Pending.
2. Confirm the SAM bell and correct category count increment and the request appears in Pending Requests.
3. Select `Remind Me in 30 Minutes`; confirm the immediate alert hides while the bell/category count and inbox row remain.
4. Approve in SAM; confirm the alert clears, the bell/category count decrements, and the row remains under Approved.
5. Refresh and restart MTS; confirm History, Home Recent Activity, and Smart Resume/shared session details show Approved.

### Denial

1. Create a Newbie Shift reschedule request.
2. Attempt Deny with no reason and confirm submission is blocked.
3. Enter a readable reason and deny; confirm SAM shows Denied and the alert/suppression state clears.
4. Refresh and restart MTS; confirm Denied and the reason appear in the existing details surfaces.

### Candidate deletion

1. Create a History & Candidate List Request and confirm SAM receives the single-session request.
2. Approve it and confirm the response reports `deletion_action_required=true`.
3. Confirm no broad automatic candidate or session deletion occurs. Perform any authorized deletion as a separate explicit admin action.

### Runtime and display checks

1. Run MTS and SAM simultaneously on their established separate ports.
2. Close each app normally in both orders; confirm only its owned processes stop and its port is released.
3. Confirm normal errors remain sanitized and contain no deployment URL, sheet ID, token, credential, or raw request object.
4. Check the alert/banner and its View, Remind Me, and Dismiss actions at restored/maximized widths and 100%, 125%, 150%, and 200% display scaling.
5. Confirm Headset Review shows one grouped reminder for multiple pending headsets, repeats after about 2 hours, and clears after approve/deny.
6. Confirm no popup loop, timer storm, duplicate listener, clipped action, covered navigation/content, or lingering focus trap.

Record the date, deployment version description, pass/fail result for each numbered item, and sanitized blocker summary. Do not record secrets or private request content.
