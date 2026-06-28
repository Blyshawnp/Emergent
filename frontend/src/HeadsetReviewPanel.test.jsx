import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { HeadsetReviewPanel, buildSamHeadsetResearchUrl } from './NotificationManagerApp';

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buttonByText(container, text) {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent.trim() === text);
}

async function renderPanel(props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<HeadsetReviewPanel {...props} />);
    await flushPromises();
  });
  return {
    container,
    unmount: async () => act(async () => root.unmount()),
  };
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  window.electronAPI = { openExternal: jest.fn().mockResolvedValue({ ok: true }) };
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('Research Headset opens the required Google query and presents all follow-up decisions', async () => {
  const onDecision = jest.fn().mockResolvedValue({ ok: true });
  const view = await renderPanel({
    data: {
      ok: true,
      pending: [{ brand: 'Acme', model: 'USB 100', status: 'pending', note: 'Candidate entry', tester: 'Tester One', submitted_date: '2026-06-23T12:00:00Z' }],
      approved: [],
      denied: [],
    },
    loading: false,
    onRefresh: jest.fn(),
    onDecision,
    onStatus: jest.fn(),
    onConfirm: jest.fn().mockResolvedValue(true),
  });

  expect(view.container.textContent).toContain('Tester One');
  await act(async () => {
    buttonByText(view.container, 'Research Headset').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  const openedUrl = window.electronAPI.openExternal.mock.calls[0][0];
  expect(openedUrl).toBe(buildSamHeadsetResearchUrl({ brand: 'Acme', model: 'USB 100' }));
  expect(decodeURIComponent(openedUrl)).toContain('Does the headset Acme USB 100 have a noise cancelling microphone and connect via USB?');
  expect(buttonByText(view.container, 'Approve Headset')).toBeTruthy();
  expect(buttonByText(view.container, 'Deny Headset')).toBeTruthy();
  expect(buttonByText(view.container, 'Review Later')).toBeTruthy();
  expect(buttonByText(view.container, 'Cancel')).toBeTruthy();

  await act(async () => {
    buttonByText(view.container, 'Approve Headset').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(onDecision).toHaveBeenCalledWith({
    action: 'approve',
    brand: 'Acme',
    model: 'USB 100',
    review_id: '',
    submitted_date: '2026-06-23T12:00:00Z',
    tester: 'Tester One',
  });
  await view.unmount();
});

test('tabs allow approved headsets to be denied with a reason and denied headsets to be approved', async () => {
  const onDecision = jest.fn().mockResolvedValue({ ok: true });
  const view = await renderPanel({
    data: {
      ok: true,
      pending: [],
      approved: [{ brand: 'Allowed', model: 'A1', status: 'approved', note: '' }],
      denied: [{ brand: 'Blocked', model: 'B1', status: 'denied', note: 'No USB' }],
    },
    loading: false,
    onRefresh: jest.fn(),
    onDecision,
    onStatus: jest.fn(),
    onConfirm: jest.fn().mockResolvedValue(true),
  });

  await act(async () => buttonByText(view.container, 'Approved Headsets (1)').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(view.container.textContent).toContain('Allowed');
  expect(view.container.textContent).not.toContain('Blocked');

  await act(async () => buttonByText(view.container, 'Change to Denied').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const firstReason = view.container.querySelector('input[name="headset-denial-reason"]');
  await act(async () => firstReason.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await act(async () => {
    buttonByText(view.container, 'Deny').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(onDecision).toHaveBeenCalledWith({
    action: 'deny',
    brand: 'Allowed',
    model: 'A1',
    reason: 'Headset does not connect via USB',
    note: '',
    review_id: '',
    submitted_date: '',
    tester: '',
  });

  await act(async () => buttonByText(view.container, 'Denied Headsets (1)').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await act(async () => {
    buttonByText(view.container, 'Approve').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(onDecision).toHaveBeenCalledWith({
    action: 'approve',
    brand: 'Blocked',
    model: 'B1',
    review_id: '',
    submitted_date: '',
    tester: '',
  });
  await view.unmount();
});
