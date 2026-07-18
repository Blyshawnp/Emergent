import React, { useEffect, useMemo, useState } from 'react';
import geminiActiveGraphic from '../assets/images/Gemini2.png';
import api from '../api';
import { useModal } from '../components/ModalProvider';
import { TutorialVideoLibrary } from '../components/TutorialVideoPlayer';
import { normalizeTutorialVideos } from '../utils/tutorialVideos';

const APP_VERSION_FALLBACK = '1.0.1';
const HELP_HOME_GROUPS = [
  ['Getting Started', '#getting-started'],
  ['Common Tasks', '#home-screen'],
  ['MTS Workflows', '#basics'],
  ['SAM Workflows', '#sam-workflows'],
  ['Status Glossary', '#status-glossary'],
  ['Troubleshooting', '#tech-issues'],
  ['Keyboard Shortcuts', '#discord-productivity'],
  ['Tutorial Videos', '#mts-tutorial-videos'],
];

const HELP_CATEGORIES = [
  {
    id: 'cat-getting-started',
    title: 'Getting Started',
    description: 'First launch, setup wizard, and tutorial replay.',
    anchor: 'getting-started',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12 L12 3 L21 12"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>',
  },
  {
    id: 'cat-basics-setup',
    title: 'Basics',
    description: 'Candidate readiness, headsets, VPN, and IP checks.',
    anchor: 'basics',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  },
  {
    id: 'cat-calls-workflow',
    title: 'Calls Workflow',
    description: 'Mock calls, payment options, coaching, and fail reasons.',
    anchor: 'calls',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  },
  {
    id: 'cat-supervisor-transfer',
    title: 'Supervisor Transfer',
    description: 'Transfer flow, supervisor-only sessions, and resume.',
    anchor: 'supervisor-transfer',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  },
  {
    id: 'cat-review-form',
    title: 'Review / Form Fill',
    description: 'Summaries, evaluator override, and Fill Form.',
    anchor: 'review',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>',
  },
  {
    id: 'cat-discord-tech',
    title: 'Discord & Tech Issues',
    description: 'Discord posts, tech-issue flow, and Newbie Shift.',
    anchor: 'discord',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  },
  {
    id: 'cat-screenshots',
    title: 'Screenshots',
    description: 'Phonetics reference and configured screenshot images.',
    anchor: 'discord',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  },
  {
    id: 'cat-tech-issues',
    title: 'Tech Issues',
    description: 'Technical issue flow, recovery paths, and where to look.',
    anchor: 'tech-issues',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="0.6" fill="currentColor"/></svg>',
  },
  {
    id: 'cat-contact-support',
    title: 'Contact Support',
    description: 'Open the Request App Support form when you need help.',
    anchor: 'faq',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
  },
];

