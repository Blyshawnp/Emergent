import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import HelpPage from './HelpPage';
import api from '../api';

jest.mock('../api', () => ({
  __esModule: true,
  default: {
    getHelpContent: jest.fn(),
  },
}));

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderComponent(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(element);
    await flushPromises();
    await flushPromises();
  });

  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: false });
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('help page renders Q:/A: faq paragraphs even when backend has not transformed them', async () => {
  api.getHelpContent.mockResolvedValue({
    help_markdown: '# Help\n',
    faq_markdown: [
      'Mock Testing Suite FAQ Content',
      '',
      'Q: What if the candidate stops responding?',
      'A: Click the red Stopped Responding button.',
      '',
      '**Q: Where is my data stored?**',
      'A: In the local app database.',
    ].join('\n'),
    support: { intro: '', email: '', discord_name: '', discord_url: '', footer: '' },
  });

  const view = await renderComponent(
    <HelpPage
      appVersion="1.0.1"
      settings={{ enable_gemini: false, gemini_api_key: '' }}
      onNavigate={jest.fn()}
      onReplayTutorial={jest.fn()}
    />
  );

  expect(view.container.textContent).toContain('What if the candidate stops responding?');
  expect(view.container.textContent).toContain('Click the red Stopped Responding button.');
  expect(view.container.textContent).toContain('Where is my data stored?');
  expect(view.container.textContent).toContain('In the local app database.');

  await view.unmount();
});

test('help page renders current help topics and configured faq entries', async () => {
  api.getHelpContent.mockResolvedValue({
    help_markdown: [
      '# Mock Testing Suite Help Center',
      '',
      '## Session Flow',
      'Use this page as the live help source.',
      '- Start New Session begins the standard flow.',
      '### Details',
      'Use `Settings` for user overrides.',
    ].join('\n'),
    faq_markdown: [
      '# FAQ',
      '',
      '## Where is my data stored?',
      'In the local app database.',
    ].join('\n'),
    support: {
      intro: 'Need help with the app?',
      email: 'support@example.com',
      discord_name: 'mock-support',
      discord_url: 'https://discord.com/users/mock-support',
      footer: 'Include the page name and visible error details.',
    },
  });

  const view = await renderComponent(
    <HelpPage
      appVersion="1.0.1"
      settings={{ enable_gemini: true, gemini_api_key: 'key' }}
      onNavigate={jest.fn()}
      onReplayTutorial={jest.fn()}
    />
  );

  expect(api.getHelpContent).toHaveBeenCalled();
  expect(view.container.textContent).toContain('Mock Testing Suite Help Center');
  expect(view.container.textContent).toContain('Getting Started');
  expect(view.container.textContent).toContain('Supervisor Transfer Only');
  expect(view.container.textContent).toContain('Ticker and Notifications');
  expect(view.container.textContent).toContain('Setup Wizard includes ticker speed');
  expect(view.container.textContent).toContain('Payment Settings starts with 3 Credit Card defaults and 3 EFT defaults');
  expect(view.container.textContent).toContain('H390 or H650e');
  expect(view.container.textContent).toContain('Sound Volume supports Off, Low, Medium, and High');
  expect(view.container.textContent).toContain('Favorites are accessed with the Favorites filter chip');
  expect(view.container.textContent).toContain('Recent posts are accessed with the Recent filter chip');
  expect(view.container.textContent).toContain('Search is the fastest default workflow');
  expect(view.container.textContent).toContain('Keyboard shortcuts: Ctrl+D opens Discord Posts');
  expect(view.container.textContent).toContain('Favorite shortcuts are customized in Settings -> Discord -> Productivity');
  expect(view.container.textContent).toContain('25. Discord Productivity');
  expect(view.container.textContent).toContain('Command Palette: press Ctrl+Shift+P');
  expect(view.container.textContent).toContain('Suggested screenshots: admins can link zero, one, two, or three screenshots');
  expect(view.container.textContent).toContain('Copy Post copies only text');
  expect(view.container.textContent).toContain('Conflict detection: duplicate shortcut assignments are blocked');
  expect(view.container.textContent).toContain('Restoring defaults: use Restore Default');
  expect(view.container.textContent).toContain('Final Readiness Judgment lets the evaluator keep the calculated result');
  expect(view.container.textContent).toContain('If a tutorial video is available');
  expect(view.container.textContent).toContain('Use Reschedule from History only for an eligible incomplete session');
  expect(view.container.textContent).toContain('Form Filled means MTS completed filling the Microsoft Form');
  expect(view.container.textContent).toContain('Follow-up may be Pending, Approved, or Denied');
  expect(view.container.textContent).toContain('Use Category to filter grouped templates or screenshots');
  expect(view.container.querySelector('[data-testid="help-hero-search"]')).toBeTruthy();
  expect(view.container.textContent).toContain('Where is my data stored?');
  expect(view.container.textContent).toContain('In the local app database.');
  expect(view.container.textContent).toContain('support@example.com');

  await view.unmount();
});

