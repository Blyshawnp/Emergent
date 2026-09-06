const fs = require('fs');
const path = require('path');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const PendingRequestAlert = require('./components/PendingRequestAlert').default;
const {
  buildCandidateInformationChanges,
  applyCandidateInformationUpdate,
  applyPendingRequestDecision,
  candidateCertificationMeta,
  getCandidateUpdateErrorMessage,
  getHeadsetReviewDisplayTitle,
  getPendingRequestSchedules,
  getVisiblePendingRequests,
} = require('./NotificationManagerApp');

test('candidate status keeps failed final attempt authoritative over passed mock calls', () => {
  const meta = candidateCertificationMeta({
    status: 'Pass',
    final_attempt: true,
    call_1_result: 'Pass',
    call_2_result: 'Pass',
    sup_transfer_1_result: 'Fail',
    sup_transfer_2_result: 'Fail',
  });
  expect(meta.label).toBe('Fail – Final Attempt');
  expect(meta.tone).toBe('denied');
});

test('authorized admin status override has highest display precedence', () => {
  const meta = candidateCertificationMeta({
    status: 'FAIL-Final Attempt',
    final_attempt: true,
    readiness_override_applied: true,
    readiness_override_result: 'Pass',
    sup_transfer_1_result: 'Fail',
    sup_transfer_2_result: 'Fail',
  });
  expect(meta.label).toBe('Pass');
});

test('pending Newbie Shift approval keeps the optional shift number as text', () => {
  const data = {
    requests: [{ request_id: 'request-1', category: 'newbie_reschedule', raw_status: 'pending' }],
    counts: { reschedules: 1, workflowRequests: 1, actionableTotal: 1, unresolved: 1 },
  };
  const updated = applyPendingRequestDecision(data, {
    request_id: 'request-1', category: 'newbie_reschedule', decision: 'approved',
    newbie_shift_number: '001842', actor: 'Admin',
  }, { decision_at: '2026-07-30T12:00:00Z' });
  expect(updated.requests[0].newbie_shift_number).toBe('001842');
  expect(updated.requests[0].raw_status).toBe('approved');
});
const {
  MAX_PENDING_REQUEST_SUPPRESSIONS,
  PENDING_REQUEST_SUPPRESSION_MS,
  PENDING_REQUEST_SUPPRESSION_STORAGE_KEY,
  getUnresolvedPendingRequests,
  loadPendingRequestSuppressions,
  normalizePendingRequestSuppressions,
  savePendingRequestSuppressions,
  selectPendingRequestAlert,
  suppressPendingRequest,
} = require('./utils/notificationManager');

global.IS_REACT_ACT_ENVIRONMENT = true;

const appSource = fs.readFileSync(path.join(__dirname, 'NotificationManagerApp.jsx'), 'utf8');
const pendingRequestAlertSource = fs.readFileSync(path.join(__dirname, 'components', 'PendingRequestAlert.jsx'), 'utf8');
const mtsAppSource = fs.readFileSync(path.join(__dirname, 'App.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const appCss = fs.readFileSync(path.join(__dirname, 'notification-manager.css'), 'utf8');
const samPolishCss = fs.readFileSync(path.join(__dirname, 'polish-sam.css'), 'utf8');
const soundSource = fs.readFileSync(path.join(__dirname, 'utils', 'sound.js'), 'utf8');
const basicsSource = fs.readFileSync(path.join(__dirname, 'pages', 'BasicsPage.jsx'), 'utf8');
const electronMain = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'src', 'main.js'), 'utf8');

test('Pending Requests and Resolved Requests remain separate across category filters', () => {
  const rows = [
    { request_id: 'pending-delete', category: 'candidate_deletion', raw_status: 'pending', created_at: '2026-07-20' },
    { request_id: 'approved-delete', category: 'candidate_deletion', raw_status: 'approved', admin_decision_at: '2026-07-22' },
    { request_id: 'denied-correction', category: 'candidate_correction', raw_status: 'denied', admin_decision_at: '2026-07-23' },
  ];
  expect(getVisiblePendingRequests(rows, 'pending').map((row) => row.request_id)).toEqual(['pending-delete']);
  expect(getVisiblePendingRequests(rows, 'deletions').map((row) => row.request_id)).toEqual(['pending-delete']);
  expect(getVisiblePendingRequests(rows, 'resolved').map((row) => row.request_id)).toEqual(['denied-correction', 'approved-delete']);
});

test('SAM status banner is dismissible and success/info banners auto-dismiss on configured duration', () => {
  expect(appSource).toContain('aria-label="Dismiss status message"');
  expect(appSource).toContain('statusBannerDurationSeconds');
  expect(appSource).toContain('window.setTimeout');
  expect(appSource).toContain('DEFAULT_SAM_SETTINGS');
  expect(appCss).toContain('.nm-status-dismiss');
});

test('SAM candidate archive and archived search controls are wired without using delete', () => {
  expect(appSource).toContain("action: 'archive_candidate'");
  expect(appSource).toContain('Include archived candidates');
  expect(appSource).toContain('isCandidateArchived');
  expect(appSource).toContain('nm-archive-badge');
  expect(appSource).toContain('Archived Candidates');
});

