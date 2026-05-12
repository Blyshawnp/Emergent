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
  expect(view.container.textContent).toContain('Where is my data stored?');
  expect(view.container.textContent).toContain('In the local app database.');
  expect(view.container.textContent).toContain('support@example.com');

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
