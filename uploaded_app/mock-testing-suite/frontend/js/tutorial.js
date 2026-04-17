/**
 * tutorial.js — Screen-by-screen walkthrough.
 * Shows what each screen does, what buttons mean, and how to use the app.
 */
import { api } from './api.js';

const STEPS = [
  {
    icon: '🎉',
    title: 'Welcome to Mock Testing Suite!',
    body: `This tutorial walks you through each screen in the app so you know 
           exactly what to do during a mock testing session.<br><br>
           <b>The session flow is always:</b><br>
           <span style="color:var(--color-primary);font-weight:700;">
           The Basics → Mock Calls → Sup Transfers → Review
           </span><br><br>
           The app handles the routing for you — you just fill in the forms 
           and click Continue. Let's look at each screen.`,
  },
  {
    icon: '📋',
    title: 'Screen 1: The Basics',
    body: `<b>This is always your first stop.</b> You'll verify the candidate's setup before any calls begin.<br><br>
           <b>What you fill in:</b><br>
           • <b>Candidate Name</b> — required, this identifies the session<br>
           • <b>Pronouns</b> — optional, used in Gemini summaries<br>
           • <b>FINAL ATTEMPT</b> — check this if this is their last allowed attempt<br>
           • <b>Headset</b> — must be USB with noise-cancelling mic<br>
           • <b>VPN</b> — if they have one, they must be able to turn it off<br>
           • <b>Browser</b> — must be default, extensions off, pop-ups allowed<br><br>
           <b style="color:var(--color-danger);">Red buttons at the bottom:</b><br>
           • <b>NC/NS</b> — candidate didn't show up (auto-fails immediately)<br>
           • <b>Not Ready</b> — can't get set up (auto-fails)<br>
           • <b>⚠ Stopped Responding</b> — went silent in Discord (auto-fails)<br><br>
           If headset or VPN fails, the app prompts you to confirm the auto-fail.`,
  },
  {
    icon: '📞',
    title: 'Screen 2: Mock Calls (Up to 3)',
    body: `<b>You grade the candidate's mock calls here.</b> The app supports up to 3 calls but usually only needs 2.<br><br>
           <b>For each call you select:</b><br>
           • <b>Call Type</b> — New Donor or Existing Member (must pass one of each!)<br>
           • <b>Show / Caller / Donation</b> — the scenario details<br>
           • The green <b>Scenario Card</b> auto-generates what to tell the candidate<br>
           • The <b>Payment Card</b> shows the dummy credit card / EFT numbers<br><br>
           <b>After the call, you must:</b><br>
           • Click <b>PASS</b> or <b>FAIL</b><br>
           • Select <b>Coaching</b> checkboxes (required for every call, pass or fail)<br>
           • If FAIL: select <b>Fail Reasons</b> (at least one required)<br><br>
           <b style="color:var(--color-success);">Routing rules:</b><br>
           • <b>2 Passes</b> (1 New + 1 Existing) → moves to Sup Transfers<br>
           • <b>2 Fails</b> → session ends, goes to Review<br>
           • <b>1 Pass + 1 Fail</b> → Call 3 appears for another try`,
  },
  {
    icon: '🔄',
    title: 'Screen 3: Supervisor Transfers (Up to 2)',
    body: `<b>Tests the candidate's ability to transfer a call to a supervisor.</b><br><br>
           <b>At the top you'll see:</b><br>
           • The <b>WXYZ Test Transfer Number</b>: 1-828-630-7006<br>
           • A <b>Discord copy button</b> for "WXYZ Supervisor Test Call Being Queued"<br><br>
           <b>For each transfer you select:</b><br>
           • <b>Caller / Show / Reason</b> — the scenario details<br>
           • <b>PASS or FAIL</b> the transfer<br>
           • <b>Coaching checkboxes</b> — minimize dead air, Discord permission, queue change, etc.<br><br>
           <b style="color:var(--color-success);">Routing rules:</b><br>
           • <b>Pass Transfer 1</b> → done, goes to Review<br>
           • <b>Fail Transfer 1</b> → gets Transfer 2<br>
           • <b>Fail Transfer 2</b> → goes to Newbie Shift scheduling<br>
           • <b>Final attempt + Fail both</b> → goes to Review as a fail`,
  },
  {
    icon: '📅',
    title: 'Screen 4: Newbie Shift',
    body: `<b>This screen only appears if the candidate needs a follow-up session</b> 
           (failed both supervisor transfers but it's not their final attempt).<br><br>
           <b>What you do:</b><br>
           • Pick a <b>Date</b> for the follow-up shift<br>
           • Enter the <b>Start Time</b> (just type digits like "1030")<br>
           • Select <b>AM/PM</b> and <b>Timezone</b><br>
           • Click <b>📅 Add to Google Calendar</b> to create a calendar event<br><br>
           After setting the date, click <b>Continue to Review</b>.`,
  },
  {
    icon: '📝',
    title: 'Screen 5: Review & Submit',
    body: `<b>The final screen — review everything before submitting.</b><br><br>
           <b>What it shows:</b><br>
           • A colored banner: <span style="color:var(--color-success);">PASS</span> / 
             <span style="color:var(--color-danger);">FAIL</span> / 
             <span style="color:var(--color-warning);">INCOMPLETE</span><br>
           • All call and transfer results with details<br>
           • <b>Coaching Summary</b> — editable text area (auto-generated from your checkboxes, 
             or rewritten by Gemini AI if enabled)<br>
           • <b>Fail Summary</b> — editable, shows "N/A" for passing sessions<br><br>
           <b>Buttons:</b><br>
           • <b>📋 Copy</b> — copies the summary to clipboard<br>
           • <b>🔄 Regenerate</b> — asks Gemini to rewrite it (if enabled)<br>
           • <b>📝 Fill Form</b> — opens Chrome and auto-fills the Cert Form<br>
           • <b>Save & Finish ✔</b> — saves to history, sends to Google Sheets, clears the session`,
  },
  {
    icon: '⚡',
    title: 'Tips & Integrations',
    body: `<b>Global buttons available on every screen:</b><br>
           • <b>⚠ Stopped Responding</b> — instantly ends the session as a fail<br>
           • <b>🛠 Tech Issue</b> — logs technical problems<br>
           • <b>← Back</b> — go back to the previous step<br><br>
           <b>Sidebar quick links:</b><br>
           • <b>💬 Discord Post</b> — popup with copy-paste templates<br>
           • <b>📊 Tracker Sheet / Cert Spreadsheet</b> — opens external links<br><br>
           <b>Enable in Settings:</b><br>
           • 🤖 <b>Gemini AI</b> — professional summary generation<br>
           • 📊 <b>Google Sheets</b> — automatic session backup<br>
           • 📅 <b>Google Calendar</b> — one-click Newbie Shift events<br><br>
           <span style="color:var(--text-tertiary);">Detailed setup guides are in the Help tab. 
           You can replay this tutorial anytime from Help → Tutorial.</span>`,
  },
];

