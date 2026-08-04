import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import SettingsPage from './SettingsPage';
import CallsPage from './CallsPage';
import SupTransferPage from './SupTransferPage';
import BasicsPage, { buildHeadsetResearchUrl, computeApprovedHeadsetHash, computeHeadsetSyncSignature } from './BasicsPage';
import api from '../api';

const mockModal = {
  alert: jest.fn(),
  showModal: jest.fn(),
  confirm: jest.fn(),
  confirmDanger: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
};

jest.mock('../api', () => ({
  __esModule: true,
  default: {
    getSettings: jest.fn(),
    getDefaults: jest.fn(),
    saveSettings: jest.fn(),
    restoreSettingsDefaults: jest.fn(),
    resetSettingsSection: jest.fn(),
    getCurrentSession: jest.fn(),
    getApprovedHeadsets: jest.fn(),
    lookupSharedCandidate: jest.fn(),
    logHeadsetReview: jest.fn(),
    startSession: jest.fn(),
    updateSession: jest.fn(() => Promise.resolve({})),
    saveCall: jest.fn(),
    saveSupTransfer: jest.fn(),
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

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(select, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
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
  window.scrollTo = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockModal.showModal.mockResolvedValue(true);
  mockModal.confirm.mockResolvedValue(true);
  mockModal.confirmDanger.mockResolvedValue(false);
  mockModal.warning.mockResolvedValue(true);
  mockModal.alert.mockResolvedValue(true);
  mockModal.error.mockResolvedValue(true);
  api.updateSession.mockResolvedValue({});
  api.lookupSharedCandidate.mockResolvedValue({ ok: true, matches: [] });
  api.logHeadsetReview.mockResolvedValue({ ok: true });
  api.startSession.mockResolvedValue({ ok: true });
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.electronAPI = {
    setUnsavedChanges: jest.fn().mockResolvedValue(undefined),
    openExternal: jest.fn().mockResolvedValue({ ok: true }),
  };
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: jest.fn().mockResolvedValue(undefined),
    },
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('settings shows immediate feedback for Discord list changes and clear save confirmation', async () => {
  api.getSettings.mockResolvedValue({
    tester_name: 'Tester',
    discord_templates: [{ category: 'Sup Transfer', title: 'Existing Trigger', message: 'Existing message' }],
    discord_screenshots: [{ category: 'Setup', title: 'Existing Screenshot', image_url: '' }],
  });
  api.getDefaults.mockResolvedValue({
    discord_templates: [{ category: 'Sup Transfer', title: 'Existing Trigger', message: 'Existing message' }],
    discord_screenshots: [{ category: 'Setup', title: 'Existing Screenshot', image_url: '' }],
  });
  api.saveSettings.mockResolvedValue({ ok: true });

  const view = await renderComponent(
    <SettingsPage
      onNavigate={jest.fn()}
      updateState={{}}
      refreshUpdateState={jest.fn()}
      appVersion="1.0.1"
    />
  );

  await act(async () => {
    view.container.querySelector('[data-testid="settings-tab-discord"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  await act(async () => {
    view.container.querySelector('[data-testid="settings-discord-add"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(view.container.textContent).toContain('Apply to List');
  expect(view.container.textContent).toContain('Reset Posts to Defaults');
  expect(view.container.textContent).toContain('Suggested Screenshots');
  expect(view.container.querySelector('[data-testid="settings-discord-suggested-0-0"]')).not.toBeNull();
  expect(view.container.textContent).toContain('Category');
  expect(view.container.querySelector('input[value="Sup Transfer"]')).not.toBeNull();
  expect(view.container.textContent).toContain('Added. Click Save Settings to keep changes.');
  expect(view.container.querySelector('[data-testid="settings-unsaved-banner"]')).not.toBeNull();

  await act(async () => {
    view.container.querySelector('[data-testid="settings-discord-tab-screenshots"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  await act(async () => {
    view.container.querySelector('[data-testid="settings-discord-ss-add"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(view.container.textContent).toContain('Added. Click Save Settings to keep changes.');
  expect(view.container.querySelector('input[value="Setup"]')).not.toBeNull();

  await act(async () => {
    view.container.querySelector('[data-testid="settings-save"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(api.saveSettings).toHaveBeenCalled();
  expect(mockModal.showModal).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Settings Saved',
  }));
  expect(view.container.querySelector('[data-testid="settings-unsaved-banner"]')).toBeNull();

  await view.unmount();
});

test('settings exposes welcome voice and sound volume controls', async () => {
  api.getSettings.mockResolvedValue({
    tester_name: 'Shawn Bly',
    display_name: '',
    enable_sounds: true,
    sound_volume: 'medium',
    welcome_voice: 'male',
    ticker_speed: undefined,
  });
  api.getDefaults.mockResolvedValue({});
  api.saveSettings.mockResolvedValue({ ok: true });

  const view = await renderComponent(
    <SettingsPage
      onNavigate={jest.fn()}
      updateState={{}}
      refreshUpdateState={jest.fn()}
      appVersion="1.0.1"
    />
  );

  expect(view.container.textContent).toContain('Optional. Leave blank to automatically use your first name.');
  expect(view.container.querySelector('[data-testid="settings-welcome-voice"]').value).toBe('male');
  expect(view.container.querySelector('[data-testid="settings-sound-volume"]').value).toBe('medium');
  expect(view.container.querySelector('[data-testid="settings-ticker-speed"]').value).toBe('normal');

  await act(async () => {
    setSelectValue(view.container.querySelector('[data-testid="settings-welcome-voice"]'), 'female');
    setSelectValue(view.container.querySelector('[data-testid="settings-sound-volume"]'), 'off');
    setSelectValue(view.container.querySelector('[data-testid="settings-ticker-speed"]'), 'fast');
    await flushPromises();
  });

  await act(async () => {
    view.container.querySelector('[data-testid="settings-save"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
    welcome_voice: 'female',
    sound_volume: 'off',
    enable_sounds: false,
    ticker_speed: 'fast',
  }));

  await view.unmount();
});

test('settings does not render obsolete reschedule admin mention controls', async () => {
  api.getSettings.mockResolvedValue({
    tester_name: 'Trainer',
  });
  api.getDefaults.mockResolvedValue({});

  const view = await renderComponent(
    <SettingsPage
      onNavigate={jest.fn()}
      updateState={{}}
      refreshUpdateState={jest.fn()}
      appVersion="1.0.1"
    />
  );

  expect(view.container.querySelector('[data-testid="settings-reschedule-admin-mention"]')).toBeNull();
  expect(view.container.textContent).not.toContain('Reschedule Admin Mention');
  expect(view.container.textContent).not.toContain('newbieShiftRescheduleAdminMention');

  await view.unmount();
});

test('settings shows fail reason source and can disable local call fail override', async () => {
  api.getSettings.mockResolvedValue({
    tester_name: 'Tester',
    call_fails: ['Legacy Local Fail', 'Did not search for member'],
    call_fails_customized: true,
  });
  api.getDefaults.mockResolvedValue({
    call_fails: ['Remote Custom Fail', 'Did not search for member'],
    sup_fails: ['Supervisor Fail'],
    _content_sources: {
      call_fails: { source: 'google', count: 2, ok: true },
      sup_fails: { source: 'local_csv', count: 1, ok: true },
    },
  });
  api.resetSettingsSection.mockResolvedValue({
    ok: true,
    section: 'call_fails',
    settings: {
      tester_name: 'Tester',
      call_fails: ['Remote Custom Fail', 'Did not search for member'],
      call_fails_customized: false,
    },
  });

  const view = await renderComponent(
    <SettingsPage
      onNavigate={jest.fn()}
      updateState={{}}
      refreshUpdateState={jest.fn()}
      appVersion="1.0.1"
    />
  );

  await act(async () => {
    view.container.querySelector('[data-testid="settings-tab-failreasons"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(view.container.querySelector('[data-testid="settings-call_fails-source"]').textContent).toContain('Source: Local override');
  expect(view.container.textContent).toContain('Legacy Local Fail');

  await act(async () => {
    Array.from(view.container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Use Google/admin content')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(mockModal.showModal).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Use Google/admin content for Call Fail Reasons',
    buttons: [
      expect.objectContaining({ label: 'Cancel', value: false }),
      expect.objectContaining({ label: 'Use Google/admin content', value: true }),
    ],
  }));
  expect(api.resetSettingsSection).toHaveBeenCalledWith('call_fails');
  expect(view.container.querySelector('[data-testid="settings-call_fails-source"]').textContent).toContain('Source: Google Sheet');
  expect(view.container.textContent).toContain('Remote Custom Fail');
  expect(view.container.textContent).toContain('Did not search for member');
  expect(view.container.textContent).not.toContain('Legacy Local Fail');

  await view.unmount();
});

test('settings payment tab shows defaults and persists add/remove edits', async () => {
  api.getSettings.mockResolvedValue({
    tester_name: 'Tester',
    payment: {},
  });
  api.getDefaults.mockResolvedValue({});
  api.saveSettings.mockResolvedValue({ ok: true });

  const view = await renderComponent(
    <SettingsPage
      onNavigate={jest.fn()}
      updateState={{}}
      refreshUpdateState={jest.fn()}
      appVersion="1.0.1"
    />
  );

  await act(async () => {
    view.container.querySelector('[data-testid="settings-tab-payment"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(view.container.querySelector('[data-testid="settings-payment-card-0"]')).not.toBeNull();
  expect(view.container.querySelector('[data-testid="settings-payment-card-1"]')).not.toBeNull();
  expect(view.container.querySelector('[data-testid="settings-payment-card-2"]')).not.toBeNull();
  expect(view.container.querySelector('[data-testid="settings-payment-eft-0"]')).not.toBeNull();
  expect(view.container.querySelector('[data-testid="settings-payment-eft-1"]')).not.toBeNull();
  expect(view.container.querySelector('[data-testid="settings-payment-eft-2"]')).not.toBeNull();
  expect(view.container.querySelector('[data-testid="settings-payment-remove-card-0"]').disabled).toBe(true);
  expect(view.container.querySelector('[data-testid="settings-payment-remove-eft-0"]').disabled).toBe(true);

  await act(async () => {
    view.container.querySelector('[data-testid="settings-payment-add-card"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  await act(async () => {
    view.container.querySelector('[data-testid="settings-payment-add-eft"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(view.container.querySelector('[data-testid="settings-payment-card-3"]')).not.toBeNull();
  expect(view.container.querySelector('[data-testid="settings-payment-eft-3"]')).not.toBeNull();

  await act(async () => {
    setInputValue(view.container.querySelector('[data-testid="settings-payment-card-3-label"]'), 'Travel Card');
    setInputValue(view.container.querySelector('[data-testid="settings-payment-card-3-number"]'), '4111 1111 1111 1111');
    setInputValue(view.container.querySelector('[data-testid="settings-payment-eft-3-label"]'), 'Backup EFT');
    setInputValue(view.container.querySelector('[data-testid="settings-payment-eft-3-routing"]'), '111000025');
    await flushPromises();
  });

  await act(async () => {
    view.container.querySelector('[data-testid="settings-payment-remove-card-1"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  await act(async () => {
    view.container.querySelector('[data-testid="settings-payment-remove-eft-1"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(view.container.querySelector('[data-testid="settings-payment-card-3"]')).toBeNull();
  expect(view.container.querySelector('[data-testid="settings-payment-eft-3"]')).toBeNull();
  expect(view.container.querySelector('[data-testid="settings-payment-card-2-label"]').value).toBe('Travel Card');
  expect(view.container.querySelector('[data-testid="settings-payment-eft-2-label"]').value).toBe('Backup EFT');

  await act(async () => {
    view.container.querySelector('[data-testid="settings-save"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  const saved = api.saveSettings.mock.calls[0][0];
  expect(saved.payment.card_options).toHaveLength(3);
  expect(saved.payment.eft_options).toHaveLength(3);
  expect(saved.payment.card_options.some((item) => item.label === 'Travel Card')).toBe(true);
  expect(saved.payment.eft_options.some((item) => item.label === 'Backup EFT')).toBe(true);
  expect(saved.payment.card_options[0].id).toBe('default');
  expect(saved.payment.eft_options[0].id).toBe('default');

  await view.unmount();
});

test('calls page renders custom coaching and fail reasons from saved settings', async () => {
  const currentSession = {
    session: {
      candidate_name: 'Taylor Example',
      final_attempt: false,
    },
  };
  const defaults = {
    call_types: ['New Donor - One Time Donation'],
    shows: [['Show A', '$25', '$10', 'Gift']],
    donors_new: [['Jamie', 'Doe', '1 Main', 'Austin', 'TX', '78701', '555-0100', 'jamie@example.com']],
    call_coaching: [{ id: 'default', label: 'Default Coaching', children: [] }],
    call_fails: ['Default Fail'],
  };
  const settings = {
    call_types: ['New Donor - One Time Donation'],
    shows: [['Show A', '$25', '$10', 'Gift']],
    donors_new: [['Jamie', 'Doe', '1 Main', 'Austin', 'TX', '78701', '555-0100', 'jamie@example.com']],
    call_coaching: [{ id: 'test-coach', label: 'Test Coaching Reason', children: ['Test Coaching Subitem'] }],
    call_fails: ['Test Fail Reason'],
  };
  api.getCurrentSession.mockResolvedValue(currentSession);
  api.getDefaults.mockResolvedValue(defaults);
  api.getSettings.mockResolvedValue(settings);

  const view = await renderComponent(
    <CallsPage onNavigate={jest.fn()} currentSession={currentSession} defaults={defaults} settings={settings} />
  );

  expect(view.container.textContent).toContain('Test Coaching Reason');
  expect(view.container.textContent).toContain('Test Coaching Subitem');
  expect(view.container.textContent).not.toContain('Default Coaching');

  await act(async () => {
    view.container.querySelector('[data-testid="call-fail"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(view.container.textContent).toContain('Test Fail Reason');
  expect(view.container.textContent).not.toContain('Default Fail');

  await view.unmount();
});

test('supervisor transfer page renders custom coaching and fail reasons from saved settings', async () => {
  const currentSession = {
    session: {
      candidate_name: 'Taylor Example',
      supervisor_only: true,
      final_attempt: false,
    },
  };
  const defaults = {
    shows: [['Show A', '$25', '$10', 'Gift']],
    donors_new: [['Jamie', 'Doe', '1 Main', 'Austin', 'TX', '78701', '555-0100', 'jamie@example.com']],
    donors_existing: [],
    donors_increase: [],
    sup_reasons: ['Default Sup Reason'],
    sup_coaching: [{ label: 'Default Supervisor Coaching', children: [] }],
    sup_fails: ['Default Supervisor Fail'],
  };
  const settings = {
    shows: [['Show A', '$25', '$10', 'Gift']],
    donors_new: [['Jamie', 'Doe', '1 Main', 'Austin', 'TX', '78701', '555-0100', 'jamie@example.com']],
    donors_existing: [],
    donors_increase: [],
    sup_reasons: ['Default Sup Reason'],
    sup_coaching: [{ label: 'Test Supervisor Coaching', children: ['Supervisor Subitem'] }],
    sup_fails: ['Test Supervisor Fail'],
  };
  api.getCurrentSession.mockResolvedValue(currentSession);
  api.getDefaults.mockResolvedValue(defaults);
  api.getSettings.mockResolvedValue(settings);

  const view = await renderComponent(
    <SupTransferPage onNavigate={jest.fn()} currentSession={currentSession} defaults={defaults} settings={settings} />
  );

  expect(view.container.textContent).toContain('Test Supervisor Coaching');
  expect(view.container.textContent).toContain('Supervisor Subitem');
  expect(view.container.textContent).not.toContain('Default Supervisor Coaching');

  await act(async () => {
    view.container.querySelector('[data-testid="sup-fail"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(view.container.textContent).toContain('Test Supervisor Fail');
  expect(view.container.textContent).not.toContain('Default Supervisor Fail');

  await view.unmount();
});

test('basics headset search matches brand and model portions while preserving unapproved entries', async () => {
  api.getCurrentSession.mockResolvedValue({ session: null });
  api.getSettings.mockResolvedValue({});
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({
    groups: [
      { brand: 'Logitech', models: ['H390', 'Stereo H650e'] },
      { brand: 'Plantronics', models: ['Blackwire 3220'] },
    ],
  });

  const view = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);
  const input = view.container.querySelector('[data-testid="basics-brand"]');

  await act(async () => {
    setInputValue(input, 'H390');
    await flushPromises();
  });
  expect(view.container.textContent).toContain('Logitech H390');

  await act(async () => {
    setInputValue(input, 'Logitech H650e');
    await flushPromises();
  });
  expect(view.container.textContent).toContain('Logitech Stereo H650e');

  await act(async () => {
    setInputValue(input, 'h650e');
    await flushPromises();
  });
  expect(view.container.textContent).toContain('Logitech Stereo H650e');

  await act(async () => {
    setInputValue(input, 'Not Approved 123');
    await flushPromises();
  });
  expect(view.container.textContent).toContain('Headset not found');
  expect(view.container.textContent).not.toContain('Approved headset selected. USB and Noise Cancelling are marked Yes automatically.');

  await view.unmount();
});

test('Basics shows one persistent authoritative Final Attempt banner', async () => {
  api.getCurrentSession.mockResolvedValue({
    session: {
      candidate_name: 'Taylor Example',
      final_attempt: true,
      attempt_state: { current_attempt: 3, max_attempts: 3 },
    },
  });
  api.getSettings.mockResolvedValue({});
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [], denied: [] });

  const view = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);
  const banners = view.container.querySelectorAll('[data-testid="final-attempt-banner"]');
  expect(banners).toHaveLength(1);
  expect(banners[0].textContent).toContain('FINAL ATTEMPT');

  await view.unmount();
});

test('shared candidate lookup retries after a temporary failure and recovers without restart', async () => {
  api.getCurrentSession.mockResolvedValue({ session: null });
  api.getSettings.mockResolvedValue({});
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [], denied: [] });
  api.lookupSharedCandidate
    .mockResolvedValueOnce({ ok: false, error: 'temporary google outage', matches: [] })
    .mockResolvedValueOnce({
      ok: true,
      matches: [{ candidate_name: 'Candidate Example', matchConfirmed: true, status: 'Fail', completed_at: '2026-07-01T12:00:00Z' }],
      finalAttempt: false,
      finalAttemptUsed: false,
      withdrawn: false,
      extraAttemptGranted: false,
    });
  const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const view = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);

  jest.useFakeTimers();
  try {
    await act(async () => {
      setInputValue(view.container.querySelector('[data-testid="basics-candidate"]'), 'Candidate Example');
      jest.advanceTimersByTime(650);
      await Promise.resolve();
    });

    expect(api.lookupSharedCandidate).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain('Shared candidate lookup unavailable. Using local session mode.');

    await act(async () => {
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(650);
      await Promise.resolve();
    });

    expect(api.lookupSharedCandidate).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).not.toContain('Shared candidate lookup unavailable. Using local session mode.');
    expect(view.container.textContent).toContain('Candidate Example');
    expect(infoSpy).toHaveBeenCalledWith('[MTS] Shared candidate lookup reconnected successfully.', expect.objectContaining({ previousFailures: 1 }));
  } finally {
    jest.useRealTimers();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    await view.unmount();
  }
});

test('shared candidate typed-name choice suppresses repeated dropdown until the name changes', async () => {
  api.getCurrentSession.mockResolvedValue({ session: null });
  api.getSettings.mockResolvedValue({});
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [], denied: [] });
  api.lookupSharedCandidate.mockResolvedValue({
    ok: true,
    matches: [{ candidate_name: 'Candidate Example', matchConfirmed: true, status: 'Fail', session_type: 'mock_session', completed_at: '2026-07-01T12:00:00Z' }],
    finalAttempt: false,
    finalAttemptUsed: false,
    withdrawn: false,
    extraAttemptGranted: false,
    passedCertification: false,
  });

  const view = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);
  jest.useFakeTimers();
  try {
    await act(async () => {
      setInputValue(view.container.querySelector('[data-testid="basics-candidate"]'), 'Candidate Example');
      jest.advanceTimersByTime(650);
      await Promise.resolve();
    });

    expect(api.lookupSharedCandidate).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('[data-testid="candidate-suggestions-dropdown"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Session: Mock Session');
    expect(view.container.textContent).not.toContain('Campaign:');
    expect(view.container.textContent).not.toContain('mock_session');

    await act(async () => {
      Array.from(view.container.querySelectorAll('.suggestion-item'))
        .find((item) => item.textContent.includes('Use typed name: Candidate Example'))
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.container.querySelector('[data-testid="candidate-suggestions-dropdown"]')).toBeNull();
    expect(api.lookupSharedCandidate).toHaveBeenCalledTimes(1);

    await act(async () => {
      setInputValue(view.container.querySelector('[data-testid="basics-candidate"]'), 'Candidate Example Jr');
      jest.advanceTimersByTime(650);
      await Promise.resolve();
    });

    expect(api.lookupSharedCandidate).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
    await view.unmount();
  }
});

test('shared candidate lookup blocks passed candidates unless an extra attempt is granted', async () => {
  const onNavigate = jest.fn();
  api.getCurrentSession.mockResolvedValue({ session: null });
  api.getSettings.mockResolvedValue({});
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [], denied: [] });
  api.lookupSharedCandidate.mockResolvedValue({
    ok: true,
    matches: [{ candidate_name: 'Passed Candidate', matchConfirmed: true, status: 'PASS', completed_at: '2026-07-01T12:00:00Z' }],
    finalAttempt: false,
    finalAttemptUsed: false,
    withdrawn: false,
    extraAttemptGranted: false,
    passedCertification: true,
  });

  const view = await renderComponent(<BasicsPage onNavigate={onNavigate} />);
  jest.useFakeTimers();
  try {
    await act(async () => {
      setInputValue(view.container.querySelector('[data-testid="basics-candidate"]'), 'Passed Candidate');
      jest.advanceTimersByTime(650);
      await Promise.resolve();
    });

    await act(async () => {
      Array.from(view.container.querySelectorAll('.suggestion-item'))
        .find((item) => item.textContent.includes('Passed Candidate') && !item.textContent.includes('Use typed name'))
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockModal.showModal).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Candidate Already Passed',
    }));
    expect(api.discardSession).toHaveBeenCalled();
    expect(api.startSession).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith('home');
  } finally {
    jest.useRealTimers();
    await view.unmount();
  }
});

test('basics records changed approved-list hash without interrupting the trainer', async () => {
  const oldGroups = [{ brand: 'Logitech', models: ['H390'] }];
  const newGroups = [{ brand: 'Logitech', models: ['H390', 'H650e'] }];
  window.localStorage.setItem('mts_headset_sync_ack_signature', computeHeadsetSyncSignature(oldGroups, []));
  window.localStorage.setItem('mts_approved_headset_list_seen_hash', computeApprovedHeadsetHash(oldGroups));
  const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
  api.getCurrentSession.mockResolvedValue({ session: null });
  api.getSettings.mockResolvedValue({});
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: newGroups, denied: [] });

  const view = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);
  await act(async () => {
    await flushPromises();
  });

  expect(mockModal.showModal).not.toHaveBeenCalled();
  expect(infoSpy).toHaveBeenCalledWith('[MTS] Headset lookup data changed and was acknowledged silently.');
  expect(window.localStorage.getItem('mts_headset_sync_ack_signature')).toBe(computeHeadsetSyncSignature(newGroups, []));
  expect(window.localStorage.getItem('mts_approved_headset_list_seen_hash')).toBe(computeApprovedHeadsetHash(newGroups));
  infoSpy.mockClear();
  await view.unmount();

  const secondView = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);
  await act(async () => {
    await flushPromises();
  });

  expect(mockModal.showModal).not.toHaveBeenCalled();
  expect(infoSpy).not.toHaveBeenCalled();
  await secondView.unmount();
  infoSpy.mockRestore();
});

test('Basics keeps VPN questions functional and manual links never change session answers', async () => {
  api.getCurrentSession.mockResolvedValue({ session: null });
  api.getSettings.mockResolvedValue({});
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [], denied: [] });
  const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => Promise.reject(new Error('Unexpected network request')));
  const view = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);
  const vpnInputs = Array.from(view.container.querySelectorAll('input[name="b-vpn"]'));
  const vpnOffInputs = Array.from(view.container.querySelectorAll('input[name="b-vpnoff"]'));
  const vpnOffRow = vpnOffInputs[0].closest('.radio-group').parentElement;

  expect(view.container.textContent).toContain('Has VPN?');
  expect(view.container.textContent).toContain('Can turn off?');
  expect(vpnInputs).toHaveLength(2);
  expect(vpnOffInputs).toHaveLength(2);
  expect(vpnOffRow.style.pointerEvents).toBe('none');
  expect(view.container.textContent).not.toContain('Automatic VPN / Proxy Check');
  expect(view.container.textContent).not.toContain('INTEGRATED CHECK');
  expect(view.container.textContent).not.toContain('Check IP');
  expect(view.container.textContent).not.toContain('No saved candidate IP');

  await act(async () => vpnInputs[0].click());
  let currentVpnInputs = Array.from(view.container.querySelectorAll('input[name="b-vpn"]'));
  let currentVpnOffInputs = Array.from(view.container.querySelectorAll('input[name="b-vpnoff"]'));
  let currentVpnOffRow = currentVpnOffInputs[0].closest('.radio-group').parentElement;
  expect(currentVpnInputs[0].checked).toBe(true);
  expect(currentVpnOffRow.style.pointerEvents).toBe('auto');
  await act(async () => currentVpnOffInputs[0].click());
  currentVpnInputs = Array.from(view.container.querySelectorAll('input[name="b-vpn"]'));
  currentVpnOffInputs = Array.from(view.container.querySelectorAll('input[name="b-vpnoff"]'));
  expect(currentVpnOffInputs[0].checked).toBe(true);

  await act(async () => view.container.querySelector('.candidate-ip-card-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  api.updateSession.mockClear();
  api.startSession.mockClear();
  await act(async () => {
    view.container.querySelector('[aria-label="Copy IP2Location link"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  expect(currentVpnInputs[0].checked).toBe(true);
  expect(currentVpnOffInputs[0].checked).toBe(true);
  expect(api.updateSession).not.toHaveBeenCalled();
  expect(api.startSession).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();

  await act(async () => {
    currentVpnInputs[1].click();
    await Promise.resolve();
  });
  const updatedVpnInputs = Array.from(view.container.querySelectorAll('input[name="b-vpn"]'));
  const updatedVpnOffInputs = Array.from(view.container.querySelectorAll('input[name="b-vpnoff"]'));
  const updatedVpnOffRow = updatedVpnOffInputs[0].closest('.radio-group').parentElement;
  expect(updatedVpnInputs[1].checked).toBe(true);
  expect(updatedVpnOffInputs.some((input) => input.checked)).toBe(false);
  expect(updatedVpnOffRow.style.pointerEvents).toBe('none');
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  await view.unmount();
});

test('unknown headset research opens the required search query without approving the headset', async () => {
  mockModal.showModal.mockResolvedValueOnce('cancel');
  api.getCurrentSession.mockResolvedValue({ session: null });
  api.getSettings.mockResolvedValue({});
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [{ brand: 'Logitech', models: ['H390'] }] });

  const view = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);
  await act(async () => {
    setInputValue(view.container.querySelector('[data-testid="basics-brand"]'), 'Acme USB 100');
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="headset-research-btn"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(window.electronAPI.openExternal).toHaveBeenCalledWith(buildHeadsetResearchUrl('Acme USB 100'));
  expect(mockModal.showModal).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Research Complete',
    body: expect.stringContaining('Did the research show that this headset has both a wired USB connection and a noise-cancelling microphone?'),
  }));
  expect(mockModal.showModal.mock.calls[0][0].body).not.toContain('<strong>USB:</strong>');
  expect(view.container.textContent).not.toContain('Approved headset selected');
  await view.unmount();
});

test('unknown headset research yes selects the typed headset but leaves both verification answers explicit', async () => {
  mockModal.showModal.mockResolvedValueOnce('yes');
  api.getCurrentSession.mockResolvedValue({ session: null });
  api.getSettings.mockResolvedValue({});
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [{ brand: 'Logitech', models: ['H390'] }] });

  const view = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);
  await act(async () => {
    setInputValue(view.container.querySelector('[data-testid="basics-brand"]'), 'Acme USB 100');
    await flushPromises();
  });
  expect(view.container.textContent).toContain('Use This Headset');
  expect(view.container.textContent).not.toContain('Use This Headset For Now');
  await act(async () => {
    view.container.querySelector('[data-testid="headset-research-btn"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(Array.from(view.container.querySelectorAll('input[name="b-usb"]')).some((input) => input.checked)).toBe(false);
  expect(Array.from(view.container.querySelectorAll('input[name="b-noise"]')).some((input) => input.checked)).toBe(false);
  expect(view.container.querySelector('[data-testid="basics-brand"]').value).toBe('Acme USB 100');
  expect(view.container.textContent).not.toContain('Use This Headset');
  expect(view.container.textContent).not.toContain('Approved headset selected');
  await view.unmount();
});

test('unknown headset research no asks for another headset and returns to entry area', async () => {
  mockModal.showModal.mockResolvedValueOnce('no').mockResolvedValueOnce('yes');
  api.getCurrentSession.mockResolvedValue({ session: null });
  api.getSettings.mockResolvedValue({});
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [{ brand: 'Logitech', models: ['H390'] }] });

  const view = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);
  await act(async () => {
    setInputValue(view.container.querySelector('[data-testid="basics-brand"]'), 'Acme USB 100');
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="headset-research-btn"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(mockModal.showModal).toHaveBeenLastCalledWith(expect.objectContaining({
    title: 'Another Headset?',
    body: expect.stringContaining('Does the candidate have another headset to try?'),
  }));
  expect(view.container.querySelector('[data-testid="basics-brand"]').value).toBe('');
  expect(api.updateSession).toHaveBeenCalledWith({ auto_fail_reason: null, final_status: null });
  expect(document.activeElement).toBe(view.container.querySelector('[data-testid="basics-brand"]'));
  await view.unmount();
});

test('Another Headset No reaches ordered Headset Issue confirmation and exact dual-reason fail', async () => {
  mockModal.showModal
    .mockResolvedValueOnce('no')
    .mockResolvedValueOnce('no')
    .mockResolvedValueOnce(true);
  api.getCurrentSession.mockResolvedValue({
    session: {
      candidate_name: 'Taylor Example',
      tester_name: 'Tester',
      final_attempt: true,
      headset_brand: 'Acme Invalid 100',
      headset_usb: null,
      noise_cancel: null,
      vpn_on: false,
      chrome_default: true,
      extensions_disabled: true,
      popups_allowed: true,
    },
  });
  api.getSettings.mockResolvedValue({
    tester_name: 'Tester',
    discord_templates: [{ category: 'Failure Outcomes', title: 'Wrong Headset', message: 'Wrong headset post' }],
  });
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [{ brand: 'Logitech', models: ['H390'] }] });
  const onNavigate = jest.fn();
  const view = await renderComponent(<BasicsPage onNavigate={onNavigate} />);

  await act(async () => {
    await flushPromises();
    view.container.querySelector('[data-testid="headset-research-btn"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="basics-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  const headsetIssue = mockModal.showModal.mock.calls.find(([config]) => config.title === 'Headset Issue')?.[0];
  expect(headsetIssue).toBeDefined();
  expect(headsetIssue.body).toContain('Wrong headset (not USB) and Wrong headset (not noise cancelling)');
  expect(headsetIssue.buttons.map((button) => button.label)).toEqual([
    'Discord Post: Wrong Headset',
    'No',
    'Yes',
  ]);
  expect(api.startSession).toHaveBeenCalledWith(expect.objectContaining({
    final_attempt: true,
    headset_usb: false,
    noise_cancel: false,
    auto_fail_reason: 'Wrong headset (not USB) and Wrong headset (not noise cancelling)',
    final_status: 'Fail',
  }));
  expect(onNavigate).toHaveBeenCalledWith('review');
  await view.unmount();
});











test('existing non-IP VPN unable-to-turn-off flow still autofails as VPN', async () => {
  const onNavigate = jest.fn();
  mockModal.showModal.mockResolvedValueOnce(true);
  api.getCurrentSession.mockResolvedValue({
    session: {
      candidate_name: 'Taylor Example',
      tester_name: 'Tester',
      final_attempt: false,
      headset_usb: true,
      noise_cancel: true,
      headset_brand: 'Logitech H390',
      vpn_on: true,
      vpn_off: false,
      chrome_default: true,
      extensions_disabled: true,
      popups_allowed: true,
    },
  });
  api.getSettings.mockResolvedValue({
    tester_name: 'Tester',
    discord_templates: [{ category: 'Failure Outcomes', title: 'VPN Fail', message: 'VPN fail post' }],
  });
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [{ brand: 'Logitech', models: ['H390'] }] });

  const view = await renderComponent(<BasicsPage onNavigate={onNavigate} />);
  await act(async () => {
    view.container.querySelector('[data-testid="basics-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(mockModal.showModal).toHaveBeenCalledTimes(1);
  expect(mockModal.showModal.mock.calls[0][0]).toEqual(expect.objectContaining({
    title: 'VPN Issue',
    body: expect.stringContaining('Using a VPN is not accepted'),
  }));
  expect(api.startSession).toHaveBeenCalledWith(expect.objectContaining({
    final_status: 'Fail',
    auto_fail_reason: 'Unable to turn off VPN',
  }));
  expect(onNavigate).toHaveBeenCalledWith('review');
  await view.unmount();
});

test('denied headset auto-fails with the Wrong Headset Discord action and preserves Other notes', async () => {
  api.getCurrentSession.mockResolvedValue({ session: null });
  api.getSettings.mockResolvedValue({
    tester_name: 'Tester',
    discord_templates: [{ category: 'Failure Outcomes', title: 'Wrong Headset', message: 'Wrong headset post' }],
  });
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({
    groups: [{ brand: 'Allowed', models: ['A1'] }],
    denied: [{ brand: 'Blocked', model: 'B1', status: 'denied', note: 'Other fit issue' }],
  });
  mockModal.showModal.mockResolvedValue(false);
  const onNavigate = jest.fn();
  const view = await renderComponent(<BasicsPage onNavigate={onNavigate} />);

  await act(async () => {
    setInputValue(view.container.querySelector('[data-testid="basics-candidate"]'), 'Candidate Example');
    setInputValue(view.container.querySelector('[data-testid="basics-brand"]'), 'Blocked B1');
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="basics-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  const deniedModal = mockModal.showModal.mock.calls[0][0];
  expect(deniedModal.body).toContain('This headset has been reviewed and marked as unacceptable for contracting with ACD.');
  expect(deniedModal.body).toContain('Other fit issue');
  expect(deniedModal.buttons.map((button) => button.label)).toContain('Discord Post: Wrong Headset');
  expect(api.startSession).toHaveBeenCalledWith(expect.objectContaining({
    final_status: 'Fail',
    auto_fail_reason: 'Wrong headset (Other: Other fit issue)',
  }));
  expect(onNavigate).toHaveBeenCalledWith('review');
  await view.unmount();
});

test('calls and supervisor coaching render backfilled default reasons and helper text', async () => {
  const callCoaching = [
    { id: 'custom', label: 'Custom Coaching', children: [] },
    { id: 'c-other', label: 'Other' },
    { id: 'c-search-name', label: 'Search name for every call', helper: "Search the caller's name on every call to avoid duplicate member records." },
    { id: 'c-no-volunteer', label: 'Do not volunteer information', helper: 'Do not verify details the member has not provided, such as an email address.' },
  ];
  const supCoaching = [
    { label: 'Custom Supervisor Coaching', children: [] },
    { label: 'Other' },
    { label: 'Search name for every call', helper: "Search the caller's name on every call to avoid duplicate member records." },
    { label: 'Do not volunteer information', helper: 'Do not verify details the member has not provided, such as an email address.' },
  ];

  api.getCurrentSession.mockResolvedValue({
    session: {
      candidate_name: 'Taylor Example',
      supervisor_only: true,
      final_attempt: false,
    },
  });
  api.getDefaults.mockResolvedValue({
    call_types: ['New Donor - One Time Donation'],
    shows: [['Show A', '$25', '$10', 'Gift']],
    donors_new: [['Jamie', 'Doe', '1 Main', 'Austin', 'TX', '78701', '555-0100', 'jamie@example.com']],
    donors_existing: [],
    donors_increase: [],
    sup_reasons: ['Default Sup Reason'],
    call_coaching: [{ id: 'default', label: 'Default Coaching', children: [] }],
    sup_coaching: [{ label: 'Default Supervisor Coaching', children: [] }],
    call_fails: ['Default Fail'],
    sup_fails: ['Default Supervisor Fail'],
  });
  api.getSettings.mockResolvedValue({
    call_types: ['New Donor - One Time Donation'],
    shows: [['Show A', '$25', '$10', 'Gift']],
    donors_new: [['Jamie', 'Doe', '1 Main', 'Austin', 'TX', '78701', '555-0100', 'jamie@example.com']],
    donors_existing: [],
    donors_increase: [],
    sup_reasons: ['Default Sup Reason'],
    call_coaching: callCoaching,
    sup_coaching: supCoaching,
    call_fails: ['Test Fail Reason'],
    sup_fails: ['Test Supervisor Fail'],
  });

  const callsView = await renderComponent(<CallsPage onNavigate={jest.fn()} />);
  expect(callsView.container.textContent).toContain('Search name for every call');
  expect(callsView.container.textContent).toContain('Do not volunteer information');
  expect(callsView.container.textContent).toContain("Search the caller's name on every call to avoid duplicate member records.");
  expect(callsView.container.textContent).toContain('Do not verify details the member has not provided, such as an email address.');
  const callsLabels = Array.from(callsView.container.querySelectorAll('.coaching-group label')).map((label) => label.textContent.trim());
  expect(callsLabels).not.toContain('Other');
  expect(callsView.container.querySelector('.other-coaching-control')?.textContent).toContain('Other Coaching Notes');
  await callsView.unmount();

  const supView = await renderComponent(<SupTransferPage onNavigate={jest.fn()} />);
  expect(supView.container.textContent).toContain('Search name for every call');
  expect(supView.container.textContent).toContain('Do not volunteer information');
  expect(supView.container.textContent).toContain("Search the caller's name on every call to avoid duplicate member records.");
  expect(supView.container.textContent).toContain('Do not verify details the member has not provided, such as an email address.');
  const supLabels = Array.from(supView.container.querySelectorAll('.coaching-group label')).map((label) => label.textContent.trim());
  expect(supLabels.indexOf('Search name for every call')).toBeLessThan(supLabels.indexOf('Other'));
  expect(supLabels.indexOf('Do not volunteer information')).toBeLessThan(supLabels.indexOf('Other'));
  await supView.unmount();
});

test('live USB pairs remain distinct and the denied variant is removed from autocomplete', async () => {
  api.getCurrentSession.mockResolvedValue({ session: null });
  api.getSettings.mockResolvedValue({});
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({
    groups: [
      { brand: 'USB', models: ['TEST HEADSET'] },
    ],
    denied: [
      { brand: 'USB', model: 'TESTER HEADSET' },
    ],
  });

  const view = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);
  const input = view.container.querySelector('[data-testid="basics-brand"]');

  await act(async () => {
    setInputValue(input, 'USB');
    await flushPromises();
  });

  // It should show USB TEST HEADSET
  expect(view.container.textContent).toContain('USB TEST HEADSET');
  // It should not merge into "USB TEST HEADSET, TESTER HEADSET" or show TESTER HEADSET
  expect(view.container.textContent).not.toContain('TESTER HEADSET');

  await view.unmount();
});
