import { buildBasicsFromRecord, mergeBasicsIntoSession } from './sessionBasics';

export function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function hasSavedCallResult(call) {
  return Boolean(call && call.result);
}

export function hasSavedSupTransferResult(transfer) {
  return Boolean(transfer && transfer.result);
}

export function logicalResumeSourceId(entry = {}) {
  return String(entry.resume_source_history_id || entry.source_session_id || entry.history_id || entry.session_id || '').trim();
}

export function canResumeForSupTransfer(entry, testerNames) {
  const status = entry.status || entry.final_status || '';
  const requestType = String(entry.newbie_shift_request_type || entry.request_type || '').trim().toLowerCase();
  const sessionType = String(entry.session_type || entry.workflow_type || '').trim().toLowerCase();
  const storedTesterName = normalizeName(entry.tester_name);
  const matchesTester = testerNames.some((name) => storedTesterName && storedTesterName === normalizeName(name));
  const hasMockCalls = [entry.call_1, entry.call_2, entry.call_3].some(hasSavedCallResult);
  const hasPassedSupTransfer = [entry.sup_transfer_1, entry.sup_transfer_2].some((transfer) => transfer && transfer.result === 'Pass');
  const isMockCallSession = !entry.supervisor_only;
  const isResumedIncompleteSupTransfer = Boolean(entry.resumed_sup_transfer_only && entry.supervisor_only && status === 'Incomplete');
  const finalized = ['Pass', 'RESUMED-PASS', 'Fail', 'FAIL-Final Attempt', 'NC/NS'].includes(status);
  const scheduleOnly = Boolean(
    entry.schedule_only
    || entry.scheduling_only
    || requestType === 'reschedule'
    || requestType === 'newbie_shift_reschedule'
    || sessionType.includes('newbie shift')
    || sessionType.includes('schedule')
    || (entry.newbie_shift_rescheduled_at && !hasMockCalls)
  );
  const consumedContinuation = Boolean(entry.supervisor_transfer_completed || entry.sup_transfer_completed || entry.resume_consumed_at);

  return matchesTester && !scheduleOnly && !consumedContinuation
    && (isMockCallSession || isResumedIncompleteSupTransfer)
    && hasMockCalls && !hasPassedSupTransfer && !finalized;
}

export function canonicalResumableHistory(history, testerNames) {
  const eligible = (history || [])
    .filter((entry) => canResumeForSupTransfer(entry, testerNames))
    .sort((a, b) => String(b.timestamp_iso || b.timestamp || '').localeCompare(String(a.timestamp_iso || a.timestamp || '')));
  const seen = new Set();
  return eligible.filter((entry) => {
    const identity = logicalResumeSourceId(entry);
    if (!identity || seen.has(identity)) return !identity;
    seen.add(identity);
    return true;
  });
}

export function getHistoricalTechIssueFields(entry = {}) {
  const issue = String(entry.tech_issue || '').trim();
  const issueLogs = Array.isArray(entry.tech_issues_log) ? entry.tech_issues_log : [];
  const hasHistoricalIssue = Boolean(issue && !['N/A', 'No', 'None'].includes(issue)) || issueLogs.length > 0;
  return {
    historical_tech_issue: hasHistoricalIssue ? issue || 'Technical issue recorded in original session' : 'N/A',
    historical_tech_issues_log: issueLogs,
    historical_tech_issue_ended_session: Boolean(entry.tech_issue_ended_session),
    historical_tech_issue_summary_required: Boolean(entry.tech_issue_summary_required),
    historical_other_technical_issue: entry.other_technical_issue || '',
  };
}

