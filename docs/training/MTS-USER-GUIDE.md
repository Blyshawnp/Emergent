# Mock Testing Suite (MTS) User Guide

## Purpose

MTS guides trainers through candidate readiness, mock calls, Supervisor Transfers, follow-up scheduling, Review, Form Fill, and local History. It saves active drafts while you work. Use the visible workflow and confirmations; do not bypass a block unless you have the required authorization.

## First launch and Quick Start

1. Complete the Setup Wizard with your tester identity and the workflow information provided by the department.
2. Choose ticker speed, welcome voice, and sound volume.
3. At **Setup complete**, choose **Watch the MTS Quick Start**, **Open the MTS User Guide**, or **Go to MTS Home**.
4. The guided tutorial runs once after setup. Use **Next**, **Back**, **Skip**, or **Finish**. Replay it later from Help.

Do not enter or share secrets in training notes or recordings. If setup information is missing, use the approved support process rather than guessing.

## Home and navigation

- **Start New Session** opens the full Basics -> Calls -> Supervisor Transfer -> Review workflow.
- **Supervisor Transfer Only** is for completing the transfer portion when mock calls were completed earlier.
- **Session History** opens saved local sessions.
- An active-session prompt offers Smart Resume when a draft exists.
- The sidebar also provides Discord Post, Settings, and Help.

## Candidate Lookup and typed names

1. Start a session and enter a strong name search, normally first name plus part of the last name.
2. Review matching shared records. Use **Review Previous Session** before choosing a row when you need prior Basics, call, transfer, summary, or status context.
3. Select **Correct Candidate** only after verifying the match.
4. If no record is the correct person, select **Use typed name: [name]** to continue without linking a shared record.

If shared lookup is temporarily unavailable, MTS may show **Shared candidate lookup unavailable. Using local session mode.** You may continue, but cross-tester or older history may not be visible.

### Eligibility and attempts

- A passed candidate is blocked from another attempt unless the record is archived or an extra attempt has been granted.
- A candidate who already used a failed final attempt is blocked unless an authorized override or extra attempt is available.
- A withdrawn candidate is blocked until restored or granted an extra attempt in SAM.
- When prior failures make the current session the final attempt, MTS warns you and sets **Final Attempt**.
- Do not manually mark **Final Attempt** unless it is the candidate's last allowed attempt.
- For blocked-candidate questions, direct the candidate to `certification@acdsupport.com` and use the approved admin/Discord escalation path.

Department confirmation required: who may authorize a candidate override or extra attempt, and the department's exact attempt-count policy outside what MTS displays.

## Basics readiness

Complete every required field before **Continue**.

### Headset Requirements

1. Enter or search **Brand / Model**.
2. Approved selections automatically mark **Is the headset USB?** and **Noise Cancelling Mic?** as Yes.
3. If the model is not listed, use **Research Headset**. Research is evidence only; admin review is still required.
4. **Use This Headset** lets the trainer continue based on current judgment. It does not approve or add the model.
5. A denied model opens **Denied Headset**. Confirm whether the candidate has a replacement before ending the session.

The current product requirement is a USB headset with a noise-cancelling microphone. Do not treat an unlisted model as approved merely because a search result looks promising.

### VPN and Browser Checklist

- Complete the VPN questions and use **VPN / Proxy Check** as decision support.
- The tester always makes the final decision. A limited or stale signal requires manual verification.
- Complete **Default browser?**, **Extensions disabled?**, and **Pop-ups allowed?**
- If a readiness item cannot be corrected, follow the confirmation path to Review instead of forcing Continue.

### Immediate session-ending actions

- **NC / NS** means the candidate did not join. MTS then asks you to choose **Same Day Drop** or **NC/NS**.
- **Same Day Drop** means the candidate dropped the session within 24 hours.
- **Not Ready** means the candidate is present but cannot start.
- **Stopped Responding** is for a candidate who stops responding after a real attempt to re-engage them.
- **Tech Issue** is for an actual technical interruption and does not automatically fail the candidate.

NC/NS and Same Day Drop use the same NC/NS form checkbox behavior but preserve different summary wording. Read the confirmation before continuing.

## Mock Calls

MTS scores up to three calls.

1. On **Call #1**, complete **Call Setup**: Call Type, Show, Caller, and Donation.
2. Use **Payment Simulation** values only as training data.
3. Mark **PASS** or **FAIL**.
4. Under **Coaching Given**, select only coaching actually delivered.
5. For a failed call, select at least one **Fail Reason**.
6. Use **+ Add detail** for a selected reason only when the situation needs clarification.
7. Use **Other Coaching Notes** or **Other Fail Notes** only when **Other** is selected and no listed choice fits.
8. Select **Continue** and repeat as routed.

