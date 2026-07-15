# Smart Alert Manager (SAM) User Guide

## Purpose and access

SAM is the administrator control surface for Notifications, Live Preview, Headset Review, Candidate Tracking, Pending Sup Transfers, Pending Requests, reports, and updates. Use it only with your assigned identity and authorization. This guide intentionally describes operational behavior, not storage or integration internals.

## First run and Quick Start

1. Complete the SAM setup prompt with your assigned name, role, and PIN.
2. At **Setup complete**, choose **Watch the SAM Quick Start**, **Open the SAM User Guide**, or **Go to SAM Dashboard**.
3. The guided walkthrough remains available under Help as **Replay Guided Walkthrough**. Use **Quick Start Choices** to reopen the first-run choices.

Never record real PINs or identities in training video footage.

## Dashboard and navigation

The dashboard shows counts for active notifications, pending headset reviews, pending candidates, and pending requests, plus sync status. Navigation tabs are:

- **Notifications**
- **Live Preview**
- **Headset Review**
- **Candidate Tracking**
- **Pending Sup Transfers**
- **Pending Requests**

The quick-action groups provide Data, Workflow, and System actions such as Refresh, Export CSV, Add Notification, Candidate Search, Pending Requests, and Check for Updates. **Settings/Help** is available from Help.

## Notifications

### Create

1. Select **Add Notification**. New drafts default to Ticker only.
2. In **Edit Notification**, enter the title, message, type, status, delivery options, and schedule needed for the alert.
3. Use **Active Status** to enable or disable it.
4. Choose Delivery Types: **Ticker**, **Show Popup**, **Show Banner**, and **Persistent** as needed.
5. Review the Live Preview before saving.
6. Select **Submit Selected Notification**.

SAM assigns and preserves the internal notification ID automatically. Do not create or edit an ID. A duplicate receives a new generated ID.

### Edit, duplicate, deactivate, and delete

- **Edit** opens the existing notification.
- **Duplicate** creates a copy with a new generated ID and `Copy` added to the title when a title exists.
- **Disable** deactivates an enabled row without deleting it. **Enable** makes a disabled row eligible to display according to its schedule.
- **Delete** permanently removes the selected notification after confirmation.
- Use **Current**, **Disabled / Expired**, and **All Notifications** to find rows.

Prevent costly errors: preview the selected row, verify dates/time, and confirm the intended delivery types before saving. Use Disable rather than Delete when the content may be needed later.

## Live Preview

Select a notification, then open **Live Preview**. Review:

- **Ticker Preview**
- **Banner Preview** (requires Show Banner)
- **Popup Preview** (requires Show Popup)

Preview demonstrates display formatting; it does not prove that a scheduled notification is currently active. Recheck Active Status and the schedule.

## Candidate Search

Select **Candidate Search**, type a candidate name, and optionally choose **Include archived candidates**. Select **View in Tracking** to open the record in Candidate Tracking. Search is for locating a record; administration happens in Candidate Tracking.

## Candidate Tracking

Views include **Pending Sup Transfers**, **Incomplete**, **Failed, Not Final**, **Failed Final Attempts**, **Withdrawn**, **Extra Attempt Granted**, **Passed Certifications**, **Archived Candidates**, and **All Active Candidates**.

Use search, filters, and sorting to find the correct row. Confirm candidate name, date, status, tester, attempts, form state, and Newbie Shift approval state before acting.

### View Details versus Show More

- **Show More / Show Less** expands only the Results/Notes preview in the current row.
- **View Details** opens the authoritative full-record/history reading pane, including attempts and available notes.

Do not make a status decision from a truncated preview when View Details is available.

### Update Status

Depending on the row, **Update Status** can include:

- **Mark Passed**
- **Mark Failed**
- **Move to Pending Sup**
- **Mark Incomplete**
- **Extra Attempt**

Manual corrections request an optional note. Record a useful correction note whenever the reason is not self-evident.

### More Actions

Depending on the row, **More Actions** can include:

- **Cancel Transfer**
- **Archive**: keeps shared history but removes the row from active views.
- **Withdraw**: blocks the candidate from continuing.
- **Restore**: removes withdrawn status.
- **Delete**: permanently removes shared candidate history and should be rare.

**Extra Attempt** permits another attempt after admin authorization. Archive is not an extra attempt, Withdraw is not Delete, and Restore does not rewrite past outcomes.

Department confirmation required: which roles may mark final results, withdraw/restore, grant extra attempts, archive, or delete.

## Pending Sup Transfers

This view lists candidates whose mock calls are saved but Supervisor Transfer still needs completion or correction. Use **View Details** before changing status. Terminal/completed latest statuses should not remain in this view; select Refresh and investigate if one appears.

## Pending Requests and bell

