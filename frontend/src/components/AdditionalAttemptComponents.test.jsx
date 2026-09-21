import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AdditionalAttemptModal from './AdditionalAttemptModal';
import EmergencyOfflineAcknowledgement from './EmergencyOfflineAcknowledgement';
import FinalAttemptReasonModal from './FinalAttemptReasonModal';
import { canHistoryStartSession } from '../utils/sessionResume';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function setNativeValue(element, value) {
  const valueSetter = Object.getOwnPropertyDescriptor(element.__proto__, 'value') ||
                      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
  const prototype = Object.getPrototypeOf(element);
  const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (prototypeValueSetter) {
    prototypeValueSetter.call(element, value);
  } else {
    element.value = value;
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function renderComponent(jsx) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(jsx));
  return {
    container,
    root,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe('AdditionalAttemptModal', () => {
  test('renders candidate and attempt number, validates mandatory reason', async () => {
    const onCancel = jest.fn();
    const onProceed = jest.fn();

    const view = await renderComponent(
      <AdditionalAttemptModal
        candidateName="Jordan Lee"
        attemptNumber={4}
        onCancel={onCancel}
        onProceed={onProceed}
      />
    );

    expect(view.container.textContent).toContain('Jordan Lee');
    expect(view.container.textContent).toContain('Attempt 4');

    const proceedBtn = Array.from(view.container.querySelectorAll('button')).find(
      (b) => b.textContent.includes('Proceed with Additional Attempt')
    );
    expect(proceedBtn).toBeDefined();

    // Click proceed with empty reason
    await act(async () => {
      proceedBtn.click();
    });

    expect(view.container.textContent).toContain('A written reason is required to proceed');
    expect(onProceed).not.toHaveBeenCalled();

    // Enter valid reason
    const textarea = view.container.querySelector('textarea');
    await act(async () => {
      setNativeValue(textarea, 'Equipment disconnect approved by supervisor.');
    });

    await act(async () => {
      proceedBtn.click();
    });

    expect(onProceed).toHaveBeenCalledWith('Equipment disconnect approved by supervisor.');
    await view.cleanup();
  });

  test('cancel button and escape key trigger onCancel', async () => {
    const onCancel = jest.fn();
    const onProceed = jest.fn();

    const view = await renderComponent(
      <AdditionalAttemptModal
        candidateName="Jordan Lee"
        attemptNumber={4}
        onCancel={onCancel}
        onProceed={onProceed}
      />
    );

    const cancelBtn = Array.from(view.container.querySelectorAll('button')).find(
      (b) => b.textContent.includes('Cancel')
    );
    await act(async () => {
      cancelBtn.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);

    const overlay = view.container.querySelector('.cmodal-overlay');
    await act(async () => {
      overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(2);

    await view.cleanup();
  });
});

describe('EmergencyOfflineAcknowledgement', () => {
  test('requires checkbox acknowledgement to enable start button', async () => {
    const onCancel = jest.fn();
    const onAcknowledge = jest.fn();

    const view = await renderComponent(
      <EmergencyOfflineAcknowledgement
        candidateName="Sam Taylor"
        onCancel={onCancel}
        onAcknowledge={onAcknowledge}
      />
    );

    expect(view.container.textContent).toContain('Sam Taylor');
    const startBtn = Array.from(view.container.querySelectorAll('button')).find(
      (b) => b.textContent.includes('Acknowledge & Start Offline')
    );
    expect(startBtn.disabled).toBe(true);

    const checkbox = view.container.querySelector('input[type="checkbox"]');
    await act(async () => {
      checkbox.click();
    });

    expect(startBtn.disabled).toBe(false);

    await act(async () => {
      startBtn.click();
    });
    expect(onAcknowledge).toHaveBeenCalledTimes(1);

    await view.cleanup();
  });

  test('cancel button invokes onCancel', async () => {
    const onCancel = jest.fn();
    const onAcknowledge = jest.fn();

    const view = await renderComponent(
      <EmergencyOfflineAcknowledgement
        candidateName="Sam Taylor"
        onCancel={onCancel}
        onAcknowledge={onAcknowledge}
      />
    );

    const cancelBtn = Array.from(view.container.querySelectorAll('button')).find(
      (b) => b.textContent.includes('Cancel')
    );
    await act(async () => {
      cancelBtn.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);

    await view.cleanup();
  });
});

describe('FinalAttemptReasonModal', () => {
  test('rejects empty reason and hardcoded generic default reason', async () => {
    const onCancel = jest.fn();
    const onConfirm = jest.fn();

    const view = await renderComponent(
      <FinalAttemptReasonModal
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    );

    const confirmBtn = Array.from(view.container.querySelectorAll('button')).find(
      (b) => b.textContent.includes('Confirm Override')
    );

    // Empty reason
    await act(async () => {
      confirmBtn.click();
    });
    expect(view.container.textContent).toContain('A mandatory written explanation is required');
    expect(onConfirm).not.toHaveBeenCalled();

    const textarea = view.container.querySelector('textarea');

    // Hardcoded generic default
    await act(async () => {
      setNativeValue(textarea, 'Tester confirmed Final Attempt Yes to No override.');
    });
    await act(async () => {
      confirmBtn.click();
    });
    expect(view.container.textContent).toContain('Please provide a specific explanation rather than the default');
    expect(onConfirm).not.toHaveBeenCalled();

    // Genuine reason
    await act(async () => {
      setNativeValue(textarea, 'Audio glitch during call 2; supervisor approved redo.');
    });
    await act(async () => {
      confirmBtn.click();
    });
    expect(onConfirm).toHaveBeenCalledWith('Audio glitch during call 2; supervisor approved redo.');

    await view.cleanup();
  });
});

describe('sessionResume canHistoryStartSession gating', () => {
  test('blocks new session if candidate has pending override authorization', () => {
    const failRecord = { id: 'sess-1', candidate_name: 'Taylor', status: 'Fail', final_attempt: false, created_at: '2026-09-20T10:00:00Z' };
    expect(canHistoryStartSession(failRecord, [failRecord])).toBe(true);

    const pendingRecord = { id: 'sess-2', candidate_name: 'Taylor', status: 'Fail', authorization_status: 'pending_admin_authorization', created_at: '2026-09-20T11:00:00Z' };
    expect(canHistoryStartSession(pendingRecord, [pendingRecord])).toBe(false);

    const pendingInHistory = { id: 'sess-3', candidate_name: 'Taylor', status: 'Fail', authorization_status: 'pending_admin_authorization', created_at: '2026-09-20T12:00:00Z' };
    expect(canHistoryStartSession(failRecord, [failRecord, pendingInHistory])).toBe(false);
  });
});