const HELP_TOPICS = [
  {
    id: 'getting-started',
    title: '1. Getting Started',
    summary: 'Mock Testing Suite is the control center for certification mock sessions, supervisor transfers, and follow-up scheduling.',
    bullets: [
      'Open the app from the desktop shortcut or Start menu.',
      'The first launch runs the Setup Wizard, then the Tutorial.',
      'The default welcome audio plays before setup is complete, and personalized welcome audio is used on returning launches when a matching file exists.',
      'Everything begins from the Home screen: new sessions, supervisor-only work, and history.',
      'Active session drafts are saved automatically while you work, so moving between screens never wipes progress.',
    ],
  },
  {
    id: 'setup-wizard',
    title: '2. Setup Wizard',
    summary: 'The first-run wizard captures your tester identity and the provided certification workflow links.',
    bullets: [
      'Enter your first name, last name, and (optional) display name.',
      'First install uses the default welcome audio and does not need your name before setup is complete.',
      'After setup, returning launches use Display Name when available. If Display Name is blank, the app uses the first name from Tester Name.',
      'Setup Wizard includes ticker speed, welcome voice, and sound volume. Ticker speed defaults to Normal.',
      'Welcome voice can be Male or Female. Female welcome audio files use -f before .mp3.',
      'Sound volume controls welcome audio and app sound effects.',
      'Confirm the provided certification workflow links.',
      'When you finish the wizard, the Tutorial starts automatically if it has not been completed yet.',
      'You can revisit any of these values later from Settings.',
    ],
  },
  {
    id: 'tutorial',
    title: '3. Tutorial and Replay Tutorial',
    summary: 'The guided tutorial walks through the main app workflow without changing any session data.',
    bullets: [
      'The tutorial runs once on first launch.',
      'You can replay it any time from this Help screen using the Replay Tutorial button.',
      'The tutorial points out current Settings, payment, headset, Discord, and Review behavior.',
      'Use Next, Back, Skip, and Finish inside the tutorial to control it.',
      'Tutorial completion is only marked after Skip or Finish.',
      'If a tutorial video is available, use Watch Tutorial Video. Otherwise, Replay Tutorial opens the guided walkthrough.',
    ],
  },
  {
    id: 'home-screen',
    title: '4. Home Screen',
    summary: 'Home is the launcher for every session type and the entry point to history.',
    bullets: [
      'Start New Session begins the full Basics → Calls → Supervisor Transfer → Review flow.',
      'Supervisor Transfer Only is used when mock calls were already completed earlier.',
      'Session History opens the archive of saved sessions.',
      'Recent stats and any active session prompt also appear on Home.',
    ],
  },
  {
    id: 'smart-resume',
    title: '5. Smart Resume',
    summary: 'Smart Resume restores work in progress so you do not lose data from a paused or interrupted session.',
    bullets: [
      'If you reopen the app while a session is in progress, Home offers to resume it.',
      'For Supervisor Transfer Only, Smart Resume can continue from local history when you conducted the original mock calls.',
      'If another tester conducted the original mock calls, choose No when prompted to load the shared pending supervisor-transfer queue.',
      'Shared pending entries show candidate name, original tester, call results, created date/time, and available prior coaching or review notes.',
      'Selecting a shared pending candidate loads the saved session data, skips Basics, and opens Supervisor Transfer Call 1.',
      'If shared lookup is unavailable, the app falls back to local session mode so testing can continue.',
      'Choosing not to resume starts a brand-new session and keeps the previous work in History.',
    ],
  },
  {
    id: 'basics',
    title: '6. Basics Screen',
    summary: 'Basics verifies candidate readiness before any scoring begins.',
    bullets: [
      'Candidate Name is required.',
      'Final Attempt marks this as the candidate’s last allowed mock attempt and affects routing later.',
      'Select the headset brand/model before answering USB and Noise Cancelling.',
      'Headset must be USB with a noise-cancelling microphone. Approved headset selections automatically mark USB and Noise Cancelling as Yes.',
      'VPN must be off, and required browser checks must pass before you can continue.',
      'When checking for VPN or proxy, use VPN / Proxy Check as decision support and manually review the result.',
      'VPN / Proxy Check never fails a candidate automatically. The tester always makes the final decision.',
      'Automatic VPN/proxy lookup is the default. Manual lookup links remain available when provider coverage is limited or a trainer needs to send a lookup site to the candidate.',
      'Integrated mode never treats a single provider as a confident clear result. If coverage is limited, verify the candidate IP manually.',
      'Headset and VPN fail popups include Discord copy buttons when the matching post template is available.',
      'Candidate lookup waits for a stronger name entry, such as first name plus part of last name, before checking shared candidate records.',
      'When prior records appear, use Review Previous Session to inspect Basics info, tester, date/status, call results, supervisor-transfer results, summaries, and notes.',
      'Choose Correct Candidate only after confirming the match. The app loads the matching Basics context and starts Calls, or Supervisor Transfer 1 for Supervisor Transfer Only.',
      'If the most recent previous session was NC/NS, the app looks for older usable Basics information for that candidate.',
      'If no previous Basics information exists, the app keeps the candidate linked and returns you to Basics with a message to complete the screen before continuing.',
      'If prior qualifying failures show this is truly the final attempt, the app warns you and sets Final Attempt automatically after candidate confirmation.',
      'If the shared record shows the final attempt was already used, testing is blocked unless you use the override flow and notify Admin in the Discord Tester Room.',
      'Blocked candidates should email certification@acdsupport.com if there are issues, and testers can post in the Discord Tester Room for help.',
      'Withdrawn candidates are blocked unless an admin restores the candidate or grants an extra attempt in SAM.',
      'Candidates with an extra attempt granted can continue, with the notice shown during lookup.',
      'Continue validates readiness and routes into Calls (or Supervisor Transfer Only when applicable).',
    ],
  },
  {
    id: 'headset-lookup',
    title: '7. Headset Autocomplete',
    summary: 'Use the Brand / Model autocomplete to confirm a candidate is using an allowed USB noise-cancelling model.',
    bullets: [
      'Start typing in Brand / Model to search approved headsets.',
      'Search works by brand or model number, such as H390 or H650e.',
      'Click the dropdown arrow in the field to view approved headset options.',
      'Pick an approved headset first so USB and Noise Cancelling can be marked Yes automatically.',
      'If the model is not listed, double-check that the headset is USB and has a noise-cancelling microphone before continuing.',
      'Use Research Headset when a model is not found. It opens a browser search and reminds you that administrator review is still required before the model can be added to the approved list.',
      'Use This Headset only when trainer judgment says the session should continue; it does not approve or add the headset.',
      'If the headset is confirmed USB with a noise-cancelling microphone, type it manually in the field.',
      'Manually entered headset models that are not on the approved list may be sent for admin review.',
      'Approved but unlisted headsets are reviewed and added to the approved list every 7-10 days.',
      'A denied model shows a Denied Headset popup. If the candidate has no replacement headset, the session auto-fails.',
    ],
  },
  {
    id: 'autofails-ncns-notready',
    title: '8. NC/NS and Not Ready Auto-Fails',
    summary: 'These red buttons end the session immediately. Use them only when the candidate cannot start testing.',
    bullets: [
      'NC/NS = the candidate did not join the session at all.',
      'NC/NS badges use a bright fuchsia/magenta color so they are visually distinct from normal red Fail statuses.',
      'Not Ready = the candidate is present but cannot start (no headset, VPN on, wrong browser, etc.).',
      'Both buttons end the session and route directly to Review with the auto-fail reason recorded.',
      "If a candidate's most recent session was NC/NS and no previous Basics information exists, complete the Basics screen before continuing.",
    ],
  },
  {
    id: 'tech-issue',
    title: '9. Tech Issue Flow',
    summary: 'Use Tech Issue when a real technical problem is interrupting the session, before deciding to end it.',
    bullets: [
      'Open Tech Issue from Basics or any session screen where it is available.',
      'Choose Internet Speed Issues, Calls Would Not Route, No Script Pop, Discord Issues, or Other.',
      'Follow the prompts to continue the session, route to Review, or schedule a Newbie Shift if the candidate cannot finish today.',
      'A Tech Issue does not automatically fail the candidate; it just guides the next step.',
      'For internet speed issues, have the candidate run www.speedtest.net first, then enter upload and download speeds when prompted.',
      'If speed passes but another technical issue remains, choose Yes, describe the issue, and answer whether the session was completed.',
      'Other technical issue notes fill the Other option on the certification form.',
      'If the speed test is below the required threshold, the flow records the low speed result and routes to Review.',
      'If Other is unresolved and the session cannot continue, Review still opens with the active candidate/session data instead of No Active Session.',
      'If an unresolved technical issue ends the session, Review preserves the current candidate and session data.',
      'Resolved technical issues stay in history but do not populate Reason for Fail Summary.',
    ],
  },
  {
    id: 'calls',
    title: '10. Calls Screen',
    summary: 'The Calls screen scores up to three mock calls.',
    bullets: [
      'For each call pick Call Type, Show, Caller, and Donation amount.',
      'Browser Checklist checks on Basics confirm the default browser, extensions, and pop-up settings before calls begin.',
      'Payment Simulation uses the saved Credit Card and EFT options from Settings.',
      'Each new call starts payment dropdowns on Default even if you changed the prior call.',
      'Settings starts with 3 Credit Card defaults and 3 EFT defaults, and admins or evaluators can add or remove options.',
      'Mark the call Pass or Fail before moving on.',
      'Two passed calls (with the required mix of New Donor and Existing Member work) route to Supervisor Transfer.',
      'Two failed calls route directly to Review.',
    ],
  },
  {
    id: 'coaching-checkboxes',
    title: '11. Coaching Checkboxes',
    summary: 'Coaching checkboxes record what coaching was actually given on each call.',
    bullets: [
      'Check only the items you actually coached during the call.',
      'Search name for every call and Do not volunteer information are available when those coaching topics were covered.',
      'Search name for every call and Do not volunteer information appear before Other, which stays last for custom notes.',
      'Helper text appears below coaching items when extra guidance is configured, and child checkboxes stay disabled until their parent item is checked.',
      'Coaching selections feed the Coaching Summary on the Review screen.',
      'Use Other notes only when no existing checkbox describes the coaching clearly.',
    ],
  },
  {
    id: 'fail-reasons',
    title: '12. Fail Reason Checkboxes',
    summary: 'Fail reasons explain why a call did not pass.',
    bullets: [
      'When a call is marked FAIL, select at least one fail reason.',
      'For any checked fail reason except Other, use + Add detail only when you need to capture what specifically happened.',
      'Fail reason details stay tied to that specific checked reason and appear in the Review summaries.',
      'Pick every reason that applies; the Review summary lists all of them.',
      'Use Other notes only when the existing list does not describe the issue.',
    ],
  },
  {
    id: 'autofail-stopped-responding',
    title: '13. Stopped Responding Auto-Fail',
    summary: 'Stopped Responding ends the session as a fail when the candidate goes silent and will not respond.',
    bullets: [
      'Use the red Stopped Responding button only after a real attempt to re-engage the candidate.',
      'It immediately ends the session and routes to Review with Stopped Responding recorded.',
      'This is different from Tech Issue: pick Stopped Responding only when the candidate, not technology, is the problem.',
    ],
  },
  {
    id: 'supervisor-transfer',
    title: '14. Supervisor Transfer',
    summary: 'Supervisor Transfer verifies the candidate can complete the transfer process correctly.',
    bullets: [
      'Post the Discord queue message and use the WXYZ supervisor test number.',
      'Choose caller, show, and supervisor reason before scoring the transfer.',
      'Supervisor Transfer payment dropdowns use saved Settings options and start on Default.',
      'When Supervisor Transfer 1 fails, use the Fail Reasons copy button to copy the Failed 1st Sup Transfer Discord post.',
      'Pass Transfer 1 to complete the transfer requirement.',
      'If both transfers fail, the session routes to Newbie Shift follow-up.',
    ],
  },
  {
    id: 'supervisor-only',
    title: '15. Supervisor Transfer Only',
    summary: 'Use this when mock calls were already completed earlier and only the transfer portion remains.',
    bullets: [
      'Choose Supervisor Transfer Only from Home.',
      'Choose Yes when you conducted the original mock calls; the app uses local Smart Resume and matching local history.',
      'Choose No when another tester conducted the original mock calls; the app loads the shared pending supervisor-transfer queue.',
      'Selecting a shared pending candidate loads the prior call results, prior notes, and available Basics information, then goes directly to Supervisor Transfer Call 1.',
      'If a pending shared record is missing Basics, the app searches prior sessions for the most recent usable Basics for that candidate.',
      'If shared candidate records cannot be reached, the app shows a local-only notice and continues without blocking the workflow.',
      'Fresh supervisor-only sessions still run through Basics first when no resumable local or shared record is selected.',
      'For a No Call/No Show on the transfer-only appointment, use the Supervisor Transfer NC/NS action and confirm the choice before Review.',
    ],
  },
  {
    id: 'newbie-shift',
    title: '16. Newbie Shift',
    summary: 'Newbie Shift schedules follow-up work when a candidate cannot complete the flow today.',
    bullets: [
      'Enter the follow-up date, start time, AM/PM, and timezone.',
      'Use Add to Google Calendar to open a prefilled calendar event.',
      'Use the Supervisor Transfer time-check popup to copy the Out of Time (Needs Sup) Discord post when there is not enough time to complete Supervisor Transfers.',
      'Use Reschedule from History only for an eligible incomplete session that still needs Newbie Shift or Supervisor Transfer follow-up.',
      'Choose who needed the change and select one reason. Other requires additional details before you can continue.',
      'Select the new date, time, and timezone after providing the reason.',
      'A candidate-requested change may count as an attempt based on when it was requested. Approval may remain Pending until an admin reviews it.',
      'Use the editable temporary Discord post when the reschedule needs to be shared with the admin team.',
      'The Temporary Discord Post is shown by default for initial scheduling and rescheduling. It never adds @mentions automatically; add any required tags manually.',
      'Continue to Review to save the Newbie Shift details on the session.',
    ],
  },
  {
    id: 'review',
    title: '17. Review Screen',
    summary: 'Review is the final checkpoint before filling forms or saving the session.',
    bullets: [
      'Confirm the final status, call results, transfer results, and any auto-fail reason.',
      'Review should show the Basics information for the session, including headset, VPN, and browser checks when available.',
      'Read the Coaching Summary and Fail Summary before using them anywhere else.',
      'If the overall session passes with one failed call, that failed call information belongs in Coaching Summary, not the Fail Summary.',
      'Failed supervisor-transfer details also stay in Coaching Summary when the session passes or remains incomplete.',
      'Failed call or failed supervisor-transfer details stay in Coaching Summary when the overall session passed or remains incomplete.',
      'Reason for Fail Summary is only used when the overall session fails.',
      'Summaries can always be edited manually before Fill Form or Save and Finish.',
      'Final Readiness Judgment lets the evaluator keep the calculated result or override it with a final result and reason.',
      'When an override is applied, summaries and saved history preserve both the calculated result and the final evaluator result.',
      'Use Fill Form to push session data into the certification form.',
      'Form Filled means MTS completed filling the Microsoft Form. It does not mean the trainer clicked Submit.',
      'Not Yet Filled means the fill action has not completed. Fill Failed means the browser automation did not complete.',
      'If MTS says the form was filled but session status could not be updated, do not fill it again. Refresh History or contact support.',
      'Save and Finish stores the session in local History, immediately updates shared Candidate Sessions, and updates Pending Sup Transfers when applicable.',
      'If the shared candidate update fails, the local save still completes and the app shows a trainer-safe warning.',
    ],
  },
  {
    id: 'generic-summaries',
    title: '18. Generic Summaries',
    summary: 'Generic summaries are built from your coaching and fail-reason selections without using AI.',
    bullets: [
      'No setup is required. Generic summaries always work.',
      'They list the selected coaching items and fail reasons in plain text.',
      'Use them as-is, or turn on Gemini for cleaner wording (see next topic).',
    ],
  },
  {
    id: 'gemini-summaries',
    title: '19. Gemini Summaries',
    summary: 'Gemini summaries rewrite the generic summary into more polished management-facing wording.',
    bullets: [
      'Gemini is optional. The app still creates generic summaries without it.',
      'Gemini only rewrites the wording; it does not change pass/fail status or routing.',
      'Turn Gemini on in Settings -> Gemini AI after adding an API key (next topic).',
      'Use Test Gemini Connection after saving the key. If it fails, the status shows a friendly connection message without exposing the key.',
      'If the API key is typed or already saved, Settings shows the key as configured instead of saying no key is configured.',
      'If Gemini connects but the test response is blocked or empty, try again later or use a simpler prompt.',
      'Typical usage in this app is light, often fewer than 5 AI calls per day.',
    ],
  },
  {
    id: 'gemini-setup',
    title: '20. How to get and add a free Gemini API key',
    summary: 'A short, beginner-friendly walkthrough for adding Gemini to Mock Testing Suite.',
    bullets: [
      'Gemini is optional. The app can still create generic summaries without it.',
      'Gemini just makes the coaching and fail summaries sound more polished.',
      'Do not share your API key publicly. Treat it like a password.',
    ],
    steps: [
      'Open Google AI Studio in your browser: https://aistudio.google.com',
      'Sign in with your Google account.',
      'Create or get a Gemini API key from Google AI Studio.',
      'Copy the API key to your clipboard.',
      'In Mock Testing Suite, open Settings.',
      'Go to the Gemini AI tab.',
      'Turn on Enable Gemini AI Summaries.',
      'Paste your API key into the Gemini API Key box.',
      'Click Save Settings.',
      'Open a session and check Review - Gemini will now polish the coaching and fail summaries.',
    ],
  },
  {
    id: 'fill-form',
    title: '21. Fill Form',
    summary: 'Fill Form pushes session data into the configured Microsoft certification form using a browser.',
    bullets: [
      'Use Fill Form from Review before closing the active session.',
      'The app maps known session data into the form, but you should still confirm everything before submitting.',
      'When Tech Issue includes Other notes, Fill Form checks Other and fills the Other text field.',
      'If Fill Form fails, check the form URL and browser setting in Settings.',
    ],
  },
  {
    id: 'history-fill-form',
    title: '22. History and Historical Fill Form',
    summary: 'History stores recent local sessions. You can reopen a session in read-only Review or fill the form from it again.',
    bullets: [
      'Open History from Home to see recent sessions tested on this app/user.',
      'Local History is retained for recent work only and can be cleared or deleted by the tester without deleting SAM admin candidate history.',
      'Shared candidate records remain available for older or cross-tester lookup unless an administrator approves their removal.',
      'Click a session to view summary details, or open it in Historical Review (read-only).',
      'Use View to inspect a saved session, Reschedule for an eligible incomplete follow-up, and Delete to choose whether only local History should be removed.',
      'History shows the session result, form status, and follow-up status. Follow-up may be Pending, Approved, or Denied.',
      'Historical Fill Form runs Fill Form from a saved record without changing the active session. Confirm carefully before filling a record again.',
    ],
  },
  {
    id: 'settings',
    title: '23. Settings',
    summary: 'Settings controls your profile, integrations, and app preferences.',
    bullets: [
      'General: tester identity, workflow links, browser behavior, welcome voice, sound volume, theme, and ticker speed.',
      'Female welcome audio files use -f before .mp3, such as welcome-shawn-f.mp3.',
      'Missing personalized welcome files fall back to default welcome audio.',
      'Sound volume controls welcome audio and app sound effects.',
      'Ticker speed can be changed in Setup Wizard or Settings and falls back to Normal when missing.',
      'Payment Settings starts with 3 Credit Card defaults and 3 EFT defaults. Admins or evaluators can add or remove payment simulation options.',
      'Call and Supervisor Transfer payment dropdowns show saved options and reset to Default for each new call or transfer.',
      'Sound Volume supports Off, Low, Medium, and High.',
      'Admin lists: shows, callers, coaching items, fail reasons, Discord posts, screenshots, Gemini AI, and Calendar.',
      'Help content is not editable from normal Settings.',
      'Notifications are managed by admins in SAM, not from normal MTS Settings.',
    ],
  },
  {
    id: 'discord',
    title: '24. Discord Posts and Screenshots',
    summary: 'The Discord panel keeps reusable Discord messages and screenshot images close at hand during a session.',
    bullets: [
      'Open Discord Post from the sidebar.',
      'Use Category to filter grouped templates or screenshots when categories are configured. Search still works within the selected category.',
      'The search box is focused automatically. Type to filter templates immediately.',
      'Search is the fastest default workflow. The search box is the primary control and filters as you type.',
      'Favorites are accessed with the Favorites filter chip, and Recent posts are accessed with the Recent filter chip. They do not take over the default list.',
      'Category badges are color-coded so common areas such as Calls, Supervisor Transfer, VPN, Headsets, Discord Audio, Screen Share, and Technical Issues are recognizable without reading every row.',
      'Suggested posts appear when the current session clearly points to headset, VPN, tech issue, no script pop, or supervisor-transfer needs.',
      'Select a template to preview the full post on the right with notes and up to three configured suggested screenshots.',
      'Use Copy Post for the Discord text. Use Copy Screenshot on each suggested screenshot image. Copying both together depends on clipboard and Discord paste support, so copy the post and screenshot separately if needed.',
      'Double-click a Discord post to copy it immediately. Copy buttons and the confirmation toast show Copied when successful.',
      'Keyboard shortcuts: Ctrl+D opens Discord Posts, Ctrl+Shift+D opens the Screenshot Library, Ctrl+F or Cmd+F focuses search, Ctrl+Shift+F shows Favorites, Arrow Up/Down moves through templates, Enter copies the selected/top result, and Escape closes the modal.',
      'Category shortcuts: Alt+1 Calls, Alt+2 Supervisor Transfer, Alt+3 VPN, Alt+4 Headsets, Alt+5 Discord Audio, Alt+6 Screen Share, Alt+7 Technical Issues, and Alt+8 Favorites.',
      'Favorite shortcuts are customized in Settings -> Discord -> Productivity with the Press Shortcut recorder. Click Press Shortcut and press the desired key combination; do not type the shortcut manually.',
      'Some workflow fail popups and follow-up screens also copy specific Discord templates directly from this same content.',
      'Switch to Screenshots to preview and copy any configured screenshot image. Screenshot copy buttons also show Copied when successful.',
      'Use Screenshots -> Discord Posts to open the centralized Phonetics.png reference when supported.',
      'Templates, suggested screenshots, screenshot image rows, shortcut behavior, automatic copy, confirmation toast, and favorite shortcut assignments are managed in Settings.',
    ],
  },
  {
    id: 'discord-productivity',
    title: '25. Discord Productivity',
    summary: 'Discord Productivity adds a Command Palette and configurable shortcuts so trainers can find and copy posts without browsing long lists.',
    bullets: [
      'Command Palette: press Ctrl+Shift+P to open Discord Posts and show the centered Discord Command Palette. Search Discord posts by title, category, keyword, or alias.',
      'Searching: type terms such as vpn, head, transfer, or audio to filter instantly. Arrow Up/Down changes the selected result.',
      'Copy from palette: press Enter to copy the selected Discord post, close the palette, and show the Copied confirmation.',
      'Favorites: use the Favorites filter chip to show only favorite posts. Favorite posts can also have direct shortcuts such as Ctrl+1 Wrong Headset, Ctrl+2 VPN Failed, Ctrl+3 Change DTE, Ctrl+4 Supervisor Failed, and Ctrl+5 Technical Issue.',
      'Recent: copied posts are tracked locally and are available through the Recent filter chip, keeping the default list uncluttered.',
      'Categories: color-coded badges and Alt+1 through Alt+8 shortcuts jump to Calls, Supervisor Transfer, VPN, Headsets, Discord Audio, Screen Share, Technical Issues, and Favorites.',
      'Preview: selecting a post shows the full message, notes, Copy Post action, and any configured screenshot previews.',
      'Suggested screenshots: admins can link zero, one, two, or three screenshots to each Discord post in Settings -> Discord -> Posts. The preview labels them Screenshot 1, Screenshot 2, and Screenshot 3 in order.',
      'Copy actions: Copy Post copies only text. Copy Screenshot copies the selected image. Copy both separately if Discord or the platform clipboard does not paste text and image together reliably.',
      'Screenshots: Ctrl+Shift+D opens the Screenshot Library from the same Discord productivity workflow.',
      'Search is the fastest default workflow for mouse users. Command Palette remains available for keyboard-first access.',
      'Keyboard shortcuts: defaults can be customized in Settings -> Discord -> Productivity under Global Shortcuts, Category Shortcuts, and Favorite Shortcuts.',
      'Shortcut customization: click Edit or Press Shortcut, then press the desired key combination. The app records the real keys pressed; do not type shortcut text manually.',
      'Conflict detection: duplicate shortcut assignments are blocked and the conflicting action is shown so trainers can choose another shortcut.',
      'Restoring defaults: use Restore Default on a shortcut row to return that action to its default combination.',
      'Mouse shortcuts: double-click a Discord post row to copy immediately. Copy buttons and toast feedback confirm the clipboard update.',
    ],
  },
  {
    id: 'notifications',
    title: '26. Ticker and Notifications',
    summary: 'The ticker and notification system surfaces operational messages without blocking normal work.',
    bullets: [
      'Ticker messages scroll across the top of the app.',
      'Ticker, banner, and popup content is managed by admins through SAM.',
      'Banner and popup notifications can also appear from the same source.',
      'Ticker Speed can be set during Setup Wizard and changed later in Settings; the ticker URL is admin-only.',
    ],
  },
  {
    id: 'updates-about',
    title: '27. Updates and About',
    summary: 'Update checks and app version info live in the app menu and Settings.',
    bullets: [
      'Use the app menu or Settings update panel to check for updates.',
      'Available update details include the version, release date, release title, and release notes.',
      'When an update is required, normal use is blocked until Update Now is selected.',
      'Optional updates show release notes and can be installed now or deferred.',
      'Deferred updates can be installed later from Settings when available.',
      'When a download cannot open automatically, use the manual download option shown in the updater message.',
      'About shows the app version and support identity details (also shown on this Help screen).',
    ],
  },
  {
    id: 'tech-issues',
    title: '27. Tech Issues',
    summary: 'Use the built-in tech issue paths before ending a session for technical reasons.',
    bullets: [
      'Use Tech Issue for internet, DTE, browser, routing, or Other technical problems.',
      'Use the centralized Discord Posts screenshot reference to preview and copy the phonetics image for Discord.',
      'Follow the prompts to continue the session, go to Review, or schedule Newbie Shift.',
      'If shared candidate data is temporarily unavailable, continue with the local or manual workflow, wait a moment, and try Refresh again.',
      'If the app itself is misbehaving, restart it. Active session drafts are saved automatically.',
      'When reporting an app issue, include the screen name, the action you took, and any visible error text.',
    ],
  },
  {
    id: 'faq',
    title: '28. FAQ',
    summary: 'The FAQ panel lists short answers to common questions.',
    bullets: [
      'See the Common Questions panel on this page (right side on wide screens, below the topics on narrow screens).',
      'FAQ content is loaded from the admin-configured FAQ source, with a built-in fallback if loading fails.',
      'If the FAQ shows the fallback notice, the app could not reach the configured FAQ source. Try Help again later.',
    ],
  },
];

