# Certification Department Master Guide

## Document purpose

This guide joins the verified certification workflow, trainer-facing MTS instructions, and administrator-facing SAM instructions. It is not a new policy manual. Where repository behavior does not prove department policy, the guide says **Department confirmation required.**

Canonical certification email: `certification@acdsupport.com`

## 1. Department purpose and roles

The certification department uses mock calls, readiness checks, Supervisor Transfers, follow-up work, and recorded decisions to determine whether a candidate is ready to proceed. MTS is the trainer workflow; SAM is the administrator workflow.

### Trainer/tester

- Verify candidate identity and readiness.
- Run and score mock calls and Supervisor Transfers.
- Record coaching and failure reasons accurately.
- Use technical-issue and follow-up paths rather than forcing an outcome.
- Review summaries and Form Fill results before finishing.
- Escalate blocks, policy exceptions, and app failures.

### Evaluator

- Review the calculated result.
- Apply **Final Readiness Judgment** overrides only with authority and a clear reason/explanation.
- Ensure Fail Summary is populated only for an actual certification failure.

### SAM administrator

- Maintain operational notifications.
- Review Candidate Tracking and Pending Sup Transfers.
- Approve or deny Newbie Shift/reschedule requests.
- Review headsets and action candidate deletion requests.
- Use archival, withdrawal, restoration, extra-attempt, and deletion actions carefully.

### Department leadership / quality control

- Own policy, authorization levels, exception handling, retention, and audit review.
- Approve training content and release-readiness evidence.

Department confirmation required: named role definitions, separation of duties, who may override results, grant extra attempts, approve/deny requests, delete records, and approve headset decisions.

## 2. Candidate lifecycle

1. Candidate appears for a session or is recorded NC/NS/Same Day Drop.
2. Trainer completes Candidate Lookup and readiness in Basics.
3. Trainer runs mock calls and records Pass/Fail, coaching, and fail reasons.
4. Qualifying calls route to Supervisor Transfer.
5. The session ends as Pass, Fail, final-attempt Fail, Incomplete, NC/NS, or an authorized override result.
6. Incomplete sessions may require Newbie Shift or pending Supervisor Transfer follow-up.
7. Trainer reviews summaries and uses Form Fill.
8. MTS saves local History and updates shared candidate tracking where available.
9. SAM administrators review pending requests, candidate status, headsets, and authorized administrative actions.
10. Closed records may later be archived under the current retention behavior.

## 3. Policy and process rules

### Eligibility, attempts, and final attempts

Verified application behavior:

- Passed candidates are blocked from another attempt unless archived or granted an extra attempt.
- Candidates who failed a final attempt are blocked unless an authorized override or extra attempt exists.
- Withdrawn candidates are blocked until restored or granted an extra attempt.
- Candidate Lookup can identify a final attempt from prior qualifying history and set **Final Attempt**.
- MTS supports an override path that records the override and tells the trainer to notify Admin.

Department confirmation required: the maximum number of attempts, what constitutes a qualifying attempt outside the explicit reschedule rule, who authorizes an override, and evidence needed for an extra attempt.

### Incomplete sessions

Incomplete is not a certification failure. It means required work remains. MTS displays **Incomplete Reason** and **Next Actions** only when appropriate. Failed-call or failed-transfer detail remains in Coaching Summary/history; Fail Summary is `N/A` unless the final certification status is actually a failure or a verified technical/final-readiness failure requires failure text.

### Calls and grading

- Each mock call is marked **PASS** or **FAIL**.
- Failed calls require at least one Fail Reason; **Other** requires notes.
- Coaching records what the trainer actually coached.
- Two qualifying passes route to Supervisor Transfer; two failures route to Review. MTS may require a third call for the required mix.
- Final readiness can use the calculated result or an authorized evaluator override.

Department confirmation required: grading rubric ownership, qualifying call mix policy, required coaching standards, and approval threshold for overrides.

### NC/NS and Same Day Drop

- **NC/NS**: candidate did not join.
- **Same Day Drop**: candidate dropped within 24 hours.
- Both use the NC/NS Microsoft Form checkbox behavior, while preserving different summary text.
- Supervisor Transfer Only has its own confirmed NC/NS action for a missed transfer appointment.

Department confirmation required: any attendance documentation or escalation requirement beyond the application workflow.

### Technical issues