export function buildResumedSession(entry, currentTester = '') {
  return {
    ...getHistoricalTechIssueFields(entry),
    candidate_name: entry.candidate_name || entry.candidate || '',
    tester_name: currentTester || entry.tester_name || '',
    pronoun: entry.pronoun || '',
    final_attempt: !!entry.final_attempt,
    attempt_state: entry.attempt_state || null,
    prior_counted_attempts: entry.attempt_state?.counted_attempts || entry.prior_counted_attempts || 0,
    attempt_number: entry.next_attempt_number || entry.attempt_state?.current_attempt || entry.attempt_number || 1,
    attempt_history: Array.isArray(entry.attempt_history) ? entry.attempt_history : [],
    supervisor_retry_required: false,
    supervisor_only: true,
    resumed_sup_transfer_only: true,
    resume_source_history_id: entry.history_id || entry.source_session_id || entry.original_session_id || entry.session_id || '',
    resume_source_timestamp_iso: entry.timestamp_iso || entry.timestamp || '',
    resume_source_candidate: entry.candidate_name || entry.candidate || '',
    resume_source_tester: entry.tester_name || '',
    status: 'In Progress',
    auto_fail_reason: null,
    tech_issue: 'N/A',
    tech_issue_ended_session: false,
    tech_issue_summary_required: false,
    other_technical_issue: '',
    current_session_tech_issue: false,
    headset_usb: entry.headset_usb ?? null,
    headset_brand: entry.headset_brand || '',
    headset_review_id: entry.headset_review_id || '',
    headset_review_status: entry.headset_review_status || '',
    noise_cancel: entry.noise_cancel ?? null,
    vpn_on: entry.vpn_on ?? null,
    vpn_off: entry.vpn_off ?? null,
    chrome_default: entry.chrome_default ?? null,
    extensions_disabled: entry.extensions_disabled ?? null,
    popups_allowed: entry.popups_allowed ?? null,
    call_1: entry.call_1 || null,
    call_2: entry.call_2 || null,
    call_3: entry.call_3 || null,
    sup_transfer_1: null,
    sup_transfer_2: null,
    time_for_sup: true,
    newbie_shift_data: entry.newbie_shift_data || null,
    newbie_shift_scheduled_at: entry.newbie_shift_scheduled_at || '',
    newbie_shift_timezone: entry.newbie_shift_timezone || '',
    newbie_shift_request_id: entry.newbie_shift_request_id || '',
    newbie_shift_request_type: entry.newbie_shift_request_type || '',
    newbie_shift_request_status: entry.newbie_shift_request_status || '',
    newbie_shift_requested_by: entry.newbie_shift_requested_by || '',
    newbie_shift_request_reason: entry.newbie_shift_request_reason || '',
    newbie_shift_request_details: entry.newbie_shift_request_details || '',
    newbie_shift_request_created_at: entry.newbie_shift_request_created_at || '',
    newbie_shift_original_scheduled_at: entry.newbie_shift_original_scheduled_at || '',
    newbie_shift_rescheduled_at: entry.newbie_shift_rescheduled_at || '',
    newbie_shift_within_24_hours: Boolean(entry.newbie_shift_within_24_hours),
    newbie_shift_counts_as_attempt: Boolean(entry.newbie_shift_counts_as_attempt),
    newbie_shift_admin_decision_at: entry.newbie_shift_admin_decision_at || '',
    newbie_shift_admin_decision_by: entry.newbie_shift_admin_decision_by || '',
    newbie_shift_denial_reason: entry.newbie_shift_denial_reason || '',
    final_status: null,
    last_saved: null,
    tech_issues_log: [],
  };
}

