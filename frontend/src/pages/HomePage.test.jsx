import React, { useState } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import fs from 'fs';
import path from 'path';
import HomePage, { buildResumedSession, canonicalResumableHistory, ResumeSupTransferModal } from './HomePage';

const mockModal = {
  showModal: jest.fn(),
  warning: jest.fn(),
  confirm: jest.fn(),
  alert: jest.fn(),
};

jest.mock('../components/ModalProvider', () => ({
  useModal: () => mockModal,
}));

jest.mock('../utils/sound', () => ({
  playSound: jest.fn(),
}));

jest.mock('../api', () => ({
  __esModule: true,
  default: {
    getSettings: jest.fn(),
    getHistory: jest.fn(),
    getStats: jest.fn(),
    getSharedPendingSupTransfers: jest.fn(),
    startSession: jest.fn(),
  },
}));

test('Smart Resume preserves Newbie Shift audit state until Supervisor Transfer PASS cleanup', () => {
  const resumed = buildResumedSession({
    history_id: 'history-2',
    candidate_name: 'Taylor Example',
    final_attempt: true,
    next_attempt_number: 3,
    attempt_state: { current_attempt: 3, max_attempts: 3, counted_attempts: 2, final_attempt: true },
    newbie_shift_data: { newbie_date: '07/30/2026', newbie_time: '10:00 AM', newbie_tz: 'ET' },
    newbie_shift_request_id: 'stale-request',
    newbie_shift_request_status: 'approved',
  });

  expect(resumed.final_attempt).toBe(true);
  expect(resumed.attempt_number).toBe(3);
  expect(resumed.prior_counted_attempts).toBe(2);
  expect(resumed.newbie_shift_data).toEqual({ newbie_date: '07/30/2026', newbie_time: '10:00 AM', newbie_tz: 'ET' });
  expect(resumed.newbie_shift_request_id).toBe('stale-request');
  expect(resumed.newbie_shift_request_status).toBe('approved');
  expect(resumed.supervisor_retry_required).toBe(false);
});

test('Smart Resume excludes Newbie Shift reschedules and deduplicates derivative source sessions', () => {
  const base = {
    tester_name: 'Tester One', status: 'Incomplete', call_1: { result: 'Pass' },
    call_2: { result: 'Pass' }, supervisor_only: false,
  };
  const rows = [
    { ...base, history_id: 'source-1', candidate_name: 'Fred Testone', timestamp_iso: '2026-07-29T10:00:00Z' },
    { ...base, history_id: 'derived-1', resume_source_history_id: 'source-1', candidate_name: 'Fred Testone', timestamp_iso: '2026-07-29T10:05:00Z' },
    { ...base, history_id: 'schedule-1', candidate_name: 'Fred Testone', newbie_shift_request_type: 'reschedule', timestamp_iso: '2026-07-29T10:06:00Z' },
    { ...base, history_id: 'source-2', candidate_name: 'Fred Testone', timestamp_iso: '2026-07-29T09:00:00Z' },
  ];
  const eligible = canonicalResumableHistory(rows, ['Tester One']);
  expect(eligible.map((row) => row.history_id)).toEqual(['derived-1', 'source-2']);
});

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
  mockModal.showModal.mockResolvedValue('cancel');
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('supervisor transfer only modal makes Smart Resume the primary safe action', async () => {
  const view = await renderComponent(
    <HomePage
      onNavigate={jest.fn()}
      settings={{ tester_name: 'Tester One' }}
      history={[]}
      historyStats={{}}
      startupStatuses={{}}
      onHistoryRefresh={jest.fn().mockResolvedValue({ history: [], stats: {} })}
    />
  );

  await act(async () => {
    view.container.querySelector('[data-testid="home-sup-only-btn"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(mockModal.showModal).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Supervisor Transfer Only',
    body: expect.stringContaining('Use Smart Resume when this candidate has saved mock-call data'),
    buttons: [
      { label: 'Cancel', cls: 'btn-ghost', value: 'cancel' },
      { label: 'Start Supervisor Transfer Only', cls: 'btn-muted', value: 'standalone' },
      { label: 'Use Smart Resume', cls: 'btn-primary', value: 'smart-resume' },
    ],
  }));

  await view.unmount();
});

