/**
 * help.js — User-facing Help & Documentation.
 * No admin/dev instructions (ticker, update URLs, etc.).
 */
import { api } from '../api.js';
import { showTutorial } from '../tutorial.js';

const TABS = [
  { id: 'instructions', label: '📖 Instructions' },
  { id: 'faq', label: '❓ FAQ' },
  { id: 'integrations', label: '🔌 Integrations' },
  { id: 'troubleshooting', label: '🛠 Troubleshooting' },
];

export async function render(content, footer) {
  content.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-lg);">
      <h1>Help &amp; Documentation</h1>
      <button class="btn btn-primary btn-sm" id="help-replay-tutorial">🎓 Replay Tutorial</button>
    </div>

    <div class="tabs-header" id="help-tabs">
      ${TABS.map((t, i) => `<button class="tab-btn ${i === 0 ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
    </div>

    <div id="help-panels">
      <!-- INSTRUCTIONS -->
      <div class="help-panel card" data-panel="instructions" style="line-height:1.8;">
        <h2 style="color:var(--color-primary);margin-bottom:var(--space-lg);">Complete Session Guide</h2>

        <h3>Before You Begin</h3>
        <p>Make sure the candidate is in the Discord chat and ready. Confirm they have their headset plugged in, browser open, and are logged into Gateway, Simple Script, and Call Corp.</p>

        <h3 style="margin-top:var(--space-lg);">Step 1: The Basics</h3>
        <p>Enter the candidate's name and verify their technical setup:</p>
        <ul><li><b>Headset:</b> Must be USB with a noise-cancelling microphone.</li>
        <li><b>VPN:</b> If they have one, they must turn it off.</li>
        <li><b>Browser:</b> Default browser, extensions off, pop-ups allowed.</li>
        <li><b>Final Attempt:</b> Check if this is their last mock session.</li></ul>

        <h3 style="margin-top:var(--space-lg);">Step 2: Mock Calls (2-3 calls)</h3>
        <p>The candidate must pass <b>two calls</b> — one as a <b>New Donor</b> and one as an <b>Existing Member</b>.</p>
        <ul><li>Select Call Type, Show, Caller, and Donation from the dropdowns.</li>
        <li>The green Scenario Card auto-generates what to tell the candidate.</li>
        <li>Click <b>PASS</b> or <b>FAIL</b> after each call.</li>
        <li>Select <b>Coaching checkboxes</b> for every call (required).</li>
        <li>If FAIL: select at least one <b>Fail Reason</b>.</li></ul>
        <p><b>Routing:</b> 2 passes → Sup Transfers. 2 fails → session ends. 1+1 → Call 3.</p>

        <h3 style="margin-top:var(--space-lg);">Step 3: Supervisor Transfers (1-2 transfers)</h3>
        <ul><li>Post "WXYZ Supervisor Test Call Being Queued" in Stars Discord channel.</li>
        <li>Call the WXYZ number: <b>1-828-630-7006</b></li>
        <li>Grade with PASS/FAIL and coaching checkboxes.</li>
        <li>Pass Transfer 1 → done. Fail both → Newbie Shift.</li></ul>

        <h3 style="margin-top:var(--space-lg);">Step 4: Newbie Shift (if needed)</h3>
        <p>Pick a date, time, and timezone. Use the Google Calendar button to create an event.</p>

        <h3 style="margin-top:var(--space-lg);">Step 5: Review &amp; Submit</h3>
        <ul><li>Pass/Fail/Incomplete banner is calculated automatically.</li>
        <li>Coaching and Fail summaries are generated from your checkboxes.</li>
        <li><b>📝 Fill Form</b> opens Chrome and auto-fills the Cert Form.</li>
        <li><b>Save &amp; Finish</b> saves to history and clears the session.</li></ul>

        <h3 style="margin-top:var(--space-lg);">Interruptions (Any Screen)</h3>
        <ul><li><b style="color:var(--color-danger);">NC/NS</b> — No Call / No Show. Auto-fails.</li>
        <li><b style="color:var(--color-danger);">⚠ Stopped Responding</b> — Candidate went silent. Auto-fails.</li>
        <li><b>🛠 Tech Issue</b> — Logs technical problems.</li>
        <li><b>← Back</b> — Returns to the previous screen.</li></ul>
      </div>

      <!-- FAQ -->
      <div class="help-panel card" data-panel="faq" style="display:none;line-height:1.8;">
        <h2 style="color:var(--color-primary);margin-bottom:var(--space-lg);">Frequently Asked Questions</h2>
        ${faq('What if the candidate stops responding?', 'Click the red "⚠ Stopped Responding" button. This instantly ends the session as a fail.')}
        ${faq('What if the candidate has technical issues?', 'Click "🛠 Tech Issue". The app walks you through troubleshooting: check DTE status, clear browsing data, re-login.')}
        ${faq('Can I go back and change something?', 'Yes — click "← Back" on any screen. Your data is saved as you go.')}
        ${faq('What if I forget to select coaching?', 'The app won\'t let you continue without selecting at least one coaching checkbox.')}
        ${faq('How do I do a Supervisor Transfer ONLY session?', 'On the Home screen, click "🔄 Supervisor Transfer Only". This skips Mock Calls.')}
        ${faq('What does "Final Attempt" mean?', 'If this is the candidate\'s last allowed attempt, check the box. The messaging changes to tell them they\'ve exceeded allowed attempts.')}
        ${faq('What if 2 calls fail?', 'The session ends immediately and goes to Review. They should reschedule in Gateway within 24 hours.')}
        ${faq('Do I need one New Donor AND one Existing Member pass?', 'Yes. The app enforces this — if both passes are the same type, it prompts you to change.')}
        ${faq('Where is my data stored?', 'Locally in the app\'s data folder — settings.json, history.json, current_draft.json. Nothing goes online unless Google Sheets is enabled.')}
        ${faq('How does auto-save work?', 'The app saves your session draft every 60 seconds. If it crashes, your session is recovered on reopen.')}
        ${faq('Can I edit the Discord message templates?', 'Yes — go to Settings → Discord tab. Add, edit, or remove templates.')}
        ${faq('What is the scrolling bar at the top?', 'The ticker shows announcements and reminders from your team.')}
        ${faq('How do I reset the app?', 'Delete the data/ folder inside the app. On next launch, everything resets to defaults.')}
      </div>

      <!-- INTEGRATIONS -->
      <div class="help-panel card" data-panel="integrations" style="display:none;line-height:1.8;">
        <h2 style="color:var(--color-primary);margin-bottom:var(--space-lg);">Integration Setup Guides</h2>
        <p>All integrations are optional. The app works perfectly without them.</p>

        <h3 style="margin-top:var(--space-xl);">🤖 Gemini AI — Smart Summaries</h3>
        <p>Rewrites your coaching and fail summaries into clean, professional language.</p>
        <ol><li>Go to <b>aistudio.google.com</b></li>
        <li>Sign in → click <b>Get API Key</b> → <b>Create API key</b></li>
        <li>Copy the key</li>
        <li>In this app: <b>Settings → Gemini</b> → paste key → check Enable → Save</li></ol>
        <p class="text-muted text-sm">Free for personal use. The key stays on your computer.</p>

        <h3 style="margin-top:var(--space-xl);">📊 Google Sheets — Auto Backup</h3>
        <p>Logs every session to a Google Spreadsheet automatically.</p>
        <ol><li>Go to <b>console.cloud.google.com</b></li>
        <li>Create a project → enable <b>Google Sheets API</b> + <b>Google Drive API</b></li>
        <li>Go to Credentials → <b>Service Account</b> → create one</li>
        <li>Keys tab → <b>Add Key → JSON</b> → download the file</li>
        <li>Rename to <b>service_account.json</b> → put in app's backend folder</li>
        <li>Open the JSON → copy the <b>client_email</b></li>
        <li>Share your Google Sheet with that email (Editor access)</li>
        <li>Copy the <b>Spreadsheet ID</b> from the Sheet URL</li>
        <li>In this app: <b>Settings → Google Sheet</b> → paste ID → check Enable → Save</li></ol>

        <h3 style="margin-top:var(--space-xl);">📅 Google Calendar</h3>
        <p>The "Add to Google Calendar" button on Newbie Shift creates a calendar event. No setup needed.</p>

        <h3 style="margin-top:var(--space-xl);">📝 Form Filler</h3>
        <p>Auto-fills the Cert Form in Chrome. Requires Google Chrome to be installed.</p>
      </div>

      <!-- TROUBLESHOOTING -->
      <div class="help-panel card" data-panel="troubleshooting" style="display:none;line-height:1.8;">
        <h2 style="color:var(--color-primary);margin-bottom:var(--space-lg);">Troubleshooting</h2>
        ${issue('Form filler crashes or Chrome doesn\'t open', 'Make sure Google Chrome is installed. The form filler uses Chrome specifically.')}
        ${issue('Google Sheets says "permission denied"', 'Open the service_account.json file, find the <code>client_email</code>, and share your Sheet with that email address.')}
        ${issue('Gemini says "API key not valid"', 'Go to aistudio.google.com, create a new API key, and paste it in Settings → Gemini.')}
        ${issue('Session data lost after crash', 'The app auto-saves every 60 seconds. On reopen, your session should be recovered from the draft file.')}
        ${issue('The app looks broken or glitchy', 'Close and reopen the app. If the issue persists, delete the data/ folder to reset.')}
      </div>
    </div>
  `;

  document.querySelectorAll('#help-tabs .tab-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#help-tabs .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.help-panel').forEach(p => p.style.display = 'none');
      document.querySelector(`.help-panel[data-panel="${btn.dataset.tab}"]`).style.display = 'block';
    };
  });

  document.getElementById('help-replay-tutorial').onclick = showTutorial;
  footer.innerHTML = '';
}

function faq(q, a) {
  return `<div style="margin-bottom:var(--space-md);padding-bottom:var(--space-md);border-bottom:1px solid var(--border-subtle);">
    <p style="font-weight:700;margin-bottom:4px;">Q: ${q}</p>
    <p style="color:var(--text-secondary);">A: ${a}</p></div>`;
}

function issue(title, solution) {
  return `<div style="margin-bottom:var(--space-md);padding-bottom:var(--space-md);border-bottom:1px solid var(--border-subtle);">
    <p style="font-weight:700;color:var(--color-danger);margin-bottom:4px;">${title}</p>
    <p style="color:var(--text-secondary);">${solution}</p></div>`;
}
