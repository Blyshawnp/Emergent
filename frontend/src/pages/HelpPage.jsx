import React from 'react';
import geminiActiveGraphic from '../assets/images/Gemini2.png';

const APP_VERSION_FALLBACK = '1.0.1';

const HELP_SECTIONS = [
  {
    id: 'getting-started',
    eyebrow: 'Start Here',
    title: 'Getting Started',
    body: 'Use Home as the control center for new sessions, supervisor-only continuation, history, and daily stats. Replay the tutorial any time from this page or Help after setup is complete.',
    bullets: [
      'Start New Session launches the standard mock-call flow.',
      'Supervisor Transfer Only is for candidates whose mock calls were already completed.',
      'Session History opens saved sessions, search, and detail review.',
    ],
  },
  {
    id: 'setup-wizard',
    eyebrow: 'First Launch',
    title: 'Setup Wizard',
    body: 'The Setup Wizard handles the initial tester profile and required baseline settings. On first launch, the in-app tutorial should begin immediately after setup is completed.',
    bullets: [
      'Enter tester-facing profile information before running sessions.',
      'Save setup changes before beginning certification work.',
      'Tutorial completion is only recorded after Finish or Skip.',
    ],
    adminNote: 'Admin-only notification sheet configuration is not exposed here. Normal users only manage user-facing settings.',
  },
  {
    id: 'basics',
    eyebrow: 'Session Flow',
    title: 'Basics',
    body: 'The Basics screen verifies whether the candidate is ready to proceed before any call scoring begins.',
    bullets: [
      'Candidate Name is required.',
      'Headset, VPN, browser readiness, and final-attempt status are documented here.',
      'NC/NS, Not Ready, and Stopped Responding route directly to Review as immediate outcomes.',
    ],
  },
  {
    id: 'calls',
    eyebrow: 'Session Flow',
    title: 'Calls',
    body: 'Mock calls are scored one section at a time with scenario data, coaching, and fail reasons captured for review and documentation.',
    bullets: [
      'Call setup uses Call Type, Show, Caller, and donation scenario defaults.',
      'Coaching selections should match what was actually coached during the call.',
      'Fail reasons are required when a call is marked FAIL.',
      'Routing remains based on pass/fail outcomes, not summary text generation.',
    ],
  },
  {
    id: 'supervisor-transfer',
    eyebrow: 'Session Flow',
    title: 'Supervisor Transfer',
    body: 'Supervisor transfers document whether the candidate successfully handled the transfer portion after mock-call requirements were met.',
    bullets: [
      'Supervisor Transfer Only can resume prior mock-call work for the same tester when eligible history exists.',
      'Transfer sections use the same coaching and fail-reason capture model as calls.',
      'If both supervisor transfers fail, the session can route to Newbie Shift as incomplete follow-up work.',
    ],
  },
  {
    id: 'review-fill-form',
    eyebrow: 'Documentation',
    title: 'Review and Fill Form',
    body: 'Review is the documentation checkpoint. It generates the management-facing coaching and fail summaries and prepares the Microsoft certification form fill.',
    bullets: [
      'Coaching Summary and Fail Summary are built from selected checkboxes and notes.',
      'Gemini only rewrites summary text when enabled; it does not affect scoring or routing.',
      'Fill Form opens the certification form and maps session data into the form fields.',
      'Save & Finish stores the session in history and clears the working session.',
    ],
  },
  {
    id: 'history',
    eyebrow: 'Records',
    title: 'History',
    body: 'History keeps the local record of completed and incomplete sessions for search, review, and continuation scenarios.',
    bullets: [
      'Use History to review saved outcomes and session details.',
      'Supervisor-only smart resume depends on eligible saved history tied to the current tester.',
      'If prior data is missing from History, the app cannot resume that session.',
    ],
  },
  {
    id: 'settings',
    eyebrow: 'Configuration',
    title: 'Settings',
    body: 'Settings control user-editable app behavior such as profile, Gemini, Discord defaults, calendar support, and editable scenario content.',
    bullets: [
      'Ticker Speed is the only notification ticker option shown to normal users.',
      'Gemini API keys are entered only by the current app user in Settings.',
      'Call Types, Shows, Callers, coaching items, and fail reasons remain editable through their existing tabs.',
    ],
    adminNote: 'Notification sheet URLs and other admin-only notification sources should be managed outside the normal user Settings UI.',
  },
  {
    id: 'gemini-ai',
    eyebrow: 'Integration',
    title: 'Gemini AI',
    body: 'Gemini is optional. When enabled with a user-provided API key, it produces concise management-facing coaching and fail summaries from the selected review data.',
    bullets: [
      'No shared Gemini API key is bundled with the app.',
      'If Gemini is disabled or unavailable, the app falls back to the built-in summary generator.',
      'Summaries should remain factual, documentation-style, and suitable for management review.',
    ],
    media: 'gemini',
  },
  {
    id: 'discord',
    eyebrow: 'Integration',
    title: 'Discord Posts and Screenshots',
    body: 'Discord support is split between reusable post templates and screenshot assets used during tester communication and coaching.',
    bullets: [
      'Discord Post opens the existing template-and-screenshot panel from the sidebar.',
      'Settings → Discord keeps templates and screenshots editable.',
      'Screenshots/Discord coaching language belongs in generated summaries when those coaching items are selected.',
    ],
    note: 'Copying text and an image together as one cross-app Discord payload is not reliably supported through the browser clipboard stack. Text copy and image copy are safer as separate actions.',
  },
  {
    id: 'notifications',
    eyebrow: 'Integration',
    title: 'Notifications and Ticker',
    body: 'The app can display ticker messages, banners, and popups from the admin-managed notification source while keeping the user-facing ticker speed local.',
    bullets: [
      'If no active notification ticker exists, the app falls back to its existing ticker behavior.',
      'Ticker Speed in Settings controls the animation speed for the current user.',
      'Normal users do not manage the notification sheet URL in Settings.',
    ],
  },
  {
    id: 'updates-about',
    eyebrow: 'Application',
    title: 'Updates and About',
    body: 'Versioning and installer updates remain available through the desktop app shell and the Settings update panel.',
    bullets: [
      `Current app version: v${APP_VERSION_FALLBACK}.`,
      'Use Settings to check for published updates when available.',
      'About information is also available from the desktop app menu.',
    ],
  },
  {
    id: 'troubleshooting',
    eyebrow: 'Support',
    title: 'Troubleshooting',
    body: 'Use the built-in technical issue flow for live call troubleshooting and use support channels when the issue is app-side rather than candidate-side.',
    bullets: [
      'Tech Issue handles internet speed, routing, browser, and manual issue notes.',
      'If a screen behaves unexpectedly, note the page, the action taken, and any visible error.',
      'Include the app version when reporting persistent issues.',
    ],
  },
];