test('quick actions use five desktop columns and avoid a four plus one wrap', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'polish-mts.css'), 'utf8');
  expect(css).toContain('grid-template-columns: repeat(5, minmax(150px, 1fr))');
  expect(css).toContain('@media (max-width: 1120px)');
  expect(css).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
  expect(css).not.toContain('grid-template-columns: repeat(auto-fit, minmax(190px, 1fr))');
});

test('recent activity uses clean status labels without visible symbol prefixes', async () => {
  const sampleHistory = [
    {
      timestamp: '07/12/2026 10:30 PM',
      candidate: 'Taylor Example',
      status: 'RESUMED-PASS',
      form_fill_status: 'filled',
    },
    {
      timestamp: '07/13/2026 9:00 PM',
      candidate: 'Jordan Example',
      status: 'FAIL-Final Attempt',
      form_fill_status: 'not_attempted',
    },
  ];
  const view = await renderComponent(
    <HomePage
      onNavigate={jest.fn()}
      settings={{ tester_name: 'Tester One' }}
      history={sampleHistory}
      historyStats={{}}
      startupStatuses={{}}
      onHistoryRefresh={jest.fn().mockResolvedValue({ history: sampleHistory, stats: {} })}
    />
  );

  expect(view.container.textContent).toContain('Resumed – Pass');
  expect(view.container.textContent).toContain('Fail – Final Attempt');
  expect(view.container.textContent).toContain('Form Filled');
  expect(view.container.textContent).toContain('Not Yet Filled');
  expect(view.container.textContent).not.toContain('OK Resumed');
  expect(view.container.textContent).not.toContain('x Fail');
  expect(view.container.textContent).not.toContain('- Not Yet Filled');
  view.container.querySelectorAll('.status-chip').forEach((chip) => {
    const markers = chip.querySelectorAll(':scope > .status-chip-icon');
    expect(markers).toHaveLength(1);
    expect(markers[0].getAttribute('aria-hidden')).toBe('true');
  });

  await view.unmount();
});

test('recent activity displays reconciled request status without changing Form Filled', async () => {
  const sampleHistory = [
    {
      history_id: 'request-1',
      timestamp: '07/14/2026 4:00 PM',
      candidate: 'Taylor Example',
      status: 'Incomplete',
      form_fill_status: 'filled',
      newbie_shift_request_id: 'newbie-request-1',
      newbie_shift_request_status: 'approved',
      newbie_shift_data: { newbie_date: '07/16/2026', newbie_time: '2:00 PM', newbie_tz: 'EST (Eastern)' },
    },
    {
      history_id: 'request-2',
      timestamp: '07/14/2026 3:00 PM',
      candidate: 'Jordan Example',
      status: 'Incomplete',
      form_fill_status: 'filled',
      newbie_shift_request_id: 'newbie-request-2',
      newbie_shift_request_status: 'denied',
      newbie_shift_data: { newbie_date: '07/17/2026', newbie_time: '3:00 PM', newbie_tz: 'EST (Eastern)' },
    },
  ];
  const view = await renderComponent(
    <HomePage
      onNavigate={jest.fn()}
      settings={{ tester_name: 'Tester One' }}
      history={sampleHistory}
      historyStats={{}}
      startupStatuses={{}}
      onHistoryRefresh={jest.fn().mockResolvedValue({ history: sampleHistory, stats: {} })}
    />
  );

  expect(view.container.textContent).toContain('Newbie Shift Scheduled');
  expect(view.container.textContent).toContain('Newbie Shift Denied');
  expect(view.container.textContent.match(/Form Filled/g)).toHaveLength(2);
  await view.unmount();
});

