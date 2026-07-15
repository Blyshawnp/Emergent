import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import HistoryPage from './HistoryPage';
import api from '../api';

const mockModal = {
  alert: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  confirm: jest.fn(),
  confirmDanger: jest.fn(),
  showModal: jest.fn(),
};

jest.mock('../api', () => ({
  __esModule: true,
  default: {
    getHistory: jest.fn(),
    getHistoryStats: jest.fn(),
    startSession: jest.fn(),
    fillForm: jest.fn(),
    deleteHistorySession: jest.fn(),
    requestHistorySessionDeletion: jest.fn(),
    clearHistory: jest.fn(),
  },
}));

jest.mock('../components/ModalProvider', () => ({
  useModal: () => mockModal,
}));

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderPage(history) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onNavigate = jest.fn();

  api.getHistory.mockResolvedValue(history);
  api.getHistoryStats.mockResolvedValue({
    total: history.length,
    passes: 1,
    fails: 1,
    ncns: 0,
    incomplete: 1,
    pass_rate: 50,
  });

  await act(async () => {
    root.render(<HistoryPage onNavigate={onNavigate} />);
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

const historyRows = [
  {
    history_id: 'pass-1',
    timestamp: '07/12/2026 10:30 PM',
    candidate: 'Taylor Example',
    tester_name: 'Tester One',
    status: 'RESUMED-PASS',
    form_fill_status: 'filled',
  },
  {
    history_id: 'incomplete-1',
    timestamp: '07/13/2026 9:00 PM',
    candidate: 'Jordan Example',
    tester_name: 'Tester Two',
    status: 'Incomplete',
    form_fill_status: 'not_attempted',
    time_for_sup: false,
    newbie_shift_data: {
      newbie_date: '07/14/2026',
      newbie_time: '10:30 PM',
      newbie_tz: 'EST (Eastern)',
    },
    newbie_shift_request_status: 'pending',
  },
  {
    history_id: 'fail-1',
    timestamp: '07/14/2026 8:15 PM',
    candidate: 'Casey Example',
    tester_name: 'Tester Three',
    status: 'FAIL-Final Attempt',
    form_fill_status: 'failed',
  },
];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockModal.alert.mockResolvedValue(true);
  mockModal.warning.mockResolvedValue(true);
  mockModal.error.mockResolvedValue(true);
  mockModal.confirm.mockResolvedValue(false);
  mockModal.confirmDanger.mockResolvedValue(false);
  mockModal.showModal.mockResolvedValue('cancel');
  api.startSession.mockResolvedValue({ ok: true });
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('history renders responsive grid rows with required regions and reachable actions', async () => {
  const view = await renderPage(historyRows);

  expect(view.container.querySelector('.hist-grid')).not.toBeNull();
  expect(view.container.querySelector('table.hist-table')).toBeNull();
  expect(view.container.querySelector('[role="columnheader"]').textContent).toBe('Date');
  const row = view.container.querySelector('[data-testid="history-row-1"]');
  expect(row.querySelector('[data-label="Date"]').textContent).toContain('07/13/2026');
  expect(row.querySelector('[data-label="Candidate"]').textContent).toContain('Jordan Example');
  expect(row.querySelector('[data-label="Tester"]').textContent).toContain('Tester Two');
  expect(row.querySelector('[data-label="Session Status"]').textContent).toContain('Incomplete');
  expect(row.querySelector('[data-label="Follow-Up"]').textContent).toContain('07/14/2026, 10:30 PM');
  expect(row.querySelector('[data-label="Follow-Up"]').textContent).toContain('Eastern');
  expect(row.querySelector('[data-label="Follow-Up"]').textContent).not.toContain('EST (Eastern)');
  expect(row.querySelector('[data-label="Form Status"]').textContent).toContain('Not Yet Filled');
  expect(row.querySelector('[data-testid="history-view-1"]')).not.toBeNull();
  expect(row.querySelector('[data-testid="history-reschedule-1"]')).not.toBeNull();
  expect(row.querySelector('[data-testid="history-delete-1"]')).not.toBeNull();

  await view.unmount();
});

test('history status chips use clean labels without visible symbol prefixes', async () => {
  const view = await renderPage(historyRows);
  const text = view.container.textContent;

  expect(text).toContain('Resumed – Pass');
  expect(text).toContain('Fail – Final Attempt');
  expect(text).toContain('Form Filled');
  expect(text).toContain('Not Yet Filled');
  expect(text).not.toContain('OK Resumed');
  expect(text).not.toContain('OK Form Filled');
  expect(text).not.toContain('x Fail');
  expect(text).not.toContain('- Not Yet Filled');
  expect(view.container.querySelector('.status-chip-icon').getAttribute('aria-hidden')).toBe('true');
  expect(view.container.querySelector('.status-chip').getAttribute('aria-label')).toContain('status:');

  await view.unmount();
});

test('history reschedule action only appears for eligible incomplete sessions', async () => {
  const view = await renderPage(historyRows);

  expect(view.container.querySelector('[data-testid="history-reschedule-0"]')).toBeNull();
  expect(view.container.querySelector('[data-testid="history-reschedule-1"]')).not.toBeNull();
  expect(view.container.querySelector('[data-testid="history-reschedule-2"]')).toBeNull();

  await view.unmount();
});

test('history displays reconciled approved and denied statuses and keeps denial details accessible', async () => {
  const reconciledRows = [
    {
      ...historyRows[1],
      history_id: 'approved-request',
      newbie_shift_request_id: 'request-approved',
      newbie_shift_request_status: 'approved',
      form_fill_status: 'filled',
    },
    {
      ...historyRows[1],
      history_id: 'denied-request',
      newbie_shift_request_id: 'request-denied',
      newbie_shift_request_status: 'denied',
      newbie_shift_denial_reason: 'No supervisor availability',
      form_fill_status: 'filled',
    },
  ];
  const view = await renderPage(reconciledRows);

  expect(view.container.querySelector('[data-testid="history-row-0"]').textContent).toContain('Approved');
  expect(view.container.querySelector('[data-testid="history-row-1"]').textContent).toContain('Denied');
  expect(view.container.querySelector('[data-testid="history-row-1"]').textContent).toContain('Form Filled');

  await act(async () => {
    view.container.querySelector('[data-testid="history-view-1"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(view.container.textContent).toContain('Denial Reason: No supervisor availability');
  expect(view.container.textContent).toContain('Approval Status: Denied');
  await view.unmount();
});
