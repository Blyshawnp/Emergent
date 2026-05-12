# Mock Testing Suite Help

## 1. Getting Started
Mock Testing Suite is the control center for certification mock sessions, supervisor transfers, and follow-up scheduling.
- Open the app from the desktop shortcut or Start menu.
- The first launch runs the Setup Wizard, then the Tutorial.
- Everything begins from the Home screen: new sessions, supervisor-only work, and history.
- Active session drafts are saved automatically while you work, so moving between screens never wipes progress.

## 2. Setup Wizard
The first-run wizard captures your tester identity and the form/spreadsheet links the app needs to fill.
- Enter your first name, last name, and (optional) display name.
- Confirm the certification form URL and the certification spreadsheet URL.
- When you finish the wizard, the Tutorial starts automatically if it has not been completed yet.
- You can revisit any of these values later from Settings.

## 3. Tutorial and Replay Tutorial
The guided tutorial walks through the main app workflow without changing any session data.
- The tutorial runs once on first launch.
- You can replay it any time from the Help screen using the Replay Tutorial button.
- Use Next, Back, Skip, and Finish inside the tutorial to control it.
- Tutorial completion is only marked after Skip or Finish.

## 4. Home Screen
Home is the launcher for every session type and the entry point to history.
- Start New Session begins the full Basics → Calls → Supervisor Transfer → Review flow.
- Supervisor Transfer Only is used when mock calls were already completed earlier.
- Session History opens the archive of saved sessions.
- Recent stats and any active session prompt also appear on Home.

## 5. Smart Resume
Smart Resume restores work in progress so you do not lose data from a paused or interrupted session.
- If you reopen the app while a session is in progress, Home offers to resume it.
- For Supervisor Transfer Only, Smart Resume can continue from a saved record when prior mock calls match the candidate.
- Choosing not to resume starts a brand-new session and keeps the previous work in History.

## 6. Basics Screen
Basics verifies candidate readiness before any scoring begins.
- Candidate Name is required.
- Final Attempt marks this as the candidate's last allowed mock attempt and affects routing later.
- Headset must be USB with a noise-cancelling microphone.
- VPN must be off, and required browser checks must pass before you can continue.
- Continue validates readiness and routes into Calls (or Supervisor Transfer Only when applicable).

## 7. Headset Lookup
Use the approved headset lookup to confirm a candidate is using an allowed USB noise-cancelling model.
- Click Lookup Approved Headsets next to the Brand / Model field.
- Search by brand or model, then select a listed model to auto-fill the field.
- If the model is not listed, double-check that the headset is USB and has a noise-cancelling microphone before continuing.

## 8. NC/NS and Not Ready Auto-Fails
These red buttons end the session immediately. Use them only when the candidate cannot start testing.
- NC/NS = the candidate did not join the session at all.
- Not Ready = the candidate is present but cannot start (no headset, VPN on, wrong browser, etc.).
- Both buttons end the session and route directly to Review with the auto-fail reason recorded.

## 9. Tech Issue Flow
Use Tech Issue when a real technical problem is interrupting the session, before deciding to end it.
- Open Tech Issue from Basics or any session screen where it is available.
- Choose the issue type: internet, DTE, browser, routing, or Other.
- Follow the prompts to continue the session, route to Review, or schedule a Newbie Shift if the candidate cannot finish today.
- A Tech Issue does not automatically fail the candidate; it just guides the next step.

## 10. Calls Screen
The Calls screen scores up to three mock calls.
- For each call pick Call Type, Show, Caller, and Donation amount.
- Mark the call Pass or Fail before moving on.
- Two passed calls (with the required mix of New Donor and Existing Member work) route to Supervisor Transfer.
- Two failed calls route directly to Review.

## 11. Coaching Checkboxes
Coaching checkboxes record what coaching was actually given on each call.
- Check only the items you actually coached during the call.
- Coaching selections feed the Coaching Summary on the Review screen.
- Use Other notes only when no existing checkbox describes the coaching clearly.

## 12. Fail Reason Checkboxes
Fail reasons explain why a call did not pass.
- When a call is marked FAIL, select at least one fail reason.
- Pick every reason that applies; the Review summary lists all of them.
- Use Other notes only when the existing list does not describe the issue.

## 13. Stopped Responding Auto-Fail
Stopped Responding ends the session as a fail when the candidate goes silent and will not respond.
- Use the red Stopped Responding button only after a real attempt to re-engage the candidate.
- It immediately ends the session and routes to Review with Stopped Responding recorded.
- This is different from Tech Issue: pick Stopped Responding only when the candidate, not technology, is the problem.

## 14. Supervisor Transfer
Supervisor Transfer verifies the candidate can complete the transfer process correctly.
- Post the Discord queue message and use the WXYZ supervisor test number.
- Choose caller, show, and supervisor reason before scoring the transfer.
- Pass Transfer 1 to complete the transfer requirement.
- If both transfers fail, the session routes to Newbie Shift follow-up.

