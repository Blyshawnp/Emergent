import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ReviewPage from './ReviewPage';
import api from '../api';

const mockModal = {
  alert: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  showModal: jest.fn(),
  confirmDanger: jest.fn(),
};

jest.mock('../api', () => ({
  __esModule: true,
  default: {
    getCurrentSession: jest.fn(),
    getSettings: jest.fn(),
    updateSession: jest.fn(),
    generateSummaries: jest.fn(),
    regenerateSummary: jest.fn(),
    fillForm: jest.fn(),
    finishSession: jest.fn(),
    discardSession: jest.fn(),
    startSession: jest.fn(),
  },
}));

jest.mock('../components/ModalProvider', () => ({
  useModal: () => mockModal,
}));

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

const passingSession = {
  candidate_name: 'Taylor Example',
  tester_name: 'Tester One',
  final_attempt: false,
  headset_usb: true,
  noise_cancel: true,
  headset_brand: 'Logitech H390',
  vpn_on: false,
  chrome_default: true,
  extensions_disabled: true,
  popups_allowed: true,
  call_1: { result: 'Pass' },
  call_2: { result: 'Pass' },
  sup_transfer_1: { result: 'Pass' },
  finalEvaluatorNotes: { completed: true, skipped: false },
  coaching_summary: 'Base coaching summary.',
  fail_summary: 'N/A',
};

async function renderReview(session = passingSession) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onNavigate = jest.fn();

  api.getCurrentSession.mockResolvedValue({ session });
  api.getSettings.mockResolvedValue({});
  api.updateSession.mockResolvedValue({ ok: true, session });
  api.fillForm.mockResolvedValue({ ok: true, message: 'Filled' });
  api.finishSession.mockResolvedValue({ ok: true, message: 'Saved' });
  mockModal.alert.mockResolvedValue(true);
  mockModal.showModal.mockResolvedValue(true);

  await act(async () => {
    root.render(<ReviewPage onNavigate={onNavigate} />);
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

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('defaults final readiness judgment to calculated result', async () => {
  const view = await renderReview();

  expect(view.container.textContent).toContain('Final Readiness Judgment');
  expect(view.container.textContent).toContain('Calculated result: Pass');
  expect(view.container.querySelector('[name="final-readiness-mode"]').checked).toBe(true);

  await view.unmount();
});

test('override to fail updates final result and fill form payload', async () => {
  const view = await renderReview();

  await act(async () => {
    view.container.querySelectorAll('[name="final-readiness-mode"]')[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="readiness-override-result"]').value = 'Fail';
    view.container.querySelector('[data-testid="readiness-override-result"]').dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="readiness-primary-reason"]').value = 'Accuracy/detail concerns';
    view.container.querySelector('[data-testid="readiness-primary-reason"]').dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="review-fill-form"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(view.container.textContent).toContain('Evaluator Override Applied');
  expect(api.fillForm).toHaveBeenCalledWith(
    expect.stringContaining('Evaluator Override Applied'),
    expect.stringContaining('Evaluator Override Applied'),
    null
  );

  await view.unmount();
});

test('override requires primary reason before fill form', async () => {
  const view = await renderReview();

  await act(async () => {
    view.container.querySelectorAll('[name="final-readiness-mode"]')[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="readiness-override-result"]').value = 'Fail';
    view.container.querySelector('[data-testid="readiness-override-result"]').dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    view.container.querySelector('[data-testid="review-fill-form"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(mockModal.warning).toHaveBeenCalledWith('Final Readiness Judgment Required', 'Select a primary reason for the override.');
  expect(api.fillForm).not.toHaveBeenCalled();

  await view.unmount();
});