const REQUIRED_GUIDE_TOPICS = [
  {
    id: 'candidate-lookup',
    title: 'Candidate Lookup',
    summary: 'Candidate Lookup checks shared history before a trainer begins or resumes certification work.',
    bullets: [
      'Enter enough of the candidate name to identify the correct person, then select the matching record.',
      'Review attempt and final-attempt information before starting a new session.',
      'If shared lookup is temporarily unavailable, keep the candidate name and retry before relying on local-only history.',
    ],
  },
  {
    id: 'browser-checklist',
    title: 'Browser Checklist',
    summary: 'Browser Checklist confirms that required browser preparation is complete before calls begin.',
    bullets: [
      'Complete every visible checklist item with the candidate on Basics.',
      'Do not mark a check complete based on a similar-looking browser screen or an earlier session.',
      'If a required check cannot be completed, use Technical Issues and preserve the session for follow-up.',
    ],
  },
  {
    id: 'rescheduling-24-hour-rule',
    title: 'Rescheduling and 24-hour rule',
    summary: 'Rescheduling records who requested a Newbie Shift change and whether current timing rules affect the attempt.',
    bullets: [
      'Open Reschedule from an eligible incomplete record in History and choose who requested the change.',
      'Select the reason, enter the new schedule, and review any less-than-24-hour or final-attempt guidance.',
      'The Temporary Discord Post starts open for initial scheduling and rescheduling. Edit it before copying, add @mentions manually, and use Reset to Generated Text if needed.',
    ],
  },
  {
    id: 'sam-workflows',
    title: 'SAM Workflows',
    summary: 'Smart Alert Manager is the administrator workspace for notifications, candidate follow-up, reviews, reports, and updates.',
    bullets: [
      'Use Dashboard to see what needs attention, Notifications and Live Preview to prepare trainer alerts, and Candidate Search or Candidate Tracking to review shared candidate progress.',
      'Pending Supervisor Transfers and Pending Requests remain visible until an administrator completes the required action.',
      'Headset Review records approved or denied headset decisions, Reports support operational handoff, and Updates checks for the current SAM release.',
      'Open SAM Help for the complete step-by-step administrator guide.',
    ],
  },
  {
    id: 'status-glossary',
    title: 'Status Glossary',
    summary: 'Use these labels to understand what is complete, what needs attention, and what follow-up remains.',
    bullets: [
      'Session — Pass: certification was passed. No retry is needed; review the saved form status.',
      'Session — Resumed – Pass: a resumed session finished with a passing result. Confirm the continuation is saved.',
      'Session — Fail: certification failed and another attempt may be available. Review the fail reason and next-step guidance.',
      'Session — Fail – Final Attempt: the final allowed attempt failed. Do not start another attempt without administrator approval.',
      'Session — NC/NS: the candidate did not attend. Confirm the correct attendance choice and follow the current scheduling policy.',
      'Session — Incomplete: the session could not be completed. Review the reason and any Supervisor Transfer or Newbie Shift follow-up.',
      'Follow-Up — Pending: an administrator has not decided yet. The request remains visible until Approved or Denied.',
      'Follow-Up — Approved: the requested follow-up was approved. Continue with the approved schedule or action.',
      'Follow-Up — Denied: the request was denied. Read the denial reason before taking another action.',
      'Form — Not Yet Filled: the Microsoft Form has not been filled. Review the session and fill it when ready.',
      'Form — Form Filled: MTS completed filling the Microsoft Form. Review it in the browser; this does not mean Form Submitted.',
      'Form — Form Skipped: the trainer intentionally skipped form fill. Complete the form manually if required.',
      'Form — Fill Failed: automatic fill did not finish. Review the visible message and use the documented recovery steps.',
      'Form — Not Recorded: an older record has no saved form status. Verify manually before refilling.',
    ],
  },
];

