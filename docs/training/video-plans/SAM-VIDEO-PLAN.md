# SAM Tutorial Video Plan

## Metadata

- Title: SAM Administrator Tutorial Series
- VideoKey: `sam-production-plan` (planning-only; do not publish as a tutorial row)
- Category: Dashboard
- HelpTopicKey: `dashboard`
- Audience: New and cross-trained SAM administrators
- Duration: Four videos; approximately 26-34 minutes total

## Objectives

- Prepare administrators to find unresolved work and take the correct action.
- Prevent destructive candidate, notification, request, and headset mistakes.
- Explain alert suppression, request decisions, and MTS synchronization accurately.

## Prerequisites

- Current SAM release-candidate build and Help content.
- Synthetic notifications, candidates, requests, and headset tickets.
- Assigned training identity with no production access.

## Demo data/setup

- Create one inactive synthetic notification with Ticker, Banner, and Popup examples.
- Seed candidates in pending, incomplete, withdrawn, archived, extra-attempt, and passed views.
- Seed initial Newbie Shift, reschedule, candidate deletion, and headset review requests.
- Use synthetic denial reasons and no real report exports.

## Recording checklist

- [ ] Confirm navigation and action labels.
- [ ] Confirm generated ID is not editable.
- [ ] Confirm bell counts include suppressed unresolved requests.
- [ ] Confirm denial requires a reason.
- [ ] Confirm deletion approval is action-required and non-destructive.
- [ ] Hide setup identity and all production data.

## Scene-by-scene plan

| VideoKey | Opening | Main demonstration | Safety pause | Closing |
|---|---|---|---|---|
| `sam-quick-start` | Dashboard purpose | Navigation, Notifications, Candidate Tracking, bell/Pending Requests, Headset Review, Help | View Details before action | Daily queue order |
| `sam-notifications-live-preview` | Communicate safely | Create/generated ID, edit, duplicate, disable, delete, preview modes | Disable versus Delete | Preview then save |
| `sam-candidate-tracking-headset-review` | Manage the correct record | Search, filters, Show More/View Details, status actions, archive/withdraw/restore/extra attempt, headset decision | Destructive actions and evidence | Record decision |
| `sam-pending-requests` | Resolve requests, not alerts | Bell/counts, View, Remind, Dismiss, approval/denial/reason, MTS sync, deletion limitation | Suppression is not resolution | Verify resolved state |

## Exact narration

Series intro: “SAM is where administrators see what needs attention and record deliberate decisions. The safest pattern is simple: open the correct queue, review the full record, choose the authorized action, and confirm the refreshed result.”

Series safety card: “A count or alert is not a decision. Remind Me and Dismiss do not resolve requests, and approving a candidate deletion request does not delete candidate history.”

Series outro: “When evidence or authority is unclear, leave the item pending, use Review Later where available, and follow the department escalation process.”

## Exact on-screen actions

1. Show the SAM title slate and synthetic-data notice.
2. Tour dashboard metrics and navigation tabs.
3. Open Help, show the four matching tutorial categories, and close Help.
4. End on Pending Requests with no decision submitted.

## Callout text

- `Review the full record`
- `Suppression is not resolution`
- `Generated ID - do not edit`
- `Approve only with evidence`
- `Deletion approval requires separate action`

## Pause/zoom notes

- Pause on the bell summary, View Details, candidate destructive confirmations, headset denial reasons, and deletion action-required result.
- Keep counts and candidate names synthetic and readable.

## Mistakes to emphasize

- Acting on Show More instead of View Details.
- Confusing Archive, Withdraw, Restore, Extra Attempt, and Delete.
- Deleting a notification when Disable is sufficient.
- Treating Dismiss as denial or approval.
- Expecting candidate deletion approval to remove history.

## Closing summary

The four modules cover the requested administrator launch scope without adding another video.

## Related Help topics

`dashboard`, `notifications`, `live-preview`, `candidate-search`, `candidate-tracking`, `pending-sup-transfers`, `pending-requests`, `headset-review`, `reports`, `check-for-updates`, `troubleshooting`

## Thumbnail/title suggestion

- Series title: `SAM Administrator Essentials`
- Thumbnail: SAM dashboard with `Review`, `Decide`, `Confirm`

## Editing notes

- Use the same synthetic admin and status color language throughout.
- Freeze destructive confirmations long enough to read.
- Never show production exports or setup PIN entry.

## Caption review checklist

- [ ] Navigation labels are exact.
- [ ] View Details and Show More are distinct.
- [ ] Remind Me in 30 Minutes and Dismiss are described as temporary suppression.
- [ ] Approve/Deny and required denial reason are exact.
- [ ] Candidate deletion limitation is explicit.
- [ ] No private data or internal implementation language appears.
