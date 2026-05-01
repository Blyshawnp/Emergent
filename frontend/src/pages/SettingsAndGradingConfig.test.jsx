import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import SettingsPage from './SettingsPage';
import CallsPage from './CallsPage';
import SupTransferPage from './SupTransferPage';
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
    getCurrentSession: jest.fn(),
    getApprovedHeadsets: jest.fn(),
    updateSession: jest.fn(),
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
    discord_templates: [['Existing Trigger', 'Existing message']],
    discord_screenshots: [{ title: 'Existing Screenshot', image_url: '' }],
  });
  api.getDefaults.mockResolvedValue({
    discord_templates: [['Existing Trigger', 'Existing message']],
    discord_screenshots: [{ title: 'Existing Screenshot', image_url: '' }],
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
