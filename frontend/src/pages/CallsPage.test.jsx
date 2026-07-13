import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import CallsPage from './CallsPage';
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
    startSession: jest.fn(),
    discardSession: jest.fn(),
    saveCall: jest.fn(),
  },
}));

jest.mock('../components/ModalProvider', () => ({ useModal: () => mockModal }));
jest.mock('../components/TechIssueDialog', () => function TechIssueDialog() { return null; });
jest.mock('../components/WorkflowProgress', () => ({
  __esModule: true,
  default: function WorkflowProgress() { return null; },
  getWorkflowProgress: () => ({}),
}));

const defaults = {
  call_types: ['New Donor - One Time'],
  shows: [['Test Show', '25', '10', '', '']],
  donors_new: [['Jamie', 'Caller', '1 Main St', '', 'Town', 'NC', '555-0100', 'jamie@example.test']],
};

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollTo = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  api.getDefaults.mockResolvedValue(defaults);
  api.getSettings.mockResolvedValue({});
  api.updateSession.mockResolvedValue({ ok: true });
  api.saveCall.mockResolvedValue({ ok: true });
  mockModal.confirmDanger.mockResolvedValue(false);
});

afterEach(() => {
  document.body.innerHTML = '';
});

async function renderPage(callNum, sessionOverrides = {}) {
  const session = {
    candidate_name: 'Taylor Example',
    final_attempt: false,
    ...sessionOverrides,
  };
  api.getCurrentSession.mockResolvedValue({ session });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onNavigate = jest.fn();
  await act(async () => {
    root.render(<CallsPage onNavigate={onNavigate} navigationState={{ callNum }} />);
    await flushPromises();
  });
  return {
    container,
    onNavigate,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test('shows Caller Demographics before Payment Simulation', async () => {
  const view = await renderPage(1);
  const text = view.container.textContent;
  expect(text.indexOf('Caller Demographics')).toBeGreaterThan(-1);
  expect(text.indexOf('Caller Demographics')).toBeLessThan(text.indexOf('Payment Simulation'));
  await view.unmount();
});

test('formats donation dropdown labels as currency without changing option values', async () => {
  api.getDefaults.mockResolvedValue({
    ...defaults,
    shows: [
      ['Whole Dollar Show', '16', '25', '', ''],
      ['Cents Show', '12.50', '100', '', ''],
    ],
  });

  const view = await renderPage(1);
  const donationSelect = view.container.querySelector('[data-testid="call-donation"]');
  const optionLabels = Array.from(donationSelect.options).map((option) => option.textContent);
  const optionValues = Array.from(donationSelect.options).map((option) => option.value);

  expect(optionLabels).toEqual(['$16', 'Other']);
  expect(optionValues).toEqual(['16', 'Other']);

  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(view.container.querySelector('[data-testid="call-show"]'), 'Cents Show');
    view.container.querySelector('[data-testid="call-show"]').dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
  });

  const updatedDonationSelect = view.container.querySelector('[data-testid="call-donation"]');
  expect(Array.from(updatedDonationSelect.options).map((option) => option.textContent)).toEqual(['$12.50', 'Other']);
  expect(Array.from(updatedDonationSelect.options).map((option) => option.value)).toEqual(['12.50', 'Other']);

  await view.unmount();
});

