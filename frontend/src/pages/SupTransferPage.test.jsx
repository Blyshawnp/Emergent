import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import fs from 'fs';
import path from 'path';
import SupTransferPage, {
  DEFAULT_SUP_REASONS,
  getSupervisorReasonScenarioText,
} from './SupTransferPage';
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

function selectValue(select, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function readReasonCsv(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(1)
    .map((line) => line.replace(/^"|"$/g, ''));
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.scrollTo = jest.fn();
});

async function renderPage(sessionOverrides = {}, navigationState = null, defaults = {}, settings = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onNavigate = jest.fn();

  const currentSession = {
    session: {
      candidate_name: 'Taylor Example',
      supervisor_only: false,
      final_attempt: false,
      ...sessionOverrides,
    },
  };
  api.getCurrentSession.mockResolvedValue(currentSession);

  await act(async () => {
    root.render(
      <SupTransferPage
        onNavigate={onNavigate}
        navigationState={navigationState}
        settings={settings}
        defaults={defaults}
        currentSession={currentSession}
      />
    );
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

test.each([
  ['Damaged Gift', 'The caller received a damaged gift.'],
  ['Did Not Receive Gift', 'The caller did not receive their gift.'],
  ["Didn't Receive Gift", 'The caller did not receive their gift.'],
  ['Cancelled Sustaining Donation Charged', 'The caller was charged for a cancelled sustaining donation.'],
  ['Charged for a cancelled sustaining', 'The caller was charged for a cancelled sustaining donation.'],
  ['Double Charged', 'The caller was double charged.'],
  ['Hung Up On', 'The caller was hung up on during a previous call.'],
  ['Use Own/Other', 'Tester’s chosen reason.'],
])('uses reason-specific Supervisor Transfer text for %s', (reason, expected) => {
  expect(getSupervisorReasonScenarioText(reason)).toBe(expected);
});

test('only Hung Up On uses the previous-call suffix and prohibited phrases are absent', () => {
  const outputs = [
    'Damaged Gift',
    'Did Not Receive Gift',
    'Cancelled Sustaining Donation Charged',
    'Double Charged',
    'Hung Up On',
    'Use Own/Other',
  ].map((reason) => getSupervisorReasonScenarioText(reason));

  expect(outputs.filter((text) => text.includes('during a previous call'))).toEqual([
    'The caller was hung up on during a previous call.',
  ]);
  expect(outputs.join(' ')).not.toMatch(/received a damaged gift during a previous call/i);
  expect(outputs.join(' ')).not.toMatch(/did(?:n't| not) receive their gift during a previous call/i);
  expect(outputs.join(' ')).not.toMatch(/double charged during a previous call/i);
  expect(outputs.join(' ')).not.toMatch(/charged for a cancelled sustaining donation during a previous call/i);
  expect(outputs.join(' ')).not.toMatch(/caller Use Own\/Other/i);
});

test('Use Own/Other can render safely supplied custom text', () => {
  expect(getSupervisorReasonScenarioText('Use Own/Other', 'the package arrived late'))
    .toBe('the package arrived late.');
});

test('dropdown changes update scenario text and Regenerate preserves reason semantics and caller identity', async () => {
  const view = await renderPage({}, null, {
    donors_new: [['Jamie', 'Caller', '1 Main St', '', 'Town', 'NC', '555-0100', 'jamie@example.test']],
    shows: [['WXYZ']],
    sup_reasons: ['Damaged Gift', 'Double Charged'],
  });
  const scenario = view.container.querySelector('[data-testid="sup-scenario-card"]');

  expect(scenario.textContent).toContain('For this call you will portray Jamie Caller.');
  expect(scenario.textContent).toContain('Jamie would like to speak with a supervisor.');
  expect(scenario.textContent).toContain('The caller received a damaged gift.');

  await act(async () => {
    selectValue(view.container.querySelector('[data-testid="sup-reason"]'), 'Double Charged');
  });
  expect(scenario.textContent).toContain('The caller was double charged.');
  expect(scenario.textContent).not.toContain('The caller received a damaged gift.');

  await act(async () => {
    view.container.querySelector('[data-testid="sup-regen"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(scenario.textContent).toContain('The caller was double charged.');
  expect(scenario.textContent).toContain('Jamie would like to speak with a supervisor.');

  await view.unmount();
});

test('frontend, packaged backend, and admin-package fallback reason labels stay aligned', () => {
  expect(readReasonCsv('../../../backend/defaults/sup-reasons.csv')).toEqual(DEFAULT_SUP_REASONS);
  expect(readReasonCsv('../../../docs/admin-content-package/csv-tabs/sup-reasons.csv')).toEqual(DEFAULT_SUP_REASONS);
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

test('uses App-cached entry data without duplicate defaults, settings, or session requests', async () => {
  const view = await renderPage({ supervisor_only: true });

  expect(api.getDefaults).not.toHaveBeenCalled();
  expect(api.getSettings).not.toHaveBeenCalled();
  expect(api.getCurrentSession).not.toHaveBeenCalled();

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