test('SAM candidate tracking exposes accessible sortable headers and sort menu', () => {
  expect(appSource).toContain('CANDIDATE_SORT_OPTIONS');
  expect(appSource).toContain('aria-sort={ariaSort}');
  expect(appSource).toContain("renderSortableHeader('candidate', 'Candidate')");
  expect(appSource).toContain("renderSortableHeader('attempts', 'Attempts')");
  expect(appSource).toContain("renderSortableHeader('date', 'Date')");
  expect(appSource).toContain('Date newest first');
  expect(appSource).toContain('Attempts high to low');
  expect(samPolishCss).toContain('.nm-sort-header');
});

test('SAM candidate tracking uses workflow-specific status labels and a bounded responsive card layout', () => {
  expect(appSource).toContain("workflowApprovalMeta(isReschedule ? 'Newbie Shift Reschedule' : 'Newbie Shift', status)");
  expect(appSource).toContain("workflowApprovalMeta('Supervisor Transfer', 'pending')");
  expect(appSource).toContain("workflowApprovalMeta('Candidate Deletion', row.deletion_request_status)");
  expect(appSource).toContain("label: 'Form Filled'");
  expect(appSource).toContain("label: 'Form Submitted'");
  expect(appSource).toContain("label: 'Form Not Submitted'");
  expect(appSource).toContain("label: 'Resumed – Pass'");
  expect(appSource).toContain("label: 'Fail – Final Attempt'");
  expect(appSource).toContain('candidateCertificationMeta(row)');
  expect(samPolishCss).toContain('@media (max-width: 1320px)');
  expect(samPolishCss).toContain('content: attr(data-label)');
  expect(samPolishCss).toContain('overflow-x: hidden');
});

test('SAM shared snapshot sanitizes feature errors and deduplicates refreshes', () => {
  expect(appSource).toContain('SAM_CANDIDATE_TRACKING_TEMPORARY_MESSAGE');
  expect(appSource).toContain('Candidate Tracking is temporarily unavailable. SAM will retry automatically.');
  expect(appSource).toContain('createSamSnapshotCoordinator');
  expect(appSource).toContain('samSnapshotCoordinatorRef.current.load');
  expect(appSource).toContain('api.getSharedAdminSnapshot');
  expect(appSource).not.toContain('candidateTrackingRequestRef');
  expect(appSource).not.toContain('candidateTrackingCacheRef');
  expect(appSource).not.toContain('const requiredSetup = Object.entries(setup)');
  expect(appSource).not.toContain('<pre>{requiredSetup}</pre>');
  expect(appSource).not.toContain('HTTP 429\\nRATE_LIMIT_EXCEEDED');
  expect(appSource).not.toContain('[object Object]');
});

test('SAM pending request inbox, bell, and denial safeguards are wired', () => {
  expect(appSource).toContain('SAM_PENDING_REQUESTS_TEMPORARY_MESSAGE');
  expect(appSource).not.toContain('pendingRequestsRequestRef');
  expect(appSource).toContain('getSharedAdminSnapshot');
  expect(appSource).toContain('updateSharedAdminPendingRequest');
  expect(appSource).toContain('Pending Requests');
  expect(appSource).toContain('aria-label={`Pending request summary: ${combinedActionableCount} unresolved actionable items`}');
  expect(appSource).toContain("{ key: 'newbie', label: 'Newbie Shifts' }");
  expect(appSource).toContain("{ key: 'reschedules', label: 'Reschedules' }");
  expect(appSource).toContain("{ key: 'deletions', label: 'Candidate Deletions' }");
  expect(appSource).toContain('Headset Reviews');
  expect(appSource).toContain('<strong>Request Submitted</strong>');
  expect(appSource).toContain('<strong>Lead Time Category</strong>');
  expect(appSource).toContain('<strong>Counts as Candidate Attempt</strong>');
  expect(appSource).toContain('<strong>Current Attempt</strong>');
  expect(appSource).toContain('<strong>Resulting Attempt</strong>');
  expect(appSource).toContain('<strong>Final Attempt</strong>');
  expect(appSource).toContain('A denial reason is required.');
  expect(pendingRequestAlertSource).toContain('Remind Me in 30 Minutes');
  expect(appSource).toContain('PendingRequestAlert');
  expect(appSource).toContain('pendingRequestsRefreshCycle');
  expect(appSource).not.toContain('pendingRequestsCacheRef');
  expect(appSource).toContain('Session History and Candidate Tracking');
  expect(samPolishCss).toContain('.nm-request-bell-badge');
  expect(samPolishCss).toContain('.nm-request-status.is-approved');
  expect(samPolishCss).toContain('.nm-request-status.is-denied');
});

test('SAM candidate deletion cards use labelled fields and suppress raw serialized metadata', () => {
  expect(appSource).toContain('<strong>Deletion Reason</strong>');
  expect(appSource).toContain('<strong>Certification Result</strong>');
  expect(appSource).toContain('<strong>Deletion Scope</strong>');
  expect(appSource).toContain("request.category === 'candidate_deletion' ?");
  expect(appSource).toContain("request.category === 'candidate_deletion' ? <>");
  expect(appSource).not.toContain("status=${request.session_status}; final_attempt=${request.final_attempt}");
});