export function buildSharedPendingSession(entry, testerName, basicsSource = null) {
  const priorSummary = [entry.notes, entry.mock_call_summary].filter(Boolean).join('\n\n');
  const baseSession = {
    candidate_name: entry.candidate_name || '',
    tester_name: testerName || '',
    pronoun: '',
    final_attempt: Boolean(entry.final_attempt),
    supervisor_only: true,
    resumed_sup_transfer_only: true,
    shared_pending_sup_transfer: true,
    pending_sup_transfer_id: entry.pending_id || '',
    shared_pending_id: entry.pending_id || '',
    resume_source_history_id: entry.original_session_id || '',
    resume_source_timestamp_iso: '',
    resume_source_candidate: entry.candidate_name || '',
    resume_source_tester: entry.original_tester_name || '',
    status: 'In Progress',
    auto_fail_reason: null,
    tech_issue: 'N/A',
    tech_issue_ended_session: false,
    tech_issue_summary_required: false,
    other_technical_issue: '',
    current_session_tech_issue: false,
    historical_tech_issue: 'N/A',
    historical_tech_issues_log: [],
    headset_usb: null,
    headset_brand: '',
    headset_review_id: entry.headset_review_id || '',
    headset_review_status: entry.headset_review_status || '',
    noise_cancel: null,
    vpn_on: null,
    vpn_off: null,
    chrome_default: null,
    extensions_disabled: null,
    popups_allowed: null,
    call_1: entry.call_1_result ? { result: entry.call_1_result } : null,
    call_2: entry.call_2_result ? { result: entry.call_2_result } : null,
    call_3: entry.call_3_result ? { result: entry.call_3_result } : null,
    sup_transfer_1: null,
    sup_transfer_2: null,
    time_for_sup: true,
    newbie_shift_data: entry.newbie_shift_data || null,
    newbie_shift_scheduled_at: entry.newbie_shift_scheduled_at || '',
    newbie_shift_timezone: entry.newbie_shift_timezone || '',
    newbie_shift_request_id: entry.newbie_shift_request_id || '',
    newbie_shift_request_type: entry.newbie_shift_request_type || '',
    newbie_shift_request_status: entry.newbie_shift_request_status || '',
    newbie_shift_requested_by: entry.newbie_shift_requested_by || '',
    newbie_shift_request_reason: entry.newbie_shift_request_reason || '',
    newbie_shift_request_details: entry.newbie_shift_request_details || '',
    newbie_shift_request_created_at: entry.newbie_shift_request_created_at || '',
    newbie_shift_original_scheduled_at: entry.newbie_shift_original_scheduled_at || '',
    newbie_shift_rescheduled_at: entry.newbie_shift_rescheduled_at || '',
    newbie_shift_within_24_hours: Boolean(entry.newbie_shift_within_24_hours),
    newbie_shift_counts_as_attempt: Boolean(entry.newbie_shift_counts_as_attempt),
    newbie_shift_admin_decision_at: entry.newbie_shift_admin_decision_at || '',
    newbie_shift_admin_decision_by: entry.newbie_shift_admin_decision_by || '',
    newbie_shift_denial_reason: entry.newbie_shift_denial_reason || '',
    final_status: null,
    last_saved: null,
    tech_issues_log: [],
    coaching_summary: priorSummary,
    fail_summary: entry.completed_status || '',
    review_notes: entry.notes || '',
  };
  return mergeBasicsIntoSession(baseSession, buildBasicsFromRecord(basicsSource || entry));
}

export function buildFailedCandidateRetrySession(record = {}, currentTester = '', basicsSource = null) {
  const candidateName = record.candidate_name || record.candidate || '';
  const historicalTester = record.tester_name || '';
  const isSameTester = Boolean(
    currentTester &&
    historicalTester &&
    normalizeName(currentTester) === normalizeName(historicalTester)
  );

  const priorAttemptNumber = record.attempt_number || record.attempt_state?.current_attempt || 1;
  const priorCounted = record.attempt_state?.counted_attempts || record.prior_counted_attempts || 1;
  const nextAttemptNumber = priorAttemptNumber + 1;

  const priorAttemptRecord = {
    attempt_number: priorAttemptNumber,
    status: record.status || record.final_status || 'Fail',
    final_attempt: Boolean(record.final_attempt),
    tester_name: historicalTester,
    timestamp_iso: record.timestamp_iso || record.timestamp || '',
    call_1: record.call_1 || null,
    call_2: record.call_2 || null,
    call_3: record.call_3 || null,
    sup_transfer_1: record.sup_transfer_1 || null,
    sup_transfer_2: record.sup_transfer_2 || null,
  };

  const attemptHistory = Array.isArray(record.attempt_history) && record.attempt_history.length > 0
    ? [...record.attempt_history]
    : [priorAttemptRecord];

  const session = {
    candidate_name: candidateName,
    candidate_id: record.candidate_id || '',
    source_candidate_id: record.source_candidate_id || '',
    tester_name: currentTester || historicalTester,
    pronoun: record.pronoun || '',
    final_attempt: false,
    attempt_number: nextAttemptNumber,
    prior_counted_attempts: priorCounted,
    attempt_history: attemptHistory,
    supervisor_retry_required: false,
    supervisor_only: false,
    resumed_sup_transfer_only: false,
    smart_resumed: !isSameTester,
    resume_source_history_id: record.history_id || record.session_id || '',
    resume_source_timestamp_iso: record.timestamp_iso || record.timestamp || '',
    resume_source_candidate: candidateName,
    resume_source_tester: historicalTester,
    status: 'In Progress',
    final_status: null,
    auto_fail_reason: null,
    tech_issue: 'N/A',
    tech_issue_ended_session: false,
    tech_issue_summary_required: false,
    other_technical_issue: '',
    current_session_tech_issue: false,
    headset_usb: null,
    headset_brand: '',
    headset_review_id: '',
    headset_review_status: '',
    noise_cancel: null,
    vpn_on: null,
    vpn_off: null,
    chrome_default: null,
    extensions_disabled: null,
    popups_allowed: null,
    call_1: null,
    call_2: null,
    call_3: null,
    sup_transfer_1: null,
    sup_transfer_2: null,
    time_for_sup: null,
    newbie_shift_data: null,
    newbie_shift_scheduled_at: '',
    newbie_shift_timezone: '',
    newbie_shift_request_id: '',
    newbie_shift_request_type: '',
    newbie_shift_request_status: '',
    newbie_shift_requested_by: '',
    newbie_shift_request_reason: '',
    newbie_shift_request_details: '',
    newbie_shift_request_created_at: '',
    newbie_shift_original_scheduled_at: '',
    newbie_shift_rescheduled_at: '',
    newbie_shift_within_24_hours: false,
    newbie_shift_counts_as_attempt: false,
    newbie_shift_admin_decision_at: '',
    newbie_shift_admin_decision_by: '',
    newbie_shift_denial_reason: '',
    last_saved: null,
    tech_issues_log: [],
    coaching_summary: '',
    fail_summary: '',
    prior_tester_notes: record.notes || record.review_notes || '',
  };

  const source = basicsSource || record;
  return mergeBasicsIntoSession(session, buildBasicsFromRecord(source));
}