export function showTutorial() {
  if (document.getElementById('tutorial-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'tutorial-overlay';
  overlay.innerHTML = `
    <div class="tut-panel">
      <div class="tut-body" id="tut-body"></div>
      <div class="tut-dots" id="tut-dots"></div>
      <div class="tut-footer">
        <button class="tut-skip" id="tut-skip">Skip Tutorial</button>
        <span style="flex:1;"></span>
        <button class="btn btn-muted btn-sm" id="tut-back" style="display:none;">← Back</button>
        <button class="btn btn-primary" id="tut-next">Next →</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  let current = 0;

  function renderStep() {
    const step = STEPS[current];
    document.getElementById('tut-body').innerHTML = `
      <div class="tut-icon">${step.icon}</div>
      <div class="tut-title">${step.title}</div>
      <div class="tut-text">${step.body}</div>
    `;
    document.getElementById('tut-dots').innerHTML = STEPS.map((_, i) =>
      `<span class="tut-dot ${i === current ? 'active' : i < current ? 'done' : ''}">●</span>`
    ).join('');
    document.getElementById('tut-back').style.display = current > 0 ? 'inline-flex' : 'none';
    const nextBtn = document.getElementById('tut-next');
    if (current === STEPS.length - 1) {
      nextBtn.textContent = 'Get Started ✔';
      nextBtn.className = 'btn btn-success';
    } else {
      nextBtn.textContent = 'Next →';
      nextBtn.className = 'btn btn-primary';
    }
  }

  function close() {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 300);
    api.saveSettings({ tutorial_completed: true }).catch(() => {});
  }

  document.getElementById('tut-next').onclick = () => {
    if (current < STEPS.length - 1) { current++; renderStep(); }
    else close();
  };
  document.getElementById('tut-back').onclick = () => {
    if (current > 0) { current--; renderStep(); }
  };
  document.getElementById('tut-skip').onclick = close;

  renderStep();
}
