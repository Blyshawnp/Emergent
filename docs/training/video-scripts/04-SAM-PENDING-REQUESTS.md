# SAM Pending Requests

## Metadata

- Title: SAM Pending Requests: Alerts, Decisions, and MTS Sync
- VideoKey: `sam-pending-requests`
- Category: Pending Requests
- HelpTopicKey: `pending-requests`
- Audience: SAM administrators who review requests
- Duration: 7-9 minutes

## Objectives

- Use bell counts, separated workflow/headset counts, filters, View, Remind Me, and Dismiss correctly.
- Review previous and requested values, then approve or deny with a readable reason.
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
| 0:00-0:35 | Purpose | “Pending Requests is the decision inbox for Newbie Shifts, reschedules, and candidate deletions. Headset Review is separate, but the bell can summarize both kinds of work. Resolve the request, not just the alert.” | Show bell, Pending Requests, and Headset Review badge. | `Alert != decision` | Hold bell badge. |
| 0:35-1:35 | Bell/counts | “The bell count includes every unresolved actionable item, even if an immediate alert is temporarily suppressed. The summary separates Workflow Requests from Headset Reviews.” | Open bell; show Workflow Requests and Headset Reviews counts. | `Counts stay separated` | Zoom popover. |
| 1:35-2:35 | Alert controls | “View opens this workflow request and advances to the next eligible alert for the current refresh cycle. Remind Me in 30 Minutes and Dismiss both suppress only this immediate workflow alert for 30 minutes. Headset Review reminders are grouped and repeat later, not every 30 minutes.” | On alert, select **View** in first prepared cycle; in separate reset show **Remind Me in 30 Minutes** and **Dismiss**; show grouped headset reminder. | `Workflow: 30 min / Headsets: grouped` | Use labeled separate clips. |
| 2:35-3:40 | Filters/details | “Use All Pending, Newbie Shifts, Reschedules, Candidate Corrections, Candidate Deletions, Approved, and Denied for workflow requests. Use Headset Review for headset tickets. For a correction, compare every Previous Value with its Requested Value and read the Correction Reason. For scheduling, verify requester, original and requested schedules, the 24-Hour Rule, Counts as Attempt, and Final Attempt.” | Click filters; open synthetic candidate correction and reschedule details; point to **Previous Value**, **Requested Value**, and **Correction Reason**; open Headset Review separately. | `Compare before deciding` | Freeze both request types. |
| 3:40-4:35 | Approve | “Select Approve only after review. Newbie Shift approvals include an optional Newbie Shift Number. Leave it blank or enter the assigned text, including leading zeros. On reschedule, the current number is prefilled and can be retained, changed, or cleared. When present, it follows the exact request into Candidate Tracking, Recent Activity, and MTS History.” | Approve one blank synthetic request and one numbered request; show **Request approved.** and Approved filter. | `Shift number is optional` | Hold success state. |
| 4:35-5:30 | Deny | “Deny requires a readable reason. Enter the reason, then select Deny Request. The resolved record remains under Denied with the reason available.” | Open Deny; attempt blank; show required error; enter safe reason; submit isolated example. | `Denial reason required` | Hold blank validation and resolved state. |
| 5:30-6:20 | MTS sync | “Initial and reschedule decisions appear in MTS as Pending, Approved, or Denied after refresh. If the state looks stale, refresh SAM and MTS History or candidate lookup. Do not create a duplicate decision.” | Show paired synthetic SAM Approved and MTS History Approved clips. | `Refresh - do not duplicate` | Clearly label apps. |
| 6:20-6:55 | Candidate correction result | “An approved candidate correction updates the exact linked session. A denied correction leaves the original candidate or headset value authoritative. Immediate feedback confirms the action; if the display is stale, refresh instead of submitting the request again.” | Approve one isolated synthetic correction and show the exact History session updated. Deny a separate correction and show the original value retained. | `Exact session; one decision` | Clearly label separate examples. |
| 6:55-7:50 | Deletion limitation | “Approving a candidate deletion request is non-destructive. It marks the request action required; it does not delete candidate history. An authorized administrator must separately use the explicit Candidate Tracking delete action after reviewing scope.” | Approve isolated synthetic deletion request; show action-required result; open Candidate Tracking without deleting. | `Approval does not delete history` | Freeze limitation four seconds. |

## Mistakes to emphasize

- Treating Dismiss as denial or Remind as resolution.
- Counting headset reviews as workflow requests.
- Approving from the alert without reviewing details.
- Treating Pending Requests as a generic row editor instead of a review-and-decision queue.
- Approving a correction without comparing Previous Value, Requested Value, and Correction Reason.
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
- [ ] Workflow and Headset Review count labels exact.
- [ ] Denial reason requirement clear.
- [ ] Pending/Approved/Denied sync accurate.
- [ ] Candidate Corrections filter and Previous Value / Requested Value labels exact.
- [ ] Approved correction updates only the exact linked session; denial preserves the original.
- [ ] Deletion action-required limitation explicit.
- [ ] No real request/candidate data.