- **Tech Issue** is for technology interruptions; it does not automatically fail a candidate.
- Resolved issues remain in history and do not populate Fail Summary.
- Unresolved issues can route to Review or Newbie Shift while preserving the session context.
- **Stopped Responding** is a candidate-response outcome, not a technical issue.

Department confirmation required: technical thresholds, exception authority, and whether evidence beyond MTS notes is required.

### Supervisor Transfers, Smart Resume, and Supervisor Transfer Only

- Normal flow begins after qualifying calls.
- Transfer 1 pass completes the requirement; Transfer 1 fail routes to Transfer 2.
- Both transfer failures on a non-final attempt route to Incomplete/Newbie Shift; a final attempt routes to final failure.
- Smart Resume is preferred when prior call data exists.
- **Supervisor Transfer Only** is an override/fresh path when only transfer work remains.
- A resumed transfer appointment may be marked NC/NS after confirmation.

### Newbie Shift, rescheduling, and the 24-hour rule

- Initial follow-up captures date, time, AM/PM, timezone, Calendar handoff, and an out-of-time Discord post.
- Reschedule collects requester, structured reason, optional/required details, new schedule, and temporary Discord post.
- Candidate request received less than 24 hours before the original shift counts as an attempt and maps to NC/NS form behavior.
- Candidate request received exactly 24 hours or more before the original shift does not count as an attempt.
- Tester-requested change does not penalize the candidate.
- Final-attempt candidate requests inside the less-than-24-hour window direct the candidate to `certification@acdsupport.com`; approval is not guaranteed.
- Requests display Pending until Approved or Denied.

Department confirmation required: review-time expectation, exception/appeal process, and any documentation required for the listed reschedule reasons.

### Approval and denial

SAM approval records the decision and refreshes MTS-visible request state. Denial requires a readable reason. **Remind Me in 30 Minutes** and **Dismiss** are temporary alert controls, not decisions.

Department confirmation required: approval authority, denial review/appeal process, and audit cadence.

### Deletion requests

MTS can request candidate-list deletion while deleting local History. SAM approval is non-destructive and returns an action-required result. Authorized candidate-history deletion is a separate explicit Candidate Tracking action. This protects against accidental deletion by approval alone.

Department confirmation required: deletion authorization, retention/legal hold, identity verification, and required audit note.

### Form workflow

- **Form Filled** means MTS filled the Microsoft Form; it does not mean the trainer submitted it.
- Trainer reviews every populated field before submitting.
- **Form Filled - Status Warning** means the fill completed but status metadata was not fully saved. Do not refill.
- Form states are Form Filled, Form Skipped, Not Yet Filled, Fill Failed, and Not Recorded.
- Refill requires an explicit warning confirmation because it can duplicate work.

Department confirmation required: who clicks Submit, required second-person review, and correction procedure after submission.

### Discord and Calendar

- Trainers use managed Discord templates and separate screenshot copying.
- Newbie Shift uses **Add to Google Calendar** to open a prefilled event that must be reviewed before saving.
- Reschedule provides an editable temporary Discord post.

Department confirmation required: required Discord channels/mentions, Calendar ownership, and whether proof of posting/scheduling is retained.

### Headset approval

- MTS approved list requires USB connection and a noise-cancelling microphone.
- Unknown models can be researched and sent to SAM review.
- SAM can Approve, Deny, Review Later, Archive, or Delete a mistaken review record.
- **Other** headset denial requires a note.

Department confirmation required: acceptable research sources, reviewer role, re-review cadence, and exception policy.

## 4. MTS instructions by lifecycle stage

### Intake and readiness

1. Start New Session.
2. Search candidate and confirm the correct shared record, or explicitly use the typed name.
3. Review eligibility/final-attempt warnings.
4. Complete headset, VPN decision support, and Browser Checklist.
5. Use NC/NS, Same Day Drop, Not Ready, Stopped Responding, or Tech Issue only for the matching situation.

### Evaluation

1. Complete Call Setup and Payment Simulation.
2. Mark Pass/Fail and record actual coaching.
3. For Fail, select all applicable reasons and add detail only where useful.
4. Complete the Supervisor Transfer workflow and Discord queue text.
5. Use Smart Resume for saved work; use Supervisor Transfer Only only when appropriate.

### Follow-up and completion

