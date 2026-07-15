# MTS Review, Form Fill, and History

## Metadata

- Title: MTS Review, Form Fill, and History: Verify Before You Finish
- VideoKey: `mts-review-form-fill-history`
- Category: Review and Form Fill
- HelpTopicKey: `review`
- Audience: MTS trainers and evaluators
- Duration: 8-10 minutes

## Objectives

- Validate final status and summaries.
- Interpret Form Fill success, failure, skip, legacy, and partial success.
- Use History actions without duplicating or deleting the wrong record.

## Prerequisites

Synthetic Pass, Fail, Incomplete, Form Filled, and legacy History records; isolated safe form demo.

## Demo data/setup

Prepare one incomplete record with failed-call detail in Coaching Summary and Fail Summary `N/A`; one failed record with a factual Fail Summary; one Form Filled - Status Warning fixture.

## Recording checklist

- [ ] No real form submission possible.
- [ ] Summary examples match final status.
- [ ] Refill warning and partial-success warning readable.

## Scene-by-scene plan

| Time | Scene | Exact narration | Exact on-screen actions | Callout text | Pause/zoom notes |
|---|---|---|---|---|---|
| 0:00-0:40 | Review purpose | “Review is the final checkpoint. Verify the result and record before you fill a form or finish the session.” | Show result banner and session details. | `Final checkpoint` | Hold banner. |
| 0:40-1:40 | Readiness | “Final Readiness Judgment shows the calculated result. Choose Yes, use calculated result unless an authorized evaluator must choose No, override result and complete the result, reason, and explanation.” | Show both modes; do not save an unauthorized override. | `Override requires authority` | Zoom on required fields. |
| 1:40-3:00 | Summaries | “Coaching Summary includes coaching and unsuccessful work when the overall outcome is Pass or Incomplete. Fail Summary contains information only when certification actually fails. Incomplete Reason explains unfinished work, and Next Actions appears only for Incomplete.” | Show prepared Pass, Incomplete, and Fail clips. Point to **Schedule Newbie Shift** only in Incomplete. | `Fail Summary: failures only` | Chapter labels between records. |
| 3:00-4:05 | Fill Form | “Select Fill Form, wait for MTS to fill the Microsoft Form, then review every populated field. Form Filled means MTS filled the form. It does not mean the trainer submitted it.” | Run isolated fill or show approved fixture; stop before Submit. | `Filled != submitted` | Freeze browser before any Submit control. |
| 4:05-5:00 | Partial success | “Form Filled - Status Warning means the form was filled but MTS could not fully save the status metadata. Do not run Form Fill again. Refresh History or contact support.” | Show exact warning fixture and close it. | `Do not refill` | Hold warning four seconds. |
| 5:00-5:45 | Finish | “Save and Finish Session stores the record. If Form Fill has not run, MTS asks whether to skip or Fill Form. Choose deliberately.” | Select Save & Finish in isolated demo; show **No** and **Fill Form** choice, cancel. | `Choose skip or fill` | Hold buttons. |
| 5:45-7:00 | History statuses | “History separates Session Status, Follow-Up, and Form Status. Form labels are Form Filled, Form Skipped, Not Yet Filled, Fill Failed, and Not Recorded. None of those labels alone proves a form was submitted.” | Open History and point to all three columns with synthetic rows. | `Three independent statuses` | Zoom on chips. |
| 7:00-8:10 | History actions | “View opens details. Open in Review is read-only. Reschedule appears only for eligible incomplete follow-up. Delete asks about local History and a candidate-list request. Local deletion does not itself delete the admin record.” | Open View; point to Open in Review, Reschedule, Delete; cancel deletion. | `Read before action` | Hold deletion choices if safe. |
| 8:10-8:45 | Refill | “A record already marked filled shows Refill Cert Form and a Form Already Filled warning. Continue only when duplicate form work is intentional and authorized.” | Select **Refill Cert Form**, show warning, cancel. | `Refill can duplicate work` | Freeze warning. |

## Mistakes to emphasize

- Editing summaries to change facts or outcome.
- Putting failed-call detail in Fail Summary for Pass/Incomplete.
- Calling Form Filled submitted.
- Refilling after partial success.
- Assuming local Delete removes shared candidate history.

## Closing summary

“Verify the result, keep summaries aligned with final status, review the filled form, and confirm all three status types in History before you move on.”

## Related Help topics

`review`, `fill-form`, `history-fill-form`, `generic-summaries`, `status-glossary`

## Thumbnail/title suggestion

Title: `MTS Review and Form Fill: Avoid Duplicate Work`
Thumbnail: Review plus `Form Filled is not submitted`.

## Editing notes

Use isolated labeled records for Pass, Incomplete, and Fail. Never make a single candidate appear to change result through editing.

## Caption review checklist

- [ ] Final Readiness labels exact.
- [ ] Incomplete Reason/Next Actions rules exact.
- [ ] All five form labels exact.
- [ ] Partial success says do not refill.
- [ ] No real submission or candidate data.
