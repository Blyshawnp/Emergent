# Mock Testing Suite Help

## 1. Getting Started
Mock Testing Suite is the control center for certification mock sessions, supervisor transfers, and follow-up scheduling.
- Open the app from the desktop shortcut or Start menu.
- The first launch runs the Setup Wizard, then the Tutorial.
- The default welcome audio plays before setup is complete, and personalized welcome audio is used on returning launches when a matching file exists.
- Everything begins from the Home screen: new sessions, supervisor-only work, and history.
- Active session drafts are saved automatically while you work, so moving between screens never wipes progress.

## 2. Setup Wizard
The first-run wizard captures your tester identity and the form/spreadsheet links the app needs to fill.
- Enter your first name, last name, and (optional) display name.
- First install uses the default welcome audio and does not need your name before setup is complete.
- After setup, returning launches use Display Name when available. If Display Name is blank, the app uses the first name from Tester Name.
- Setup Wizard includes ticker speed, welcome voice, and sound volume. Ticker speed defaults to Normal.
- Welcome voice can be Male or Female. Female welcome audio files use -f before .mp3.
- Sound volume controls welcome audio and app sound effects.
- Confirm the certification form URL and the certification spreadsheet URL.
- When you finish the wizard, the Tutorial starts automatically if it has not been completed yet.
- You can revisit any of these values later from Settings.

## 3. Tutorial and Replay Tutorial
The guided tutorial walks through the main app workflow without changing any session data.
- The tutorial runs once on first launch.
- You can replay it any time from the Help screen using the Replay Tutorial button.
- The tutorial points out current Settings, payment, headset, Discord, and Review behavior.
- Use Next, Back, Skip, and Finish inside the tutorial to control it.
- Tutorial completion is only marked after Skip or Finish.
- Optional tutorial videos are local files only. Place tutorial.mp4 or mts-tutorial.mp4 in frontend/public/assets/tutorial, then rebuild the app. If no video exists, the guided tutorial remains the fallback.

## 4. Home Screen
Home is the launcher for every session type and the entry point to history.
- Start New Session begins the full Basics → Calls → Supervisor Transfer → Review flow.
- Supervisor Transfer Only is used when mock calls were already completed earlier.
- Session History opens the archive of saved sessions.
- Recent stats and any active session prompt also appear on Home.

## 5. Smart Resume
Smart Resume restores work in progress so you do not lose data from a paused or interrupted session.
- If you reopen the app while a session is in progress, Home offers to resume it.
- For Supervisor Transfer Only, Smart Resume can continue from local history when you conducted the original mock calls.
- If another tester conducted the original mock calls, choose No when prompted to load the shared pending supervisor-transfer queue from the master Google Sheet.
- Shared pending entries show candidate name, original tester, call results, created date/time, and available prior coaching or review notes.
- Selecting a shared pending candidate loads the saved session data, skips Basics, and opens Supervisor Transfer Call 1.
- If shared lookup is unavailable, the app falls back to local session mode so testing can continue.
- Choosing not to resume starts a brand-new session and keeps the previous work in History.

