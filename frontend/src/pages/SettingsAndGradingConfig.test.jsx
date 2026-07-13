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
    checkIpIntelligence: jest.fn(),
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
  api.checkIpIntelligence.mockResolvedValue({
    ok: true,
    ip: '8.8.8.8',
    timestamp: '2026-06-29T12:00:00Z',
    verdict: 'CLEAR',
    level: 'green',
    summary: 'No providers detected VPN, proxy, hosting, or datacenter usage.',
    warning: 'Only one VPN/proxy detector is currently available. Verify manually if this result is important.',
    detectorProviderCount: 1,
    metadataProviderCount: 1,
    confidence: 'Medium',
    providerResults: [
      {
        provider: 'proxycheck.io',
        status: 'ok',
        capability: 'vpn_proxy_detector',
        reputationCapable: true,
        vpnProxy: 'No',
        lastSeen: '',
        isp: 'Comcast Cable Communications, LLC',
        asn: 'AS7922',
        usageType: 'Residential',
        country: 'United States',
        region: 'PA',
        city: 'Philadelphia',
        connectionType: 'Cable',
        confidence: 'Medium',
        notes: 'Clear detector result',
      },
      {
        provider: 'ipapi.co network metadata',
        status: 'metadata',
        capability: 'metadata_only',
        reputationCapable: false,
        vpnProxy: 'Unknown',
        isp: 'Comcast Cable Communications, LLC',
        asn: 'AS7922',
        usageType: 'Network metadata only',
        country: 'United States',
        region: 'PA',
        city: 'Philadelphia',
        connectionType: 'Residential',
        confidence: 'Unknown',
        notes: 'Metadata only',
      },
    ],
  });
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
  api.getCurrentSession.mockResolvedValue({
    session: {
      candidate_name: 'Taylor Example',
      final_attempt: false,
    },
  });
  api.getDefaults.mockResolvedValue({
    call_types: ['New Donor - One Time Donation'],
    shows: [['Show A', '$25', '$10', 'Gift']],
    donors_new: [['Jamie', 'Doe', '1 Main', 'Austin', 'TX', '78701', '555-0100', 'jamie@example.com']],
    call_coaching: [{ id: 'default', label: 'Default Coaching', children: [] }],
    call_fails: ['Default Fail'],
  });
  api.getSettings.mockResolvedValue({
    call_types: ['New Donor - One Time Donation'],
    shows: [['Show A', '$25', '$10', 'Gift']],
    donors_new: [['Jamie', 'Doe', '1 Main', 'Austin', 'TX', '78701', '555-0100', 'jamie@example.com']],
    call_coaching: [{ id: 'test-coach', label: 'Test Coaching Reason', children: ['Test Coaching Subitem'] }],
    call_fails: ['Test Fail Reason'],
  });

  const view = await renderComponent(<CallsPage onNavigate={jest.fn()} />);

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
  api.getCurrentSession.mockResolvedValue({
    session: {
      candidate_name: 'Taylor Example',
      supervisor_only: true,
      final_attempt: false,
    },
  });
  api.getDefaults.mockResolvedValue({
    shows: [['Show A', '$25', '$10', 'Gift']],
    donors_new: [['Jamie', 'Doe', '1 Main', 'Austin', 'TX', '78701', '555-0100', 'jamie@example.com']],
    donors_existing: [],
    donors_increase: [],
    sup_reasons: ['Default Sup Reason'],
    sup_coaching: [{ label: 'Default Supervisor Coaching', children: [] }],
    sup_fails: ['Default Supervisor Fail'],
  });
  api.getSettings.mockResolvedValue({
    shows: [['Show A', '$25', '$10', 'Gift']],
    donors_new: [['Jamie', 'Doe', '1 Main', 'Austin', 'TX', '78701', '555-0100', 'jamie@example.com']],
    donors_existing: [],
    donors_increase: [],
    sup_reasons: ['Default Sup Reason'],
    sup_coaching: [{ label: 'Test Supervisor Coaching', children: ['Supervisor Subitem'] }],
    sup_fails: ['Test Supervisor Fail'],
  });

  const view = await renderComponent(<SupTransferPage onNavigate={jest.fn()} />);

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

test('unknown headset research yes marks USB and noise cancelling without approving the headset', async () => {
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

  expect(view.container.querySelectorAll('input[name="b-usb"]')[0]?.checked).toBe(true);
  expect(view.container.querySelectorAll('input[name="b-noise"]')[0]?.checked).toBe(true);
  expect(view.container.querySelector('[data-testid="basics-brand"]').value).toBe('Acme USB 100');
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
  await view.unmount();
});