test('Home recent-session details hand the selected record to the shared History modal flow', async () => {
  const selected = {
    history_id: 'history-reschedule-1',
    timestamp: '07/18/2026 4:00 PM',
    candidate: 'Taylor Example',
    status: 'Incomplete',
    newbie_shift_request_status: 'approved',
    newbie_shift_scheduled_at: '2026-07-25T11:00:00-04:00',
  };
  const onNavigate = jest.fn();
  const view = await renderComponent(
    <HomePage
      onNavigate={onNavigate}
      settings={{ tester_name: 'Tester One' }}
      history={[selected]}
      historyStats={{}}
      startupStatuses={{}}
      onHistoryRefresh={jest.fn().mockResolvedValue({ history: [selected], stats: {} })}
    />
  );

  await act(async () => {
    view.container.querySelector('.recent-row').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(onNavigate).toHaveBeenCalledWith('history', { selectedHistoryRecord: selected });
  await view.unmount();
});

test('Smart Resume carries the authoritative request decision and original workflow data', () => {
  const entry = {
    history_id: 'history-1',
    candidate_name: 'Taylor Example',
    tester_name: 'Tester One',
    call_1: { result: 'Pass' },
    form_fill_status: 'filled',
    newbie_shift_data: { newbie_date: '07/16/2026', newbie_time: '2:00 PM', newbie_tz: 'EST (Eastern)' },
    newbie_shift_request_id: 'request-1',
    newbie_shift_request_status: 'denied',
    newbie_shift_admin_decision_at: '2026-07-14T16:00:00+00:00',
    newbie_shift_admin_decision_by: 'SAM Admin',
    newbie_shift_denial_reason: 'No availability',
  };

  const resumed = buildResumedSession(entry);

  expect(resumed.resume_source_history_id).toBe('history-1');
  expect(resumed.call_1).toEqual({ result: 'Pass' });
  expect(resumed.newbie_shift_request_id).toBe('request-1');
  expect(resumed.newbie_shift_request_status).toBe('denied');
  expect(resumed.newbie_shift_denial_reason).toBe('No availability');
  expect(resumed.newbie_shift_admin_decision_by).toBe('SAM Admin');
  expect(resumed.newbie_shift_data).toEqual(entry.newbie_shift_data);
});

test('Smart Resume cards require an explicit selection and expose the required fields', async () => {
  const entries = [
    { history_id: 'one', timestamp: '07/14/2026 4:00 PM', candidate: 'Taylor Example', status: 'Incomplete', call_1: { result: 'Pass' } },
    { history_id: 'two', timestamp: '07/15/2026 5:00 PM', candidate: 'Jordan Example', status: 'Saved', call_1: { result: 'Pass' }, call_2: { result: 'Fail' } },
  ];
  function ControlledResumeModal() {
    const [selected, setSelected] = useState(null);
    return <ResumeSupTransferModal entries={entries} selectedEntry={selected} onSelect={setSelected} onClose={jest.fn()} onConfirm={jest.fn()} />;
  }
  const view = await renderComponent(<ControlledResumeModal />);

  const continueButton = view.container.querySelector('[data-testid="resume-sup-confirm"]');
  expect(continueButton.disabled).toBe(true);
  expect(view.container.textContent).toContain('Date');
  expect(view.container.textContent).toContain('Candidate');
  expect(view.container.textContent).toContain('Calls completed');
  expect(view.container.textContent).toContain('Status');
  expect(view.container.textContent).toContain('Taylor Example');
  expect(view.container.textContent).toContain('Jordan Example');

  await act(async () => {
    view.container.querySelector('[data-testid="resume-entry-1"]').click();
    await flushPromises();
  });
  expect(continueButton.disabled).toBe(false);
  expect(view.container.querySelector('.resume-session-card.is-selected').textContent).toContain('Jordan Example');
  await view.unmount();
});
