import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import MtsTickerBar from './components/MtsTickerBar';
import { DEFAULT_NOTIFICATION_GROUPS } from './utils/notifications';

let container;
let root;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderTicker(props = {}) {
  act(() => {
    root.render(<MtsTickerBar
      notificationGroups={props.notificationGroups || DEFAULT_NOTIFICATION_GROUPS}
      settings={props.settings || {}}
      appVersion="1.0.1"
    />);
  });
}

test('neutral ticker is visible synchronously while remote work is still pending', () => {
  const startedAt = performance.now();
  renderTicker();
  const visibleAt = performance.now();
  expect(container.querySelector('[data-testid="ticker-bar"]')).not.toBeNull();
  expect(container.textContent).toContain('Welcome to Mock Testing Suite v1.0.1.');
  expect(visibleAt - startedAt).toBeLessThan(100);
});

test('cached or live content replaces the default without remounting the ticker track', () => {
  renderTicker();
  const originalTrack = container.querySelector('[data-testid="ticker-track"]');

  renderTicker({
    notificationGroups: {
      ...DEFAULT_NOTIFICATION_GROUPS,
      tickerMessages: [{ id: 'live', type: 'warning', title: 'Update', message: 'Ready now' }],
    },
  });

  expect(container.querySelector('[data-testid="ticker-track"]')).toBe(originalTrack);
  expect(container.textContent).toContain('WARNING: Ready now');
  expect(container.querySelector('.ticker-item-warning')).not.toBeNull();
});

test('ticker speed remains controlled by the existing setting', () => {
  renderTicker({ settings: { ticker_speed: 'fast' } });
  expect(container.querySelector('[data-testid="ticker-bar"]').style.getPropertyValue('--ticker-duration')).toBe('28s');
  renderTicker({ settings: { ticker_speed: 'slow' } });
  expect(container.querySelector('[data-testid="ticker-bar"]').style.getPropertyValue('--ticker-duration')).toBe('56s');
});