1. Schedule Newbie Shift when routed.
2. Use Calendar and Discord handoffs.
3. On Review, verify result, summaries, Incomplete Reason, Next Actions, and form state.
4. Use Fill Form, review the browser, and submit according to department policy.
5. Save & Finish Session.
6. Use History for View, read-only Review, intentional refill, eligible reschedule, and deletion/request workflow.

## 5. SAM admin instructions by lifecycle stage

### Daily queue check

1. Review dashboard counts and live status.
2. Open the bell and Pending Requests.
3. Review Pending Sup Transfers and Headset Review.
4. Refresh stale views once before escalating.

### Candidate administration

1. Use Candidate Search or Candidate Tracking.
2. Use **View Details**, not only **Show More**, before decisions.
3. Use **Update Status** for result/correction actions.
4. Use **More Actions** for Archive, Withdraw/Restore, Cancel Transfer, or Delete.
5. Grant **Extra Attempt** only with authorization.

### Request administration

1. Verify request details and 24-hour/attempt flags.
2. Approve or deny; denial requires a reason.
3. For candidate deletion approval, complete the separately authorized action if required.
4. Confirm the resolved status appears after refresh.

### Notifications and communications

1. Add/Edit notification.
2. Verify Active Status, delivery type, and schedule.
3. Review Live Preview.
4. Submit the selected notification and confirm success.
5. Disable rather than delete when temporary retirement is sufficient.

## 6. Escalation and support

Escalate when:

- Candidate eligibility or final-attempt status conflicts with verified records.
- An override/extra attempt lacks clear authority.
- Request decision will not synchronize after refresh.
- Form Fill reports completion with a status warning.
- A headset decision lacks reliable evidence.
- A deletion or export may conflict with retention/privacy requirements.
- The app cannot launch, save, open Review, or preserve the current session.

For certification questions use `certification@acdsupport.com`. For app issues, use Request App Support with app, screen, action, timestamp, and visible error. Do not include secrets or candidate private data beyond the approved support form's requirements.

## 7. Recordkeeping and statuses

Required operational records are the facts entered in MTS/SAM: candidate match, readiness, results, coaching, fail reasons, final readiness decision, follow-up schedule/request state, denial reason when applicable, form state, and authorized admin notes.

Key distinctions:

- Pass/Fail/Incomplete describe certification outcome.
- Pending/Approved/Denied describe follow-up request decision.
- Form Filled/Form Skipped/Not Yet Filled/Fill Failed/Not Recorded describe Form Fill state.
- Withdrawn/Archived/Extra Attempt Granted describe candidate administration state.

Department confirmation required: retention period, report/export destinations, audit frequency, record-correction approval, and privacy review requirements.

## 8. Quality-control checklist

### Trainer session QC

- [ ] Correct candidate or intentional typed-name path selected.
- [ ] Eligibility/final-attempt warning reviewed.
- [ ] Headset, VPN decision support, and Browser Checklist completed.
- [ ] Call results, coaching, and fail reasons match what occurred.
- [ ] NC/NS, Same Day Drop, Stopped Responding, and Tech Issue used only for their defined cases.
- [ ] Supervisor Transfer and Smart Resume path is correct.
- [ ] Newbie Shift time, timezone, requester, reason, and 24-hour result are correct.
- [ ] Final Readiness Judgment is complete and authorized.
- [ ] Fail Summary contains text only for an actual failure.
- [ ] Form state is accurate; Form Filled is not called submitted.
- [ ] History/follow-up status is visible after Save & Finish.

### SAM admin QC

- [ ] Correct candidate/request record opened with View Details.
- [ ] Bell/reminder/dismiss controls are not mistaken for a decision.
- [ ] Approval/denial is supported; denial reason is readable.
- [ ] Candidate deletion approval is followed by separate action only when authorized.
- [ ] Archive, Withdraw, Restore, Extra Attempt, and Delete are not confused.
- [ ] Headset decision verifies USB and noise-cancelling microphone.
- [ ] Notification preview, active state, schedule, and delivery types are correct.
- [ ] Export/share follows department retention and privacy policy.

### Release/training QC

- [ ] Labels match current source.
- [ ] VideoKey and HelpTopicKey are unique/correct.
- [ ] Category is an approved exact value.
- [ ] Demo data is synthetic.
- [ ] Captions, callouts, and privacy review pass.
- [ ] Unlisted playback and embedding work.
- [ ] Help placement and related article attachment are verified.
