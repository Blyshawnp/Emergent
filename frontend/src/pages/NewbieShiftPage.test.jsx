import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import NewbieShiftPage from './NewbieShiftPage';
import api from '../api';

const mockModal = {
  warning: jest.fn(),
  error: jest.fn(),
  confirm: jest.fn(),
  confirmDanger: jest.fn(),
};

jest.mock('../api', () => ({
  __esModule: true,
  default: {
    getCurrentSession: jest.fn(),
    getSettings: jest.fn(),
    getDefaults: jest.fn(),
    updateSession: jest.fn(),
    discardSession: jest.fn(),
  },
}));

jest.mock('../components/ModalProvider', () => ({
  useModal: () => mockModal,
}));

jest.mock('../components/TechIssueDialog', () => function TechIssueDialog() {
  return null;
});

jest.mock('../components/WorkflowProgress', () => {
  function WorkflowProgress() {
    return null;
  }

  return {
    __esModule: true,
    default: WorkflowProgress,
    getWorkflowProgress: () => ({}),
  };
});

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderPage(sessionOverrides = {}, settingsOverrides = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onNavigate = jest.fn();

  api.getCurrentSession.mockResolvedValue({
    session: {
      candidate_name: 'Taylor Example',
      newbie_shift_request_type: 'reschedule',
      newbie_shift_request_status: 'pending',
      newbie_shift_data: {
        newbie_date: '07/15/2026',
        newbie_time: '10:00 AM',
        newbie_tz: 'EST (Eastern)',
      },
      ...sessionOverrides,
    },
  });
  api.getSettings.mockResolvedValue(settingsOverrides);
  api.getDefaults.mockResolvedValue({});

  await act(async () => {
    root.render(<NewbieShiftPage onNavigate={onNavigate} />);
    await flushPromises();
  });

  return {
    container,
    onNavigate,
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
  Object.assign(navigator, {
    clipboard: {
      writeText: jest.fn(),
    },
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  api.updateSession.mockResolvedValue({ ok: true });
  api.discardSession.mockResolvedValue({ ok: true });
  mockModal.warning.mockResolvedValue(true);
  mockModal.error.mockResolvedValue(true);
  mockModal.confirm.mockResolvedValue(true);
  mockModal.confirmDanger.mockResolvedValue(false);
  navigator.clipboard.writeText.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('reschedule modal renders reason cards with single-selection radio semantics', async () => {
  const view = await renderPage();

  const dialog = view.container.querySelector('[data-testid="reschedule-dialog"]');
  expect(dialog).not.toBeNull();
  const reasonCards = Array.from(dialog.querySelectorAll('[data-testid^="reschedule-reason-"]'));
  expect(reasonCards).toHaveLength(8);
  reasonCards.forEach((card) => {
    expect(card.getAttribute('role')).toBe('radio');
    expect(card.className).toContain('reschedule-radio-card');
  });

  await act(async () => {
    view.container.querySelector('[data-testid="reschedule-reason-internet-outage"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    view.container.querySelector('[data-testid="reschedule-reason-power-outage"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(view.container.querySelector('[data-testid="reschedule-reason-internet-outage"]').getAttribute('aria-checked')).toBe('false');
  expect(view.container.querySelector('[data-testid="reschedule-reason-power-outage"]').getAttribute('aria-checked')).toBe('true');

  await view.unmount();
});

test('Other reason requires details before Continue updates session', async () => {
  const view = await renderPage();

  await act(async () => {
    view.container.querySelector('[data-testid="reschedule-requester-candidate"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  await act(async () => {
    view.container.querySelector('[data-testid="reschedule-reason-other"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  await act(async () => {
    view.container.querySelector('[data-testid="reschedule-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(view.container.textContent).toContain('Enter details when the reason is Other.');
  expect(api.updateSession).not.toHaveBeenCalled();
  expect(view.container.querySelector('[data-testid="reschedule-details"]').getAttribute('aria-required')).toBe('true');

  await act(async () => {
    const details = view.container.querySelector('[data-testid="reschedule-details"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(details, 'Candidate had a documented conflict.');
    details.dispatchEvent(new Event('input', { bubbles: true }));
    details.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
  });

  await act(async () => {
    view.container.querySelector('[data-testid="reschedule-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(api.updateSession).toHaveBeenCalledWith(expect.objectContaining({
    newbie_shift_requested_by: 'candidate',
    newbie_shift_request_reason: 'Other',
    newbie_shift_request_details: 'Candidate had a documented conflict.',
  }));

  await view.unmount();
});

test('reschedule dialog action order is Cancel, Discard, Continue', async () => {
  const view = await renderPage();

  const actions = Array.from(view.container.querySelectorAll('[data-testid^="reschedule-"]'))
    .filter((node) => ['reschedule-cancel', 'reschedule-discard', 'reschedule-continue'].includes(node.getAttribute('data-testid')))
    .map((node) => node.getAttribute('data-testid'));
  expect(actions).toEqual(['reschedule-cancel', 'reschedule-discard', 'reschedule-continue']);

  await view.unmount();
});

test('Newbie Shift keeps the primary action footer in the shared sticky-action layout', async () => {
  const view = await renderPage();

  expect(view.container.querySelector('[data-testid="newbieshift-page"]').classList.contains('page-with-sticky-actions')).toBe(true);
  expect(view.container.querySelector('[data-testid="newbie-footer"]').classList.contains('sticky-action-footer')).toBe(true);

  await view.unmount();
});

test('temporary reschedule Discord post is shown by default without automatic mentions', async () => {
  const view = await renderPage({
    newbie_shift_requested_by: 'candidate',
    newbie_shift_request_reason: 'Internet outage',
    newbie_shift_request_details: '',
    newbie_shift_within_24_hours: false,
  });

  const textarea = view.container.querySelector('[data-testid="newbie-discord-text"]');
  expect(textarea).not.toBeNull();
  expect(textarea.value.startsWith('Taylor Example ')).toBe(true);
  expect(textarea.value).not.toContain('@');
  expect(textarea.value).toContain('Taylor Example');
  expect(textarea.value).toContain('internet outage');
  expect(view.container.textContent).toContain('Add any required @mentions manually.');

  await view.unmount();
});

test('initial Newbie Shift also shows the editable temporary Discord post', async () => {
  const view = await renderPage({
    newbie_shift_request_type: 'initial',
    newbie_shift_requested_by: 'tester',
  });

  const textarea = view.container.querySelector('[data-testid="newbie-discord-text"]');
  expect(textarea).not.toBeNull();
  expect(textarea.value).toContain('needs their supervisor transfer test calls (Newbie Shift) scheduled');
  expect(textarea.value).not.toContain('@');

  await view.unmount();
});

test('temporary reschedule Discord copy uses edited text exactly', async () => {
  const view = await renderPage({
    newbie_shift_requested_by: 'tester',
    newbie_shift_request_reason: 'Scheduling conflict',
    newbie_shift_request_details: '',
  });

  const textarea = view.container.querySelector('[data-testid="newbie-discord-text"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, '@manual-tag edited post body');

  await act(async () => {
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
  });

  await act(async () => {
    view.container.querySelector('[data-testid="newbie-discord-copy"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('@manual-tag edited post body');

  await view.unmount();
});

test('temporary Discord post preserves edits while hidden and can reset generated text', async () => {
  const view = await renderPage({
    newbie_shift_requested_by: 'tester',
    newbie_shift_request_reason: 'Scheduling conflict',
  });
  const textarea = view.container.querySelector('[data-testid="newbie-discord-text"]');
  const generated = textarea.value;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, 'customized post');

  await act(async () => {
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    view.container.querySelector('[data-testid="newbie-discord-toggle"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(view.container.querySelector('[data-testid="newbie-discord-text"]')).toBeNull();

  await act(async () => {
    view.container.querySelector('[data-testid="newbie-discord-toggle"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(view.container.querySelector('[data-testid="newbie-discord-text"]').value).toBe('customized post');

  await act(async () => {
    view.container.querySelector('[data-testid="newbie-discord-reset"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(view.container.querySelector('[data-testid="newbie-discord-text"]').value).toBe(generated);

  await view.unmount();
});

test('reschedule Save/Submit must confirm one SAM request before navigation and preserves fields on failure', async () => {
  const view = await renderPage({
    newbie_shift_request_id: 'pending-reschedule-1',
    newbie_shift_requested_by: 'candidate',
    newbie_shift_request_reason: 'Illness',
    newbie_shift_request_details: 'Candidate is unavailable.',
  });
  const time = view.container.querySelector('[data-testid="newbie-time"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(time, '1030');
    time.dispatchEvent(new Event('input', { bubbles: true }));
    time.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
  });

  api.updateSession.mockResolvedValueOnce({ ok: false, requestSaved: false, error: 'Retry Save/Submit.' });
  await act(async () => {
    view.container.querySelector('[data-testid="newbie-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(view.onNavigate).not.toHaveBeenCalledWith('review');
  expect(mockModal.error).toHaveBeenCalledWith('Request Not Submitted', 'Retry Save/Submit.');
  expect(view.container.querySelector('[data-testid="newbie-time"]').value).toBe('10:30');

  api.updateSession.mockResolvedValueOnce({ ok: true, requestSaved: true });
  await act(async () => {
    view.container.querySelector('[data-testid="newbie-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(api.updateSession).toHaveBeenCalledTimes(2);
  expect(view.onNavigate).toHaveBeenCalledWith('review');
  await view.unmount();
});