Two qualifying passed calls route to Supervisor Transfer. Two failed calls route to Review. MTS may require a third call to satisfy the needed call mix. If no coaching is selected, read the **No Coaching** confirmation and correct the call if coaching was actually provided.

## Technical issues

Open **Tech Issue** from the current workflow and choose the matching type: **Internet Speed Issues**, **Calls Would Not Route**, **No Script Pop**, **Discord Issues**, or **Other**.

- For internet issues, have the candidate run the speed test requested by the dialog and enter the displayed results.
- If the problem is resolved, continue the session. Resolved technical issues remain in history but do not populate Reason for Fail Summary.
- If the session cannot continue, follow the dialog to Review or Newbie Shift.
- An unresolved issue that ends the session is preserved in Review.
- Do not use **Stopped Responding** for a technology problem.

## Supervisor Transfers

1. Copy the visible **WXYZ Supervisor Test Call Being Queued** Discord text and use the displayed WXYZ test-transfer information.
2. Complete caller, show, supervisor reason, payment simulation, and transfer result.
3. Mark **PASS** or **FAIL** and record coaching actually given.
4. On failure, select at least one **Fail Reason**. **Other** requires notes.
5. After a failed first transfer, use **Copy Failed 1st Sup Transfer Discord post** when appropriate.
6. Pass Transfer 1 to proceed to Review. A failed Transfer 1 routes to Transfer 2.
7. If both transfers fail, a non-final attempt becomes **Incomplete** and offers **Schedule Newbie Shift**. A final attempt routes to the final-failure outcome.

### Smart Resume

Use Smart Resume when saved mock-call data exists.

- If you conducted the original calls, choose the local Smart Resume path.
- If another tester conducted them, choose the shared pending Supervisor Transfer path.
- Confirm the candidate and prior call context before resuming.
- A resumed session opens at Supervisor Transfer Call 1 and preserves prior call data.
- If the resumed candidate does not attend the transfer appointment, use the Supervisor Transfer **NC / NS** action and confirm **Mark NC/NS**.

### Supervisor Transfer Only

Choose **Supervisor Transfer Only** from Home only when the transfer portion remains. If resumable data exists, **Use Smart Resume** is the recommended action; **Start Supervisor Transfer Only** is the secondary override. A fresh supervisor-only session still collects Basics when no resumable record is selected.

## Newbie Shifts and rescheduling

### Initial scheduling

When MTS determines there is not enough time or both Supervisor Transfers need later follow-up:

1. Choose **Schedule Newbie Shift**.
2. Enter the date, **START TIME**, AM/PM, and timezone.
3. Select **Add to Google Calendar** and review the prefilled event before saving it.
4. Use the out-of-time Discord copy when prompted.
5. Select **Continue to Review**.

The initial request normally displays **Pending** until an admin approves or denies it.

### Rescheduling from History

1. Find an eligible incomplete session and select **Reschedule**.
2. Answer **Did you or [candidate] need the Newbie Shift rescheduled?** Choose **Myself** or the candidate.
3. Choose one reason: Unexpected emergency, Internet outage, Power outage, Technical issue, Login issue, Scheduling conflict, Illness, or Other.
4. **Other** requires **Additional details**.
5. Select **Continue**, enter the new date/time/timezone, and review **Temporary Discord Reschedule Post**.
6. Edit the temporary post if needed, then select **Copy**.
7. Select **Continue to Review**.

### Exact 24-hour rule

- Candidate-requested change received **less than 24 hours** before the original shift: counts as an attempt and maps to NC/NS form behavior.
- Candidate-requested change received **exactly 24 hours or more** before the original shift: does not count as an attempt.
- Tester-requested change: does not penalize the candidate.
- A final-attempt candidate inside the less-than-24-hour window is told to email `certification@acdsupport.com`; approval is not guaranteed.

The requested time is tentative while status is **Pending**. MTS displays **Approved** or **Denied** after SAM makes and MTS receives the decision. A denial reason appears in details when supplied.

Department confirmation required: service-level targets for reviewing requests and any exception process beyond the application rule.

## Review, summaries, and Form Fill

### Review checkpoint

On **Session Review & Summary**:

1. Read the result banner and session details.
2. Under **Final Readiness Judgment**, choose **Yes, use calculated result** unless an authorized evaluator must select **No, override result** and provide the required result/reason/explanation.
3. Review **Coaching Summary**, **Incomplete Reason** when present, **Fail Summary**, and **Evaluator Notes Summary**.
4. Edit or regenerate wording only to improve accuracy. Do not change facts to obtain a desired result.

Fail Summary should contain information only when the candidate actually failed certification. For Pass or Incomplete, failed-call and failed-transfer detail belongs in Coaching Summary/history; Fail Summary remains `N/A`. **Next Actions** appears only for Incomplete and can schedule a missed follow-up.