test('help page shows only active validated tutorial metadata', async () => {
  api.getHelpContent.mockResolvedValue({
    help_markdown: '# Help\n', faq_markdown: '', support: {},
    tutorial_videos: {
      mts: [
        { Category: 'Quick Start', VideoKey: 'active', Title: 'MTS Quick Start', YouTubeURL: 'https://youtu.be/dQw4w9WgXcQ', SortOrder: '1', Active: 'TRUE', HelpTopicKey: 'getting-started' },
        { Category: 'Quick Start', VideoKey: 'inactive', Title: 'Hidden Tutorial', YouTubeURL: 'https://youtu.be/dQw4w9WgXcQ', SortOrder: '2', Active: 'FALSE' },
      ],
      sam: [],
    },
  });

  const view = await renderComponent(
    <HelpPage
      appVersion="1.0.1"
      settings={{ enable_gemini: false, gemini_api_key: '' }}
      onNavigate={jest.fn()}
      onReplayTutorial={jest.fn()}
    />
  );

  expect(view.container.textContent).toContain('MTS Quick Start');
  expect(view.container.textContent).not.toContain('Hidden Tutorial');
  expect(view.container.textContent).toContain('Watch Tutorial: MTS Quick Start');

  await view.unmount();
});

test('help page shows friendly faq fallback when configured source fails', async () => {
  api.getHelpContent.mockRejectedValue(new Error('offline'));

  const view = await renderComponent(
    <HelpPage
      appVersion="1.0.1"
      settings={{ enable_gemini: false, gemini_api_key: '' }}
      onNavigate={jest.fn()}
      onReplayTutorial={jest.fn()}
    />
  );

  expect(view.container.textContent).toContain('Showing built-in guidance.');
  expect(view.container.textContent).toContain('What if FAQ content does not load?');
  expect(view.container.textContent).toContain('The app could not load the configured FAQ source.');
  expect(view.container.textContent).toContain('Use Reschedule from History only for an eligible incomplete session');
  expect(view.container.textContent).toContain('Form Filled means MTS completed filling the Microsoft Form');
  expect(view.container.textContent).toContain('Follow-up may be Pending, Approved, or Denied');
  expect(view.container.textContent).toContain('Status Glossary');
  expect(view.container.textContent).toContain('Resumed – Pass');
  expect(view.container.textContent).toContain('Form Filled: MTS completed filling the Microsoft Form');
  expect(view.container.textContent).toContain('What this is');
  expect(view.container.textContent).toContain('Common mistakes');
  expect(view.container.textContent).not.toMatch(/frontend\/public|backend failure|safety\/API|master Google Sheet|headset-review-log/i);

  await view.unmount();
});

test('trainer help filters internal remote documentation while preserving safe override content', async () => {
  api.getHelpContent.mockResolvedValue({
    help_markdown: [
      '# Mock Testing Suite Help Center',
      '',
      '## Session Flow',
      'Use Reschedule from History for an eligible incomplete session.',
      'GET /api/help/content returns the source payload.',
      'The newbieShiftRescheduleAdminMention key controls the mention.',
      '',
      '## Admin Setup',
      'Run PowerShell and edit SQLite schema migrations.',
      'Update the service-account credentials.',
      '',
      '## Backend Routes',
      'Use the following internal operations for maintenance.',
      '',
      '## Form Status',
      'Form Filled means MTS completed filling the form.',
    ].join('\n'),
    faq_markdown: [
      '## What does Pending mean?',
      'Pending means an administrator has not decided yet.',
      'POST /api/shared/admin/pending-requests/action changes the row.',
    ].join('\n'),
    support: {},
  });

  const view = await renderComponent(
    <HelpPage
      appVersion="1.0.1"
      settings={{ enable_gemini: false, gemini_api_key: '' }}
      onNavigate={jest.fn()}
      onReplayTutorial={jest.fn()}
    />
  );

  expect(view.container.textContent).toContain('Use Reschedule from History for an eligible incomplete session.');
  expect(view.container.textContent).toContain('Form Filled means MTS completed filling the form.');
  expect(view.container.textContent).toContain('Pending means an administrator has not decided yet.');
  expect(view.container.textContent).not.toMatch(/\/api\/|SQLite|schema migration|service-account|PowerShell|newbieShiftRescheduleAdminMention|Admin Setup/i);

  await view.unmount();
});
