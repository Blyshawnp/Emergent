import React, { useEffect, useMemo, useState } from 'react';
import geminiActiveGraphic from '../assets/images/Gemini2.png';
import api from '../api';

const APP_VERSION_FALLBACK = '1.0.1';

const HELP_TOPICS = [
  {
    id: 'getting-started',
    title: '1. Getting Started',
    summary: 'Mock Testing Suite is the control center for certification mock sessions, supervisor transfers, and follow-up scheduling.',
    bullets: [
      'Open the app from the desktop shortcut or Start menu.',
      'The first launch runs the Setup Wizard, then the Tutorial.',
      'Everything begins from the Home screen: new sessions, supervisor-only work, and history.',
      'Active session drafts are saved automatically while you work, so moving between screens never wipes progress.',
    ],
  },
  {
    id: 'setup-wizard',
    title: '2. Setup Wizard',
    summary: 'The first-run wizard captures your tester identity and the form/spreadsheet links the app needs to fill.',
    bullets: [
      'Enter your first name, last name, and (optional) display name.',
      'Confirm the certification form URL and the certification spreadsheet URL.',
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
      'Use Next, Back, Skip, and Finish inside the tutorial to control it.',
      'Tutorial completion is only marked after Skip or Finish.',
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
      'For Supervisor Transfer Only, Smart Resume can continue from a saved record when prior mock calls were already completed.',
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
      'Headset must be USB with a noise-cancelling microphone.',
      'VPN must be off, and required browser checks must pass before you can continue.',
      'Continue validates readiness and routes into Calls (or Supervisor Transfer Only when applicable).',
    ],
  },
  {
    id: 'headset-lookup',
    title: '7. Headset Lookup',
    summary: 'Use the approved headset lookup to confirm a candidate is using an allowed USB noise-cancelling model.',
    bullets: [
      'Click Lookup Approved Headsets next to the Brand / Model field.',
      'Search by brand or model, then select a listed model to auto-fill the field.',
      'If the model is not listed, double-check that the headset is USB and has a noise-cancelling microphone before continuing.',
    ],
  },
  {
    id: 'autofails-ncns-notready',
    title: '8. NC/NS and Not Ready Auto-Fails',
    summary: 'These red buttons end the session immediately. Use them only when the candidate cannot start testing.',
    bullets: [
      'NC/NS = the candidate did not join the session at all.',
      'Not Ready = the candidate is present but cannot start (no headset, VPN on, wrong browser, etc.).',
      'Both buttons end the session and route directly to Review with the auto-fail reason recorded.',
    ],
  },
  {
    id: 'tech-issue',
    title: '9. Tech Issue Flow',
    summary: 'Use Tech Issue when a real technical problem is interrupting the session, before deciding to end it.',
    bullets: [
      'Open Tech Issue from Basics or any session screen where it is available.',
      'Choose the issue type: internet, DTE, browser, routing, or Other.',
      'Follow the prompts to continue the session, route to Review, or schedule a Newbie Shift if the candidate cannot finish today.',
      'A Tech Issue does not automatically fail the candidate; it just guides the next step.',
    ],
  },
  {
    id: 'calls',
    title: '10. Calls Screen',
    summary: 'The Calls screen scores up to three mock calls.',
    bullets: [
      'For each call pick Call Type, Show, Caller, and Donation amount.',
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
      'Smart Resume can continue from a saved record if prior mock calls match the candidate.',
      'Fresh supervisor-only sessions still run through Basics first.',
    ],
  },
  {
    id: 'newbie-shift',
    title: '16. Newbie Shift',
    summary: 'Newbie Shift schedules follow-up work when a candidate cannot complete the flow today.',
    bullets: [
      'Enter the follow-up date, start time, AM/PM, and timezone.',
      'Use Add to Google Calendar to open a prefilled calendar event.',
      'Continue to Review to save the Newbie Shift details on the session.',
    ],
  },
  {
    id: 'review',
    title: '17. Review Screen',
    summary: 'Review is the final checkpoint before filling forms or saving the session.',
    bullets: [
      'Confirm the final status, call results, transfer results, and any auto-fail reason.',
      'Read the Coaching Summary and Fail Summary before using them anywhere else.',
      'Use Fill Form to push session data into the certification form.',
      'Save and Finish stores the session in History and clears the active draft.',
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
      'Turn Gemini on in Settings → Gemini AI after adding an API key (next topic).',
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
      'Open a session and check Review — Gemini will now polish the coaching and fail summaries.',
    ],
  },
  {
    id: 'fill-form',
    title: '21. Fill Form',
    summary: 'Fill Form pushes session data into the configured Microsoft certification form using a browser.',
    bullets: [
      'Use Fill Form from Review before closing the active session.',
      'The app maps known session data into the form, but you should still confirm everything before submitting.',
      'If Fill Form fails, check the form URL and browser setting in Settings.',
    ],
  },
  {
    id: 'history-fill-form',
    title: '22. History and Historical Fill Form',
    summary: 'History stores saved sessions. You can reopen a session in read-only Review or fill the form from it again.',
    bullets: [
      'Open History from Home to see all saved sessions.',
      'Click a session to view summary details, or open it in Historical Review (read-only).',
      'Historical Fill Form re-runs Fill Form from a saved record without changing the active session.',
    ],
  },
  {
    id: 'settings',
    title: '23. Settings',
    summary: 'Settings controls your profile, integrations, and app preferences.',
    bullets: [
      'General: tester identity, form/spreadsheet links, browser behavior, sounds, theme, and ticker speed.',
      'Admin lists: shows, callers, coaching items, fail reasons, Discord posts, screenshots, Gemini AI, and Calendar.',
      'Help content is not editable from normal Settings.',
      'The notification ticker sheet URL is managed by the admin and is not exposed to normal users.',
    ],
  },
  {
    id: 'discord',
    title: '24. Discord Posts and Screenshots',
    summary: 'The Discord panel keeps reusable Discord messages and screenshot images close at hand during a session.',
    bullets: [
      'Open Discord Post from the sidebar.',
      'Search templates and copy message text with one click.',
      'Switch to Screenshots to preview and copy any configured screenshot image.',
      'Templates and screenshots are managed in Settings.',
    ],
  },
  {
    id: 'notifications',
    title: '25. Ticker and Notifications',
    summary: 'The ticker and notification system surfaces operational messages without blocking normal work.',
    bullets: [
      'Ticker messages scroll across the top of the app.',
      'Ticker content comes from the admin-configured Google ticker sheet, with a built-in fallback when the sheet is unavailable.',
      'Banner and popup notifications can also appear from the same source.',
      'Ticker Speed is controlled in Settings; the ticker URL is admin-only.',
    ],
  },
  {
    id: 'updates-about',
    title: '26. Updates and About',
    summary: 'Update checks and app version info live in the app menu and Settings.',
    bullets: [
      'Use the app menu or Settings update panel to check for updates.',
      'Deferred updates can be installed later from Settings when available.',
      'About shows the app version and support identity details (also shown on this Help screen).',
    ],
  },
  {
    id: 'troubleshooting',
    title: '27. Troubleshooting',
    summary: 'Use the built-in troubleshooting paths before ending a session for technical reasons.',
    bullets: [
      'Use Tech Issue for internet, DTE, browser, routing, or Other technical problems.',
      'Follow the prompts to continue the session, go to Review, or schedule Newbie Shift.',
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

const FAQ_FALLBACK = [
  {
    question: 'What if FAQ content does not load?',
    blocks: [{ type: 'paragraph', text: 'The app could not load the configured FAQ source. Use this packaged fallback and try Help again later.' }],
  },
  {
    question: 'What if the candidate stops responding?',
    blocks: [{ type: 'paragraph', text: 'Use the red Stopped Responding button on the current workflow screen.' }],
  },
  {
    question: 'Where is session data stored?',
    blocks: [{ type: 'paragraph', text: 'Settings and session records are stored in the local app database.' }],
  },
];

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

export default function HelpPage({ appVersion, onNavigate, settings, onReplayTutorial }) {
  const version = appVersion || APP_VERSION_FALLBACK;
  const geminiActive = Boolean(settings?.enable_gemini && (settings?.gemini_api_key_configured || String(settings?.gemini_api_key || '').trim()));
  const [helpContent, setHelpContent] = useState(null);
  const [helpLoadError, setHelpLoadError] = useState('');
  const [query, setQuery] = useState('');

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

  const faqEntries = useMemo(() => {
    if (helpContent === null) return [];
    const entries = buildFaqEntries(helpContent?.faq_markdown || '');
    return entries.length ? entries : FAQ_FALLBACK;
  }, [helpContent]);

  const normalizedQuery = query.trim().toLowerCase();
  const liveSections = useMemo(
    () => buildHelpSectionsFromMarkdown(helpContent?.help_markdown || ''),
    [helpContent],
  );
  const helpTopics = useMemo(() => mergeHelpTopics(liveSections), [liveSections]);
  const visibleTopics = useMemo(() => {
    return helpTopics.filter((topic) => (
      topic.blocks
        ? helpSectionMatches(topic, normalizedQuery)
        : topicMatches(topic, normalizedQuery)
    ));
  }, [helpTopics, normalizedQuery]);
  const support = helpContent?.support || {};

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
          <h1>Mock Testing Suite Help Center</h1>
          <p>
            Current guidance for running mock sessions, handling auto-fails, filling certification forms,
            managing Discord assets, and using app settings.
          </p>
          <div className="help-hero-pills">
            <span className="help-pill">Version v{version}</span>
            <span className="help-pill">{geminiActive ? 'Gemini summaries enabled' : 'Generic summaries available'}</span>
          </div>
          <div className="help-common-tasks" aria-label="Common help tasks">
            <a href="#tutorial" className="help-common-task">Replay Tutorial</a>
            <a href="#basics" className="help-common-task">Basics Setup</a>
            <a href="#fill-form" className="help-common-task">Fill Form</a>
            <a href="#troubleshooting" className="help-common-task">Troubleshooting</a>
          </div>
          {helpLoadError ? <div className="help-note">{helpLoadError}</div> : null}
        </div>
        <div className="help-hero-panel">
          <div>
            <div className="help-card-eyebrow">Need Help Fast?</div>
            <h2>Quick Actions</h2>
          </div>
          <div className="help-hero-action-list">
            <button className="btn btn-primary" onClick={() => onReplayTutorial?.()} data-testid="help-quick-replay">
              Replay Tutorial
            </button>
            <button className="btn btn-ghost" onClick={() => onNavigate?.('settings', null)}>
              Open Settings
            </button>
            <button className="btn btn-ghost" onClick={() => onNavigate?.('history', null)}>
              Open History
            </button>
          </div>
          <div className="help-status-grid">
            <div className="help-status-card">
              <span>Tutorial</span>
              <strong>Replay anytime</strong>
            </div>
            <div className="help-status-card">
              <span>Settings</span>
              <strong>Tester setup</strong>
            </div>
            <div className="help-status-card">
              <span>Fill Form</span>
              <strong>Review first</strong>
            </div>
            <div className="help-status-card">
              <span>Gemini</span>
              <strong>{geminiActive ? 'Enabled' : 'Optional'}</strong>
            </div>
          </div>
          {geminiActive ? (
            <div className="help-gemini-brand">
              <img src={geminiActiveGraphic} alt="Gemini enabled" />
              <span>Gemini is configured for cleaner coaching and fail summary wording.</span>
            </div>
          ) : (
            <p className="text-muted text-sm">
              Gemini is optional. The app still creates generic summaries from selected coaching and fail reasons.
            </p>
          )}
        </div>
      </section>

      <section className="help-search-card card">
        <div>
          <h2>Find Help</h2>
          <p className="text-muted text-sm">Search current workflow topics or jump directly to a section.</p>
        </div>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search Basics, Gemini, Fill Form, Discord..."
          data-testid="help-search"
        />
      </section>

      <section className="help-anchor-nav card">
        <div className="help-anchor-title">
          <h2>Browse Topics</h2>
          <p className="text-muted text-sm">{visibleTopics.length} topic{visibleTopics.length === 1 ? '' : 's'} shown</p>
        </div>
        <div className="help-anchor-grid">
          {visibleTopics.map((topic) => (
            <a key={topic.id} href={`#${topic.id}`} className="help-anchor-link">
              {topic.title}
            </a>
          ))}
        </div>
      </section>

      <section className="help-doc-grid">
        <div className="help-doc-column">
          {visibleTopics.length ? visibleTopics.map((topic) => (
            <article key={topic.id} id={topic.id} className="card help-card help-doc-card">
              <div className="help-card-header">
                <div>
                  <div className="help-card-eyebrow">Help Topic</div>
                  <h2>{topic.title}</h2>
                </div>
              </div>
              {topic.blocks && topic.blocks.length ? (
                topic.blocks.map((block, index) => (
                  <MarkdownBlock key={`${topic.id}-${block.type}-${index}`} block={block} />
                ))
              ) : (
                <>
                  {topic.summary ? <p className="help-card-body">{topic.summary}</p> : null}
                  {topic.bullets && topic.bullets.length ? (
                    <ul className="help-list">
                      {topic.bullets.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : null}
                  {topic.steps && topic.steps.length ? (
                    <ol className="help-list help-list-numbered">
                      {topic.steps.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ol>
                  ) : null}
                </>
              )}
            </article>
          )) : (
            <div className="card help-empty-state">
              <h2>No topics match that search.</h2>
              <p className="help-card-body">Try a shorter term such as Settings, Review, Discord, or Form.</p>
            </div>
          )}
        </div>

        <aside className="help-support-column">
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

          <div className="card help-support-card">
            <div className="help-card-eyebrow">Support</div>
            <h2>Support and About</h2>
            <p className="help-card-body">
              {support.intro || `Mock Testing Suite version ${version}. Include the screen, action, and visible error details when reporting issues.`}
            </p>
            <div className="help-support-actions">
              <a
                href={`mailto:${support.email || 'blyshawnp@gmail.com'}?subject=Mock%20Testing%20Suite%20Support`}
                className="btn btn-primary"
                style={{ textDecoration: 'none' }}
                data-testid="support-email"
              >
                Send Email
              </a>
              <a
                href={support.discord_url || 'https://discord.com/users/shawnbly'}
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
              <p><strong>Version:</strong> {version}</p>
              <p><strong>Email:</strong> {support.email || 'blyshawnp@gmail.com'}</p>
              <p><strong>Discord:</strong> {support.discord_name || 'shawnbly'}</p>
              <p><strong>Support note:</strong> {support.footer || 'Include the page name, action taken, and any visible error details.'}</p>
            </div>
          </div>
        </aside>
      </section>
    </div>
  );
}
