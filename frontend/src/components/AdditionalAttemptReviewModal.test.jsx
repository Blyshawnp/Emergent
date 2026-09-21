import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AdditionalAttemptReviewModal from './AdditionalAttemptReviewModal';

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

describe('AdditionalAttemptReviewModal', () => {
  const mockInProgressOverride = {
    id: 'ov-in-progress-1',
    candidate_name: 'Robin Banks',
    tester_name: 'Tester Sarah',
    source_session_id: 'sess-prog-123',
    attempt_number: 4,
    authorized_max_attempts: 3,
    reason: 'Audio disconnected on Call 2 of 3rd test',
    authorization_status: 'pending_admin_authorization',
    is_offline_emergency: false,
    occurred_at: '2026-09-21T02:00:00Z',
    session: {
      is_in_progress: true,
      final_result: null,
      mock_calls_completed: 1,
    },
    prior_history: [
      { attempt_number: 1, final_result: 'Fail', session_id: 'sess-1' },
      { attempt_number: 2, final_result: 'Fail', session_id: 'sess-2' },
      { attempt_number: 3, final_result: 'Fail', session_id: 'sess-3' },
    ],
  };

  const mockCompletedOverride = {
    id: 'ov-completed-1',
    candidate_name: 'Robin Banks',
    tester_name: 'Tester Sarah',
    source_session_id: 'sess-comp-456',
    attempt_number: 4,
    authorized_max_attempts: 3,
    reason: 'Audio disconnected on Call 2 of 3rd test',
    authorization_status: 'pending_admin_authorization',
    is_offline_emergency: true,
    occurred_at: '2026-09-21T02:00:00Z',
    session: {
      is_in_progress: false,
      final_result: 'PASS',
      mock_calls_completed: 3,
      sup_transfers_completed: 1,
      evaluator_notes_summary: 'Candidate demonstrated outstanding de-escalation skills.',
    },
    prior_history: [
      { attempt_number: 1, final_result: 'Fail', session_id: 'sess-1' },
      { attempt_number: 2, final_result: 'Fail', session_id: 'sess-2' },
      { attempt_number: 3, final_result: 'Fail', session_id: 'sess-3' },
    ],
  };

  const mockConflictOverride = {
    id: 'ov-conflict-1',
    candidate_name: 'Robin Banks',
    tester_name: 'Tester Bob (Offline Station)',
    source_session_id: 'sess-offline-conflict-789',
    attempt_number: 4,
    authorized_max_attempts: 3,
    reason: 'Emergency offline test during local router reboot',
    authorization_status: 'conflict',
    is_offline_emergency: true,
    occurred_at: '2026-09-21T02:15:00Z',
    session: {
      is_in_progress: false,
      final_result: 'PASS',
      mock_calls_completed: 3,
    },
    conflict_data: {
      conflicting_override_id: 'ov-prior-pending',
      conflicting_session_id: 'sess-comp-456',
      conflicting_tester_name: 'Tester Sarah',
      conflicting_authorization_status: 'pending_admin_authorization',
      conflicting_reason: 'Prior online reservation',
    },
  };

  test('in-progress session displays warning and disables Approve/Deny buttons', async () => {
    const onDecide = jest.fn();
    const onClose = jest.fn();

    const view = await renderComponent(
      <AdditionalAttemptReviewModal
        open={true}
        override={mockInProgressOverride}
        onClose={onClose}
        onDecide={onDecide}
      />
    );

    // Header & Business Fields
    expect(view.container.textContent).toContain('Robin Banks');
    expect(view.container.textContent).toContain('Attempt 4 of 3 allowed');
    expect(view.container.textContent).toContain('sess-prog-123');
    expect(view.container.textContent).toContain('Audio disconnected on Call 2 of 3rd test');

    // In progress warning is shown
    expect(view.container.textContent).toContain('Session in Progress — Evaluation Not Yet Available');

    // Approve and Deny buttons are DISABLED
    const approveBtn = view.container.querySelector('[data-testid="approve-override-btn"]');
    const denyBtn = view.container.querySelector('[data-testid="deny-override-btn"]');
    expect(approveBtn).toBeDefined();
    expect(denyBtn).toBeDefined();
    expect(approveBtn.disabled).toBe(true);
    expect(denyBtn.disabled).toBe(true);

    await view.cleanup();
  });

  test('completed session displays actual Pass/Fail result and enables Approve/Deny', async () => {
    const onDecide = jest.fn();
    const onClose = jest.fn();

    const view = await renderComponent(
      <AdditionalAttemptReviewModal
        open={true}
        override={mockCompletedOverride}
        onClose={onClose}
        onDecide={onDecide}
      />
    );

    // Shows evaluation result
    expect(view.container.textContent).toContain('Result: PASS');
    expect(view.container.textContent).toContain('Evaluation Submitted');
    expect(view.container.textContent).toContain('Emergency Offline Option B');
    expect(view.container.textContent).toContain('Candidate demonstrated outstanding de-escalation skills.');

    // Buttons are enabled
    const approveBtn = view.container.querySelector('[data-testid="approve-override-btn"]');
    const denyBtn = view.container.querySelector('[data-testid="deny-override-btn"]');
    expect(approveBtn.disabled).toBe(false);
    expect(denyBtn.disabled).toBe(false);

    await view.cleanup();
  });

  test('confirmation step before applying decision gates API call', async () => {
    const onDecide = jest.fn().mockResolvedValue({ ok: true });
    const onClose = jest.fn();

    const view = await renderComponent(
      <AdditionalAttemptReviewModal
        open={true}
        override={mockCompletedOverride}
        onClose={onClose}
        onDecide={onDecide}
      />
    );

    const approveBtn = view.container.querySelector('[data-testid="approve-override-btn"]');
    await act(async () => {
      approveBtn.click();
    });

    // Confirmation step is shown, API not yet called
    expect(view.container.querySelector('[data-testid="confirmation-step"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Confirm Approval');
    expect(onDecide).not.toHaveBeenCalled();

    // Confirm decision
    const confirmBtn = view.container.querySelector('[data-testid="confirm-decision-btn"]');
    await act(async () => {
      confirmBtn.click();
    });

    expect(onDecide).toHaveBeenCalledWith({
      override_id: 'ov-completed-1',
      decision: 'approved',
      reason: undefined,
    });
    expect(onClose).toHaveBeenCalled();

    await view.cleanup();
  });

  test('conflict review displays both sessions and allows conflict resolution', async () => {
    const onResolveConflict = jest.fn().mockResolvedValue({ ok: true });
    const onClose = jest.fn();

    const view = await renderComponent(
      <AdditionalAttemptReviewModal
        open={true}
        override={mockConflictOverride}
        onClose={onClose}
        onResolveConflict={onResolveConflict}
      />
    );

    expect(view.container.textContent).toContain('Offline Override Conflict Review');
    expect(view.container.textContent).toContain('Conflicting Sessions Comparison');
    expect(view.container.textContent).toContain('Tester Bob (Offline Station)');
    expect(view.container.textContent).toContain('Tester Sarah');
    expect(view.container.textContent).toContain('sess-comp-456');

    // Conflict action buttons
    const approveWinnerBtn = view.container.querySelector('[data-testid="approve-winner-btn"]');
    const denyBothBtn = view.container.querySelector('[data-testid="deny-both-btn"]');
    expect(approveWinnerBtn).toBeDefined();
    expect(denyBothBtn).toBeDefined();

    // Click Approve This Session
    await act(async () => {
      approveWinnerBtn.click();
    });

    expect(view.container.textContent).toContain('Confirm Conflict Resolution');
    const confirmBtn = view.container.querySelector('[data-testid="confirm-decision-btn"]');
    await act(async () => {
      confirmBtn.click();
    });

    expect(onResolveConflict).toHaveBeenCalledWith({
      conflict_override_id: 'ov-conflict-1',
      decision: 'approved',
      reason: undefined,
    });
    expect(onClose).toHaveBeenCalled();

    await view.cleanup();
  });

  test('displays sanitized error message on decision failure without closing', async () => {
    const onDecide = jest.fn().mockResolvedValue({
      ok: false,
      error: 'Network timeout contacting hosted authorization service.',
    });
    const onClose = jest.fn();

    const view = await renderComponent(
      <AdditionalAttemptReviewModal
        open={true}
        override={mockCompletedOverride}
        onClose={onClose}
        onDecide={onDecide}
      />
    );

    const approveBtn = view.container.querySelector('[data-testid="approve-override-btn"]');
    await act(async () => {
      approveBtn.click();
    });

    const confirmBtn = view.container.querySelector('[data-testid="confirm-decision-btn"]');
    await act(async () => {
      confirmBtn.click();
    });

    expect(view.container.textContent).toContain('Network timeout contacting hosted authorization service.');
    // Modal did not close
    expect(onClose).not.toHaveBeenCalled();

    await view.cleanup();
  });
});
