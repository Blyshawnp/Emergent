import React, { useState } from 'react';
import api from '../api';
import geminiActiveGraphic from '../assets/images/Gemini2.png';

const TABS = [
  { id: 'howto', label: 'How to Use' },
  { id: 'flows', label: 'Session Flows' },
  { id: 'integrations', label: 'Integration Setup' },
  { id: 'faq', label: 'FAQ' },
  { id: 'support', label: 'Support' },
];

const APP_VERSION_FALLBACK = '1.0.1';

export default function HelpPage({ appVersion, onNavigate, settings }) {
  const [tab, setTab] = useState('howto');
  const [showTutorial, setShowTutorial] = useState(false);
  const geminiActive = Boolean(settings?.enable_gemini && String(settings?.gemini_key || '').trim());

  return (
    <div data-testid="help-page">
      <div className="page-header-row">
        <button
          className="btn btn-ghost btn-sm page-back-btn"
          onClick={() => onNavigate?.('home', null)}
          data-testid="help-back"
          title="Return to Home"
        >
          ← Back
        </button>
        <h1 style={{ marginBottom: 0 }}>Help & Documentation</h1>
        <button className="btn btn-primary btn-sm" onClick={() => setShowTutorial(true)} data-testid="help-tutorial">Replay Tutorial</button>
      </div>
      <div className="tabs-header">
        {TABS.map(t => (
          <button key={t.id} className={`tab-btn ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)} data-testid={`help-tab-${t.id}`}>{t.label}</button>
        ))}
      </div>

      {tab === 'howto' && <HowToTab />}
      {tab === 'flows' && <FlowsTab />}
      {tab === 'integrations' && <IntegrationsTab geminiActive={geminiActive} />}
      {tab === 'faq' && <FaqTab />}
      {tab === 'support' && <SupportTab appVersion={appVersion} />}

      {showTutorial && <TutorialOverlay onClose={() => { setShowTutorial(false); api.saveSettings({ tutorial_completed: true }); }} />}
    </div>
  );
}

function HowToTab() {
  return (
    <div className="card" style={{ lineHeight: 1.8 }}>
      <h2 style={{ color: 'var(--color-primary)', marginBottom: 20 }}>How to Use Mock Testing Suite</h2>

      <Section title="Home Screen">
        <p>The Home screen is your dashboard. It shows your stats (Total Sessions, Pass Rate, NC/NS Rate) and recent sessions.</p>
        <ul>
          <li><b>Start New Session</b> — Begin a full mock call + supervisor transfer session</li>
          <li><b>Supervisor Transfer Only</b> — Used when a candidate previously ran out of time and only needs supervisor transfers</li>
          <li><b>Session History</b> — View all past sessions with search and detail views</li>
        </ul>
      </Section>

      <Section title="The Basics Screen">
        <p>This is the first step in every session. You'll verify the candidate's setup.</p>
        <ul>
          <li><b>Tester Name</b> — Auto-filled from your settings</li>
          <li><b>Candidate Name</b> — Type the candidate's full name (required)</li>
          <li><b>Final Attempt</b> — Mark whether this is the candidate's last allowed mock session</li>
          <li><b>Headset</b> — Must be USB with noise-cancelling microphone. If not, auto-fails</li>
          <li><b>VPN</b> — If they have one, they must turn it off. If they can't, auto-fails</li>
          <li><b>Browser</b> — Must be default, extensions off, pop-ups allowed</li>
        </ul>
        <p><b>Footer buttons:</b></p>
        <ul>
          <li><b style={{ color: 'var(--color-danger)' }}>NC/NS</b> — No Call / No Show. Instantly fails and goes to Review</li>
          <li><b style={{ color: 'var(--color-danger)' }}>Not Ready</b> — Candidate wasn't prepared for the session</li>
          <li><b style={{ color: 'var(--color-danger)' }}>Stopped Responding</b> — Candidate went silent in Discord</li>
          <li><b>Tech Issue</b> — Opens the Technical Issues dialog for troubleshooting</li>
        </ul>
      </Section>

      <Section title="Calls Screen (Up to 3)">
        <p>You'll grade up to 3 mock calls. The scenario card shows you exactly who to portray.</p>
        <ul>
          <li><b>Call Setup</b> — Select Call Type, Show, Caller, and Donation from the dropdowns</li>
          <li><b>Scenario Card</b> — Shows the caller's info, gift, and randomized variables (Phone Type, SMS, E-Newsletter, Shipping, CC Fee)</li>
          <li><b>Regenerate</b> — Re-rolls the random scenario variables without changing the call data</li>
          <li><b>Payment Simulation</b> — Shows the credit card and EFT info for the test call</li>
          <li><b>Pass/Fail</b> — Click PASS or FAIL after the call</li>
          <li><b>Coaching</b> — Select coaching checkboxes (required — if none selected, you'll be asked to confirm)</li>
          <li><b>Fail Reasons</b> — If FAIL, you must select at least one fail reason</li>
        </ul>
        <p><b>Routing logic:</b> 2 passes (1 New Donor + 1 Existing Member) → Sup Transfers. 2 fails → session ends. 1+1 → Call 3.</p>
      </Section>

      <Section title="Supervisor Transfer Screen (Up to 2)">
        <p>Tests the candidate's ability to transfer to a supervisor. Same coaching/fail flow as calls.</p>
        <ul>
          <li>Post "WXYZ Supervisor Test Call Being Queued" in Discord Stars channel</li>
          <li>Call the WXYZ number: <b>1-828-630-7006</b></li>
          <li>Pass Transfer 1 → done (go to Review). Fail both → Newbie Shift.</li>
        </ul>
      </Section>

      <Section title="Smart Resume for Supervisor Transfer Only">
        <p>The Smart Resume flow helps you continue a candidate into Supervisor Transfer when the mock calls were already completed in an earlier session.</p>
        <ul>
          <li><b>When it appears</b> — Click <b>Supervisor Transfer Only</b> from Home, then answer <b>Yes</b> when asked if you previously conducted the mock session for that candidate.</li>
          <li><b>How it finds sessions</b> — The app looks through saved history for prior mock-call sessions tied to the current tester name in Settings. It only shows sessions that already have mock call results and have not already completed supervisor transfers.</li>
          <li><b>What you’ll see</b> — If matching sessions exist, a resume picker opens so you can choose the right candidate. If none exist, the app tells you there are no resumable sessions for that tester.</li>
          <li><b>How to continue</b> — Select the candidate, confirm the prompt, and the app restores the earlier Basics and mock-call data, then opens directly on <b>Supervisor Transfer #1</b>.</li>
        </ul>
      </Section>

      <Section title="Newbie Shift Screen">
        <p>Only appears when the candidate needs a follow-up session. Pick a date, time, and timezone.</p>
        <ul>
          <li>Enter the date using the date picker or type in MM/DD/YYYY format</li>
          <li>Enter time as H:MM (e.g. 10:30)</li>
          <li><b>Add to Google Calendar</b> — Creates an event titled "Supervisor Test Call - [Candidate Name]"</li>
        </ul>
      </Section>

      <Section title="Review Screen">
        <p>Final review of the session. The Pass/Fail/Incomplete banner is calculated automatically.</p>
        <ul>
          <li><b>Coaching Summary</b> — Generated from your coaching checkboxes, with Gemini used only if enabled and configured</li>
          <li><b>Fail Summary</b> — Generated from fail reasons (N/A for passing sessions)</li>
          <li><b>Copy</b> — Copies the summary text to your clipboard</li>
          <li><b>Regenerate</b> — Rebuilds the summary from checkbox data</li>
          <li><b>Fill Form</b> — Opens the Cert Form and maps session data to form fields</li>
          <li><b>Save & Finish</b> — Saves to history and clears the session</li>
        </ul>
      </Section>

      <Section title="Discord Post Panel">
        <p>Click "Discord Post" in the sidebar to open the panel with two tabs:</p>
        <ul>
          <li><b>Templates</b> — Pre-written messages for Pass, Fail, Sup Intro, etc. Click "Copy" to copy to clipboard</li>
          <li><b>Screenshots</b> — Welcome images that can be copied to clipboard for Discord. Click "Copy Image" to copy</li>
          <li>Both tabs are searchable</li>
        </ul>
      </Section>

      <Section title="Tech Issue Button">
        <p>Available on every session screen. Opens a troubleshooting wizard:</p>
        <ul>
          <li><b>Internet Speed</b> — Asks for speed test results. Below 25 Mbps down / 10 Mbps up = fail</li>
          <li><b>Calls Won't Route</b> — Checks DTE status, then browser troubleshooting</li>
          <li><b>No Script Pop</b> — Browser troubleshooting steps</li>
          <li><b>Discord/Other</b> — Manual notes with resolution tracking</li>
        </ul>
      </Section>
    </div>
  );
}

function FlowsTab() {
  return (
    <div className="card" style={{ lineHeight: 1.8 }}>
      <h2 style={{ color: 'var(--color-primary)', marginBottom: 20 }}>Session Flows</h2>
      <Section title="Standard Full Session">
        <p>The Basics → Call 1 → Call 2 → (Call 3 if needed) → Sup Transfer 1 → (Sup Transfer 2 if needed) → Review → Save</p>
        <p><b>Pass conditions:</b> 2 passed calls (1 New Donor + 1 Existing) AND 1 passed Sup Transfer.</p>
      </Section>
      <Section title="Supervisor Transfer Only">
        <p>Used when the candidate previously completed mock calls but still needs supervisor transfers.</p>
        <ul>
          <li>If you answer <b>No</b> to the resume prompt, the app starts a fresh Supervisor Transfer Only flow through Basics and then routes straight to Supervisor Transfer.</li>
          <li>If you answer <b>Yes</b>, Smart Resume searches your saved history for prior mock-call sessions completed by the current tester and lets you continue the correct candidate into Supervisor Transfer.</li>
        </ul>
      </Section>
      <Section title="Newbie Shift (Incomplete)">
        <p>If the candidate fails both Sup Transfers or can't complete due to tech issues, a Newbie Shift is scheduled. The session is marked "Incomplete" rather than "Fail".</p>
      </Section>
      <Section title="Auto-Fail Scenarios">
        <ul>
          <li><b>NC/NS</b> — No Call / No Show</li>
          <li><b>Stopped Responding</b> — Candidate went silent in Discord</li>
          <li><b>Not Ready</b> — Incorrect setup, can't log in</li>
          <li><b>Wrong Headset</b> — Not USB or not noise-cancelling</li>
          <li><b>VPN</b> — Using VPN and can't turn it off</li>
        </ul>
      </Section>
    </div>
  );
}

function IntegrationsTab({ geminiActive }) {
  return (
    <div className="card" style={{ lineHeight: 1.8 }}>
      <h2 style={{ color: 'var(--color-primary)', marginBottom: 20 }}>Integration Setup Guides</h2>
      <p>All integrations are optional. The app works perfectly without them.</p>

      <Section title="Gemini AI — Smart Summaries">
        {geminiActive && (
          <div className="help-gemini-brand">
            <img src={geminiActiveGraphic} alt="Gemini enabled" />
            <span>Gemini summaries are enabled and configured.</span>
          </div>
        )}
        <p>Gemini is optional. When enabled and configured with your own API key, it generates coaching summaries and fail summaries from the checkboxes selected during Review.</p>
        <p>The summaries are written for management and certification form documentation. Gemini does <b>not</b> affect scoring, pass/fail decisions, routing, or any other session logic. It only helps rewrite the summary text shown on the Review screen.</p>
        <p>If Gemini is disabled, no key is saved, or Gemini fails, the app still works and automatically uses a built-in generic summary generator instead.</p>
        <h4 style={{ marginTop: 16, marginBottom: 8 }}>How to set up your own Gemini API key</h4>
        <ol style={{ paddingLeft: 20 }}>
          <li>Go to <a href="https://aistudio.google.com/" target="_blank" rel="noreferrer">https://aistudio.google.com/</a>.</li>
          <li>Sign in with your Google account.</li>
          <li>Click <b>Get API key</b>.</li>
          <li>Create a new API key.</li>
          <li>Copy the generated key.</li>
          <li>Open this app and go to <b>Settings</b>.</li>
          <li>Open the <b>Gemini AI</b> tab.</li>
          <li>Turn on <b>Enable Gemini AI Summaries</b>.</li>
          <li>Paste your key into <b>Gemini API Key</b>.</li>
          <li>Click <b>Save Settings</b>.</li>
        </ol>
        <p>The app sends your saved key only when generating summaries. There is no built-in shared Gemini key.</p>
      </Section>

      <Section title="Google Calendar">
        <p>The "Add to Google Calendar" button on the Newbie Shift screen creates a calendar event. No setup needed — it uses a Google Calendar URL template.</p>
      </Section>
    </div>
  );
}

function FaqTab() {
  return (
    <div className="card" style={{ lineHeight: 1.8 }}>
      <h2 style={{ color: 'var(--color-primary)', marginBottom: 20 }}>Frequently Asked Questions</h2>
      <FAQ q="What if the candidate stops responding?" a='Click the red "Stopped Responding" button. This instantly ends the session as a fail.' />
      <FAQ q="What if the candidate has technical issues?" a='Click "Tech Issue". The app walks you through troubleshooting: check DTE status, clear browsing data, re-login.' />
      <FAQ q="Can I go back and change something?" a='Yes — click "Back" on any screen. Your data is saved as you go.' />
      <FAQ q="What if I forget to select coaching?" a="The app will ask you to confirm if you want to continue without coaching." />
      <FAQ q='How do I do a Supervisor Transfer ONLY session?' a='On the Home screen, click "Supervisor Transfer Only". This skips Mock Calls.' />
      <FAQ q='What does "Final Attempt" mean?' a="Use this on The Basics screen when the candidate is on their last allowed attempt. The app uses it in the session flow and messaging." />
      <FAQ q='How does Smart Resume find a candidate for Supervisor Transfer Only?' a='It searches saved history for prior mock-call sessions that belong to the current tester, already have mock call results, and do not already have completed supervisor transfers.' />
      <FAQ q="What if 2 calls fail?" a="The session ends immediately and goes to Review. They should reschedule within 24 hours." />
      <FAQ q="Where is my data stored?" a="In the app's local database." />
      <FAQ q="How do I customize the Discord templates?" a='Go to Settings → Discord tab. You can add, edit, and remove both message templates and screenshot images.' />
      <FAQ q="Can I edit the caller data and shows?" a='Yes — go to Settings. The Call Types, Shows, Callers, and Sup Reasons tabs let you fully customize all scenario data.' />
    </div>
  );
}

function SupportTab({ appVersion }) {
  return (
    <div className="card" style={{ lineHeight: 1.8, textAlign: 'center' }}>
      <h2 style={{ color: 'var(--color-primary)', marginBottom: 20 }}>Get Support</h2>
      <p className="text-muted text-sm" style={{ marginBottom: 16 }}>
        Mock Testing Suite version {appVersion || APP_VERSION_FALLBACK}
      </p>
      <p style={{ marginBottom: 24 }}>Need help with the app? Reach out using one of these options:</p>
      <div style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 32 }}>
        <a href="mailto:blyshawnp@gmail.com?subject=Mock%20Testing%20Suite%20Support" className="btn btn-primary" style={{ textDecoration: 'none', padding: '14px 32px' }} data-testid="support-email">
          Send Email
        </a>
        <a href="https://discord.com/users/shawnbly" target="_blank" rel="noopener noreferrer" className="btn" style={{ textDecoration: 'none', padding: '14px 32px', background: '#5865F2', color: 'white' }} data-testid="support-discord">
          Message on Discord
        </a>
      </div>
      <div style={{ textAlign: 'left', maxWidth: 500, margin: '0 auto' }}>
        <p><b>Email:</b> blyshawnp@gmail.com</p>
        <p><b>Discord:</b> shawnbly</p>
        <p><b>About:</b> Created by Shawn Bly. Use Help → About for version details and update information.</p>
        <p className="text-muted text-sm" style={{ marginTop: 16 }}>Include a description of the issue, what screen you were on, and any error messages you saw.</p>
      </div>
    </div>
  );
}

/* ══════ Shared ══════ */
function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ marginBottom: 8 }}>{title}</h3>
      {children}
    </div>
  );
}

function FAQ({ q, a }) {
  return (
    <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--border-subtle)' }}>
      <p style={{ fontWeight: 700, marginBottom: 4 }}>Q: {q}</p>
      <p style={{ color: 'var(--text-secondary)' }}>A: {a}</p>
    </div>
  );
}

/* ══════ Tutorial ══════ */
const TUTORIAL_STEPS = [
  { title: 'Welcome to Mock Testing Suite!', body: 'This app guides you through every step of a mock call certification session. The flow is always: The Basics → Mock Calls → Sup Transfers → Review.' },
  { title: 'The Basics', body: 'First, verify the candidate\'s headset (USB, noise-cancelling), VPN, and browser setup. Red buttons at the bottom handle auto-fails for NC/NS, Not Ready, and Stopped Responding.' },
  { title: 'Mock Calls (Up to 3)', body: 'Grade calls using the Scenario Card. Select coaching checkboxes and Pass/Fail. 2 Passes (1 New + 1 Existing) moves to Sup Transfers. 2 Fails ends the session.' },
  { title: 'Supervisor Transfers', body: 'Test the candidate\'s transfer skills. Post the Discord message, call 1-828-630-7006, and grade. Pass 1 = done. Fail both = Newbie Shift.' },
  { title: 'Review & Submit', body: 'Review all results, edit summaries, fill the Cert Form, and save. The app calculates Pass/Fail/Incomplete automatically.' },
  { title: 'Settings & Customization', body: 'Customize app behavior, Gemini summaries, Discord templates, caller data, shows, payment info, and more. All in the Settings tab.' },
  { title: 'Need Help?', body: 'Check the Help tab anytime. The Support tab has direct links to email and Discord for getting help from the developer.' },
];

function TutorialOverlay({ onClose }) {
  const [step, setStep] = useState(0);
  const s = TUTORIAL_STEPS[step];
  return (
    <div className="cmodal-overlay open" data-testid="tutorial-overlay">
      <div className="cmodal" style={{ maxWidth: 580 }}>
        <div className="cmodal-title" style={{ color: 'var(--color-primary)' }}>{s.title}</div>
        <div className="cmodal-body" style={{ textAlign: 'left' }}>{s.body}</div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 16 }}>
          {TUTORIAL_STEPS.map((_, i) => <span key={i} style={{ width: 8, height: 8, borderRadius: '50%', background: i === step ? 'var(--color-primary)' : 'var(--border-default)', display: 'inline-block' }} />)}
        </div>
        <div className="cmodal-btns">
          <button className="btn btn-muted btn-sm" onClick={onClose}>Skip</button>
          <span style={{ flex: 1 }} />
          {step > 0 && <button className="btn btn-muted btn-sm" onClick={() => setStep(step - 1)}>Back</button>}
          <button className={`btn ${step === TUTORIAL_STEPS.length - 1 ? 'btn-success' : 'btn-primary'}`} onClick={() => { if (step < TUTORIAL_STEPS.length - 1) setStep(step + 1); else onClose(); }}>
            {step === TUTORIAL_STEPS.length - 1 ? 'Get Started' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