test('vpn proxy review verdict requires explicit manual-review decision before continuing', async () => {
  const onNavigate = jest.fn();
  mockModal.showModal.mockResolvedValue('manual');
  api.getCurrentSession.mockResolvedValue({
    session: {
      candidate_name: 'Taylor Example',
      tester_name: 'Tester',
      final_attempt: false,
      headset_usb: true,
      noise_cancel: true,
      headset_brand: 'Logitech H390',
      vpn_on: false,
      chrome_default: true,
      extensions_disabled: true,
      popups_allowed: true,
      candidate_ip_intelligence: {
        ok: true,
        ip: '8.8.8.8',
        timestamp: '2026-06-27T12:00:00Z',
        verdict: 'REVIEW',
        level: 'yellow',
        summary: 'One provider detected VPN/proxy/hosting risk. Manual review is recommended.',
        providerResults: [],
      },
    },
  });
  api.getSettings.mockResolvedValue({ tester_name: 'Tester', vpnProxyCheckMode: 'checker' });
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [{ brand: 'Logitech', models: ['H390'] }] });

  const view = await renderComponent(<BasicsPage onNavigate={onNavigate} />);
  expect(view.container.textContent).not.toContain('Trainer Notes');
  const providerDetails = view.container.querySelector('.candidate-ip-card-embedded .ip-provider-details');
  expect(providerDetails?.hasAttribute('open') || false).toBe(false);
  await act(async () => {
    view.container.querySelector('[data-testid="basics-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(mockModal.showModal).toHaveBeenCalledWith(expect.objectContaining({
    title: 'VPN / Proxy Check',
    buttons: expect.arrayContaining([
      expect.objectContaining({ label: 'Yes, recheck after a few minutes' }),
      expect.objectContaining({ label: 'No, continue to VPN/proxy auto-fail' }),
      expect.objectContaining({ label: 'Continue without auto-fail / manual review' }),
    ]),
  }));
  expect(api.startSession).toHaveBeenCalledWith(expect.objectContaining({
    candidate_ip_intelligence: expect.objectContaining({
      verdict: 'REVIEW',
      testerDecision: expect.objectContaining({ decision: 'manual_review' }),
    }),
  }));
  expect(api.startSession.mock.calls[0][0].auto_fail_reason).toBeUndefined();
  expect(onNavigate).toHaveBeenCalledWith('calls');
  await view.unmount();
});

