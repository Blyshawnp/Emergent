import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import SupTransferPage from './SupTransferPage';
import api from '../api';

const mockModal = {
  confirm: jest.fn(),
  confirmDanger: jest.fn(),
  warning: jest.fn(),
  showModal: jest.fn(),
};

jest.mock('../api', () => ({
  __esModule: true,
  default: {
    getCurrentSession: jest.fn(),
    getDefaults: jest.fn(),
    getSettings: jest.fn(),
    updateSession: jest.fn(),
    discardSession: jest.fn(),
    saveSupTransfer: jest.fn(),
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

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.scrollTo = jest.fn();
});

async function renderPage(sessionOverrides = {}, navigationState = null, defaults = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onNavigate = jest.fn();

  api.getCurrentSession.mockResolvedValue({
    session: {
      candidate_name: 'Taylor Example',
      supervisor_only: false,
      final_attempt: false,
      ...sessionOverrides,
    },
  });
  api.getDefaults.mockResolvedValue(defaults);
  api.getSettings.mockResolvedValue({});

  await act(async () => {
    root.render(<SupTransferPage onNavigate={onNavigate} navigationState={navigationState} />);
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

beforeEach(() => {
  jest.clearAllMocks();
  mockModal.confirm.mockResolvedValue(true);
  mockModal.confirmDanger.mockResolvedValue(false);
  mockModal.warning.mockResolvedValue(true);
  mockModal.showModal.mockResolvedValue(true);
  api.updateSession.mockResolvedValue({ ok: true });
  api.saveSupTransfer.mockResolvedValue({ ok: true });
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('shows NC/NS and Not Ready buttons on supervisor-only transfer 1', async () => {
  const view = await renderPage({ supervisor_only: true });

  expect(view.container.querySelector('[data-testid="sup-ncns"]')).not.toBeNull();
  expect(view.container.querySelector('[data-testid="sup-notready"]')).not.toBeNull();

  await view.unmount();
});

test('does not show NC/NS and Not Ready buttons in regular supervisor transfer flow', async () => {
  const view = await renderPage({ supervisor_only: false });

  expect(view.container.querySelector('[data-testid="sup-ncns"]')).toBeNull();
  expect(view.container.querySelector('[data-testid="sup-notready"]')).toBeNull();

  await view.unmount();
});

test('supervisor-only NC/NS button confirms, saves auto-fail, and routes to review', async () => {
  mockModal.showModal.mockResolvedValueOnce(true);
  const view = await renderPage({ supervisor_only: true, candidate_name: 'Taylor Example' });

  await act(async () => {
    view.container.querySelector('[data-testid="sup-ncns"]').dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    await flushPromises();
  });

  expect(mockModal.showModal).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Confirm Supervisor Transfer NC/NS',
    body: 'This will automatically fail Taylor Example and mark the supervisor transfer as a No Call No Show. Do you want to continue?',
    buttons: [
      expect.objectContaining({ label: 'Cancel', value: false }),
      expect.objectContaining({ label: 'Mark NC/NS', value: true }),
    ],
  }));
  expect(mockModal.confirm).not.toHaveBeenCalled();
  expect(api.updateSession).toHaveBeenCalledWith({
    auto_fail_reason: 'NC/NS',
    final_status: 'Fail',
    current_sup_transfer_draft: null,
    current_sup_transfer_num: null,
  });
  expect(view.onNavigate).toHaveBeenCalledWith('review');

  await view.unmount();
});

test('supervisor-only Not Ready button confirms, saves auto-fail, and routes to review', async () => {
  mockModal.showModal.mockResolvedValueOnce(true);
  const view = await renderPage({ supervisor_only: true, candidate_name: 'Taylor Example' });

  await act(async () => {
    view.container.querySelector('[data-testid="sup-notready"]').dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    await flushPromises();
  });

  expect(mockModal.showModal).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Confirm Auto-Fail',
    body: 'This will Automatically fail Taylor Example and mark as Not Ready for Session. Do you want to proceed?',
    buttons: [
      expect.objectContaining({ label: 'Cancel', value: false }),
      expect.objectContaining({ label: 'Yes', value: true }),
    ],
  }));
  expect(api.updateSession).toHaveBeenCalledWith({
    auto_fail_reason: 'Not Ready for Session',
    final_status: 'Fail',
    current_sup_transfer_draft: null,
    current_sup_transfer_num: null,
  });
  expect(view.onNavigate).toHaveBeenCalledWith('review');

  await view.unmount();
});

test('shows Caller Demographics before Payment Simulation', async () => {
  const view = await renderPage({}, null, {
    donors_new: [['Jamie', 'Caller', '1 Main St', '', 'Town', 'NC', '555-0100', 'jamie@example.test']],
  });
  const text = view.container.textContent;
  expect(text.indexOf('Caller Demographics')).toBeGreaterThan(-1);
  expect(text.indexOf('Caller Demographics')).toBeLessThan(text.indexOf('Payment Simulation'));
  await view.unmount();
});

test('regular supervisor transfer Back returns to the last completed call', async () => {
  const view = await renderPage({
    call_1: { result: 'Pass' },
    call_2: { result: 'Fail' },
    call_3: { result: 'Pass' },
    sup_transfer_1: { result: 'Fail' },
  }, { transferNum: 2 });

  await act(async () => {
    view.container.querySelector('[data-testid="sup-back"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(view.onNavigate).toHaveBeenCalledWith('calls', { callNum: 3 });
  expect(view.onNavigate).not.toHaveBeenCalledWith('suptransfer', { transferNum: 1 });
  await view.unmount();
});

test('supervisor-only Back returns to Basics', async () => {
  const view = await renderPage({ supervisor_only: true }, { transferNum: 1 });
  await act(async () => {
    view.container.querySelector('[data-testid="sup-back"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(view.onNavigate).toHaveBeenCalledWith('basics');
  await view.unmount();
});

test('second failed supervisor transfer prompts for Newbie Shift when not final attempt', async () => {
  const view = await renderPage({
    final_attempt: false,
    call_1: { result: 'Pass' },
    call_2: { result: 'Pass' },
    sup_transfer_1: { result: 'Fail', fails: { 'Did not ask permission to transfer': true } },
    sup_transfer_drafts: {
      2: {
        transfer_num: 2,
        result: 'Fail',
        fails: { 'Transferred to wrong queue': true },
        coaching: { 'Minimize dead air': true },
      },
    },
  }, { transferNum: 2 });
  api.getCurrentSession.mockResolvedValue({
    session: {
      candidate_name: 'Taylor Example',
      final_attempt: false,
      call_1: { result: 'Pass' },
      call_2: { result: 'Pass' },
      sup_transfer_1: { result: 'Fail', fails: { 'Did not ask permission to transfer': true } },
      sup_transfer_2: { result: 'Fail', fails: { 'Transferred to wrong queue': true } },
    },
  });
  mockModal.showModal.mockResolvedValueOnce(true);

  await act(async () => {
    view.container.querySelector('[data-testid="sup-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(mockModal.showModal).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Schedule Newbie Shift',
  }));
  expect(api.updateSession).toHaveBeenCalledWith(expect.objectContaining({
    final_status: 'Incomplete',
    fail_summary: 'N/A',
    newbie_shift_prompt: expect.objectContaining({
      trigger: 'both_sup_transfers_failed',
      status: 'accepted',
    }),
  }));
  expect(view.onNavigate).toHaveBeenCalledWith('newbieshift');

  await view.unmount();
});

test('final-attempt second failed supervisor transfer fails with no Newbie Shift prompt', async () => {
  const view = await renderPage({
    final_attempt: true,
    call_1: { result: 'Pass' },
    call_2: { result: 'Pass' },
    sup_transfer_1: { result: 'Fail', fails: { 'Did not ask permission to transfer': true } },
    sup_transfer_drafts: {
      2: {
        transfer_num: 2,
        result: 'Fail',
        fails: { 'Transferred to wrong queue': true },
        coaching: { 'Minimize dead air': true },
      },
    },
  }, { transferNum: 2 });
  api.getCurrentSession.mockResolvedValue({
    session: {
      candidate_name: 'Taylor Example',
      final_attempt: true,
      sup_transfer_1: { result: 'Fail' },
      sup_transfer_2: { result: 'Fail' },
    },
  });

  await act(async () => {
    view.container.querySelector('[data-testid="sup-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(mockModal.showModal).not.toHaveBeenCalledWith(expect.objectContaining({
    title: 'Schedule Newbie Shift',
  }));
  expect(api.updateSession).toHaveBeenCalledWith({ final_status: 'FAIL-Final Attempt' });
  expect(view.onNavigate).toHaveBeenCalledWith('review');

  await view.unmount();
});

test('already scheduled Newbie Shift suppresses second-fail prompt and routes to Review', async () => {
  const view = await renderPage({
    final_attempt: false,
    call_1: { result: 'Pass' },
    call_2: { result: 'Pass' },
    sup_transfer_1: { result: 'Fail', fails: { 'Did not ask permission to transfer': true } },
    sup_transfer_drafts: {
      2: {
        transfer_num: 2,
        result: 'Fail',
        fails: { 'Transferred to wrong queue': true },
        coaching: { 'Minimize dead air': true },
      },
    },
  }, { transferNum: 2 });
  api.getCurrentSession.mockResolvedValue({
    session: {
      candidate_name: 'Taylor Example',
      final_attempt: false,
      newbie_shift_data: { newbie_date: '06/23/2026', newbie_time: '10:00 AM', newbie_tz: 'ET' },
      sup_transfer_1: { result: 'Fail' },
      sup_transfer_2: { result: 'Fail' },
    },
  });

  await act(async () => {
    view.container.querySelector('[data-testid="sup-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(mockModal.showModal).not.toHaveBeenCalledWith(expect.objectContaining({
    title: 'Schedule Newbie Shift',
  }));
  expect(api.updateSession).toHaveBeenCalledWith(expect.objectContaining({
    final_status: 'Incomplete',
    fail_summary: 'N/A',
  }));
  expect(view.onNavigate).toHaveBeenCalledWith('review');

  await view.unmount();
});