### Form Fill states

- **Form Filled**: MTS completed filling the Microsoft Form. The trainer must still review the browser and decide when to submit.
- **Form Skipped**: the session was finished without running Form Fill.
- **Not Yet Filled**: Form Fill has not completed.
- **Fill Failed**: browser automation did not complete.
- **Not Recorded**: legacy history has no recorded form state.

Select **Fill Form**, review the populated form, and confirm every field before submitting. If MTS reports **Form Filled - Status Warning**, the form was filled but status metadata was not fully saved. Do not refill; refresh History or contact support.

Select **Save & Finish Session** after review. If Form Fill has not run, MTS asks whether to skip or **Fill Form**.

## History and actions

**Session History** shows Date, Candidate, Tester, Session Status, Follow-Up, Form Status, and Actions.

- **View** opens details.
- **Open in Review** opens **Historical Review & Summary** in read-only mode.
- **Fill Cert Form** fills from a saved record.
- **Refill Cert Form** appears when already marked filled and warns about duplicate work. Continue only when intentionally authorized.
- **Reschedule** appears only for eligible incomplete follow-up records.
- **Delete** asks whether to remove local History only or request deletion from the certification candidate list as well.

Local deletion does not itself delete the admin candidate record. A shared deletion request remains action-required even after SAM approval; authorized deletion is a separate admin action.

## Discord Posts, screenshots, and shortcuts

Open **Discord Posts** and use search first. Filter by Category, **Favorites**, or **Recent**. Select a post to preview it, then use **Copy Post**. Copy each suggested screenshot separately. Switch to **Screenshots** for the library.

Default shortcuts:

| Shortcut | Action |
|---|---|
| Ctrl+D | Open Discord Posts |
| Ctrl+Shift+D | Open Screenshot Library |
| Ctrl+Shift+P | Open Command Palette |
| Ctrl+F | Focus Search |
| Ctrl+Shift+F | Show Favorites |
| Alt+1 | Calls |
| Alt+2 | Supervisor Transfer |
| Alt+3 | VPN |
| Alt+4 | Headsets |
| Alt+5 | Discord Audio |
| Alt+6 | Screen Share |
| Alt+7 | Technical Issues |
| Alt+8 | Favorites |
| Ctrl+1 | Wrong Headset |
| Ctrl+2 | VPN Failed |
| Ctrl+3 | Change DTE |
| Ctrl+4 | Supervisor Failed |
| Ctrl+5 | Technical Issue |

Shortcuts can be changed in Settings and may differ on your device. The app prevents conflicts. Use the in-window **Shortcuts** reference as the current authority.

## Settings and Help

Settings includes profile/general preferences, payment options, managed lists, Discord productivity, optional summary settings, Calendar guidance, sound, theme, ticker speed, and updates. Change managed workflow content only when authorized.

Help provides searchable articles, FAQ, **Replay Tutorial**, **Watch Tutorial Video** when available, and Tutorial Videos by category. If a video is unavailable, written Help remains the source for the workflow.

## Troubleshooting

- Missing active draft: return Home and look for Smart Resume; do not create a duplicate session until you confirm the prior draft.
- Candidate lookup unavailable: continue in local mode only if appropriate, and retry later for shared history.
- Form Filled warning: do not refill; refresh History or contact support.
- Fill Failed: confirm the configured form/browser settings, then retry only when the form was not filled.
- Stale Newbie Shift decision: refresh History/Home or repeat candidate lookup. Do not create a duplicate request.
- Discord copy failure: open Discord Posts and copy manually.
- App issue: restart MTS; drafts are autosaved. Report the screen, action, visible message, and time through the approved support form.

## Status glossary

| Status | Meaning / action |
|---|---|
| Pass | Certification session passed. |
| Resumed - Pass | A resumed session passed. |
| Fail | Certification session failed. Fail Summary should explain the failure. |
| Fail - Final Attempt | Final allowed attempt failed; follow the block/support process. |
| Incomplete | Certification needs follow-up; review Incomplete Reason and Next Actions. |
| Needs Retest / Additional Coaching | Evaluator override outcome requiring another attempt/coaching. |
| NC/NS | Candidate did not attend. |
| Withdrawn | Candidate is blocked until restored or granted an extra attempt. |
| Archived | Closed shared record hidden from active views. |
| Pending | Newbie Shift request awaits admin decision. |
| Approved | Newbie Shift request approved. |
| Denied | Newbie Shift request denied; review the reason. |
| Form Filled | MTS filled the Microsoft Form; not proof of submission. |
| Form Skipped | Session finished without Form Fill. |
| Not Yet Filled | Form Fill has not completed. |
| Fill Failed | Form automation did not complete. |
| Not Recorded | Legacy record has no form state. |