## 15. Supervisor Transfer Only
Use this when mock calls were already completed earlier and only the transfer portion remains.
- Choose Supervisor Transfer Only from Home.
- Smart Resume can continue from a saved record if prior mock calls match the candidate.
- Fresh supervisor-only sessions still run through Basics first.

## 16. Newbie Shift
Newbie Shift schedules follow-up work when a candidate cannot complete the flow today.
- Enter the follow-up date, start time, AM/PM, and timezone.
- Use Add to Google Calendar to open a prefilled calendar event.
- Continue to Review to save the Newbie Shift details on the session.

## 17. Review Screen
Review is the final checkpoint before filling forms or saving the session.
- Confirm the final status, call results, transfer results, and any auto-fail reason.
- Read the Coaching Summary and Fail Summary before using them anywhere else.
- Use Fill Form to push session data into the certification form.
- Save and Finish stores the session in History and clears the active draft.

## 18. Generic Summaries
Generic summaries are built from your coaching and fail-reason selections without using AI.
- No setup is required. Generic summaries always work.
- They list the selected coaching items and fail reasons in plain text.
- Use them as-is, or turn on Gemini for cleaner wording (see next section).

## 19. Gemini Summaries
Gemini summaries rewrite the generic summary into more polished management-facing wording.
- Gemini is optional. The app still creates generic summaries without it.
- Gemini only rewrites the wording; it does not change pass/fail status or routing.
- Turn Gemini on in Settings → Gemini AI after adding an API key (next section).
- Typical usage in this app is light, often fewer than 5 AI calls per day.

## 20. How to get and add a free Gemini API key
A short, beginner-friendly walkthrough for adding Gemini to Mock Testing Suite.

Important notes:
- Gemini is optional. The app can still create generic summaries without it.
- Gemini just makes the coaching and fail summaries sound more polished.
- Do not share your API key publicly. Treat it like a password.

Steps:
1. Open Google AI Studio in your browser: https://aistudio.google.com
2. Sign in with your Google account.
3. Create or get a Gemini API key from Google AI Studio.
4. Copy the API key to your clipboard.
5. In Mock Testing Suite, open Settings.
6. Go to the Gemini AI tab.
7. Turn on Enable Gemini AI Summaries.
8. Paste your API key into the Gemini API Key box.
9. Click Save Settings.
10. Open a session and check Review — Gemini will now polish the coaching and fail summaries.

## 21. Fill Form
Fill Form pushes session data into the configured Microsoft certification form using a browser.
- Use Fill Form from Review before closing the active session.
- The app maps known session data into the form, but you should still confirm everything before submitting.
- If Fill Form fails, check the form URL and browser setting in Settings.

## 22. History and Historical Fill Form
History stores saved sessions. You can reopen a session in read-only Review or fill the form from it again.
- Open History from Home to see all saved sessions.
- Click a session to view summary details, or open it in Historical Review (read-only).
- Historical Fill Form re-runs Fill Form from a saved record without changing the active session.

## 23. Settings
Settings controls your profile, integrations, and app preferences.
- General: tester identity, form/spreadsheet links, browser behavior, sounds, theme, and ticker speed.
- Admin lists: shows, callers, coaching items, fail reasons, Discord posts, screenshots, Gemini AI, and Calendar.
- Help content is not editable from normal Settings.
- The notification ticker sheet URL is managed by the admin and is not exposed to normal users.

## 24. Discord Posts and Screenshots
The Discord panel keeps reusable Discord messages and screenshot images close at hand during a session.
- Open Discord Post from the sidebar.
- Search templates and copy message text with one click.
- Switch to Screenshots to preview and copy any configured screenshot image.
- Templates and screenshots are managed in Settings.

## 25. Ticker and Notifications
The ticker and notification system surfaces operational messages without blocking normal work.
- Ticker messages scroll across the top of the app.
- Ticker content comes from the admin-configured Google ticker sheet, with a built-in fallback when the sheet is unavailable.
- Banner and popup notifications can also appear from the same source.
- Ticker Speed is controlled in Settings; the ticker URL is admin-only.

## 26. Updates and About
Update checks and app version info live in the app menu and Settings.
- Use the app menu or Settings update panel to check for updates.
- Deferred updates can be installed later from Settings when available.
- About shows the app version and support identity details (also shown on this Help screen).

## 27. Troubleshooting
Use the built-in troubleshooting paths before ending a session for technical reasons.
- Use Tech Issue for internet, DTE, browser, routing, or Other technical problems.
- Follow the prompts to continue the session, go to Review, or schedule Newbie Shift.
- If the app itself is misbehaving, restart it. Active session drafts are saved automatically.
- When reporting an app issue, include the screen name, the action you took, and any visible error text.

## 28. FAQ
The FAQ panel lists short answers to common questions.
- See the Common Questions panel on the Help screen (right side on wide screens, below the topics on narrow screens).
- FAQ content is loaded from the admin-configured FAQ source, with a built-in fallback if loading fails.
- If the FAQ shows the fallback notice, the app could not reach the configured FAQ source. Try Help again later.

## Support
Need help with the app? Include the screen, action, and any visible error when reporting issues.
