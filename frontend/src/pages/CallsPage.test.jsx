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

const newCoachingOptions = [
  ['Use active listening and avoid repeating questions the caller has already answered.', 'active_listening_no_repeat'],
  ['Avoid interrupting or speaking over the caller.', 'avoid_interrupting_caller'],
  ['Maintain a warm, professional tone and use clear, professional language.', 'warm_professional_tone_language'],
];

function findCoachingInput(container, labelText) {
  const label = Array.from(container.querySelectorAll('.coaching-grid .checkbox-label'))
    .find((item) => item.textContent.trim() === labelText);
  return label?.querySelector('input') || null;
}

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

async function renderPage(callNum, sessionOverrides = {}, pageDefaults = defaults, pageSettings = {}) {
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
    root.render(
      <CallsPage
        onNavigate={onNavigate}
        navigationState={{ callNum }}
        settings={pageSettings}
        defaults={pageDefaults}
        currentSession={{ session }}
      />
    );
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

test.each([1, 2, 3])('Call %i renders the shared new coaching options and moved Other control', async (callNum) => {
  const view = await renderPage(callNum);

  newCoachingOptions.forEach(([label]) => {
    expect(findCoachingInput(view.container, label)).not.toBeNull();
  });
  expect(Array.from(view.container.querySelectorAll('.coaching-grid .checkbox-label'))
    .some((label) => label.textContent.trim() === 'Other')).toBe(false);
  expect(view.container.querySelector('[data-testid="call-other-coaching"]')).not.toBeNull();
  expect(view.container.querySelector('.other-coaching-control').textContent).toContain('Other Coaching Notes');

  await view.unmount();
});

test.each(newCoachingOptions)('%s persists under stable key %s for only the active call', async (label, storageKey) => {
  const remoteOptionsWithoutStorageKeys = newCoachingOptions.map(([remoteLabel, id]) => ({ id, label: remoteLabel }));
  const view = await renderPage(
    2,
    { call_1: { result: 'Pass' } },
    defaults,
    { call_coaching: [...remoteOptionsWithoutStorageKeys, { id: 'c-other', label: 'Other' }] },
  );
  const checkbox = findCoachingInput(view.container, label);

  await act(async () => {
    checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(checkbox.checked).toBe(true);
  await view.unmount();

  expect(api.updateSession).toHaveBeenCalledWith(expect.objectContaining({
    current_call_num: 2,
    call_drafts: expect.objectContaining({
      2: expect.objectContaining({
        coaching: expect.objectContaining({ [storageKey]: true }),
      }),
    }),
  }));
  const savedDraftPayload = api.updateSession.mock.calls
    .map(([payload]) => payload)
    .find((payload) => payload?.call_drafts?.[2]?.coaching?.[storageKey]);
  expect(savedDraftPayload.call_drafts[1]).toBeUndefined();
});

test('existing Other notes restore, remain call-specific, and require the moved checkbox', async () => {
  const view = await renderPage(3, {
    call_1: { result: 'Pass' },
    call_2: { result: 'Fail' },
    call_drafts: {
      3: {
        call_num: 3,
        coaching: { Other: true },
        coach_notes: 'Keep this custom coaching note.',
      },
    },
  });
  const otherCheckbox = view.container.querySelector('[data-testid="call-other-coaching"]');
  const notes = view.container.querySelector('[data-testid="call-coach-notes"]');

  expect(otherCheckbox.checked).toBe(true);
  expect(notes.disabled).toBe(false);
  expect(notes.value).toBe('Keep this custom coaching note.');

  await act(async () => {
    otherCheckbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(notes.disabled).toBe(true);
  expect(notes.value).toBe('Keep this custom coaching note.');

  await act(async () => {
    otherCheckbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(notes.disabled).toBe(false);
  expect(otherCheckbox.id).toBe('call-other-coaching');
  expect(view.container.querySelector('label[for="call-other-coaching"]')).not.toBeNull();
  expect(notes.getAttribute('aria-label')).toBe('Other Coaching Notes');

  await view.unmount();
});

test('new Other coaching text is retained and persisted only while explicitly selected', async () => {
  const view = await renderPage(1);
  const otherCheckbox = view.container.querySelector('[data-testid="call-other-coaching"]');
  const notes = view.container.querySelector('[data-testid="call-coach-notes"]');

  expect(notes.disabled).toBe(true);
  await act(async () => {
    otherCheckbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(notes, 'Custom coaching entered for this call.');
    notes.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
  });
  expect(notes.disabled).toBe(false);
  expect(notes.value).toBe('Custom coaching entered for this call.');

  await view.unmount();
  expect(api.updateSession).toHaveBeenCalledWith(expect.objectContaining({
    call_drafts: expect.objectContaining({
      1: expect.objectContaining({
        coaching: expect.objectContaining({ Other: true }),
        coach_notes: 'Custom coaching entered for this call.',
      }),
    }),
  }));
});

test('stale remote call coaching is backfilled without adding options to another component', async () => {
  const pageSettings = { call_coaching: [{ id: 'custom', label: 'Custom Coaching' }, { id: 'c-other', label: 'Other' }] };
  const view = await renderPage(1, {}, defaults, pageSettings);

  newCoachingOptions.forEach(([label]) => {
    expect(findCoachingInput(view.container, label)).not.toBeNull();
  });
  expect(view.container.textContent).toContain('Custom Coaching');

  await view.unmount();
});

test('shows Caller Demographics before Payment Simulation', async () => {
  const view = await renderPage(1);
  const text = view.container.textContent;
  expect(text.indexOf('Caller Demographics')).toBeGreaterThan(-1);
  expect(text.indexOf('Caller Demographics')).toBeLessThan(text.indexOf('Payment Simulation'));
  await view.unmount();
});

test('uses App-cached entry data without duplicate defaults, settings, or session requests', async () => {
  const view = await renderPage(1);

  expect(api.getDefaults).not.toHaveBeenCalled();
  expect(api.getSettings).not.toHaveBeenCalled();
  expect(api.getCurrentSession).not.toHaveBeenCalled();

  await view.unmount();
});

test('shows the persistent Final Attempt banner during Calls', async () => {
  const view = await renderPage(1, {
    final_attempt: true,
    attempt_state: { current_attempt: 3, max_attempts: 3 },
  });

  const banners = view.container.querySelectorAll('[data-testid="final-attempt-banner"]');
  expect(banners).toHaveLength(1);
  expect(banners[0].textContent).toContain('FINAL ATTEMPT');

  await view.unmount();
});

test('formats donation dropdown labels as currency without changing option values', async () => {
  const pageDefaults = {
    ...defaults,
    shows: [
      ['Whole Dollar Show', '16', '25', '', ''],
      ['Cents Show', '12.50', '100', '', ''],
    ],
  };

  const view = await renderPage(1, {}, pageDefaults);
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
  const pageDefaults = {
    ...defaults,
    call_fails: ['Skipped parts of script', 'Other'],
  };
  const pageSettings = {
    call_fails: ['Skipped parts of script', 'Other'],
  };

  const view = await renderPage(1, {}, pageDefaults, pageSettings);

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
  const pageDefaults = {
    ...defaults,
    call_types: ['Existing Member - One Time'],
    donors_existing: [['Morgan', 'Member', '2 Main St', '', 'Town', 'NC', '555-0101', 'morgan@example.test']],
  };
  const view = await renderPage(2, {
    call_1: { result: 'Pass', type: 'New Donor - One Time' },
  }, pageDefaults);
  api.saveCall.mockResolvedValueOnce({
    ok: true,
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
  const pageDefaults = {
    ...defaults,
    call_types: ['Existing Member - One Time'],
    donors_existing: [['Morgan', 'Member', '2 Main St', '', 'Town', 'NC', '555-0101', 'morgan@example.test']],
  };
  const existingSession = {
    candidate_name: 'Taylor Example',
    final_attempt: false,
    call_1: { result: 'Pass', type: 'New Donor - One Time' },
    newbie_shift_prompt: { trigger: 'not_enough_time_sup_transfer', status: 'dismissed' },
  };
  const view = await renderPage(2, existingSession, pageDefaults);
  api.saveCall.mockResolvedValueOnce({
    ok: true,
    session: {
      ...existingSession,
      call_2: { result: 'Pass', type: 'Existing Member - One Time' },
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
  expect(api.getCurrentSession).not.toHaveBeenCalled();

  await view.unmount();
});