test('vpn proxy checker mode runs the built-in provider lookup and keeps clear provider results collapsed', async () => {
  api.getCurrentSession.mockResolvedValue({ session: { candidate_ip_intelligence: { ip: '8.8.8.8', timestamp: '2026-07-11T12:00:00Z' } } });
  api.getSettings.mockResolvedValue({ tester_name: 'Tester', vpnProxyCheckMode: 'checker' });
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [{ brand: 'Logitech', models: ['H390'] }] });

  const view = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);
  await act(async () => {
    view.container.querySelector('.candidate-ip-card-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('.candidate-ip-actions .btn-primary').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(api.checkIpIntelligence).toHaveBeenCalledWith('8.8.8.8');
  expect(view.container.querySelector('[data-testid="candidate-ip-input"]')).toBeNull();
  expect(view.container.textContent).not.toContain('Candidate Public IP Address');
  expect(view.container.textContent).not.toContain('Copy IP');
  expect(view.container.textContent).toContain('Integrated Check');
  expect(view.container.textContent).toContain('CLEAR — LIMITED CHECK');
  expect(view.container.textContent).toContain('Confidence: Medium');
  expect(view.container.textContent).toContain('Detectors: 1');
  expect(view.container.textContent).toContain('Metadata sources: 1');
  expect(view.container.textContent).toContain('ISP: Comcast Cable Communications, LLC');
  expect(view.container.textContent).toContain('Connection: Residential');
  expect(view.container.textContent).toContain('Only one VPN/proxy detector is currently available. Verify manually if this result is important.');
  expect(view.container.querySelector('[data-testid="candidate-ip-manual-links"]')).not.toBeNull();
  const providerDetails = view.container.querySelector('.candidate-ip-card-embedded .ip-provider-details');
  expect(providerDetails?.hasAttribute('open') || false).toBe(false);
  expect(view.container.textContent).not.toContain('Trainer Notes');
  await view.unmount();
});

test('vpn proxy technical details show simplified columns and keep advanced metadata hidden until expanded', async () => {
  api.getCurrentSession.mockResolvedValue({ session: { candidate_ip_intelligence: { ip: '8.8.8.8', timestamp: '2026-07-11T12:00:00Z' } } });
  api.getSettings.mockResolvedValue({ tester_name: 'Tester', vpnProxyCheckMode: 'checker' });
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [{ brand: 'Logitech', models: ['H390'] }] });

  const view = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);
  await act(async () => {
    view.container.querySelector('.candidate-ip-card-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('.candidate-ip-actions .btn-primary').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('.ip-provider-details summary').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  const details = view.container.querySelector('.candidate-ip-card-embedded .ip-provider-details');
  expect(details?.hasAttribute('open') || false).toBe(true);
  const simpleHeaders = Array.from(view.container.querySelectorAll('.ip-provider-table-simple th')).map((cell) => cell.textContent);
  expect(simpleHeaders).toEqual(expect.arrayContaining(['Provider', 'Result', 'Capability', 'Last Seen', 'Confidence']));
  expect(simpleHeaders).not.toEqual(expect.arrayContaining(['ISP', 'ASN', 'City', 'Region', 'Connection Type']));
  expect(view.container.textContent).toContain('Detector providers');
  expect(view.container.textContent).toContain('Metadata providers');
  expect(view.container.textContent).toContain('proxycheck.io');
  expect(view.container.textContent).toContain('ipapi.co network metadata');
  expect(view.container.textContent).toContain('Metadata only');
  const advanced = view.container.querySelector('.ip-provider-advanced');
  expect(advanced?.hasAttribute('open') || false).toBe(false);
  await act(async () => {
    advanced.querySelector('summary').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(advanced.hasAttribute('open')).toBe(true);
  const advancedHeaders = Array.from(view.container.querySelectorAll('.ip-provider-table-advanced th')).map((cell) => cell.textContent);
  expect(advancedHeaders).toEqual(expect.arrayContaining(['ISP', 'ASN', 'Usage Type', 'Country', 'Region', 'City', 'Connection Type', 'Details']));
  await view.unmount();
});

test('vpn proxy non-clear verdicts open technical details by default', async () => {
  const scenarios = [
    { verdict: 'REVIEW', level: 'yellow' },
    { verdict: 'VPN / PROXY LIKELY', level: 'red' },
    { verdict: 'UNABLE TO VERIFY', level: 'gray', detectorProviderCount: 0, metadataProviderCount: 1, warning: 'No VPN/proxy reputation provider is currently available. Manual verification required.' },
  ];

  for (const scenario of scenarios) {
    api.getCurrentSession.mockResolvedValue({
      session: {
        candidate_name: 'Taylor Example',
        tester_name: 'Tester',
        final_attempt: false,
        headset_usb: true,
        noise_cancel: true,
        headset_brand: 'Logitech H390',
        vpn_on: false,
        chrome_default: true,
        extensions_disabled: true,
        popups_allowed: true,
        candidate_ip_intelligence: {
          ok: true,
          ip: '8.8.8.8',
          timestamp: `2026-06-29T12:00:0${scenarios.indexOf(scenario)}Z`,
          verdict: scenario.verdict,
          level: scenario.level,
          summary: scenario.verdict === 'UNABLE TO VERIFY' ? 'Only network metadata is available.' : 'Manual review is recommended.',
          warning: scenario.warning || 'Only one VPN/proxy detector is currently available. Verify manually if this result is important.',
          detectorProviderCount: scenario.detectorProviderCount ?? 1,
          metadataProviderCount: scenario.metadataProviderCount ?? 1,
          confidence: scenario.verdict === 'UNABLE TO VERIFY' ? 'Unknown' : 'Low',
          providerResults: [
            {
              provider: scenario.verdict === 'UNABLE TO VERIFY' ? 'ipapi.co network metadata' : 'proxycheck.io',
              status: scenario.verdict === 'UNABLE TO VERIFY' ? 'metadata' : 'ok',
              capability: scenario.verdict === 'UNABLE TO VERIFY' ? 'metadata_only' : 'vpn_proxy_detector',
              reputationCapable: scenario.verdict !== 'UNABLE TO VERIFY',
              vpnProxy: scenario.verdict === 'UNABLE TO VERIFY' ? 'Unknown' : 'Yes',
              confidence: scenario.verdict === 'UNABLE TO VERIFY' ? 'Unknown' : 'Low',
            },
          ],
        },
      },
    });
    api.getSettings.mockResolvedValue({ tester_name: 'Tester', vpnProxyCheckMode: 'checker' });
    api.getDefaults.mockResolvedValue({});
    api.getApprovedHeadsets.mockResolvedValue({ groups: [{ brand: 'Logitech', models: ['H390'] }] });

    const view = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);
    await act(async () => {
      view.container.querySelector('.candidate-ip-card-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushPromises();
    });

    const providerDetails = view.container.querySelector('.candidate-ip-card-embedded .ip-provider-details');
    expect(providerDetails?.hasAttribute('open') || false).toBe(true);
    expect(providerDetails.textContent).toContain('Hide technical details');
    await view.unmount();
  }
});

test('vpn proxy defaults to automatic lookup when settings omit mode', async () => {
  api.getCurrentSession.mockResolvedValue({ session: null });
  api.getSettings.mockResolvedValue({ tester_name: 'Tester' });
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [{ brand: 'Logitech', models: ['H390'] }] });

  const view = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);
  expect(view.container.querySelector('[data-testid="candidate-ip-intelligence"]')).not.toBeNull();
  expect(view.container.textContent).toContain('Integrated Check');
  await act(async () => {
    view.container.querySelector('.candidate-ip-card-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  expect(view.container.textContent).toContain('Automatic lookup checks configured providers.');
  expect(view.container.textContent).not.toContain('Candidate Public IP Address');
  expect(view.container.querySelector('[data-testid="candidate-ip-input"]')).toBeNull();
  expect(api.checkIpIntelligence).not.toHaveBeenCalled();
  await view.unmount();
});

test('vpn proxy links mode shows external lookup buttons and does not call provider API', async () => {
  api.getCurrentSession.mockResolvedValue({ session: null });
  api.getSettings.mockResolvedValue({ tester_name: 'Tester', vpnProxyCheckMode: 'links' });
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [{ brand: 'Logitech', models: ['H390'] }] });

  const view = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);
  expect(view.container.querySelector('[data-testid="candidate-ip-links"]')).not.toBeNull();
  expect(view.container.textContent).toContain('Manual Verification');
  expect(view.container.textContent).toContain('Manual verification is available when automatic lookup is not needed.');
  await act(async () => {
    const btn = Array.from(view.container.querySelectorAll('button')).find(b => b.textContent.includes('Expand'));
    if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  await act(async () => {
    view.container.querySelector('[data-testid="candidate-ip-link-ip2location"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(api.checkIpIntelligence).not.toHaveBeenCalled();
  expect(window.electronAPI.openExternal).toHaveBeenCalledWith('https://www.ip2location.com/demo');
  expect(view.container.textContent).toContain('Lookup');
  expect(view.container.textContent).not.toContain('Open Lookup');
  expect(view.container.textContent).toContain('WhatIsMyIP Proxy Check');
  expect(view.container.textContent).toContain('Teoh VPN Detection');
  expect(view.container.textContent).toContain('ProxyCheck.io');
  expect(view.container.textContent).toContain('IP2Location');
  expect(view.container.textContent).not.toContain('IPQualityScore');
  expect(view.container.textContent).not.toContain('GetIPIntel');
  expect(view.container.textContent).toContain('Check the candidate IP using more than one lookup site because individual services can be stale or incomplete.');
  expect(view.container.textContent).not.toContain('Candidate Public IP Address');
  expect(view.container.textContent).not.toContain('Copy IP');
  expect(view.container.querySelector('[data-testid="candidate-ip-manual-input"]')).toBeNull();

  await act(async () => {
    view.container.querySelector('[data-testid="candidate-ip-copy-url-whatismyip-proxy-check"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://www.whatismyip.com/proxy-check/');
  await view.unmount();
});

test('settings exposes vpn proxy mode and saves integrated selection', async () => {
  api.getSettings.mockResolvedValue({ tester_name: 'Tester', vpnProxyCheckMode: 'links' });
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

  const modeSelect = view.container.querySelector('[data-testid="settings-vpn-proxy-mode"]');
  expect(modeSelect).not.toBeNull();
  expect(modeSelect.value).toBe('links');
  await act(async () => {
    setSelectValue(modeSelect, 'checker');
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="settings-save"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ vpnProxyCheckMode: 'checker' }));
  await view.unmount();
});

test('vpn proxy disabled mode hides built-in checker and provider table', async () => {
  api.getCurrentSession.mockResolvedValue({ session: null });
  api.getSettings.mockResolvedValue({ tester_name: 'Tester', vpnProxyCheckMode: 'disabled' });
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [{ brand: 'Logitech', models: ['H390'] }] });

  const view = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);
  expect(view.container.querySelector('[data-testid="candidate-ip-disabled"]')).not.toBeNull();
  expect(view.container.textContent).toContain('Built-in VPN / Proxy Check is disabled. Use manual verification if needed.');
  expect(view.container.querySelector('.ip-provider-table')).toBeNull();
  expect(api.checkIpIntelligence).not.toHaveBeenCalled();
  await view.unmount();
});

test('vpn proxy unable-to-turn-off choice uses existing VPN autofail session path', async () => {
  const onNavigate = jest.fn();
  mockModal.showModal
    .mockResolvedValueOnce('fail')
    .mockResolvedValueOnce(true);
  api.getCurrentSession.mockResolvedValue({
    session: {
      candidate_name: 'Taylor Example',
      tester_name: 'Tester',
      final_attempt: false,
      headset_usb: true,
      noise_cancel: true,
      headset_brand: 'Logitech H390',
      vpn_on: false,
      chrome_default: true,
      extensions_disabled: true,
      popups_allowed: true,
      candidate_ip_intelligence: {
        ok: true,
        ip: '8.8.8.8',
        timestamp: '2026-06-27T12:00:00Z',
        verdict: 'VPN / PROXY LIKELY',
        level: 'red',
        summary: 'VPN/proxy detector signals indicate this IP is likely VPN/proxy/datacenter.',
        providerResults: [],
      },
    },
  });
  api.getSettings.mockResolvedValue({
    tester_name: 'Tester',
    vpnProxyCheckMode: 'checker',
    discord_templates: [{ category: 'Failure Outcomes', title: 'VPN Fail', message: 'VPN fail post' }],
  });
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [{ brand: 'Logitech', models: ['H390'] }] });

  const view = await renderComponent(<BasicsPage onNavigate={onNavigate} />);
  await act(async () => {
    view.container.querySelector('[data-testid="basics-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(mockModal.showModal.mock.calls[0][0]).toEqual(expect.objectContaining({
    title: 'VPN / Proxy Check',
  }));
  expect(mockModal.showModal.mock.calls[1][0]).toEqual(expect.objectContaining({
    title: 'VPN Issue',
    body: expect.stringContaining('Using a VPN/proxy is not accepted'),
  }));
  expect(api.startSession).toHaveBeenCalledWith(expect.objectContaining({
    final_status: 'Fail',
    auto_fail_reason: 'Unable to turn off VPN',
    candidate_ip_intelligence: expect.objectContaining({
      verdict: 'VPN / PROXY LIKELY',
      testerDecision: expect.objectContaining({ decision: 'auto_fail' }),
    }),
  }));
  expect(onNavigate).toHaveBeenCalledWith('review');
  await view.unmount();
});

test('vpn proxy recheck choice does not autofail or start session', async () => {
  mockModal.showModal.mockResolvedValueOnce('recheck');
  api.getCurrentSession.mockResolvedValue({
    session: {
      candidate_name: 'Taylor Example',
      tester_name: 'Tester',
      final_attempt: false,
      headset_usb: true,
      noise_cancel: true,
      headset_brand: 'Logitech H390',
      vpn_on: false,
      chrome_default: true,
      extensions_disabled: true,
      popups_allowed: true,
      candidate_ip_intelligence: {
        ok: true,
        ip: '8.8.8.8',
        timestamp: '2026-06-27T12:00:00Z',
        verdict: 'REVIEW',
        level: 'yellow',
        summary: 'One provider detected VPN/proxy/hosting risk.',
        providerResults: [],
      },
    },
  });
  api.getSettings.mockResolvedValue({ tester_name: 'Tester', vpnProxyCheckMode: 'checker' });
  api.getDefaults.mockResolvedValue({});
  api.getApprovedHeadsets.mockResolvedValue({ groups: [{ brand: 'Logitech', models: ['H390'] }] });

  const view = await renderComponent(<BasicsPage onNavigate={jest.fn()} />);
  await act(async () => {
    view.container.querySelector('[data-testid="basics-continue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(mockModal.warning).toHaveBeenCalledWith('Recheck Needed', expect.stringContaining('Wait 2-3 minutes'));
  expect(api.startSession).not.toHaveBeenCalled();
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
  expect(callsLabels.indexOf('Search name for every call')).toBeLessThan(callsLabels.indexOf('Other'));
  expect(callsLabels.indexOf('Do not volunteer information')).toBeLessThan(callsLabels.indexOf('Other'));
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