const FAQ_FALLBACK = [
  {
    question: 'What if FAQ content does not load?',
    blocks: [{ type: 'paragraph', text: 'The app could not load the configured FAQ source. Use this packaged fallback and try Help again later.' }],
  },
  {
    question: 'Why does candidate lookup wait before showing matches?',
    blocks: [{ type: 'paragraph', text: 'Shared lookup waits for a stronger name entry so a single letter does not accidentally match the wrong candidate or trigger final-attempt warnings.' }],
  },
  {
    question: 'What if Correct Candidate cannot find previous Basics?',
    blocks: [{ type: 'paragraph', text: 'The app keeps the candidate linked and returns you to Basics with a message to complete the Basics screen before continuing.' }],
  },
  {
    question: 'What if a candidate already used their final attempt?',
    blocks: [{ type: 'paragraph', text: 'Testing is blocked unless an override is used with admin permission. The candidate should email certification@acdsupport.com for issues, and testers can ask in the Discord Tester Room.' }],
  },
  {
    question: 'How do I check a candidate IP address?',
    blocks: [{ type: 'paragraph', text: 'On Basics, expand VPN / Proxy Check, enter the public IP address, and click Check IP. If no provider is available, use manual verification.' }],
  },
  {
    question: 'What if the candidate stops responding?',
    blocks: [{ type: 'paragraph', text: 'Use the red Stopped Responding button on the current workflow screen.' }],
  },
  {
    question: 'Where is session data stored?',
    blocks: [{ type: 'paragraph', text: 'Local History stores recent sessions tested on this app. Shared candidate records remain separate for cross-tester lookup and resume workflows unless an administrator approves their removal.' }],
  },
  {
    question: 'What if Gemini says the test response was blocked or empty?',
    blocks: [{ type: 'paragraph', text: 'That means Gemini connected but did not return usable text for the test. Try again later or use a simpler prompt.' }],
  },
  {
    question: 'What if VPN/Proxy Check is unavailable or blocked?',
    blocks: [{ type: 'paragraph', text: 'If the integrated VPN/proxy check cannot run, the app falls back to manual verification. Use the manual lookup links on Basics to check the candidate IP yourself, or have the candidate turn off their VPN and recheck after a few minutes.' }],
  },
  {
    question: 'The candidate\'s headset is not on the approved list. What should I do?',
    blocks: [{ type: 'paragraph', text: 'If the headset is not listed, confirm it is USB and has a noise-cancelling microphone. Use Research Headset to look up the requirements, or type it manually if it meets the criteria. Unlisted but approved headsets are reviewed by admins every 7-10 days.' }],
  },
  {
    question: 'How do I manually look up a candidate\'s VPN/proxy status?',
    blocks: [{ type: 'paragraph', text: 'On the Basics screen, expand VPN / Proxy Check. If the integrated checker is unavailable, use the manual lookup links provided to verify the candidate\'s IP address and VPN/proxy status yourself.' }],
  },
  {
    question: 'What happens if shared session data is temporarily unavailable?',
    blocks: [{ type: 'paragraph', text: 'If shared candidate data cannot be reached, the app shows a local-only notice and continues without blocking the workflow. Retry after a short wait or refresh the app. Local session data remains available during the outage.' }],
  },
];