export function getCandidateLatestSessionMap(history = []) {
  const map = new Map();
  const sorted = [...(history || [])].sort((a, b) => {
    const dateA = String(a.timestamp_iso || a.timestamp || a.completed_at || a.created_at || '');
    const dateB = String(b.timestamp_iso || b.timestamp || b.completed_at || b.created_at || '');
    return dateB.localeCompare(dateA);
  });
  for (const record of sorted) {
    const candidateName = normalizeName(record.candidate_name || record.candidate || '');
    if (candidateName && !map.has(candidateName)) {
      map.set(candidateName, record);
    }
  }
  return map;
}

export function isRecordSuperseded(record, history = []) {
  if (!record) return false;
  const candidateName = normalizeName(record.candidate_name || record.candidate || '');
  if (!candidateName) return false;
  const map = getCandidateLatestSessionMap(history);
  const latest = map.get(candidateName);
  if (!latest || latest === record) return false;

  const recordId = logicalResumeSourceId(record);
  const latestId = logicalResumeSourceId(latest);
  if (recordId && latestId) {
    return recordId !== latestId;
  }
  const dateRecord = String(record.timestamp_iso || record.timestamp || record.completed_at || record.created_at || '');
  const dateLatest = String(latest.timestamp_iso || latest.timestamp || latest.completed_at || latest.created_at || '');
  if (dateLatest && dateRecord && dateLatest !== dateRecord) {
    return dateLatest > dateRecord;
  }
  return false;
}

export function canHistoryStartSession(record, history = []) {
  if (!record) return false;
  if (String(record.sync_status || '').toLowerCase() === 'local_only') return false;
  if (isRecordSuperseded(record, history)) return false;
  const status = record.status || record.final_status || '';
  if (status !== 'Fail' && status !== 'FAIL-Final Attempt') return false;
  if (record.final_attempt || status === 'FAIL-Final Attempt') return false;

  const candidateName = normalizeName(record.candidate_name || record.candidate || '');
  if (!candidateName) return false;
  const latestMap = getCandidateLatestSessionMap(history);
  const latest = latestMap.get(candidateName);
  if (!latest) return true;
  const latestStatus = latest.status || latest.final_status || '';
  if (['Pass', 'RESUMED-PASS'].includes(latestStatus)) return false;
  if (latest.final_attempt || latestStatus === 'FAIL-Final Attempt') return false;
  return latestStatus === 'Fail';
}

export function canHistorySupervisorTransferOnly(record, history = []) {
  if (!record) return false;
  if (String(record.sync_status || '').toLowerCase() === 'local_only') return false;
  if (isRecordSuperseded(record, history)) return false;
  const status = record.status || record.final_status || '';
  if (status !== 'Incomplete') return false;
  if (record.final_attempt) return false;
  if (record.supervisor_transfer_completed || record.sup_transfer_completed) return false;
  const reqStatus = String(record.newbie_shift_request_status || '').trim().toLowerCase();
  return reqStatus === 'pending';
}