export default function HelpPage({ appVersion, onNavigate, settings, onReplayTutorial }) {
  const version = appVersion || APP_VERSION_FALLBACK;
  const geminiActive = Boolean(settings?.enable_gemini && String(settings?.gemini_key || '').trim());

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
          <button className="btn btn-primary btn-sm" onClick={() => onReplayTutorial?.()} data-testid="help-tutorial">
            Replay Tutorial
          </button>
        </div>
      </div>

      <section className="help-hero">
        <div className="help-hero-copy">
          <div className="help-hero-kicker">Production Help Center</div>
          <h1>Mock Testing Suite Help Center</h1>
          <p>
            Reference the full session workflow, settings, integrations, review steps, notification behavior,
            and support guidance from one place. This page is read-only and is intended for in-app operational help.
          </p>
          <div className="help-hero-pills">
            <span className="help-pill">Version v{version}</span>
            <span className="help-pill">{geminiActive ? 'Gemini Configured' : 'Gemini Optional'}</span>
            <span className="help-pill">Tutorial Replay Available</span>
          </div>
        </div>
        <div className="help-hero-panel">
          <h2>Quick Actions</h2>
          <div className="help-hero-action-list">
            <button className="btn btn-primary" onClick={() => onReplayTutorial?.()}>
              Replay Tutorial
            </button>
            <button className="btn btn-ghost" onClick={() => onNavigate?.('settings', null)}>
              Open Settings
            </button>
            <button className="btn btn-ghost" onClick={() => onNavigate?.('history', null)}>
              Open History
            </button>
          </div>
          <p className="text-muted text-sm">
            Replay Tutorial reopens the onboarding flow without changing saved data until the tutorial is skipped or finished.
          </p>
        </div>
      </section>

      <section className="help-anchor-nav card">
        <div className="help-anchor-title">
          <h2>Browse Topics</h2>
          <p className="text-muted text-sm">Jump directly to the section you need.</p>
        </div>
        <div className="help-anchor-grid">
          {HELP_SECTIONS.map((section) => (
            <a key={section.id} href={`#${section.id}`} className="help-anchor-link">
              {section.title}
            </a>
          ))}
        </div>
      </section>

      <section className="help-card-grid">
        {HELP_SECTIONS.map((section) => (
          <article key={section.id} id={section.id} className="card help-card">
            <div className="help-card-header">
              <div>
                <div className="help-card-eyebrow">{section.eyebrow}</div>
                <h2>{section.title}</h2>
              </div>
              {section.media === 'gemini' && geminiActive && (
                <div className="help-gemini-brand">
                  <img src={geminiActiveGraphic} alt="Gemini enabled" />
                  <span>Gemini summaries are enabled.</span>
                </div>
              )}
            </div>
            <p className="help-card-body">{section.body}</p>
            <ul className="help-list">
              {section.bullets.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            {section.note && <div className="help-note">{section.note}</div>}
            {section.adminNote && (
              <div className="help-admin-note">
                <strong>Admin note:</strong> {section.adminNote}
              </div>
            )}
          </article>
        ))}
      </section>

      <section className="help-support-grid">
        <div className="card help-support-card">
          <div className="help-card-eyebrow">FAQ</div>
          <h2>Common Questions</h2>
          <div className="help-faq-list">
            <FAQ
              q="What if the candidate stops responding?"
              a='Use the red "Stopped Responding" action. The session is documented immediately and routed to Review.'
            />
            <FAQ
              q="What if coaching is not selected?"
              a="The app prompts for confirmation, but coaching selections should match what was actually covered during the call or transfer."
            />
            <FAQ
              q="How does Supervisor Transfer Only resume work?"
              a="It searches saved local history for eligible prior mock-call sessions tied to the current tester and resumes the candidate into transfer steps when possible."
            />
            <FAQ
              q="Where do Discord defaults and screenshots get edited?"
              a="Settings → Discord. Posts and screenshots remain editable there, while the Help page is read-only."
            />
          </div>
        </div>

        <div className="card help-support-card">
          <div className="help-card-eyebrow">Support</div>
          <h2>Support and About</h2>
          <p className="help-card-body">
            Mock Testing Suite version {version}. Include the page name, actions taken, and any visible error details when reporting issues.
          </p>
          <div className="help-support-actions">
            <a
              href="mailto:blyshawnp@gmail.com?subject=Mock%20Testing%20Suite%20Support"
              className="btn btn-primary"
              style={{ textDecoration: 'none' }}
              data-testid="support-email"
            >
              Send Email
            </a>
            <a
              href="https://discord.com/users/shawnbly"
              target="_blank"
              rel="noopener noreferrer"
              className="btn"
              style={{ textDecoration: 'none', background: '#5865F2', color: 'white' }}
              data-testid="support-discord"
            >
              Message on Discord
            </a>
          </div>
          <div className="help-about-block">
            <p><strong>Creator:</strong> Shawn Bly</p>
            <p><strong>Email:</strong> blyshawnp@gmail.com</p>
            <p><strong>About:</strong> Use the desktop app menu About item for the current version and published creator metadata.</p>
          </div>
        </div>
      </section>
    </div>
  );
}

function FAQ({ q, a }) {
  return (
    <div className="help-faq-item">
      <p><strong>Q:</strong> {q}</p>
      <p><strong>A:</strong> {a}</p>
    </div>
  );
}
