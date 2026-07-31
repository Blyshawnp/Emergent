import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import CandidateIpIntelligencePanel, { buildManualLookupLinks } from './CandidateIpIntelligence';

const EXPECTED_LINKS = [
  { label: 'IP2Location', url: 'https://www.ip2location.com/demo' },
  { label: 'IPinfo', url: 'https://ipinfo.io/' },
  { label: 'ip.teoh.io', url: 'https://ip.teoh.io/' },
];

async function renderPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<CandidateIpIntelligencePanel />));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function expandPanel(container) {
  await act(async () => {
    container.querySelector('.candidate-ip-card-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: jest.fn().mockResolvedValue(undefined) },
  });
  window.open = jest.fn();
  window.electronAPI = { openExternal: jest.fn() };
  global.fetch = jest.fn();
});

afterEach(() => {
  document.body.innerHTML = '';
  jest.useRealTimers();
});

test('VPN manual lookup destinations are the exact static approved URLs and never contain an IP', () => {
  expect(buildManualLookupLinks('203.0.113.25').map(({ label, url }) => ({ label, url }))).toEqual(EXPECTED_LINKS);
});

test('VPN panel is collapsed by default and performs no automatic lookup', async () => {
  const view = await renderPanel();
  expect(view.container.textContent).toContain('VPN / Proxy Lookup Sites');
  expect(view.container.textContent).toContain('Use these sites when a manual IP lookup is needed.');
  expect(view.container.querySelector('[data-testid="candidate-ip-manual-links"]')).toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(window.electronAPI.openExternal).not.toHaveBeenCalled();
  await view.unmount();
});

test('VPN panel expansion shows exactly three approved sites with one Copy Link button each', async () => {
  const view = await renderPanel();
  await expandPanel(view.container);
  const rows = Array.from(view.container.querySelectorAll('.ip-manual-service-row'));
  expect(rows).toHaveLength(3);
  expect(rows.map((row) => row.querySelector('.ip-manual-service-name').textContent)).toEqual(EXPECTED_LINKS.map(({ label }) => label));
  expect(rows.map((row) => row.querySelector('button').textContent)).toEqual(['Copy Link', 'Copy Link', 'Copy Link']);
  await view.unmount();
});

test.each(EXPECTED_LINKS)('VPN Copy Link for $label copies only its static website URL', async ({ label, url }) => {
  jest.useFakeTimers();
  const view = await renderPanel();
  await expandPanel(view.container);
  const button = view.container.querySelector(`[aria-label="Copy ${label} link"]`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(url);
  expect(button.textContent).toBe('Copied');
  expect(window.open).not.toHaveBeenCalled();
  expect(window.electronAPI.openExternal).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
  await act(async () => jest.advanceTimersByTime(1800));
  expect(button.textContent).toBe('Copy Link');
  await view.unmount();
});

test('VPN toggle and copy controls remain keyboard-activatable native buttons', async () => {
  const view = await renderPanel();
  const toggle = view.container.querySelector('.candidate-ip-card-toggle');
  expect(toggle.tagName).toBe('BUTTON');
  toggle.focus();
  expect(document.activeElement).toBe(toggle);
  await expandPanel(view.container);
  const copyButtons = Array.from(view.container.querySelectorAll('.ip-manual-service-actions button'));
  expect(copyButtons).toHaveLength(3);
  copyButtons.forEach((button) => expect(button.tagName).toBe('BUTTON'));
  await view.unmount();
});

test('VPN service rows and actions remain present at reduced viewport width', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 640 });
  const view = await renderPanel();
  await expandPanel(view.container);
  expect(view.container.querySelectorAll('.ip-manual-service-row')).toHaveLength(3);
  expect(view.container.querySelectorAll('.ip-manual-service-actions button')).toHaveLength(3);
  await view.unmount();
});