test('SAM decisions prevent duplicate submissions, retain failed denial context, and omit admin-targeting copy', () => {
  expect(appSource).toContain('submittingRequestId');
  expect(appSource).toContain('pendingDecisionKey');
  expect(appSource).toContain('setDecisionError');
  expect(appSource).toContain('setDenialRequest(null)');
  expect(appSource).not.toContain('<strong>Admin targeting</strong>');
  expect(appSource).not.toContain('Required Admin Targeting');
});

test('SAM decision success updates only the exact request before background refresh', () => {
  const current = {
    requests: [
      { request_id: 'request-1', category: 'candidate_correction', raw_status: 'pending' },
      { request_id: 'request-2', category: 'candidate_correction', raw_status: 'pending' },
    ],
    counts: { candidateCorrections: 2, workflowRequests: 2, actionableTotal: 2, unresolved: 2 },
  };
  const next = applyPendingRequestDecision(current, {
    request_id: 'request-1', category: 'candidate_correction', decision: 'approved', actor: 'Synthetic Admin',
  }, { decision_at: '2026-07-28T00:00:00Z' });
  expect(next.requests[0]).toEqual(expect.objectContaining({ request_id: 'request-1', raw_status: 'approved' }));
  expect(next.requests[1]).toBe(current.requests[1]);
  expect(next.counts).toEqual(expect.objectContaining({ candidateCorrections: 1, workflowRequests: 1 }));
  expect(appSource).toContain('void loadSamSnapshot({ silent: true, force: true })');
  expect(appSource).not.toContain('await loadSamSnapshot({ silent: true, force: true });\n      return result;');
});

test('SAM direct edit targets stable session identity and preserves certification fields', () => {
  const first = { session_id: 'session-1', candidate_name: 'Same Name', headset_brand: 'Old', status: 'PASS', attempt_count: 2 };
  const second = { session_id: 'session-2', candidate_name: 'Same Name', headset_brand: 'Other', status: 'FAIL', attempt_count: 3 };
  const next = applyCandidateInformationUpdate({ candidates: [first, second], views: { allActive: [first, second] } }, {
    action: 'edit_candidate_information', session_id: 'session-1',
    changes: [
      { field: 'candidate_name', requested_value: 'Same Name Updated' },
      { field: 'headset_model', requested_value: 'New Headset' },
    ],
  });
  expect(next.candidates[0]).toEqual(expect.objectContaining({ candidate_name: 'Same Name Updated', headset_brand: 'New Headset', status: 'PASS', attempt_count: 2 }));
  expect(next.candidates[1]).toBe(second);
  expect(next.views.allActive[0].candidate_name).toBe('Same Name Updated');
  expect(next.views.allActive[1]).toBe(second);
  expect(appSource).toContain('void loadCandidateTracking({ silent: true, force: true })');
});

test('SAM applies separate headset brand and model corrections without duplicating the display brand', () => {
  const current = { session_id: 'session-1', candidate_name: 'Synthetic', headset_brand: 'Logitech', headset_model: 'H390', status: 'PASS', attempt_count: 2 };
  const brandOnly = applyCandidateInformationUpdate({ candidates: [current] }, {
    session_id: 'session-1', changes: [{ field: 'headset_brand', requested_value: 'LOGITECH' }],
  });
  expect(brandOnly.candidates[0]).toEqual(expect.objectContaining({
    headset_brand: 'LOGITECH', headset_model: 'H390', headset_label: 'LOGITECH H390', status: 'PASS', attempt_count: 2,
  }));
  const modelOnly = applyCandidateInformationUpdate({ candidates: [current] }, {
    session_id: 'session-1', changes: [{ field: 'headset_model', requested_value: 'Logitech H390 USB' }],
  });
  expect(modelOnly.candidates[0].headset_label).toBe('Logitech H390 USB');
  expect(buildCandidateInformationChanges(
    { candidate_name: 'Synthetic', headset_brand: 'Logitech', headset_model: 'H390' },
    { candidate_name: 'Synthetic', headset_brand: 'Logitech', headset_model: 'H390 USB' },
  )).toEqual([expect.objectContaining({ field: 'headset_model', requested_value: 'H390 USB' })]);
});

test('SAM transient shared-data errors use calm retry language without exposing transport details', () => {
  expect(appSource).toContain('Shared data is taking longer than usual. SAM will keep trying.');
  expect(appSource).toContain('SAM is offline and showing the last successful shared data. SAM will keep trying.');
  expect(appSource).not.toContain('Shared data request timed out. Check the Apps Script deployment');
  expect(appSource).not.toContain("console.warn('[SAM] Shared snapshot request failed; user-facing details were sanitized.', error)");
  expect(appSource).not.toContain("if (!silent && snapshot?.ok === false)");
});

test('MTS approved-headset lookup supports targeted manual and background refresh without resetting the page', () => {
  expect(basicsSource).toContain('const loadApprovedHeadsets = useCallback');
  expect(basicsSource).toContain('api.getApprovedHeadsets(force)');
  expect(basicsSource).toContain('loadApprovedHeadsets({ force: true, silent: true })');
  expect(basicsSource).toContain('}, 60000)');
  expect(basicsSource).toContain('Refresh approved list');
});

