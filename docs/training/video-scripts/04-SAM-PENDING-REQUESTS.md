# SAM Pending Requests

## Metadata

- Title: SAM Pending Requests: Alerts, Decisions, and MTS Sync
- VideoKey: `sam-pending-requests`
- Category: Pending Requests
- HelpTopicKey: `pending-requests`
- Audience: SAM administrators who review requests
- Duration: 7-9 minutes

## Objectives

- Use bell counts, filters, View, Remind Me, and Dismiss correctly.
- Approve or deny with a readable reason.
- Explain MTS synchronization and the deletion action-required limitation.

## Prerequisites

Synthetic initial, reschedule, candidate deletion, and headset review requests.

## Demo data/setup

Use one request with less-than-24-hours/Counts as Attempt Yes and another with 24 hours or more/No. Prepare Approved and Denied resolved examples.

## Recording checklist

- [ ] Bell counts and request categories synthetic.
- [ ] Denial reason safe and readable.
- [ ] Deletion approval result available without deleting history.

## Scene-by-scene plan

| Time | Scene | Exact narration | Exact on-screen actions | Callout text | Pause/zoom notes |
|---|---|---|---|---|---|
| 0:00-0:35 | Purpose | “Pending Requests is the decision inbox for Newbie Shifts, reschedules, candidate deletions, and headset-review links. Resolve the request, not just the alert.” | Show bell and Pending Requests. | `Alert != decision` | Hold bell badge. |
| 0:35-1:35 | Bell/counts | “The bell count includes every unresolved actionable request, even if an immediate alert is temporarily suppressed. Open a category to see its queue.” | Open bell; show Newbie Shift Requests, Reschedule Requests, Candidate Deletion Requests, Headset Reviews. | `All unresolved work stays counted` | Zoom popover. |
| 1:35-2:35 | Alert controls | “View opens this request and advances to the next eligible alert for the current refresh cycle. Remind Me in 30 Minutes and Dismiss both suppress only this immediate alert for 30 minutes. Neither changes the count or request status.” | On alert, select **View** in first prepared cycle; in separate reset show **Remind Me in 30 Minutes** and **Dismiss**. | `Temporary 30-minute suppression` | Use labeled separate clips. |
| 2:35-3:40 | Filters/details | “Use All Pending, Newbie Shifts, Reschedules, Candidate Deletions, Headset Reviews, Approved, and Denied. Before deciding, verify candidate, tester, requester, reason, schedules, 24-Hour Rule, Counts as Attempt, and Final Attempt.” | Click filters; open synthetic reschedule details. | `Verify every decision field` | Freeze request grid. |
| 3:40-4:35 | Approve | “Select Approve only after review. The decision records the administrator and time when identity is available, then refreshes the request and candidate views.” | Approve isolated synthetic request; show **Request approved.** and Approved filter. | `Confirm refreshed status` | Hold success state. |
| 4:35-5:30 | Deny | “Deny requires a readable reason. Enter the reason, then select Deny Request. The resolved record remains under Denied with the reason available.” | Open Deny; attempt blank; show required error; enter safe reason; submit isolated example. | `Denial reason required` | Hold blank validation and resolved state. |
| 5:30-6:20 | MTS sync | “Initial and reschedule decisions appear in MTS as Pending, Approved, or Denied after refresh. If the state looks stale, refresh SAM and MTS History or candidate lookup. Do not create a duplicate decision.” | Show paired synthetic SAM Approved and MTS History Approved clips. | `Refresh - do not duplicate` | Clearly label apps. |
| 6:20-7:15 | Deletion limitation | “Approving a candidate deletion request is non-destructive. It marks the request action required; it does not delete candidate history. An authorized administrator must separately use the explicit Candidate Tracking delete action after reviewing scope.” | Approve isolated synthetic deletion request; show action-required result; open Candidate Tracking without deleting. | `Approval does not delete history` | Freeze limitation four seconds. |

## Mistakes to emphasize

- Treating Dismiss as denial or Remind as resolution.
- Approving from the alert without reviewing details.
- Denying with a vague or blank reason.
- Duplicating a decision when MTS is stale.
- Expecting deletion approval to remove history.

## Closing summary

“Use the bell to find work, review every request field, approve or deny deliberately, confirm the refreshed state, and remember that candidate deletion approval still requires a separate authorized action.”

## Related Help topics

`pending-requests`, `candidate-tracking`, `headset-review`, `sync-offline`, `troubleshooting`

## Thumbnail/title suggestion

Title: `SAM Pending Requests: Resolve, Don’t Dismiss`
Thumbnail: Bell plus `Suppression is not resolution`.

## Editing notes

Use separate reset clips for View, Remind, and Dismiss so one request does not appear to receive all three actions. Make the deletion limitation a full-screen safety card.

## Caption review checklist

- [ ] Remind Me in 30 Minutes and Dismiss exact.
- [ ] All filter labels exact.
- [ ] Denial reason requirement clear.
- [ ] Pending/Approved/Denied sync accurate.
- [ ] Deletion action-required limitation explicit.
- [ ] No real request/candidate data.
