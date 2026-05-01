import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import SupTransferPage from './SupTransferPage';
import api from '../api';

const mockModal = {
  confirm: jest.fn(),
  confirmDanger: jest.fn(),
  warning: jest.fn(),
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

async function renderPage(sessionOverrides = {}) {
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
  api.getDefaults.mockResolvedValue({});
  api.getSettings.mockResolvedValue({});

  await act(async () => {
    root.render(<SupTransferPage onNavigate={onNavigate} />);
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
  const view = await renderPage({ supervisor_only: true, candidate_name: 'Taylor Example' });

  await act(async () => {
    view.container.querySelector('[data-testid="sup-ncns"]').dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    await flushPromises();
  });

  expect(mockModal.confirm).toHaveBeenCalledWith(
    'Confirm Auto-Fail',
    'This will Automatically fail Taylor Example and mark as a NC/NS. Do you want to proceed?',
    'alert-triangle',
    'warning'
  );
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
  const view = await renderPage({ supervisor_only: true, candidate_name: 'Taylor Example' });

  await act(async () => {
    view.container.querySelector('[data-testid="sup-notready"]').dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    await flushPromises();
  });

  expect(mockModal.confirm).toHaveBeenCalledWith(
    'Confirm Auto-Fail',
    'This will Automatically fail Taylor Example and mark as Not Ready for Session. Do you want to proceed?',
    'alert-triangle',
    'warning'
  );
  expect(api.updateSession).toHaveBeenCalledWith({
    auto_fail_reason: 'Not Ready for Session',
    final_status: 'Fail',
    current_sup_transfer_draft: null,
    current_sup_transfer_num: null,
  });
  expect(view.onNavigate).toHaveBeenCalledWith('review');

  await view.unmount();
});