test('SAM headset review cards use headset labels and stable review IDs', () => {
  expect(getHeadsetReviewDisplayTitle({
    brand: 'Acme',
    model: 'NC-100',
    created_at: '2026-07-15T12:00:00.000Z',
    updated_at: '2026-07-15T12:05:00.000Z',
  })).toBe('Acme NC-100');
  expect(getHeadsetReviewDisplayTitle({
    brand: '2026-07-15T12:00:00.000Z',
    model: '2026-07-15T12:05:00.000Z',
    candidate: '2026-07-15T12:10:00.000Z',
  })).toBe('Unknown headset');
  expect(getHeadsetReviewDisplayTitle({
    requested_headset_label: 'Candidate entered headset',
  })).toBe('Candidate entered headset');
  expect(appSource).toContain("review_id: item.review_id || ''");
  expect(appSource).toContain('api.updateHeadsetReview({');
  expect(appSource).toContain('...payload,');
  expect(appSource).toContain("actor: samSetupStatus.userName || samSetupStatus.userRole || 'SAM'");
});

test('SAM reschedule cards keep the previous schedule separate from the requested schedule', () => {
  expect(getPendingRequestSchedules({
    original_scheduled_at: '2026-07-20T10:00:00-05:00',
    requested_scheduled_at: '2026-07-22T11:30:00-05:00',
  })).toEqual({
    original: '2026-07-20T10:00:00-05:00',
    requested: '2026-07-22T11:30:00-05:00',
  });
  expect(appSource).toContain('<strong>Previous Schedule</strong>');
});