## 6. Basics Screen
Basics verifies candidate readiness before any scoring begins.
- Candidate Name is required.
- Final Attempt marks this as the candidate's last allowed mock attempt and affects routing later.
- Select the headset brand/model before answering USB and Noise Cancelling.
- Headset must be USB with a noise-cancelling microphone. Approved headset selections automatically mark USB and Noise Cancelling as Yes.
- VPN must be off, and required browser checks must pass before you can continue.
- When checking for VPN or proxy, use Candidate IP Intelligence as decision support and manually review the result.
- Candidate IP Intelligence never fails a candidate automatically. The tester always makes the final decision.
- Headset and VPN fail popups include Discord copy buttons when the matching post template is available.
- Candidate lookup waits for a stronger name entry, such as first name plus part of last name, before checking shared Google Sheet records.
- When prior records appear, use Review Previous Session to inspect Basics info, tester, date/status, call results, supervisor-transfer results, summaries, and notes.
- Choose Correct Candidate only after confirming the match. The app loads the matching Basics context and starts Calls, or Supervisor Transfer 1 for Supervisor Transfer Only.
- If the most recent previous session was NC/NS, the app looks for older usable Basics information for that candidate.
- If no previous Basics information exists, the app keeps the candidate linked and returns you to Basics with a message to complete the screen before continuing.
- If prior qualifying failures show this is truly the final attempt, the app warns you and sets Final Attempt automatically after candidate confirmation.
- If the shared record shows the final attempt was already used, testing is blocked unless you use the override flow and notify Admin in the Discord Tester Room.
- Blocked candidates should email certification@acddirect.com if there are issues, and testers can post in the Discord Tester Room for help.
- Withdrawn candidates are blocked unless an admin restores the candidate or grants an extra attempt in SAM.
- Candidates with an extra attempt granted can continue, with the notice shown during lookup.
- Continue validates readiness and routes into Calls (or Supervisor Transfer Only when applicable).

## 7. Headset Autocomplete
Use the Brand / Model autocomplete to confirm a candidate is using an allowed USB noise-cancelling model.
- Start typing in Brand / Model to search approved headsets.
- Search works by brand or model number, such as H390 or H650e.
- Click the dropdown arrow in the field to view approved headset options.
- Pick an approved headset first so USB and Noise Cancelling can be marked Yes automatically.
- If the model is not listed, double-check that the headset is USB and has a noise-cancelling microphone before continuing.
- If the headset is confirmed USB with a noise-cancelling microphone, type it manually in the field.
- Manually entered headset models that are not on the approved list may be logged to the headset-review-log tab for admin review.
- Approved but unlisted headsets are reviewed and added to the approved list every 7-10 days.
- A denied model shows a Denied Headset popup. If the candidate has no replacement headset, the session auto-fails.

## 8. NC/NS and Not Ready Auto-Fails
These red buttons end the session immediately. Use them only when the candidate cannot start testing.
- NC/NS = the candidate did not join the session at all.
- NC/NS badges use a bright fuchsia/magenta color so they are visually distinct from normal red Fail statuses.
- Not Ready = the candidate is present but cannot start (no headset, VPN on, wrong browser, etc.).
- Both buttons end the session and route directly to Review with the auto-fail reason recorded.
- If a candidate's most recent session was NC/NS and no previous Basics information exists, complete the Basics screen before continuing.

## 9. Tech Issue Flow
Use Tech Issue when a real technical problem is interrupting the session, before deciding to end it.
- Open Tech Issue from Basics or any session screen where it is available.
- Choose Internet Speed Issues, Calls Would Not Route, No Script Pop, Discord Issues, or Other.
- Follow the prompts to continue the session, route to Review, or schedule a Newbie Shift if the candidate cannot finish today.
- A Tech Issue does not automatically fail the candidate; it just guides the next step.
- For internet speed issues, have the candidate run www.speedtest.net first, then enter upload and download speeds when prompted.
- If the speed test is below the required threshold, the flow records the low speed result and routes to Review.
- If Other is unresolved and the session cannot continue, Review still opens with the active candidate/session data instead of No Active Session.
- If an unresolved technical issue ends the session, Review preserves the current candidate and session data.
- Resolved technical issues stay in session history but do not populate Reason for Fail Summary.
- If an unresolved technical issue ends the session, the technical issue summary is used even when the session routes to a Newbie Shift.

## 10. Calls Screen
The Calls screen scores up to three mock calls.
- For each call pick Call Type, Show, Caller, and Donation amount.
- Payment Simulation uses the saved Credit Card and EFT options from Settings.
- Each new call starts payment dropdowns on Default even if you changed the prior call.
- Settings starts with 3 Credit Card defaults and 3 EFT defaults, and admins or evaluators can add or remove options.
- Mark the call Pass or Fail before moving on.
- Two passed calls (with the required mix of New Donor and Existing Member work) route to Supervisor Transfer.
- Two failed calls route directly to Review.

