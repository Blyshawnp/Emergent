import React from 'react';
import fs from 'fs';
import path from 'path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import HistoryPage, { buildHistoryCorrectionChanges } from './HistoryPage';
import api from '../api';

const mockModal = {
  alert: jest.fn(),
  success: jest.fn(),
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
    reconcileHistory: jest.fn(),
    startSession: jest.fn(),
    fillForm: jest.fn(),
    deleteHistorySession: jest.fn(),
    requestHistorySessionDeletion: jest.fn(),
    requestHistorySessionCorrection: jest.fn(),
    clearHistory: jest.fn(),
  },
}));

jest.mock('../components/ModalProvider', () => ({
  useModal: () => mockModal,
}));

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderPage(history, reconciliation = null) {
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
  api.reconcileHistory.mockReturnValue(reconciliation || Promise.resolve({
      ok: true,
      history,
      stats: { total: history.length, passes: 1, fails: 1, ncns: 0, incomplete: 1, pass_rate: 50 },
    }));

  await act(async () => {
    root.render(<HistoryPage onNavigate={onNavigate} history={history} historyStats={{ total: history.length }} />);
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
  mockModal.success.mockResolvedValue(true);
  mockModal.warning.mockResolvedValue(true);
  mockModal.error.mockResolvedValue(true);
  mockModal.confirm.mockResolvedValue(false);
  mockModal.confirmDanger.mockResolvedValue(false);
  mockModal.showModal.mockResolvedValue('cancel');
  api.startSession.mockResolvedValue({ ok: true, session: { session_id: 'active-reschedule' } });
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('history renders responsive grid rows with required regions and reachable actions', async () => {
  const view = await renderPage(historyRows);

  expect(view.container.querySelector('.hist-grid')).not.toBeNull();
  expect(view.container.querySelector('.history-list-card')).not.toBeNull();
  expect(view.container.querySelector('table.hist-table')).toBeNull();
  expect(view.container.querySelector('[role="columnheader"]').textContent).toBe('Date / Follow-Up');
  const row = view.container.querySelector('[data-testid="history-row-1"]');
  expect(row.querySelector('[data-label="Date / Follow-Up"]').textContent).toContain('07/13/2026');
  expect(row.querySelector('[data-label="Date / Follow-Up"]').textContent).toContain('07/14/2026, 10:30 PM');
  expect(row.querySelector('[data-label="Date / Follow-Up"]').textContent).toContain('Eastern');
  expect(row.querySelector('[data-label="Candidate"]').textContent).toContain('Jordan Example');
  expect(row.querySelector('[data-label="Tester / Form Status"]').textContent).toContain('Tester Two');
  expect(row.querySelector('[data-label="Tester / Form Status"]').textContent).toContain('Not Yet Filled');
  expect(row.querySelector('[data-label="Session Status"]').textContent).toContain('Incomplete');
  expect(row.querySelector('[data-label="Date / Follow-Up"]').textContent).not.toContain('EST (Eastern)');
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
  view.container.querySelectorAll('.status-chip').forEach((chip) => {
    const markers = chip.querySelectorAll(':scope > .status-chip-icon');
    expect(markers).toHaveLength(1);
    expect(markers[0].getAttribute('aria-hidden')).toBe('true');
  });
  expect(view.container.querySelector('.status-chip').getAttribute('aria-label')).toContain('status:');

  await view.unmount();
});

test('session details show one persistent Final Attempt banner and saved attempt history', async () => {
  const finalRow = {
    ...historyRows[2],
    final_attempt: true,
    attempt_state: { current_attempt: 3, max_attempts: 3 },
    attempt_history: [
      { attempt_number: 2, final_status: 'Incomplete', sup_transfer_1: { result: 'Fail' } },
    ],
  };
  const view = await renderPage([finalRow]);

  await act(async () => {
    view.container.querySelector('[data-testid="history-view-0"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  const detail = view.container.querySelector('[data-testid="history-detail-modal"]');
  expect(detail.querySelectorAll('[data-testid="final-attempt-banner"]')).toHaveLength(1);
  expect(detail.textContent).toContain('FINAL ATTEMPT');
  expect(detail.textContent).toContain('Attempt History');
  expect(detail.textContent).toContain('Attempt 2');

  await view.unmount();
});

test('history CSS uses one shared five-area template with intentional compact and card layouts', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'App.css'), 'utf8');
  expect(css).toContain('container-name: history-list');
  expect(css).toContain('max-width: 1180px');
  expect(css).toContain('@container history-list (max-width: 1100px)');
  expect(css).toContain('"date candidate tester status actions"');
  expect(css).toContain('"date candidate status"');
  expect(css).toContain('"tester tester actions"');
  expect(css).toContain('@container history-list (max-width: 680px)');
  expect(css).toContain('overflow-x: clip');
  expect(css).not.toContain('.status-chip::before');
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
      newbie_shift_number: '001842',
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

  expect(view.container.querySelector('[data-testid="history-row-0"]').textContent).toContain('Newbie Shift Scheduled');
  expect(view.container.querySelector('[data-testid="history-row-0"]').textContent).toContain('Shift #001842');
  expect(view.container.querySelector('[data-testid="history-row-1"]').textContent).toContain('Newbie Shift Denied');
  expect(view.container.querySelector('[data-testid="history-row-1"]').textContent).toContain('Form Filled');

  await act(async () => {
    view.container.querySelector('[data-testid="history-view-0"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(view.container.textContent).toContain('Newbie Shift Number: Shift #001842');
  await act(async () => {
    view.container.querySelector('.modal-close').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  await act(async () => {
    view.container.querySelector('[data-testid="history-view-1"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(view.container.textContent).toContain('Denial Reason: No supervisor availability');
  expect(view.container.textContent).toContain('Approval Status: Newbie Shift Denied');
  await view.unmount();
});

test('reschedule intake is completed before navigation and carries who and reason into the active draft', async () => {
  const view = await renderPage([historyRows[1]]);

  await act(async () => {
    view.container.querySelector('[data-testid="history-reschedule-0"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(view.container.querySelector('[data-testid="reschedule-intake-modal"]')).not.toBeNull();
  expect(view.onNavigate).not.toHaveBeenCalled();
  expect(api.startSession).not.toHaveBeenCalled();

  await act(async () => {
    view.container.querySelector('[data-testid="reschedule-intake-requester-candidate"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="reschedule-intake-reason-scheduling-conflict"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="reschedule-intake-continue"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(api.startSession).toHaveBeenCalledWith(expect.objectContaining({
    newbie_shift_request_type: 'reschedule',
    newbie_shift_requested_by: 'candidate',
    newbie_shift_request_reason: 'Scheduling conflict',
    newbie_shift_data: historyRows[1].newbie_shift_data,
  }));
  expect(view.onNavigate).toHaveBeenCalledWith('newbieshift');
  await view.unmount();
});

test('details to reschedule suspends the parent modal, traps focus, and cancel restores it', async () => {
  const view = await renderPage([historyRows[1]]);

  await act(async () => {
    view.container.querySelector('[data-testid="history-view-0"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(view.container.querySelector('[data-testid="history-detail-modal"]')).not.toBeNull();

  await act(async () => {
    view.container.querySelector('[data-testid="history-detail-reschedule"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(view.container.querySelector('[data-testid="history-detail-modal"]')).toBeNull();
  expect(view.container.querySelector('[data-testid="reschedule-intake-modal"]')).not.toBeNull();
  expect(view.container.querySelectorAll('.modal-overlay.open')).toHaveLength(1);
  expect(document.activeElement).toBe(view.container.querySelector('[data-testid="reschedule-intake-requester-candidate"]'));

  await act(async () => {
    view.container.querySelector('.reschedule-intake-actions .btn-muted').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(view.container.querySelector('[data-testid="reschedule-intake-modal"]')).toBeNull();
  expect(view.container.querySelector('[data-testid="history-detail-modal"]')).not.toBeNull();
  expect(view.container.querySelectorAll('.modal-overlay.open')).toHaveLength(1);
  expect(document.activeElement).toBe(view.container.querySelector('[data-testid="history-detail-reschedule"]'));

  await view.unmount();
});

test('details reschedule Continue leaves no hidden details modal or duplicate backdrop', async () => {
  const view = await renderPage([historyRows[1]]);
  await act(async () => {
    view.container.querySelector('[data-testid="history-view-0"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    view.container.querySelector('[data-testid="history-detail-reschedule"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    view.container.querySelector('[data-testid="reschedule-intake-requester-tester"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    view.container.querySelector('[data-testid="reschedule-intake-reason-scheduling-conflict"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    view.container.querySelector('[data-testid="reschedule-intake-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(view.onNavigate).toHaveBeenCalledWith('newbieshift');
  expect(view.container.querySelectorAll('.modal-overlay.open')).toHaveLength(0);
  expect(view.container.querySelector('[data-testid="history-detail-modal"]')).toBeNull();
  await view.unmount();
});

test('candidate deletion request requires a meaningful trimmed reason', async () => {
  mockModal.showModal.mockResolvedValueOnce('request');
  const view = await renderPage([historyRows[0]]);

  await act(async () => {
    view.container.querySelector('[data-testid="history-delete-0"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  const reason = view.container.querySelector('[data-testid="candidate-deletion-reason"]');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(reason, '   ');
    reason.dispatchEvent(new Event('input', { bubbles: true }));
    view.container.querySelector('[data-testid="candidate-deletion-submit"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(api.requestHistorySessionDeletion).not.toHaveBeenCalled();
  expect(view.container.querySelector('[role="alert"]').textContent).toContain('at least 10 characters');
  await view.unmount();
});

test('candidate deletion request sends and preserves the custom reason when submission fails', async () => {
  mockModal.showModal.mockResolvedValueOnce('request');
  api.requestHistorySessionDeletion.mockRejectedValueOnce(new Error('Request service unavailable'));
  const view = await renderPage([historyRows[0]]);

  await act(async () => {
    view.container.querySelector('[data-testid="history-delete-0"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  const textarea = view.container.querySelector('[data-testid="candidate-deletion-reason"]');
  const customReason = 'Duplicate candidate record created during certification.';
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, customReason);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    view.container.querySelector('[data-testid="candidate-deletion-submit"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(api.requestHistorySessionDeletion).toHaveBeenCalledWith('pass-1', customReason);
  expect(view.container.querySelector('[data-testid="candidate-deletion-reason"]').value).toBe(customReason);
  expect(view.container.querySelector('[role="alert"]').textContent).toContain('Request service unavailable');
  await view.unmount();
});

test('deletion submitted confirmation uses the shared success pattern and states local versus SAM effects', async () => {
  mockModal.showModal.mockResolvedValueOnce('request');
  api.requestHistorySessionDeletion.mockResolvedValueOnce({
    ok: true,
    message: 'This session was removed from MTS History. Its Candidate Tracking record will remain until a SAM administrator approves the deletion request.',
  });
  const view = await renderPage([historyRows[0]]);
  await act(async () => {
    view.container.querySelector('[data-testid="history-delete-0"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  const textarea = view.container.querySelector('[data-testid="candidate-deletion-reason"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  await act(async () => {
    setter.call(textarea, 'Duplicate candidate record requires administrator review.');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="candidate-deletion-submit"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(mockModal.success).toHaveBeenCalledWith(
    'Deletion Request Submitted',
    expect.stringMatching(/removed from local History.*submitted to SAM.*awaiting review/s)
  );
  await view.unmount();
});

test('History Only deletes locally without creating a candidate deletion request', async () => {
  mockModal.showModal.mockResolvedValueOnce('history-only');
  api.deleteHistorySession.mockResolvedValueOnce({ ok: true });
  const view = await renderPage([historyRows[0]]);

  await act(async () => {
    view.container.querySelector('[data-testid="history-delete-0"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(api.deleteHistorySession).toHaveBeenCalledWith('pass-1');
  expect(api.requestHistorySessionDeletion).not.toHaveBeenCalled();
  expect(mockModal.alert).toHaveBeenCalledWith('Deleted', expect.stringContaining('session was deleted'));
  await view.unmount();
});

test('candidate information correction submits only changed allowed fields with stable history id', async () => {
  api.requestHistorySessionCorrection.mockResolvedValueOnce({
    ok: true,
    request_id: 'correction-pass-1',
    changes: [{ field: 'candidate_name', label: 'Candidate Name', previous_value: 'Alpha User', requested_value: 'Alpha Usher' }],
  });
  const view = await renderPage([historyRows[0]]);
  await act(async () => {
    view.container.querySelector('[data-testid="history-view-0"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="history-correction-action"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  const inputs = view.container.querySelectorAll('.correction-request-modal input');
  const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const textareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  await act(async () => {
    inputSetter.call(inputs[0], 'Alpha Usher');
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    const reason = view.container.querySelector('.correction-request-modal textarea');
    textareaSetter.call(reason, 'Candidate surname was entered incorrectly.');
    reason.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="candidate-correction-submit"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(api.requestHistorySessionCorrection).toHaveBeenCalledWith(
    'pass-1',
    [expect.objectContaining({
      field: 'candidate_name',
      field_key: 'candidate_name',
      previous_value: 'Taylor Example',
      requested_value: 'Alpha Usher',
    })],
    'Candidate surname was entered incorrectly.'
  );
  expect(mockModal.success).toHaveBeenCalledWith(
    'Correction Request Submitted',
    'The requested correction was saved locally and sent to SAM for review. The current candidate information will remain authoritative until the request is approved.'
  );
  await view.unmount();
});

test('History correction preview omits unchanged whitespace and keeps capitalization-only changes', () => {
  const record = { candidate_name: 'taylor example', headset_brand: 'Jabra Evolve 40' };
  expect(buildHistoryCorrectionChanges(record, {
    candidateName: 'Taylor Example',
    headsetModel: ' Jabra Evolve 40 ',
  })).toEqual([expect.objectContaining({ field: 'candidate_name', requested_value: 'Taylor Example' })]);
  expect(buildHistoryCorrectionChanges(record, {
    candidateName: ' taylor example ',
    headsetModel: 'Jabra Evolve 40',
  })).toEqual([]);
});

test('History correction supports independent brand-only and model-only changes', () => {
  const record = { candidate_name: 'Taylor Example', headset_brand: 'Logitech', headset_model: 'H390' };
  expect(buildHistoryCorrectionChanges(record, {
    candidateName: 'Taylor Example', headsetBrand: 'LOGITECH', headsetModel: 'H390',
  })).toEqual([expect.objectContaining({
    field: 'headset_brand', previous_value: 'Logitech', requested_value: 'LOGITECH',
  })]);
  expect(buildHistoryCorrectionChanges(record, {
    candidateName: 'Taylor Example', headsetBrand: 'Logitech', headsetModel: 'H390 USB',
  })).toEqual([expect.objectContaining({
    field: 'headset_model', previous_value: 'H390', requested_value: 'H390 USB',
  })]);
});

test('History detail derives one combined headset label from separate brand and model fields', async () => {
  const view = await renderPage([{ ...historyRows[0], headset_brand: 'Logitech', headset_model: 'H390' }]);
  await act(async () => {
    view.container.querySelector('[data-testid="history-view-0"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  const detail = view.container.querySelector('[data-testid="history-detail-modal"]');
  expect(detail.textContent).toContain('Headset: Logitech H390');
  expect(detail.textContent).not.toContain('Logitech Logitech H390');
  await view.unmount();
});

test('History correction dialog stacks above the session detail dialog', () => {
  const source = fs.readFileSync(path.join(__dirname, 'HistoryPage.jsx'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'App.css'), 'utf8');
  expect(source).toMatch(/\{correctionDraft && \(\s*<div className="modal-overlay open correction-request-overlay">/);
  expect(css).toMatch(/\.correction-request-overlay\s*\{\s*z-index:\s*1100;/);
});

test('candidate correction action is in the responsive footer and absent from the detail body', async () => {
  const view = await renderPage([historyRows[0]]);
  await act(async () => {
    view.container.querySelector('[data-testid="history-view-0"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  const detail = view.container.querySelector('[data-testid="history-detail-modal"]');
  const footer = detail.querySelector('[data-testid="history-detail-footer"]');
  expect(footer.querySelector('[data-testid="history-correction-action"]')).not.toBeNull();
  expect(detail.querySelector('.modal-body [data-testid="history-correction-action"]')).toBeNull();
  expect(footer.querySelector('[data-testid="history-correction-action"]').getAttribute('aria-label')).toBe('Correct Candidate Information');
  expect(Array.from(footer.querySelectorAll('button')).map((button) => button.textContent.trim())).toEqual([
    'Close', 'Correct Candidate Info', 'Delete Session', 'Refill Cert Form', 'Open in Review',
  ]);
  await view.unmount();
});

test('local History remains visible while one background reconciliation is unresolved', async () => {
  let resolveReconciliation;
  const pending = new Promise((resolve) => { resolveReconciliation = resolve; });
  const view = await renderPage([historyRows[0]], pending);
  expect(view.container.querySelector('[data-testid="history-row-0"]').textContent).toContain('Taylor Example');
  expect(view.container.querySelector('[data-testid="history-syncing"]')).not.toBeNull();
  expect(api.reconcileHistory).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolveReconciliation({ history: [{ ...historyRows[0], candidate: 'Taylor Updated' }], stats: { total: 1 } });
    await flushPromises();
  });
  expect(view.container.querySelector('[data-testid="history-row-0"]').textContent).toContain('Taylor Updated');
  await view.unmount();
});

test('remote reconciliation failure preserves local History and offers retry', async () => {
  let rejectReconciliation;
  const pending = new Promise((_resolve, reject) => { rejectReconciliation = reject; });
  const view = await renderPage([historyRows[0]], pending);
  await act(async () => {
    rejectReconciliation(new Error('offline'));
    await flushPromises();
  });
  expect(view.container.querySelector('[data-testid="history-row-0"]').textContent).toContain('Taylor Example');
  expect(view.container.querySelector('[role="alert"]').textContent).toContain('Local History is still available');
  expect(Array.from(view.container.querySelectorAll('button')).some((button) => button.textContent === 'Retry')).toBe(true);
  await view.unmount();
});