test.each([
  [1, 'basics', null],
  [2, 'calls', { callNum: 1 }],
  [3, 'calls', { callNum: 2 }],
])('Back from Call %i follows the required route', async (callNum, page, state) => {
  const view = await renderPage(callNum);
  await act(async () => {
    view.container.querySelector('[data-testid="calls-back"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  if (state) expect(view.onNavigate).toHaveBeenCalledWith(page, state);
  else expect(view.onNavigate).toHaveBeenCalledWith(page);
  await view.unmount();
});

test('Back preserves the current call payment selection in keyed drafts', async () => {
  const view = await renderPage(2, {
    call_1: { result: 'Pass' },
    call_drafts: {
      2: {
        call_num: 2,
        type: 'New Donor - One Time',
        show: 'Test Show',
        caller: 'Jamie Caller',
        donation: '25',
        payment_selection: { cardId: 'additional_1', eftId: 'additional_2' },
      },
    },
  });
  expect(view.container.querySelector('[data-testid="call-card-option"]').value).toBe('additional_1');
  expect(view.container.querySelector('[data-testid="call-eft-option"]').value).toBe('additional_2');
  await act(async () => {
    view.container.querySelector('[data-testid="calls-back"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(api.updateSession).toHaveBeenCalledWith(expect.objectContaining({
    call_drafts: expect.objectContaining({
      2: expect.objectContaining({ payment_selection: { cardId: 'additional_1', eftId: 'additional_2' } }),
    }),
  }));
  await view.unmount();
});

test('No Coaching confirmation renders safe action before continue action', async () => {
  mockModal.showModal.mockResolvedValue(false);
  const view = await renderPage(1);

  await act(async () => {
    view.container.querySelector('[data-testid="call-pass"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="calls-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(mockModal.showModal).toHaveBeenCalledWith(expect.objectContaining({
    title: 'No Coaching',
    buttons: [
      expect.objectContaining({ label: 'No', value: false }),
      expect.objectContaining({ label: 'Yes', value: true }),
    ],
  }));
  expect(api.saveCall).not.toHaveBeenCalled();

  await view.unmount();
});

test('Did not search for member appears only for failed calls and persists in save payload', async () => {
  mockModal.showModal.mockResolvedValue(true);
  const view = await renderPage(1);

  expect(view.container.textContent).not.toContain('Did not search for member');

  await act(async () => {
    view.container.querySelector('[data-testid="call-pass"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(view.container.textContent).not.toContain('Did not search for member');

  await act(async () => {
    view.container.querySelector('[data-testid="call-fail"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  const failLabel = Array.from(view.container.querySelectorAll('.fail-reason-checkbox'))
    .find((label) => label.textContent.includes('Did not search for member'));
  expect(failLabel).toBeTruthy();

  await act(async () => {
    failLabel.querySelector('input').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  await act(async () => {
    view.container.querySelector('[data-testid="calls-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    await flushPromises();
  });

  expect(api.saveCall).toHaveBeenCalledWith(expect.objectContaining({
    result: 'Fail',
    fails: expect.objectContaining({
      'Did not search for member': true,
    }),
  }));

  await view.unmount();
});

test('required fail reason remains available when remote content is stale', async () => {
  mockModal.showModal.mockResolvedValue(true);
  api.getDefaults.mockResolvedValue({
    ...defaults,
    call_fails: ['Skipped parts of script', 'Other'],
  });
  api.getSettings.mockResolvedValue({
    call_fails: ['Skipped parts of script', 'Other'],
  });

  const view = await renderPage(1);

  await act(async () => {
    view.container.querySelector('[data-testid="call-fail"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  const matchingLabels = Array.from(view.container.querySelectorAll('.fail-reason-checkbox'))
    .filter((label) => label.textContent.includes('Did not search for member'));
  expect(matchingLabels).toHaveLength(1);

});

test('Fail Reasons remain hidden until Fail is selected', async () => {
  const view = await renderPage(1);
  expect(view.container.querySelector('[data-tour="calls-fail-reasons"]')).toBeNull();

  await act(async () => {
    view.container.querySelector('[data-testid="call-pass"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(view.container.querySelector('[data-tour="calls-fail-reasons"]')).toBeNull();

  await act(async () => {
    view.container.querySelector('[data-testid="call-fail"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(view.container.querySelector('[data-tour="calls-fail-reasons"]')).not.toBeNull();

  await view.unmount();
});


test('not enough time after passed calls prompts for Newbie Shift scheduling', async () => {
  api.getDefaults.mockResolvedValue({
    ...defaults,
    call_types: ['Existing Member - One Time'],
    donors_existing: [['Morgan', 'Member', '2 Main St', '', 'Town', 'NC', '555-0101', 'morgan@example.test']],
  });
  const view = await renderPage(2, {
    call_1: { result: 'Pass', type: 'New Donor - One Time' },
  });
  api.getCurrentSession.mockResolvedValue({
    session: {
      candidate_name: 'Taylor Example',
      final_attempt: false,
      call_1: { result: 'Pass', type: 'New Donor - One Time' },
      call_2: { result: 'Pass', type: 'Existing Member - One Time' },
    },
  });
  mockModal.showModal
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);

  await act(async () => {
    view.container.querySelector('[data-testid="call-pass"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="calls-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(mockModal.showModal).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Schedule Newbie Shift',
  }));
  expect(api.updateSession).toHaveBeenCalledWith(expect.objectContaining({
    time_for_sup: false,
    final_status: 'Incomplete',
    fail_summary: 'N/A',
    newbie_shift_prompt: expect.objectContaining({
      trigger: 'not_enough_time_sup_transfer',
      status: 'accepted',
    }),
  }));
  expect(view.onNavigate).toHaveBeenCalledWith('newbieshift');

  await view.unmount();
});

test('dismissed not-enough-time prompt routes to Review without nagging again', async () => {
  api.getDefaults.mockResolvedValue({
    ...defaults,
    call_types: ['Existing Member - One Time'],
    donors_existing: [['Morgan', 'Member', '2 Main St', '', 'Town', 'NC', '555-0101', 'morgan@example.test']],
  });
  const view = await renderPage(2, {
    call_1: { result: 'Pass', type: 'New Donor - One Time' },
  });
  api.getCurrentSession.mockResolvedValue({
    session: {
      candidate_name: 'Taylor Example',
      final_attempt: false,
      call_1: { result: 'Pass', type: 'New Donor - One Time' },
      call_2: { result: 'Pass', type: 'Existing Member - One Time' },
      newbie_shift_prompt: { trigger: 'not_enough_time_sup_transfer', status: 'dismissed' },
    },
  });
  mockModal.showModal
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);

  await act(async () => {
    view.container.querySelector('[data-testid="call-pass"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="calls-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(mockModal.showModal).not.toHaveBeenCalledWith(expect.objectContaining({
    title: 'Schedule Newbie Shift',
  }));
  expect(api.updateSession).toHaveBeenCalledWith(expect.objectContaining({
    time_for_sup: false,
    final_status: 'Incomplete',
    fail_summary: 'N/A',
  }));
  expect(view.onNavigate).toHaveBeenCalledWith('review');

  await view.unmount();
});