## 11. Coaching Checkboxes
Coaching checkboxes record what coaching was actually given on each call.
- Check only the items you actually coached during the call.
- Search name for every call and Do not volunteer information are available when those coaching topics were covered.
- Search name for every call and Do not volunteer information appear before Other, which stays last for custom notes.
- Helper text appears below coaching items when extra guidance is configured, and child checkboxes stay disabled until their parent item is checked.
- Coaching selections feed the Coaching Summary on the Review screen.
- Use Other notes only when no existing checkbox describes the coaching clearly.

## 12. Fail Reason Checkboxes
Fail reasons explain why a call did not pass.
- When a call is marked FAIL, select at least one fail reason.
- For any checked fail reason except Other, use + Add detail only when you need to capture what specifically happened.
- Fail reason details stay tied to that specific checked reason and appear in the Review summaries.
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
- Supervisor Transfer payment dropdowns use saved Settings options and start on Default.
- When Supervisor Transfer 1 fails, use the Fail Reasons copy button to copy the Failed 1st Sup Transfer Discord post.
- Pass Transfer 1 to complete the transfer requirement.
- If both transfers fail, the session routes to Newbie Shift follow-up.

## 15. Supervisor Transfer Only
Use this when mock calls were already completed earlier and only the transfer portion remains.
- Choose Supervisor Transfer Only from Home.
- Choose Yes when you conducted the original mock calls; the app uses local Smart Resume and matching local history.
- Choose No when another tester conducted the original mock calls; the app loads the shared pending supervisor-transfer queue.
- Selecting a shared pending candidate loads the prior call results, prior notes, and available Basics information, then goes directly to Supervisor Transfer Call 1.
- If a pending shared record is missing Basics, the app searches prior sessions for the most recent usable Basics for that candidate.
- If the shared Google Sheet cannot be reached, the app shows a local-only notice and continues without blocking the workflow.
- Fresh supervisor-only sessions still run through Basics first when no resumable local or shared record is selected.

## 16. Newbie Shift
Newbie Shift schedules follow-up work when a candidate cannot complete the flow today.
- Enter the follow-up date, start time, AM/PM, and timezone.
- Use Add to Google Calendar to open a prefilled calendar event.
- Use the Discord copy button next to Add to Google Calendar to copy the Out of Time (Needs Sup) post.
- Continue to Review to save the Newbie Shift details on the session.

## 17. Review Screen
Review is the final checkpoint before filling forms or saving the session.
- Confirm the final status, call results, transfer results, and any auto-fail reason.
- Review should show the Basics information for the session, including headset, VPN, and browser checks when available.
- Read the Coaching Summary and Fail Summary before using them anywhere else.
- If the overall session passes with one failed call, that failed call information belongs in Coaching Summary, not the Fail Summary.
- Failed supervisor-transfer details also stay in Coaching Summary when the session passes or remains incomplete.
- Failed call or failed supervisor-transfer details stay in Coaching Summary when the overall session passed or remains incomplete.
- Reason for Fail Summary is only used when the overall session fails.
- Summaries can always be edited manually before Fill Form or Save and Finish.
- Final Readiness Judgment lets the evaluator keep the calculated result or override it with a final result and reason.
- When an override is applied, summaries and saved history preserve both the calculated result and the final evaluator result.
- Use Fill Form to push session data into the certification form.
- Save and Finish stores the session in local History, immediately updates shared Candidate Sessions, and updates Pending Sup Transfers when applicable.
- If the shared Google Sheet update fails, the local save still completes and the app warns you without crashing.

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
- Use Test Gemini Connection after saving the key. If it fails, the status shows the backend failure reason without exposing the key.
- If the API key is typed or already saved, Settings shows the key as configured instead of saying no key is configured.
- If Gemini connects but the test response is blocked or empty, the app explains that safety/API settings may need a simpler prompt or adjustment.
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
10. Open a session and check Review - Gemini will now polish the coaching and fail summaries.

