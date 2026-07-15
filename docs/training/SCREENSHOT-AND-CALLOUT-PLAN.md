# Screenshot and Callout Plan

## Capture rules

Use synthetic data only. Capture at 1920 x 1080 with a stable app window, crop to the relevant page, and leave room for numbered callouts. Do not capture private identifiers, secrets, browser suggestions, real candidate history, private content locations, or private deployment information.

| Screenshot ID | App/page | Purpose | Callouts | Privacy precautions | Help articles | Videos | Capture status |
|---|---|---|---|---|---|---|---|
| SS-MTS-01 | MTS Home | Orient new trainer | Start New Session; Supervisor Transfer Only; Session History; Help | Empty/synthetic Recent Activity | `home-screen`, `smart-resume` | MTS Quick Start | Planned |
| SS-MTS-02 | Basics / Candidate Lookup | Show lookup and typed-name choice | Search field; Review Previous Session; Correct Candidate; Use typed name | Synthetic names/statuses; no real prior notes | `basics` | MTS Quick Start; Candidate Lookup/Basics | Priority capture |
| SS-MTS-03 | Basics / readiness | Prevent readiness mistakes | Final Attempt; Brand / Model; USB; Noise Cancelling Mic; VPN / Proxy Check; Browser Checklist | Synthetic headset/IP; crop all technical diagnostics | `basics`, `headset-lookup` | MTS Quick Start; Candidate Lookup/Basics | Priority capture |
| SS-MTS-04 | Calls | Show accurate grading | PASS/FAIL; Coaching Given; Fail Reasons; + Add detail; Other notes | Synthetic caller/donation; no private caller data | `calls`, `coaching-checkboxes`, `fail-reasons` | MTS Mock Calls | Priority capture |
| SS-MTS-05 | Supervisor Transfer | Show transfer and resume safety | Queue text; Transfer Result; Fail Reasons; Smart Resume choice | Synthetic candidate and notes; no private transfer info beyond approved UI | `supervisor-transfer`, `smart-resume`, `supervisor-only` | MTS Quick Start; Supervisor Transfers/Smart Resume | Priority capture |
| SS-MTS-06 | Schedule Newbie Shift | Show follow-up fields | Date; START TIME; AM/PM; timezone; Add to Google Calendar; Continue to Review | Synthetic date/name; calendar account hidden | `newbie-shift` | MTS Newbie Shifts/Rescheduling | Priority capture |
| SS-MTS-07 | Reschedule dialog | Explain exact request inputs | Myself/candidate; reason cards; Required for Other; Continue | Synthetic candidate; no real Discord mention or schedule | `newbie-shift`, `history-fill-form` | MTS Newbie Shifts/Rescheduling | Priority capture |
| SS-MTS-08 | Review | Prevent summary/result errors | Result banner; Final Readiness Judgment; Coaching Summary; Incomplete Reason; Fail Summary; Next Actions | Synthetic summaries; no candidate/IP details | `review` | MTS Quick Start; Review/Form Fill/History | Priority capture |
| SS-MTS-09 | Session History | Explain statuses/actions | Session Status; Follow-Up; Form Status; View; Reschedule; Delete | Synthetic rows only | `history-fill-form`, `status-glossary` | MTS Review/Form Fill/History | Priority capture |
| SS-MTS-10 | Discord Posts | Teach search/productivity | Search; Category; Favorites; Recent; Copy Post; Screenshots; Shortcuts | Approved generic templates only; no real chat/account | `discord`, `discord-productivity` | MTS Discord/Help/Shortcuts | Planned |
| SS-SAM-01 | SAM dashboard | Orient new admin | Metrics; bell; navigation tabs; Help | Synthetic counts; assigned identity hidden | `dashboard` | SAM Quick Start | Planned |
| SS-SAM-02 | Notifications editor | Show safe create/edit | Active Status; delivery types; schedule; Submit Selected Notification | Synthetic alert; action link omitted or safe | `notifications` | SAM Quick Start; Notifications/Live Preview | Planned |
| SS-SAM-03 | Live Preview | Verify display modes | Ticker Preview; Banner Preview; Popup Preview | Synthetic notification only | `live-preview` | SAM Notifications/Live Preview | Planned |
| SS-SAM-04 | Candidate Tracking | Distinguish row preview and full details | Filters; search; Show More; View Details; Update Status; More Actions | Synthetic candidates/notes; no exported report visible | `candidate-tracking`, `candidate-search` | SAM Quick Start; Candidate Tracking/Headset Review | Priority capture |
| SS-SAM-05 | Headset Review | Show evidence-based decision | Look Up; Approve; Deny; Review Later; denial reasons | Synthetic headset/ticket/tester | `headset-review` | SAM Quick Start; Candidate Tracking/Headset Review | Planned |
| SS-SAM-06 | Pending Requests + bell | Explain unresolved work | Bell badge/categories; All Pending; View; Remind Me; Dismiss | Synthetic names/schedules; assigned admin hidden | `pending-requests` | SAM Quick Start; Pending Requests | Priority capture |
| SS-SAM-07 | Approval/denial request | Prevent decision errors | Request details; 24-Hour Rule; Counts as Attempt; Approve; Deny; Reason for denial | Synthetic request; no real candidate timeline | `pending-requests` | SAM Pending Requests | Priority capture |

## Callout style

- Use 1-5 numbered callouts per image.
- Prefer short labels such as `1. Verify candidate`, `2. Read the 24-hour result`, and `3. Decision requires review`.
- Use amber for caution, red only for destructive/failure actions, green for confirmed success, and blue for navigation.
- Add alt text that describes the workflow, not visual decoration.