The header bell count includes every unresolved actionable request, even when its immediate alert is temporarily suppressed. The bell popover separates Newbie Shift Requests, Reschedule Requests, Candidate Deletion Requests, and Headset Reviews.

The Pending Requests filters are **All Pending**, **Newbie Shifts**, **Reschedules**, **Candidate Deletions**, **Headset Reviews**, **Approved**, and **Denied**.

### Alert actions

- **View** opens the request category and advances the immediate alert to the next eligible request for the current refresh cycle.
- **Remind Me in 30 Minutes** suppresses only that immediate alert for 30 minutes.
- **Dismiss** also suppresses only that immediate alert for 30 minutes.
- Escape closes the immediate alert for the current cycle.

None of these actions approves, denies, removes, or decrements the unresolved request.

### Approve or deny

1. Open the request and verify candidate, tester, requester, reason, original/requested schedule, 24-hour result, attempt impact, and final-attempt flag.
2. Select **Approve** only after review.
3. Select **Deny**, enter a readable **Reason for denial**, and select **Deny Request**.
4. Refresh results if needed. Resolved rows remain under Approved or Denied.

Initial and reschedule decisions synchronize back to MTS as **Pending**, **Approved**, or **Denied**. Do not create a second request to force synchronization.

### Candidate deletion limitation

Approving a candidate deletion request is non-destructive and marks the request for action. It does not delete candidate history. If deletion is authorized, an administrator must separately use the explicit Candidate Tracking delete action after reviewing the request scope. Denial leaves history intact.

## Headset Review

Use **Pending Review**, **Approved Headsets**, and **Denied Headsets**.

1. Open a pending ticket and select **Look Up** or **Research Headset**.
2. Confirm both USB connection and noise-cancelling microphone support.
3. Choose **Approve**, **Deny**, or **Review Later**.
4. A denial requires a listed reason; **Other** requires a denial note.
5. **Archive** keeps the completed review record. **Delete** is only for mistakes.

Research results are supporting evidence, not an automatic decision. MTS behavior changes only after the approved/denied decision is saved and refreshed.

## Reports and operational handoff

In Candidate Tracking, select rows before using:

- **Copy Selected** for a clipboard handoff.
- **Print Report** for selected rows.
- **Export CSV** for visible or selected rows.

Review the selection before copying, printing, exporting, or sharing. Use only approved channels and retention practices. Department confirmation required: retention period and approved destinations for exported reports.

## Updates

Select **Check for Updates** from System or Help. If the current version is up to date, SAM confirms it. Required updates must be installed before normal use continues. Optional updates may be closed and revisited. Review version and release notes before choosing the displayed update/download action.

## Help and local settings

Help contains searchable SAM topics, Tutorial Videos, **Quick Start Choices**, **Replay Guided Walkthrough**, local sound/banner/search preferences, and **Check for Updates**. Written Help remains available if no video is active.

## Troubleshooting

- Stale counts or rows: wait briefly and select **Refresh**.
- Shared data temporarily unavailable: keep the current view, wait about 60 seconds, and retry once.
- Pending alert disappeared: check the bell/inbox; Remind Me and Dismiss hide only the immediate alert for 30 minutes.
- Approval does not appear in MTS: refresh SAM, then refresh MTS History/Home or candidate lookup. Do not issue a duplicate decision.
- Candidate appears in the wrong view: open View Details, verify the latest status, then use the authorized Update Status action.
- Notification not visible: verify Enable/Disable, schedule, delivery type, and Live Preview.
- Headset decision uncertain: choose Review Later and obtain department confirmation.
- Continuing app problem: use Request App Support with screen, action, time, and visible error text.

## Glossary

| Term | Meaning |
|---|---|
| Current | Notification is enabled and inside its active schedule. |
| Disabled / Expired | Notification is disabled or outside its active window. |
| Pending Sup Transfer | Mock calls are saved; transfer work still needs completion/correction. |
| Incomplete | Certification is not complete and needs follow-up. |
| Failed, Not Final | Failed attempt without final-attempt closure. |
| Failed Final Attempts | Failed record marked as the final attempt. |
| Extra Attempt Granted | Admin authorization allows another attempt. |
| Withdrawn | Candidate is blocked until restored or otherwise authorized. |
| Archived | Shared history retained but hidden from active views. |
| Pending / Approved / Denied | Request decision state. |
| Form Filled | MTS filled the Microsoft Form; not proof of submission. |
| Form Skipped | Session finished without Form Fill. |
| Not Yet Filled | Form Fill has not completed. |
| Fill Failed | Form automation did not complete. |
| Not Recorded | Legacy record lacks a form state. |
| Remind Me / Dismiss | Temporary 30-minute immediate-alert suppression, not a decision. |