## 21. Fill Form
Fill Form pushes session data into the configured Microsoft certification form using a browser.
- Use Fill Form from Review before closing the active session.
- The app maps known session data into the form, but you should still confirm everything before submitting.
- If Fill Form fails, check the form URL and browser setting in Settings.

## 22. History and Historical Fill Form
History stores recent local sessions. You can reopen a session in read-only Review or fill the form from it again.
- Open History from Home to see recent sessions tested on this app/user.
- Local History is retained for recent work only and can be cleared or deleted by the tester without deleting SAM admin candidate history.
- Shared Google Sheet candidate lookup remains available for older or cross-tester records unless an admin deletes the shared candidate history in SAM or the rows are manually deleted from the Google Sheet.
- Click a session to view summary details, or open it in Historical Review (read-only).
- Historical Fill Form re-runs Fill Form from a saved record without changing the active session.

## 23. Settings
Settings controls your profile, integrations, and app preferences.
- General: tester identity, form/spreadsheet links, browser behavior, welcome voice, sound volume, theme, and ticker speed.
- Female welcome audio files use -f before .mp3, such as welcome-shawn-f.mp3.
- Missing personalized welcome files fall back to default welcome audio.
- Sound volume controls welcome audio and app sound effects.
- Ticker speed can be changed in Setup Wizard or Settings and falls back to Normal when missing.
- Payment Settings starts with 3 Credit Card defaults and 3 EFT defaults. Admins or evaluators can add or remove payment simulation options.
- Call and Supervisor Transfer payment dropdowns show saved options and reset to Default for each new call or transfer.
- Sound Volume supports Off, Low, Medium, and High.
- Admin lists: shows, callers, coaching items, fail reasons, Discord posts, screenshots, Gemini AI, and Calendar.
- Help content is not editable from normal Settings.
- Notifications are managed by admins in SAM through the master Google Sheet, not from normal MTS Settings.

## 24. Discord Posts and Screenshots
The Discord panel keeps reusable Discord messages and screenshot images close at hand during a session.
- Open Discord Post from the sidebar.
- Use Category to filter grouped templates or screenshots when categories are configured. Search still works within the selected category.
- Search templates and copy message text with one click. Copy buttons change to Copied for 3 seconds.
- Template rows show the category above the blue post title, with the full message beside it.
- Some workflow fail popups and follow-up screens also copy specific Discord templates directly from this same content.
- Switch to Screenshots to preview and copy any configured screenshot image. Screenshot copy buttons also show Copied when successful.
- Use Screenshots -> Discord Posts to open the centralized Phonetics.png reference when supported.
- Templates and screenshots are managed in Settings.

## 25. Ticker and Notifications
The ticker and notification system surfaces operational messages without blocking normal work.
- Ticker messages scroll across the top of the app.
- Ticker, banner, and popup content is managed by admins through SAM and the master sam-notifications sheet.
- Banner and popup notifications can also appear from the same source.
- Ticker Speed can be set during Setup Wizard and changed later in Settings; the ticker URL is admin-only.

## 26. Updates and About
Update checks and app version info live in the app menu and Settings.
- Use the app menu or Settings update panel to check the master Google Sheet update-MTS tab for updates.
- Update metadata includes Version, RequiredVersion, Release Date, Release Title, URL, and multiline Notes.
- If RequiredVersion is newer than your installed version, the update is required and normal use is blocked until Update Now is selected.
- Optional updates show release notes and can be installed now or deferred.
- Deferred updates can be installed later from Settings when available.
- When a download cannot open automatically, use the manual download option shown in the updater message.
- About shows the app version and support identity details (also shown on this Help screen).

## 27. Troubleshooting
Use the built-in troubleshooting paths before ending a session for technical reasons.
- Use Tech Issue for internet, DTE, browser, routing, or Other technical problems.
- Use the centralized Discord Posts screenshot reference to preview and copy the phonetics image for Discord.
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