const TRAINER_HELP_INTERNAL_SECTION = /(?:admin setup|developer|implementation|deployment|backend|API (?:routes?|endpoints?)|SQLite|database (?:setup|schema)|schema migration|Google Sheet setup|service[- ]account|Apps Script)/i;
const TRAINER_HELP_INTERNAL_LINE_PATTERNS = [
  /google-service-account|service[- ]account/i,
  /\bGoogle Sheet\b/i,
  /\bbackend\b/i,
  /\bSQLite\b/i,
  /\bApps Script\b/i,
  /\bPowerShell\b/i,
  /\bJSON\b/i,
  /\bdebug logs?\b/i,
  /\bports?\b/i,
  /\bPROJECT_CONTEXT\.md\b/i,
  /\b(?:backend|frontend)[\\/][^\s`]*/i,
  /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/api\//i,
  /\b(?:backend|API)\s+(?:route|endpoint)s?\b/i,
  /\b(?:private key|access token|credentials?)\b/i,
  /\b(?:schema migration|schema instructions?)\b/i,
  /\b(?:update-MTS|RequiredVersion)\b/i,
];

export function sanitizeTrainerHelpMarkdown(markdown) {
  let blockedSection = false;
  return String(markdown || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => {
      const headingMatch = line.trim().match(/^#{1,2}\s+(.+)$/);
      if (headingMatch) {
        blockedSection = TRAINER_HELP_INTERNAL_SECTION.test(headingMatch[1].trim());
        return !blockedSection;
      }
      if (blockedSection) return false;
      return !TRAINER_HELP_INTERNAL_LINE_PATTERNS.some((pattern) => pattern.test(line));
    })
    .join('\n');
}

function stripFaqMarkers(text) {
  return String(text || '')
    .replace(/^\*+|\*+$/g, '')
    .trim();
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

function parseMarkdownBlocks(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'paragraph', text: paragraph.join(' ').trim() });
    paragraph = [];
  };

  const flushList = () => {
    if (!list || !list.items.length) return;
    blocks.push(list);
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2].trim() });
      continue;
    }

    const unorderedMatch = line.match(/^[-*]\s+(.+)$/);
    if (unorderedMatch) {
      flushParagraph();
      if (!list || list.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(unorderedMatch[1].trim());
      continue;
    }

    const orderedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (orderedMatch) {
      flushParagraph();
      if (!list || list.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(orderedMatch[1].trim());
      continue;
    }

    if (/^\**\s*[QA]\s*[:.\-]/i.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'paragraph', text: line });
      continue;
    }

    if (list) {
      list.items[list.items.length - 1] = `${list.items[list.items.length - 1]} ${line}`.trim();
    } else {
      paragraph.push(line);
    }
  }

  flushParagraph();
  flushList();
  return blocks;
}

function renderInline(text) {
  const parts = String(text || '').split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`strong-${index}`}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={`code-${index}`}>{part.slice(1, -1)}</code>;
    }
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a key={`link-${index}`} href={linkMatch[2]} target="_blank" rel="noopener noreferrer">
          {linkMatch[1]}
        </a>
      );
    }
    return <React.Fragment key={`text-${index}`}>{part}</React.Fragment>;
  });
}

function matchFaqQuestion(text) {
  const cleaned = stripFaqMarkers(text);
  const match = cleaned.match(/^Q\s*[:.\-]\s*(.+)$/i);
  if (!match) return '';
  return stripFaqMarkers(match[1]);
}

function matchFaqAnswer(text) {
  const cleaned = stripFaqMarkers(text);
  const match = cleaned.match(/^A\s*[:.\-]\s*(.*)$/i);
  if (!match) return null;
  return stripFaqMarkers(match[1]);
}

function buildFaqEntries(markdown) {
  const blocks = parseMarkdownBlocks(markdown);
  const entries = [];
  let current = null;

  for (const block of blocks) {
    if (block.type === 'heading' && block.level <= 2) {
      const headingText = stripFaqMarkers(block.text);
      if (/^(mock testing suite )?faq( content)?$/i.test(headingText)) {
        continue;
      }
      if (current) entries.push(current);
      current = { question: headingText, blocks: [] };
      continue;
    }

    if (block.type === 'paragraph') {
      const question = matchFaqQuestion(block.text);
      if (question) {
        if (current) entries.push(current);
        current = { question, blocks: [] };
        continue;
      }
      if (current) {
        const answer = matchFaqAnswer(block.text);
        if (answer !== null) {
          if (answer) {
            current.blocks.push({ type: 'paragraph', text: answer });
          }
          continue;
        }
      }
    }

    if (!current) continue;
    current.blocks.push(block);
  }

  if (current) entries.push(current);
  return entries.filter((entry) => entry.question && entry.blocks.length > 0);
}

function MarkdownBlock({ block }) {
  if (block.type === 'heading') {
    if (block.level === 3) {
      return <h3 className="help-doc-subheading">{renderInline(block.text)}</h3>;
    }
    return null;
  }

  if (block.type === 'ul') {
    return (
      <ul className="help-list">
        {block.items.map((item, index) => (
          <li key={`${item}-${index}`}>{renderInline(item)}</li>
        ))}
      </ul>
    );
  }

  if (block.type === 'ol') {
    return (
      <ol className="help-list help-list-numbered">
        {block.items.map((item, index) => (
          <li key={`${item}-${index}`}>{renderInline(item)}</li>
        ))}
      </ol>
    );
  }

  return <p className="help-card-body">{renderInline(block.text)}</p>;
}

function topicMatches(topic, query) {
  if (!query) return true;
  const haystack = [topic.title, topic.summary, ...(topic.bullets || []), ...(topic.steps || [])].join(' ').toLowerCase();
  return haystack.includes(query);
}

function blockText(block) {
  if (!block) return '';
  if (block.type === 'paragraph' || block.type === 'heading') return block.text || '';
  if (block.type === 'ul' || block.type === 'ol') return (block.items || []).join(' ');
  return '';
}

function buildHelpSectionsFromMarkdown(markdown) {
  if (!markdown) return [];
  const blocks = parseMarkdownBlocks(markdown);
  const sections = [];
  let current = null;

  const flush = () => {
    if (current && current.blocks.length) sections.push(current);
    current = null;
  };

  for (const block of blocks) {
    if (block.type === 'heading' && block.level <= 2) {
      const heading = String(block.text || '').trim();
      if (/^mock testing suite help/i.test(heading)) continue;
      if (/^support$/i.test(heading)) {
        flush();
        continue; // Support is rendered by the side panel
      }
      flush();
      current = { id: slugify(heading), title: heading, blocks: [] };
      continue;
    }
    if (!current) continue;
    current.blocks.push(block);
  }
  flush();
  return sections;
}

function helpSectionMatches(section, query) {
  if (!query) return true;
  const text = section.blocks.map(blockText).join(' ');
  return `${section.title} ${text}`.toLowerCase().includes(query);
}

function normalizeHelpTitle(value) {
  return String(value || '')
    .trim()
    .replace(/^\d+\.\s*/, '')
    .toLowerCase();
}

function mergeHelpTopics(liveSections) {
  if (!liveSections.length) return HELP_TOPICS;

  const liveTitles = new Set(liveSections.map((section) => normalizeHelpTitle(section.title)));
  const fallbackTopics = HELP_TOPICS.filter((topic) => !liveTitles.has(normalizeHelpTitle(topic.title)));
  return [...liveSections, ...fallbackTopics];
}

function HelpArticle({ topic, videos, onWatch }) {
  const attachedVideos = videos.filter((video) => video.helpTopicKey && video.helpTopicKey === topic.id);
  return (
    <article id={topic.id} className="card help-card help-doc-card">
      <div className="help-card-header">
        <div><div className="help-card-eyebrow">Help Topic</div><h2>{topic.title}</h2></div>
      </div>
      <h3 className="help-doc-subheading">What this is</h3>
      <p className="help-card-body">{topic.summary || `Guidance for ${normalizeHelpTitle(topic.title)}.`}</p>
      <h3 className="help-doc-subheading">When to use it</h3>
      <p className="help-card-body">Use this topic when you are working in this part of MTS or need to confirm the correct next action.</p>
      <h3 className="help-doc-subheading">Steps</h3>
      {topic.blocks?.length ? topic.blocks.map((block, index) => (
        <MarkdownBlock key={`${topic.id}-${block.type}-${index}`} block={block} />
      )) : topic.steps?.length ? (
        <ol className="help-list help-list-numbered">{topic.steps.map((item) => <li key={item}>{item}</li>)}</ol>
      ) : (
        <ul className="help-list">{(topic.bullets || []).map((item) => <li key={item}>{item}</li>)}</ul>
      )}
      <h3 className="help-doc-subheading">What happens next</h3>
      <p className="help-card-body">Continue only after the required information is complete. MTS preserves the session and shows the next available workflow action.</p>
      <h3 className="help-doc-subheading">Common mistakes</h3>
      <p className="help-card-body">Do not skip required review prompts, assume a pending request is approved, or treat Form Filled as Form Submitted.</p>
      <h3 className="help-doc-subheading">Related topics</h3>
      <p className="help-card-body"><a href="#getting-started">Getting Started</a> · <a href="#status-glossary">Status Glossary</a> · <a href="#mts-tutorial-videos">Tutorial Videos</a></p>
      {attachedVideos.length ? (
        <div className="tutorial-actions">
          {attachedVideos.map((video) => <button key={video.videoKey} type="button" onClick={() => onWatch(video)}>Watch Tutorial: {video.title}</button>)}
        </div>
      ) : null}
    </article>
  );
}

export default function HelpPage({ appVersion, onNavigate, settings, defaults, onReplayTutorial, onReplayQuickStart }) {
  const modal = useModal();
  const version = appVersion || APP_VERSION_FALLBACK;
  const geminiActive = Boolean(settings?.enable_gemini && (settings?.gemini_api_key_configured || String(settings?.gemini_api_key || '').trim()));

  const handleRequestSupport = async () => {
    const url = settings?.support_form_url || 'https://forms.gle/h3L8BZcFqpZ8RZf39';
    if (!url || !url.trim()) {
      modal.warning('Support', 'Support form is not configured yet.');
      return;
    }
    if (window.electronAPI?.openExternal) {
      await window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };
  const [helpContent, setHelpContent] = useState(null);
  const [helpLoadError, setHelpLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [selectedTutorial, setSelectedTutorial] = useState(null);
  const [managedDefaults, setManagedDefaults] = useState(defaults || {});
  const [liveContentRefreshing, setLiveContentRefreshing] = useState(false);

  useEffect(() => {
    setManagedDefaults(defaults || {});
  }, [defaults]);

  const refreshLiveContent = async () => {
    setLiveContentRefreshing(true);
    try {
      const nextDefaults = await api.getDefaults(10000, true);
      setManagedDefaults(nextDefaults || {});
    } catch (_error) {
      modal.warning('Live Content', 'Live content is taking longer than usual. Packaged guidance remains available.');
    } finally {
      setLiveContentRefreshing(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    api.getHelpContent()
      .then((payload) => {
        if (cancelled) return;
        setHelpContent(payload || {});
        setHelpLoadError('');
      })
      .catch(() => {
        if (cancelled) return;
        setHelpContent({});
        setHelpLoadError('Unable to refresh the configured Help or FAQ source right now. Showing built-in guidance.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const retryHelpContent = async () => {
    try {
      const payload = await api.getHelpContent();
      setHelpContent(payload || {});
      setHelpLoadError('');
    } catch (_error) {
      setHelpLoadError('Unable to refresh the configured Help or FAQ source right now. Showing built-in guidance.');
    }
  };

  const faqEntries = useMemo(() => {
    if (helpContent === null) return [];
    const entries = buildFaqEntries(sanitizeTrainerHelpMarkdown(helpContent?.faq_markdown || ''));
    return entries.length ? entries : FAQ_FALLBACK;
  }, [helpContent]);

  const normalizedQuery = query.trim().toLowerCase();
  const liveSections = useMemo(
    () => buildHelpSectionsFromMarkdown(sanitizeTrainerHelpMarkdown(helpContent?.help_markdown || '')),
    [helpContent],
  );
  const helpTopics = useMemo(() => [...mergeHelpTopics(liveSections), ...REQUIRED_GUIDE_TOPICS], [liveSections]);
  const mtsTutorials = useMemo(() => normalizeTutorialVideos(helpContent?.tutorial_videos?.mts, 'mts'), [helpContent]);
  const selectTutorial = (video) => {
    setSelectedTutorial(video);
    window.setTimeout(() => document.getElementById('mts-tutorial-videos')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }), 0);
  };
  const visibleTopics = useMemo(() => {
    return helpTopics.filter((topic) => (
      topic.blocks
        ? helpSectionMatches(topic, normalizedQuery)
        : topicMatches(topic, normalizedQuery)
    ));
  }, [helpTopics, normalizedQuery]);
  const support = helpContent?.support || {};
  const contentSources = managedDefaults?._content_sources || {};
  const relevantSources = ['discord_templates', 'approved_headsets', 'mts_tutorial_videos']
    .map((key) => contentSources[key])
    .filter(Boolean);
  const liveContentLoading = relevantSources.some((source) => source.background_loading);
  const liveContentConnected = relevantSources.some((source) => source.ok && source.source === 'google');
  const liveContentMessage = liveContentLoading
    ? 'Live content is connecting. Packaged guidance remains available while it finishes.'
    : liveContentConnected
      ? 'Live content is connected. Select Retry live content if an approved update has not appeared yet.'
      : 'Packaged content is available. Select Retry live content to check for approved updates.';

  return (
    <div data-testid="help-page" className="help-center-page">
      <div className="page-header-row help-center-header" data-tour="help-header">
        <button
          className="btn btn-ghost btn-sm page-back-btn"
          onClick={() => onNavigate?.('home', null)}
          data-testid="help-back"
          title="Return to Home"
        >
          ← Back
        </button>
        <div className="help-center-header-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => onReplayQuickStart?.()} data-testid="help-quick-start-choices">
            Quick Start Choices
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => onReplayTutorial?.()} data-testid="help-tutorial">
            Replay Guided Walkthrough
          </button>
        </div>
      </div>

      <section className="help-hero">
        <div className="help-hero-copy">
          <h1>Mock Testing Suite Help Center</h1>
          <p>
            Quick guidance for running mock sessions, handling auto-fails, filling certification forms,
            managing Discord assets, and using app settings.
          </p>
          <div className="help-hero-pills">
            <span className="help-pill">Version v{version}</span>
            <span className="help-pill">{geminiActive ? 'Gemini summaries enabled' : 'Generic summaries available'}</span>
          </div>
          <div className="help-common-tasks" aria-label="Common help tasks">
            <a href="#tutorial" className="help-common-task">Guided Walkthrough</a>
            <button type="button" className="help-common-task" onClick={handleRequestSupport}>Request App Support</button>
            <a href="#mts-tutorial-videos" className="help-common-task">Tutorial Videos</a>
          </div>
          <div className="help-hero-tips" aria-label="Quick tips">
            <div className="help-hero-tip">
              <span className="help-hero-tip-icon" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </span>
              <div>
                <strong>Active drafts auto-save</strong>
                <span>Switch screens freely - your session progress is preserved.</span>
              </div>
            </div>
            <div className="help-hero-tip">
              <span className="help-hero-tip-icon" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
              </span>
              <div>
                <strong>Need help?</strong>
                <span>Use Request App Support on the right - or jump to a topic below.</span>
              </div>
            </div>
          </div>
          {helpLoadError ? <div className="help-note">{helpLoadError}</div> : null}
        </div>
        <div className="help-hero-panel">
          <div className="help-hero-panel-head">
            <div className="help-card-eyebrow">Need Help Fast?</div>
            <h2>Quick Actions</h2>
          </div>
          <button
            type="button"
            className="btn btn-warning help-support-cta"
            onClick={handleRequestSupport}
            data-testid="support-request-btn"
          >
            <span className="help-support-cta-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
            </span>
            Request App Support
          </button>
          <label className="help-hero-search" htmlFor="help-hero-search">
            <span>Search Help</span>
            <input
              id="help-hero-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search Basics, Discord, Review..."
              data-testid="help-hero-search"
            />
          </label>
          <div className="help-hero-action-list">
            <button className="btn btn-primary" onClick={() => onReplayTutorial?.()} data-testid="help-quick-replay">
              Replay Guided Walkthrough
            </button>
            <button className="btn btn-ghost" onClick={() => onReplayQuickStart?.()}>Show Quick Start Choices</button>
            <button className="btn btn-ghost" onClick={() => onNavigate?.('settings', null)}>
              Open Settings
            </button>
            <button className="btn btn-ghost" onClick={() => onNavigate?.('history', null)}>
              Open History
            </button>
          </div>
          {geminiActive ? (
            <div className="help-gemini-brand">
              <img src={geminiActiveGraphic} alt="Gemini enabled" />
              <span>Gemini is configured for cleaner coaching and fail summary wording.</span>
            </div>
          ) : (
            <p className="text-muted text-sm help-hero-footnote">
              Gemini is optional. The app still creates generic summaries from selected coaching and fail reasons.
            </p>
          )}
        </div>
      </section>

      <section className="help-anchor-nav card">
        <div className="help-anchor-title">
          <h2>Browse Topics</h2>
          <p className="text-muted text-sm">Jump to the section you need. {visibleTopics.length} topic{visibleTopics.length === 1 ? '' : 's'} match your search.</p>
        </div>
        <div className="help-anchor-grid" aria-label="Help home sections">
          {HELP_HOME_GROUPS.map(([label, href]) => <a key={label} href={href} className="help-anchor-link">{label}</a>)}
        </div>
        <div className="help-category-grid">
          {HELP_CATEGORIES.map((category) => (
            <a key={category.id} href={`#${category.anchor}`} className="help-category-card">
              <span className="help-category-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: category.icon }} />
              <span className="help-category-text">
                <span className="help-category-title">{category.title}</span>
                <span className="help-category-desc">{category.description}</span>
              </span>
            </a>
          ))}
        </div>
        {normalizedQuery ? (
          <div className="help-anchor-grid help-anchor-grid-search">
            {visibleTopics.map((topic) => (
              <a key={topic.id} href={`#${topic.id}`} className="help-anchor-link">
                {topic.title}
              </a>
            ))}
          </div>
        ) : null}
      </section>

      <section className="help-doc-grid">
        <div className="help-doc-column">
          {visibleTopics.length ? visibleTopics.map((topic) => (
            <HelpArticle key={topic.id} topic={topic} videos={mtsTutorials} onWatch={selectTutorial} />
          )) : (
            <div className="card help-empty-state">
              <h2>No topics match that search.</h2>
              <p className="help-card-body">Try a shorter term such as Settings, Review, Discord, or Form.</p>
            </div>
          )}
        </div>

        <aside className="help-support-column">
          <div className="card help-support-card">
            <div className="help-card-eyebrow">Support</div>
            <h2>Support & Tech Issues</h2>

            <div className="help-troubleshooting-section">
              <div className="help-support-tip help-support-tip-info">
                <strong>Live Content Connection</strong>
                <span>{liveContentMessage}</span>
                <button type="button" className="btn btn-ghost btn-sm" disabled={liveContentRefreshing} onClick={refreshLiveContent}>
                  {liveContentRefreshing ? 'Checking...' : 'Retry live content'}
                </button>
              </div>
              <div className="help-support-tip help-support-tip-warn">
                <strong>Live Ticker</strong>
                <span>If live ticker messages do not refresh, wait a minute, refresh the app, and contact support if the issue continues.</span>
              </div>
              <div className="help-support-tip help-support-tip-success">
                <strong>App Support Form</strong>
                <span>For feature requests, bug reports, or account overrides, please submit a ticket using the button below or visit the Discord Tester Room.</span>
              </div>
            </div>

            <p className="help-card-body help-support-intro">
              {support.intro || `Mock Testing Suite version ${version}. Include the screen, the action you took, and any visible message when reporting issues.`}
            </p>
            <div className="help-support-actions">
              <button
                type="button"
                className="btn btn-warning help-support-primary"
                onClick={handleRequestSupport}
                data-testid="support-request-btn-secondary"
              >
                Request App Support
              </button>
              <div className="help-support-secondary-row">
                <a
                  href={`mailto:${support.email || 'blyshawnp@gmail.com'}?subject=Mock%20Testing%20Suite%20Support`}
                  className="btn btn-primary help-support-secondary"
                  data-testid="support-email"
                >
                  Send Email
                </a>
                <a
                  href={support.discord_url || 'https://discord.com/users/shawnbly'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn help-support-discord"
                  data-testid="support-discord"
                >
                  Discord
                </a>
              </div>
            </div>
            <div className="help-about-block">
              <p><strong>Version:</strong> {version}</p>
              <p><strong>Email:</strong> {support.email || 'blyshawnp@gmail.com'}</p>
              <p><strong>Discord:</strong> {support.discord_name || 'shawnbly'}</p>
              <p><strong>Support note:</strong> {support.footer || 'Include the page name, action taken, and any visible message.'}</p>
            </div>
          </div>

          <div className="card help-support-card" id="faq">
            <div className="help-card-eyebrow">FAQ</div>
            <h2>Common Questions</h2>
            <div className="help-faq-list" data-testid="help-faq-list">
              {faqEntries.length ? faqEntries.map((entry) => (
                <div key={entry.question} className="help-faq-item">
                  <p><strong>Q:</strong> {entry.question}</p>
                  <div className="help-faq-answer">
                    {entry.blocks.map((block, index) => (
                      <MarkdownBlock key={`${entry.question}-${block.type}-${index}`} block={block} />
                    ))}
                  </div>
                </div>
              )) : (
                <div className="help-faq-item">
                  <p><strong>FAQ is loading.</strong></p>
                  <div className="help-faq-answer">
                    <p className="help-card-body">Configured FAQ content will appear here shortly.</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </aside>
      </section>
      <section className="card help-card">
        <TutorialVideoLibrary videos={mtsTutorials} title="MTS Tutorial Videos" selectedVideo={selectedTutorial} onSelectVideo={setSelectedTutorial} sectionId="mts-tutorial-videos" loadError={helpLoadError} onRetry={retryHelpContent} />
      </section>
    </div>
  );
}