describe('SAM pending request reminder lifecycle', () => {
  let container;
  let root;

  const request = (requestId, createdAt, overrides = {}) => ({
    request_id: requestId,
    category: 'newbie_reschedule',
    categoryLabel: `Request ${requestId}`,
    raw_status: 'pending',
    created_at: createdAt,
    ...overrides,
  });

  const renderAlert = (props) => {
    if (!container) {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
    act(() => {
      root.render(React.createElement(PendingRequestAlert, props));
    });
  };

  const clickButton = (label) => {
    const button = Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent.trim() === label);
    expect(button).toBeTruthy();
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  const unmountAlert = () => {
    if (root) {
      act(() => root.unmount());
    }
    container?.remove();
    root = null;
    container = null;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
    localStorage.clear();
  });

  afterEach(() => {
    unmountAlert();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('Remind Me stores a 30-minute expiry, survives remount, and becomes eligible at expiry', () => {
    const requests = [request('request-1', '2026-07-15T11:00:00.000Z')];
    renderAlert({ requests, refreshCycle: 1 });
    clickButton('Remind Me in 30 Minutes');

    const stored = JSON.parse(localStorage.getItem(PENDING_REQUEST_SUPPRESSION_STORAGE_KEY));
    expect(stored).toEqual([{
      request_id: 'request-1',
      suppression_type: 'remind',
      expires_at: Date.now() + PENDING_REQUEST_SUPPRESSION_MS,
    }]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    unmountAlert();
    renderAlert({ requests, refreshCycle: 1 });
    expect(loadPendingRequestSuppressions(localStorage)).toEqual(stored);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    act(() => jest.advanceTimersByTime(PENDING_REQUEST_SUPPRESSION_MS - 1));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    act(() => jest.advanceTimersByTime(1));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(localStorage.getItem(PENDING_REQUEST_SUPPRESSION_STORAGE_KEY)).toBeNull();
  });

  test('startup placeholder data cannot prune a valid persisted reminder before live requests load', () => {
    const requests = [request('request-1', '2026-07-15T11:00:00.000Z')];
    savePendingRequestSuppressions(localStorage, suppressPendingRequest([], 'request-1', 'remind'));

    renderAlert({ requests: [], requestsAvailable: false, refreshCycle: 0 });
    expect(localStorage.getItem(PENDING_REQUEST_SUPPRESSION_STORAGE_KEY)).not.toBeNull();

    renderAlert({ requests, requestsAvailable: true, refreshCycle: 1 });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(localStorage.getItem(PENDING_REQUEST_SUPPRESSION_STORAGE_KEY)).not.toBeNull();
  });

  test('Dismiss suppresses only the alert while preserving unresolved count and inbox data', () => {
    const requests = [request('request-1', '2026-07-15T11:00:00.000Z')];
    const onView = jest.fn();
    renderAlert({ requests, refreshCycle: 1, onView });
    clickButton('Dismiss');

    expect(getUnresolvedPendingRequests(requests)).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(onView).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(PENDING_REQUEST_SUPPRESSION_STORAGE_KEY))[0].suppression_type).toBe('dismiss');
    expect(appSource).toContain('const pendingWorkflowRequestCount = Number(');
    expect(appSource).toContain('const combinedActionableCount = pendingWorkflowRequestCount + pendingHeadsetCount;');
    expect(appSource).toContain('data-testid="sam-pending-requests"');
  });

  test('multiple startup requests produce one summarized alert and one navigation action', () => {
    const requests = [
      request('newer', '2026-07-15T11:30:00.000Z'),
      request('oldest', '2026-07-15T10:30:00.000Z'),
    ];
    const onView = jest.fn();
    renderAlert({ requests, refreshCycle: 1, onView });

    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    clickButton('View');
    expect(onView.mock.calls[0][0].request_id).toBe('oldest');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test('startup with zero requests stays quiet while one request produces one alert and sound', () => {
    const onAlertSound = jest.fn();
    renderAlert({ requests: [], requestsAvailable: true, refreshCycle: 1, onAlertSound });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(onAlertSound).not.toHaveBeenCalled();

    renderAlert({ requests: [request('request-1', '2026-07-15T11:00:00.000Z')], requestsAvailable: true, refreshCycle: 2, onAlertSound });
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.textContent).toContain('1 request needs review.');
    expect(onAlertSound).toHaveBeenCalledTimes(1);
  });

  test('approval or denial removes stored suppression state and resolved requests never re-alert', () => {
    const pending = request('request-1', '2026-07-15T11:00:00.000Z');
    renderAlert({ requests: [pending], refreshCycle: 1 });
    clickButton('Dismiss');
    expect(localStorage.getItem(PENDING_REQUEST_SUPPRESSION_STORAGE_KEY)).not.toBeNull();

    const approved = { ...pending, raw_status: 'approved', status: 'Approved' };
    renderAlert({ requests: [approved], refreshCycle: 2 });
    expect(localStorage.getItem(PENDING_REQUEST_SUPPRESSION_STORAGE_KEY)).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(selectPendingRequestAlert([approved], [], [])).toBeNull();

    const denied = { ...pending, raw_status: 'denied', status: 'Denied' };
    renderAlert({ requests: [denied], refreshCycle: 3 });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test('expired, invalid, corrupt, missing, and oversized storage entries are cleaned safely', () => {
    localStorage.setItem(PENDING_REQUEST_SUPPRESSION_STORAGE_KEY, '{corrupt-json');
    expect(loadPendingRequestSuppressions(localStorage)).toEqual([]);
    expect(localStorage.getItem(PENDING_REQUEST_SUPPRESSION_STORAGE_KEY)).toBeNull();

    const oversized = Array.from({ length: MAX_PENDING_REQUEST_SUPPRESSIONS + 30 }, (_, index) => ({
      request_id: `request-${index}`,
      suppression_type: index % 2 ? 'dismiss' : 'remind',
      expires_at: Date.now() + 1000 + index,
    }));
    const normalized = normalizePendingRequestSuppressions([
      null,
      { request_id: 'expired', suppression_type: 'dismiss', expires_at: Date.now() },
      { request_id: 'invalid-time', suppression_type: 'remind', expires_at: 'not-a-time' },
      { request_id: 'invalid-type', suppression_type: 'forever', expires_at: Date.now() + 1000 },
      ...oversized,
    ]);
    expect(normalized).toHaveLength(MAX_PENDING_REQUEST_SUPPRESSIONS);

    savePendingRequestSuppressions(localStorage, suppressPendingRequest([], 'missing-request', 'dismiss'));
    renderAlert({ requests: [], refreshCycle: 1 });
    expect(localStorage.getItem(PENDING_REQUEST_SUPPRESSION_STORAGE_KEY)).toBeNull();
  });

  test('one bounded expiry timer and one Escape listener are registered without duplication', () => {
    const requests = [request('request-1', '2026-07-15T11:00:00.000Z')];
    savePendingRequestSuppressions(localStorage, suppressPendingRequest([], 'request-1', 'remind'));
    renderAlert({ requests, refreshCycle: 1 });
    expect(jest.getTimerCount()).toBe(1);
    renderAlert({ requests, refreshCycle: 1 });
    expect(jest.getTimerCount()).toBe(1);
    unmountAlert();
    expect(jest.getTimerCount()).toBe(0);

    localStorage.clear();
    const addListener = jest.spyOn(document, 'addEventListener');
    const removeListener = jest.spyOn(document, 'removeEventListener');
    renderAlert({ requests, refreshCycle: 1 });
    renderAlert({ requests, refreshCycle: 1 });
    expect(addListener.mock.calls.filter(([eventName]) => eventName === 'keydown')).toHaveLength(1);
    unmountAlert();
    expect(removeListener.mock.calls.filter(([eventName]) => eventName === 'keydown')).toHaveLength(1);
  });

  test('Escape closes the immediate alert and the same IDs do not replay on refresh', () => {
    const requests = [request('request-1', '2026-07-15T11:00:00.000Z')];
    renderAlert({ requests, refreshCycle: 1 });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(getUnresolvedPendingRequests(requests)).toHaveLength(1);
    expect(localStorage.getItem(PENDING_REQUEST_SUPPRESSION_STORAGE_KEY)).toBeNull();

    renderAlert({ requests, refreshCycle: 2 });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test('reconnect with the same IDs stays quiet while one genuinely new ID alerts once', () => {
    const onAlertSound = jest.fn();
    const existing = request('existing', '2026-07-15T11:00:00.000Z');
    renderAlert({ requests: [existing], requestsAvailable: true, refreshCycle: 1, onAlertSound });
    expect(onAlertSound).toHaveBeenCalledTimes(1);
    clickButton('Dismiss');

    renderAlert({ requests: [], requestsAvailable: false, refreshCycle: 1, onAlertSound });
    renderAlert({ requests: [existing], requestsAvailable: true, refreshCycle: 2, onAlertSound });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(onAlertSound).toHaveBeenCalledTimes(1);

    const newcomer = request('newcomer', '2026-07-15T11:30:00.000Z');
    renderAlert({ requests: [existing, newcomer], requestsAvailable: true, refreshCycle: 3, onAlertSound });
    expect(container.textContent).toContain('1 request needs review.');
    expect(onAlertSound).toHaveBeenCalledTimes(2);
  });

  test('SAM uses one shared 60-second snapshot coordinator', () => {
    expect(appSource).toContain('const SAM_AUTO_REFRESH_INTERVAL_MS = 60000;');
    expect(appSource).toContain('createSamSnapshotCoordinator');
    expect(appSource).toContain('api.getSharedAdminSnapshot');
    expect(appSource).not.toContain('SAM_PENDING_REQUESTS_CACHE_MS');
    expect(appSource).toContain('}, SAM_AUTO_REFRESH_INTERVAL_MS);');
  });
});

test('SAM operations layout uses pending requests instead of duplicate candidate tracking metric card', () => {
  expect(appSource).toContain('<div className="nm-metric-label">Pending Requests</div>');
  expect(appSource).not.toContain('<div className="nm-metric-label">Candidate Tracking</div>');
  expect(appSource).toContain('<Plus size={16} aria-hidden="true" /> Add Notification');
});

test('SAM candidate actions use compact row menus with View Details first', () => {
  const actionsStart = appSource.indexOf('const renderCandidateActions = (row, rowKey)');
  const actionsBlock = appSource.slice(actionsStart, appSource.indexOf('const renderCandidateDetails', actionsStart));
  expect(actionsBlock.indexOf('View Details')).toBeGreaterThan(-1);
  expect(actionsBlock.indexOf('View Details')).toBeLessThan(actionsBlock.indexOf('Update Status'));
  expect(actionsBlock).toContain('More Actions');
  expect(actionsBlock).toContain('role="menu"');
  expect(actionsBlock).toContain("role=\"menuitem\"");
  expect(samPolishCss).toContain('.nm-action-menu');
  expect(appSource).toContain('nm-action-menu nm-action-menu-portal');
  expect(appSource).toContain('<ModalPortal>');
  expect(samPolishCss).not.toMatch(/\.nm-action-menu\s*\{[^}]*position:\s*static/s);
  expect(samPolishCss).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
  expect(samPolishCss).toContain('grid-template-columns: minmax(0, 1fr)');
  expect(samPolishCss).toContain('.nm-candidate-table .nm-row-actions .nm-view-details-btn');
});

test('SAM candidate information edits require an audit reason', () => {
  expect(appSource).toContain("error: 'Enter a reason for this correction.'");
  expect(appSource).toContain('className="nm-correction-reason-input"');
  expect(appSource).toContain('placeholder="Explain why this correction is needed, such as a misspelled candidate name or headset model."');
  expect(appSource).not.toContain('Optional correction reason');
});

test('SAM candidate edits submit only bounded changed fields and preserve capitalization corrections', () => {
  const current = { candidate_name: 'taylor example', headset_model: 'Jabra Evolve 40' };
  expect(buildCandidateInformationChanges(current, {
    candidate_name: 'Taylor Example',
    headset_model: 'Jabra Evolve 40',
  })).toEqual([expect.objectContaining({
    field: 'candidate_name',
    field_key: 'candidate_name',
    previous_value: 'taylor example',
    requested_value: 'Taylor Example',
  })]);
  expect(buildCandidateInformationChanges(current, {
    candidate_name: ' taylor example ',
    headset_model: ' Jabra Evolve 40 ',
  })).toEqual([]);
});

test('SAM candidate update errors map stable backend codes to actionable messages', () => {
  expect(getCandidateUpdateErrorMessage({ error_code: 'candidate_update_target_not_found' }))
    .toMatch(/candidate session/i);
  expect(getCandidateUpdateErrorMessage({ error_code: 'candidate_update_audit_failed', candidate_updated: true }))
    .toMatch(/audit record/i);
});

test('SAM notification IDs are generated once for new and duplicated drafts', () => {
  expect(appSource).toContain('createNotificationId');
  const addStart = appSource.indexOf('const handleAdd = () =>');
  const addBlock = appSource.slice(addStart, appSource.indexOf('const handleDuplicate', addStart));
  expect(addBlock).toContain('ID: createNotificationId()');

  const duplicateStart = appSource.indexOf('const handleDuplicate = (index = selectedIndex)');
  const duplicateBlock = appSource.slice(duplicateStart, appSource.indexOf('const handleDeleteIndex', duplicateStart));
  expect(duplicateBlock).toContain('ID: createNotificationId()');
  expect(duplicateBlock).not.toContain("ID: ''");
  expect(appSource).toContain('if (sheetState.isSaving) return;');
  expect(appSource).not.toContain('<label htmlFor="nm-id">Notification ID</label>');
  expect(appSource).not.toContain('Current ID');
  expect(appSource).not.toContain('Sheet ID');
});

test('SAM notification header has one help control and one destructive exit control', () => {
  expect(appSource).toContain('className="nm-btn nm-ops-exit"');
  expect(samPolishCss).toContain('.nm-ops-exit');
  expect(samPolishCss).toContain('background: #7f1d1d');
  expect((appSource.match(/aria-label="Help"/g) || [])).toHaveLength(1);
  expect((appSource.match(/aria-label="Exit Smart Alert Manager"/g) || [])).toHaveLength(1);
  expect(appSource).not.toContain('<span className="nm-ops-quick-label">Selection</span>');
});

test('SAM notification rows keep edit and duplicate actions at row level', () => {
  const notificationsStart = appSource.indexOf('id="sam-notifications"');
  const cardActionsStart = appSource.indexOf('<div className="nm-note-card-actions">', notificationsStart);
  const cardActionsBlock = appSource.slice(cardActionsStart, appSource.indexOf('</div>', cardActionsStart));
  expect(cardActionsBlock).toContain('openEditor(index)');
  expect(cardActionsBlock).toContain('handleDuplicate(index)');
  expect(cardActionsBlock).toContain('handleToggleEnabled(index)');
  expect(cardActionsBlock).toContain('handleDeleteIndex(index)');
});

test('SAM operations cards and tabs have compact identity states', () => {
  expect(appSource).toContain('Sync Status');
  expect(appSource).toContain('Add Notification</div>');
  expect(appSource).toContain('Pending Requests</div>');
  expect(appSource).toContain('<span className="nm-ops-quick-label">Data</span>');
  expect(appSource).toContain('<span className="nm-ops-quick-label">Workflow</span>');
  expect(appSource).toContain('<span className="nm-ops-quick-label">System</span>');
  expect(appSource).toContain('<Plus size={15} aria-hidden="true" /> Add Notification');
  expect(appSource).toContain('<Inbox size={15} aria-hidden="true" /> Pending Requests');
  expect(samPolishCss).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
  expect(samPolishCss).toContain('width: 246px');
  expect(appSource).toContain("tone: 'notifications'");
  expect(appSource).toContain("tone: 'pending'");
  expect(appSource).toContain("is-${item.tone || 'default'}");
  expect(samPolishCss).toContain('.nm-ops-tab.is-notifications');
  expect(samPolishCss).toContain('.nm-ops-tab.is-preview');
  expect(samPolishCss).toContain('.nm-ops-tab.is-headsets');
  expect(samPolishCss).toContain('.nm-ops-tab.is-candidates');
  expect(samPolishCss).toContain('.nm-ops-tab.is-pending');
});

test('SAM candidate table truncates long text accessibly', () => {
  expect(appSource).toContain('title={row.candidate_name ||');
  expect(appSource).toContain('title={results}');
  expect(appSource).toContain('title={notes}');
  expect(appSource).toContain('tabIndex={0}');
  expect(samPolishCss).toContain('-webkit-line-clamp: 2');
  expect(samPolishCss).toContain('overflow: visible;');
});

test('SAM candidate row preview expansion is distinct from View Details', () => {
  expect(appSource).toContain('expandedRowPreviews');
  expect(appSource).toContain('toggleRowPreview');
  expect(appSource).toContain('Show More');
  expect(appSource).toContain('Show Less');
  expect(appSource).toContain('is-preview-expanded');
  expect(appSource).toContain('nm-results-preview');
  expect(appSource).toContain('nm-row-preview-toggle');

  const previewToggleStart = appSource.indexOf('className="nm-row-preview-toggle"');
  const previewToggleBlock = appSource.slice(previewToggleStart, appSource.indexOf('</button>', previewToggleStart));
  expect(previewToggleBlock).toContain('toggleRowPreview(rowKey)');
  expect(previewToggleBlock).not.toContain('setDetailKey');

  const viewDetailsStart = appSource.indexOf('nm-view-details-btn');
  const viewDetailsBlock = appSource.slice(viewDetailsStart, appSource.indexOf('</button>', viewDetailsStart));
  expect(viewDetailsBlock).toContain('setDetailKey(rowKey)');
  expect(viewDetailsBlock).not.toContain('toggleRowPreview');

  expect(samPolishCss).toContain('.nm-candidate-table tr.is-preview-expanded .nm-results-preview');
  expect(samPolishCss).toContain('.nm-row-preview-toggle');
});

test('SAM status modals keep close control and actions centered', () => {
  expect(appCss).toContain('.nm-status-modal > .nm-help-header');
  expect(appCss).toContain('.nm-status-modal > .nm-help-actions');
  expect(appCss).toContain('.nm-modal-close::after');
  expect(appCss).toContain('font-size: 0');
  expect(appCss).toContain('box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.24)');
});

test('SAM settings and help include real controls and streamlined sections', () => {
  expect(appSource).toContain('SAM_SETTINGS_KEY');
  expect(appSource).toContain('SAM sounds');
  expect(appSource).toContain('Success banner duration');
  expect(appSource).toContain('Default candidate filter');
  expect(appSource).toContain('SAM_HELP_SECTIONS');
  expect(appSource).toContain('Check for Updates');
});

test('SAM success and error sound assets are used through the shared sound utility', () => {
  expect(soundSource).toContain("samSuccess: 'success-sam.mp3'");
  expect(soundSource).toContain("samError: 'error-sam.mp3'");
  expect(appSource).toContain("playSound(kind === 'error' ? 'samError' : 'samSuccess')");
});

test('SAM headset startup notice is a non-modal status update', () => {
  expect(appSource).toContain('Headset review queue updated.');
  expect(appSource).toContain('showPendingNotice: true');
  expect(appSource).not.toContain('New headsets are ready to review.');
  expect(appSource).not.toContain('setHeadsetReviewNoticeOpen');
});

test('Approved Headsets uses stable identities and geometry-safe hover styles', () => {
  expect(appSource).toContain('key={headsetRowIdentity(item, kind)}');
  expect(appSource).toContain('catalog_identity: item.catalog_identity');
  expect(appSource).not.toContain('key={`${kind}-${item.brand}-${item.model}-${index}`}');
  expect(samPolishCss).toContain('.nm-headset-table tbody tr:hover');
  expect(samPolishCss).toContain('transform: none;');
  expect(samPolishCss).toContain('scrollbar-gutter: stable both-edges;');
  expect(samPolishCss).toContain('overflow-x: hidden;');
  expect(samPolishCss).toContain('grid-template-columns: repeat(3, minmax(0, 1fr));');
});

test('MTS and SAM post-setup Quick Start is one-time, skippable, and replayable from Help', () => {
  expect(mtsAppSource).toContain("const MTS_QUICK_START_STATE_KEY = 'mts:quick-start:v1'");
  expect(mtsAppSource).toContain("localStorage.setItem(MTS_QUICK_START_STATE_KEY, 'pending')");
  expect(mtsAppSource).toContain('onReplayQuickStart={replayQuickStart}');
  expect(appSource).toContain("const SAM_QUICK_START_STATE_KEY = 'sam:quick-start:v1'");
  expect(appSource).toContain("localStorage.setItem(SAM_QUICK_START_STATE_KEY, 'seen')");
  expect(appSource).toContain('onReplayQuickStart={replayQuickStart}');
  expect(appSource).toContain('<PostSetupQuickStart');
});

test('Electron main locks one instance per app mode while preserving app identities', () => {
  expect(electronMain).toContain('app.requestSingleInstanceLock');
  expect(electronMain).toContain('Mock Testing Suite is already open.');
  expect(electronMain).toContain('Smart Alert Manager is already open.');
  expect(electronMain).toContain('com.acddirect.mocktestingsuite.notificationmanager');
  expect(electronMain).toContain('com.acddirect.mocktestingsuite');
  expect(electronMain).toContain('focusExistingWindow');
  expect((electronMain.match(/function ensureBackendAvailable\s*\(/g) || [])).toHaveLength(1);
});

test('SAM auto-refresh effect is declared after its callback dependencies initialize', () => {
  const loadSheetDeclaration = appSource.indexOf('const loadSheetItems = useCallback');
  const loadCandidateDeclaration = appSource.indexOf('const loadCandidateTracking = useCallback');
  const autoRefreshEffect = appSource.indexOf('}, SAM_AUTO_REFRESH_INTERVAL_MS);');

  expect(loadSheetDeclaration).toBeGreaterThan(-1);
  expect(loadCandidateDeclaration).toBeGreaterThan(-1);
  expect(autoRefreshEffect).toBeGreaterThan(loadSheetDeclaration);
  expect(autoRefreshEffect).toBeGreaterThan(loadCandidateDeclaration);
});

test('exit confirmation actions render safe action before exit action', () => {
  const samExitStart = appSource.indexOf('<h2 className="sam-exit-title">Exit Smart Alert Manager</h2>');
  const samExitBlock = appSource.slice(samExitStart, appSource.indexOf('</section>', samExitStart));
  expect(samExitBlock.indexOf('No')).toBeLessThan(samExitBlock.indexOf('Yes'));
  expect(appSource).toContain("if (event.key === 'Escape')");
  expect(appSource).toContain('resolveExitConfirm(false)');

  const mtsExitStart = mtsAppSource.indexOf("title: 'Exit App'");
  const mtsExitBlock = mtsAppSource.slice(mtsExitStart, mtsAppSource.indexOf('respondToQuitConfirmation', mtsExitStart));
  expect(mtsExitBlock.indexOf("label: 'No'")).toBeLessThan(mtsExitBlock.indexOf("label: 'Yes'"));

  expect(electronMain).toContain("sendAppEvent('app:confirm-quit'");
  expect(electronMain).toContain("ipcMain.handle('app:quit-response'");
  expect(electronMain).not.toContain("dialog.showMessageBox");
});

test('SAM error boundary keeps internal runtime errors out of user-facing copy', () => {
  expect(indexSource).toContain('console.error("[APP] Renderer crashed:"');
  expect(indexSource).toContain('{appName} could not finish loading this section. Reload {appName} to try again.');
  expect(indexSource).toContain('<AppErrorBoundary appName="SAM">');
  expect(indexSource).not.toContain('<span>{this.state.message');
});
