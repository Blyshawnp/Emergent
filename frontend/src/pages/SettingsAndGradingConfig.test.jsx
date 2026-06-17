import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import SettingsPage from './SettingsPage';
import CallsPage from './CallsPage';
import SupTransferPage from './SupTransferPage';
import BasicsPage from './BasicsPage';
import api from '../api';

const mockModal = {
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
  mockModal.error.mockResolvedValue(true);
  api.updateSession.mockResolvedValue({});
  window.electronAPI = {
    setUnsavedChanges: jest.fn().mockResolvedValue(undefined),
  };
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

  expect(view.container.textContent).toContain('If blank, the app uses the first name from Tester Name.');
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
  expect(view.container.textContent).toContain('No matching approved headsets');
  expect(view.container.textContent).not.toContain('Approved headset selected. USB and Noise Cancelling are marked Yes automatically.');

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
