# MTS Admin Training Video Script

Recording impact: partial Basics scene replacement for the manual-only VPN lookup workflow.

Target length: 8 to 15 minutes

Tone: relaxed, clear, and practical. This is a screen recording for testers and admins who need to understand the full Mock Testing Suite workflow.

## Before Recording

- Use a clean test build.
- Use safe sample candidate data.
- Do not show private keys, tokens, real Sheet IDs, or real candidate personal information.
- Keep sound on Medium if demonstrating warning sounds.
- Have a test certification form available if form fill is demonstrated.

## Opening

Say:

"Hi everyone. In this walkthrough, I’m going to show the main Mock Testing Suite workflow from setup through review and history. The goal is not to memorize every button. It’s to get comfortable with the flow and know where to go when something comes up."

Show:

- MTS launch
- Home screen
- Sidebar navigation

## Setup and Settings

Say:

"On a first launch, the Setup Wizard collects the tester information and the links the app needs. Display Name is optional. If it is blank, MTS falls back to the tester first name."

Show:

- Setup Wizard
- Tester name and display name
- Ticker speed
- Welcome voice Male and Female
- Sound volume Off, Low, Medium, High

Say:

"Settings is where you can come back later to update those choices. This is also where payment defaults, Gemini summary settings, Discord posts, screenshots, updates, and theme options live."

Show:

- Settings
- Payment Settings with 3 Credit Card defaults and 3 EFT defaults
- Add/remove payment options
- Gemini settings
- Manual update area

## Help and Tutorial

Say:

"Help is the quick reference area. Use search, open Tutorial Videos, choose Quick Start Choices, or select Replay Guided Walkthrough. If a video is unavailable, written Help remains available. Tutorial topics are not edited in Settings."

Show:

- Help search
- Quick actions
- Tutorial Videos
- Quick Start Choices
- Replay Guided Walkthrough

## Discord Posts and Screenshots

Say:

"Discord Post opens the message templates. You can filter by category or search. The category appears above the title, and the message body has room to wrap naturally. Copy buttons copy the exact template text."

Show:

- Discord Posts popup
- Category filter
- Search
- Template copy
- Screenshots tab and categories

## Basics

Say:

"Every session starts with Basics. This is where we confirm candidate identity and readiness before scoring calls."

Show:

- Candidate name
- Final Attempt
- Headset search
- Search examples `H390` and `H650e`
- Approved and unlisted headset examples
- Research Headset and the Research Complete confirmation
- Explicit USB and Noise Cancelling Mic Yes/No answers
- VPN questions
- VPN / Proxy Lookup Sites with three Copy Link buttons
- Browser checks

Say:

"If the headset or VPN requirements fail, MTS shows a confirmation popup. The purple Discord Post button tells you exactly what it copies."

Say:

"Answer Has VPN and, when applicable, Can turn off. For a manual IP check, expand VPN / Proxy Lookup Sites. Copy Link copies only the selected website address. Open it separately and enter the candidate IP on the site. These sites are reference tools only. MTS does not automatically verify VPN or proxy status, fill the answers, or determine pass or fail."

Show:

- Has VPN and Can turn off conditional behavior
- IP2Location, IPinfo, and ip.teoh.io
- Each Copy Link action and temporary Copied feedback
- No browser launch and no automatic result

Say:

"For an unlisted headset, Research Headset opens the lookup. When you return, choose Yes only if the research supports both wired USB and a noise-cancelling microphone. MTS returns the headset selected, so do not click Use This Headset again. USB and Noise Cancelling Mic still need explicit answers. Research does not approve the headset; SAM handles any later Headset Review."

Show:

- Headset fail popup with `Discord Post: Headset Fail`
- VPN fail popup with `Discord Post: VPN Fail`

## Calls, Coaching, and Fail Reasons

Say:

"Calls are scored one at a time. Select the call type, mark the result, and choose any coaching that was actually given. Other stays at the end, and the custom note area only opens when Other is selected."

Show:

- Call screen
- Missing call type warning
- No coaching selected warning
- Coaching helper text
- Other last
- Fail reason Add Detail

Say:

"Fail reasons can include extra detail. That detail carries forward into Review and helps keep the final summary specific."

## Payments

Say:

"Payment info here is simulated training data. It should be readable during the call, and dropdowns reset to Default on each new Call and Supervisor Transfer so a previous scenario does not leak into the next one."

Show:

- Payment simulation
- Payment dropdowns
- New call reset

## Newbie Shift

Say:

"If the session needs a newbie shift, this page helps schedule the date and time and provides the Discord post for out-of-time cases."

Show:

- Newbie Shift date/time
- Add to Google Calendar
- `Discord Post: Out of Time (Needs Sup)`

## Supervisor Transfer

Say:

"Supervisor Transfer can happen as part of a full session or as supervisor-only work. The screen gives the transfer number, scenario, caller details, payment simulation, coaching, and fail reasons."

Show:

- Sup Transfer pass
- Sup Transfer fail
- Failed 1st Sup Transfer Discord post button
- Coaching and fail reason details

## Review, Gemini, and Final Readiness

Say:

"Review is the final checkpoint. The old final notes popup is gone. The Final Readiness Judgment section is now where an evaluator can accept the calculated result or, when the calculated result is Pass, override it to Fail or Needs Retest."

Show:

- Review page
- Final Readiness Judgment
- Calculated Pass
- Override to Fail with reason and explanation
- Override to Needs Retest / Additional Coaching
- Fail or Incomplete cannot be overridden to Pass

Say:

"While summaries generate, MTS shows inline status so it does not look frozen. If Gemini is unavailable, fallback summaries still appear."

Show:

- Generating AI summary status
- Fallback message if practical
- Edit summary
- Regenerate
- Copy summary

## Finish and Form Fill

Say:

"Finish & Fill Form uses the final result. If Final Readiness overrides a Pass to Fail or Needs Retest, Mock Complete and Sup Complete should not be marked Yes."

Show:

- Finish & Fill Form
- Fill warning if form is missing
- Final save

## History

Say:

"History keeps completed sessions available for review. Older sessions with legacy final notes still open, but they are read-only and do not affect the current draft."

Show:

- History list
- Open a saved session
- Review details
- Correct Candidate Information in the session-detail footer

Say:

"Correct Candidate Information requests a candidate-name or headset-spelling correction for this exact session. A reason is required. Pending keeps the current value authoritative, approval applies the correction, and denial keeps the original. It does not change results, attempts, headset approval, USB, or Noise Cancelling Mic."

## Smart Resume and Rescheduling

Say:

"Resume Supervisor Transfer shows only eligible incomplete mock-call sessions. Completed transfers, Newbie Shift scheduling records, reschedules, and duplicate continuations are excluded. A continuation keeps the original workflow and does not create another headset review. Rescheduling a Newbie Shift also stays linked to the original workflow instead of creating another mock-call session."

Show:

- Resume Supervisor Transfer
- An eligible Smart Resume row
- History Reschedule on the original session

## Close

Say:

"That’s the core MTS workflow. The main habits are: complete Basics carefully, only select coaching that was actually given, use Add Detail when a fail reason needs context, and check Final Readiness before finishing."

