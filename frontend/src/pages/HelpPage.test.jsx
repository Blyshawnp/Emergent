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
  expect(view.container.textContent).toContain('Conflict detection: duplicate shortcut assignments are blocked');
  expect(view.container.textContent).toContain('Restoring defaults: use Restore Default');
  expect(view.container.textContent).toContain('Final Readiness Judgment lets the evaluator keep the calculated result');
  expect(view.container.textContent).toContain('Optional tutorial videos are local files only');
  expect(view.container.textContent).toContain('Use Category to filter grouped templates or screenshots');
  expect(view.container.querySelector('[data-testid="help-hero-search"]')).toBeTruthy();
  expect(view.container.textContent).toContain('Where is my data stored?');
  expect(view.container.textContent).toContain('In the local app database.');
  expect(view.container.textContent).toContain('support@example.com');

  await view.unmount();
});

test('help page shows tutorial video action only when a local video exists', async () => {
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValueOnce({ ok: true });
  api.getHelpContent.mockResolvedValue({ help_markdown: '# Help\n', faq_markdown: '', support: {} });

  const view = await renderComponent(
    <HelpPage
      appVersion="1.0.1"
      settings={{ enable_gemini: false, gemini_api_key: '' }}
      onNavigate={jest.fn()}
      onReplayTutorial={jest.fn()}
    />
  );

  expect(view.container.querySelector('[data-testid="help-tutorial-video"]')?.getAttribute('href')).toBe('/assets/tutorial/mts-tutorial.mp4');
  expect(view.container.textContent).toContain('Watch Tutorial Video');

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

  await view.unmount();
});
