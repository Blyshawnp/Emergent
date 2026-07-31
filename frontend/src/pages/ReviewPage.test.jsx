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

function setNativeValue(element, value) {
  const descriptor = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value');
  descriptor.set.call(element, value);
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

async function renderReview(session = passingSession, navigationState = null, options = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onNavigate = jest.fn();

  api.getCurrentSession.mockResolvedValue({ session });
  api.getSettings.mockResolvedValue({});
  api.updateSession.mockResolvedValue({ ok: true, session });
  if (options.generateSummariesError) {
    api.generateSummaries.mockRejectedValue(options.generateSummariesError);
  } else {
    api.generateSummaries.mockResolvedValue(options.generateSummariesResult || {
      coaching: 'Regenerated coaching summary.',
      fail: 'Regenerated fail summary.',
      used_gemini: false,
      used_fallback: true,
      gemini_error: '',
    });
  }
  api.fillForm.mockResolvedValue({ ok: true, message: 'Filled' });
  api.finishSession.mockResolvedValue({ ok: true, message: 'Saved' });
  mockModal.alert.mockResolvedValue(true);
  mockModal.showModal.mockResolvedValue(true);

  await act(async () => {
    root.render(<ReviewPage onNavigate={onNavigate} navigationState={navigationState} />);
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

test('shows one persistent Final Attempt banner on Review without duplicating the status surface', async () => {
  const view = await renderReview({
    ...passingSession,
    final_attempt: true,
    attempt_state: { current_attempt: 3, max_attempts: 3 },
  });

  const banners = view.container.querySelectorAll('[data-testid="final-attempt-banner"]');
  expect(banners).toHaveLength(1);
  expect(banners[0].textContent).toContain('FINAL ATTEMPT');

  await view.unmount();
});

test('review auto-populates missing coaching summary when only fail summary exists', async () => {
  const view = await renderReview({
    ...passingSession,
    coaching_summary: '',
    fail_summary: 'N/A',
  }, null, {
    generateSummariesResult: {
      coaching: 'Fallback coaching summary generated automatically.',
      fail: 'Generated fail summary should not replace N/A for a passing session.',
      used_gemini: false,
      used_fallback: true,
      gemini_error: '',
    },
  });

  await act(async () => {
    await flushPromises();
    await flushPromises();
  });

  expect(api.generateSummaries).toHaveBeenCalledWith(expect.objectContaining({
    candidate_name: 'Taylor Example',
  }));
  expect(view.container.querySelector('[data-testid="review-coaching"]').value).toBe('Fallback coaching summary generated automatically.');
  expect(view.container.querySelector('[data-testid="review-fail"]').value).toBe('N/A');

  await view.unmount();
});

test('review preserves existing coaching summary on initial load', async () => {
  const view = await renderReview({
    ...passingSession,
    coaching_summary: 'Existing trainer-approved coaching summary.',
    fail_summary: 'N/A',
  });

  await act(async () => {
    await flushPromises();
  });

  expect(api.generateSummaries).not.toHaveBeenCalled();
  expect(view.container.querySelector('[data-testid="review-coaching"]').value).toBe('Existing trainer-approved coaching summary.');

  await view.unmount();
});

test('review keeps automatic fallback visible when summary generation errors', async () => {
  const view = await renderReview({
    ...passingSession,
    coaching_summary: '',
    fail_summary: 'N/A',
  }, null, {
    generateSummariesError: new Error('Gemini unavailable'),
  });

  await act(async () => {
    await flushPromises();
    await flushPromises();
  });

  expect(view.container.querySelector('[data-testid="review-coaching"]').value).toContain('Call 1: Pass.');
  expect(view.container.querySelector('[data-testid="review-fail"]').value).toBe('N/A');
  expect(view.container.querySelector('[data-testid="review-gemini-status"]').textContent).toContain('Gemini unavailable');

  await view.unmount();
});

test('review fallback summary uses professional display labels without internal keys', async () => {
  const view = await renderReview({
    ...passingSession,
    call_1: {
      result: 'Fail',
      coaching: {
        Verification_Name: true,
        Verification_Address: true,
        'Show appreciation_After donation amount is given': true,
        'Screenshots/Discord Chat': true,
      },
      fails: {
        'Paraphrased script': true,
      },
      failReasonDetails: {
        'Paraphrased script': 'Monthly Sustaining Terms',
      },
    },
    coaching_summary: '',
    fail_summary: '',
    final_attempt: true,
  }, null, {
    generateSummariesError: new Error('Gemini unavailable'),
  });

  await act(async () => {
    await flushPromises();
    await flushPromises();
  });

  const coaching = view.container.querySelector('[data-testid="review-coaching"]').value;
  expect(coaching).toContain("Verify the candidate's name.");
  expect(coaching).toContain("Verify the candidate's address.");
  expect(coaching).toContain('Show appreciation after the donation amount is given.');
  expect(coaching).toContain('Use the required screenshots and Discord guidance.');
  expect(coaching).not.toContain('_');
  expect(coaching).not.toContain('Verification_Name');
  expect(coaching).not.toContain('Show appreciation_After donation amount is given');

  await view.unmount();
});

test('review fallback fail summary and form payload include Did not search for member', async () => {
  const view = await renderReview({
    ...passingSession,
    call_1: {
      result: 'Fail',
      fails: {
        'Did not search for member': true,
      },
    },
    call_2: { result: 'Fail', fails: { 'Skipped parts of script': true } },
    sup_transfer_1: undefined,
    coaching_summary: '',
    fail_summary: '',
    final_attempt: true,
  }, null, {
    generateSummariesError: new Error('Gemini unavailable'),
  });

  await act(async () => {
    await flushPromises();
    await flushPromises();
  });

  const failSummary = view.container.querySelector('[data-testid="review-fail"]').value;
  expect(failSummary).toContain('Did not search for the member');
  expect(failSummary).not.toContain('did_not_search_for_member');

  await act(async () => {
    view.container.querySelector('[data-testid="review-fill-form"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(api.fillForm).toHaveBeenCalledWith(
    expect.any(String),
    expect.stringContaining('Did not search for the member'),
    expect.objectContaining({
      call_1: expect.objectContaining({
        fails: expect.objectContaining({ 'Did not search for member': true }),
      }),
    }),
  );

  await view.unmount();
});

test('incomplete review keeps fail summary N/A and shows scheduling action', async () => {
  const incompleteSession = {
    ...passingSession,
    sup_transfer_1: undefined,
    tech_issue: 'Discord issues - unresolved',
    tech_issue_ended_session: true,
    coaching_summary: 'Candidate passed mock calls before the interruption.',
    fail_summary: 'Stale generated fail summary.',
  };
  const view = await renderReview(incompleteSession);

  expect(view.container.querySelector('[data-testid="review-banner"]').textContent).toContain('SESSION INCOMPLETE');
  expect(view.container.querySelector('[data-testid="review-fail"]').value).toBe('N/A');
  expect(view.container.querySelector('[data-testid="review-incomplete-reason"]').textContent).toContain('Technical issue prevented completion during Supervisor Transfer.');
  expect(view.container.querySelector('[data-testid="review-incomplete-reason"]').textContent).toContain('A Newbie Shift is needed to complete certification.');
  expect(view.container.querySelector('[data-testid="review-next-actions"]')).not.toBeNull();
  expect(view.container.querySelector('[data-testid="review-next-actions"]').textContent).toContain('This certification session requires follow-up before it can be completed.');
  expect(view.container.querySelector('[data-testid="review-next-actions"]').textContent).toContain('Use this if the automatic Newbie Shift prompt was skipped, dismissed, or the session was updated after review.');
  expect(view.container.querySelector('[data-testid="review-schedule-newbie"]')).not.toBeNull();

  await act(async () => {
    view.container.querySelector('[data-testid="review-fill-form"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(api.fillForm).toHaveBeenCalledWith(
    expect.any(String),
    'N/A',
    expect.objectContaining({ final_status: 'Incomplete' })
  );

  await view.unmount();
});

test('resumed supervisor transfer separates historical and current technical issues', async () => {
  const resumedSession = {
    ...passingSession,
    supervisor_only: true,
    resumed_sup_transfer_only: true,
    resume_source_history_id: 'history-123',
    sup_transfer_1: undefined,
    tech_issue: 'Calls would not route - unresolved',
    tech_issue_ended_session: true,
    current_session_tech_issue: false,
    historical_tech_issue: 'Calls would not route - unresolved',
    coaching_summary: 'Candidate resumed for supervisor transfer.',
    fail_summary: 'N/A',
  };
  const view = await renderReview(resumedSession);

  expect(view.container.textContent).toContain('Current Session Technical Issue: N/A');
  expect(view.container.textContent).toContain('Prior Session Technical Issue: Calls would not route - unresolved');
  expect(view.container.querySelector('[data-testid="review-incomplete-reason"]').textContent).not.toContain('Technical issue prevented completion');

  await act(async () => {
    view.container.querySelector('[data-testid="review-fill-form"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(api.fillForm).toHaveBeenCalledWith(
    expect.any(String),
    'N/A',
    expect.objectContaining({
      final_status: 'Incomplete',
      current_session_tech_issue: false,
    })
  );

  await view.unmount();
});

test('schedule newbie action launches existing scheduler and existing appointment disables action', async () => {
  const incompleteSession = {
    ...passingSession,
    sup_transfer_1: undefined,
    coaching_summary: 'Candidate passed mock calls.',
    fail_summary: '',
  };
  const view = await renderReview(incompleteSession);

  await act(async () => {
    view.container.querySelector('[data-testid="review-schedule-newbie"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(api.updateSession).toHaveBeenCalledWith(expect.objectContaining({
    final_status: 'Incomplete',
    fail_summary: 'N/A',
    newbie_shift_prompt: expect.objectContaining({
      trigger: 'review_backup_action',
      status: 'accepted',
    }),
  }));
  expect(view.onNavigate).toHaveBeenCalledWith('newbieshift');

  await view.unmount();

  const scheduledView = await renderReview({
    ...incompleteSession,
    newbie_shift_data: { newbie_date: '06/23/2026', newbie_time: '10:00 AM', newbie_tz: 'ET' },
  });

  expect(scheduledView.container.querySelector('[data-testid="review-newbie-already-scheduled"]').textContent).toContain('Newbie Shift Already Scheduled');
  expect(scheduledView.container.querySelector('[data-testid="review-next-actions"]').textContent).toContain('A Newbie Shift has already been scheduled for this candidate.');
  expect(scheduledView.container.querySelector('[data-testid="review-schedule-newbie"]')).toBeNull();

  await scheduledView.unmount();
});

test('terminal certification state suppresses stale Newbie Shift details in Review', async () => {
  const view = await renderReview({
    ...passingSession,
    status: 'Pass',
    final_status: 'Pass',
    newbie_shift_request_id: 'stale-request',
    newbie_shift_request_status: 'pending',
    newbie_shift_request_created_at: '2026-07-17T12:00:00Z',
    newbie_shift_requested_by: 'tester',
    newbie_shift_request_reason: 'Old follow-up',
    newbie_shift_data: { newbie_date: '07/20/2026', newbie_time: '10:00 AM', newbie_tz: 'ET' },
  });

  expect(view.container.textContent).not.toContain('- NEWBIE SHIFT -');
  expect(view.container.textContent).not.toContain('Newbie Shift Pending');
  await view.unmount();
});

test('failed final attempt does not show Newbie Shift backup action', async () => {
  const view = await renderReview({
    ...passingSession,
    final_attempt: true,
    sup_transfer_1: { result: 'Fail', fails: { 'Did not ask permission to transfer': true } },
    sup_transfer_2: { result: 'Fail', fails: { 'Transferred to wrong queue': true } },
    coaching_summary: 'Supervisor transfer coaching.',
    fail_summary: 'Supervisor Transfer 1 and 2 failed.',
  });

  expect(view.container.querySelector('[data-testid="review-banner"]').textContent).toContain('SESSION FAILED - FINAL ATTEMPT');
  expect(view.container.querySelector('[data-testid="review-next-actions"]')).toBeNull();
  expect(view.container.querySelector('[data-testid="review-fail"]').value).toContain('Supervisor Transfer');

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
    const explanation = view.container.querySelector('[data-testid="readiness-explanation"]');
    setNativeValue(explanation, 'Evaluator observed repeated detail issues.');
    explanation.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
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
    expect.objectContaining({
      final_status: 'Fail',
      finalReadinessJudgment: expect.objectContaining({
        overrideApplied: true,
        overrideResult: 'Fail',
        primaryReason: 'Accuracy/detail concerns',
        explanation: 'Evaluator observed repeated detail issues.',
      }),
    })
  );
  expect(api.generateSummaries).toHaveBeenCalledWith(expect.objectContaining({
    final_status: 'Fail',
    finalReadinessJudgment: expect.objectContaining({
      overrideResult: 'Fail',
      primaryReason: 'Accuracy/detail concerns',
      explanation: 'Evaluator observed repeated detail issues.',
    }),
  }));

  await view.unmount();
});

test('final evaluator notes modal no longer appears before review', async () => {
  const view = await renderReview({
    ...passingSession,
    finalEvaluatorNotes: undefined,
  });

  expect(view.container.querySelector('.modal-overlay.open')).toBeNull();
  expect(view.container.textContent).toContain('Final Readiness Judgment');

  await view.unmount();
});

test('history session with legacy final notes still loads read-only review', async () => {
  const historyRecord = {
    ...passingSession,
    finalEvaluatorNotes: {
      notes: 'Legacy note saved before modal removal.',
      completed: true,
    },
  };
  const view = await renderReview(passingSession, { historyRecord });

  expect(view.container.textContent).toContain('Final Readiness Judgment');
  expect(view.container.textContent).toContain('Legacy note saved before modal removal.');

  await view.unmount();
});

test('review does not render legacy automatic VPN provider results', async () => {
  const view = await renderReview({
    ...passingSession,
    candidate_ip_intelligence: {
      ok: true,
      ip: '8.8.8.8',
      timestamp: '2026-06-27T12:00:00Z',
      lastSeen: '2026-06-26T12:00:00Z',
      verdict: 'REVIEW',
      level: 'yellow',
      summary: 'One provider detected historical proxy activity, but the connection appears residential.',
      trainerNotes: 'Candidate said they turned off their VPN.',
      providerResults: [
        { provider: 'IP2Location / IP2Proxy', status: 'ok', capability: 'vpn_proxy_detector', vpnProxy: 'Yes', lastSeen: '2026-06-26T12:00:00Z' },
      ],
    },
  });

  expect(view.container.textContent).not.toContain('VPN / Proxy Check');
  expect(view.container.textContent).not.toContain('IP2Location / IP2Proxy');
  expect(view.container.textContent).not.toContain('Candidate said they turned off their VPN.');
  expect(view.container.querySelector('[data-testid="candidate-ip-trainer-notes"]')).toBeNull();

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
