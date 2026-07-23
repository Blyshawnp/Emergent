import {
  NEWBIE_REQUEST_STATUS,
  NEWBIE_REQUEST_TYPE,
  parseScheduledDateTime,
} from './certificationWorkflow';

export function newbieShiftRecordIdentity(record = {}) {
  return String(
    record.history_id
    || record.session_id
    || record.resume_source_history_id
    || [record.timestamp_iso || record.timestamp || '', record.tester_name || '', record.candidate_name || record.candidate || ''].join('|')
  ).trim();
}

export function buildNewbieShiftRescheduleSession(record = {}, intake = {}, now = new Date().toISOString()) {
  const identity = newbieShiftRecordIdentity(record);
  const existingNewbie = record.newbie_shift_data || {};
  const existingPendingReschedule = (
    String(record.newbie_shift_request_type || '').toLowerCase() === NEWBIE_REQUEST_TYPE.RESCHEDULE
    && String(record.newbie_shift_request_status || '').toLowerCase() === NEWBIE_REQUEST_STATUS.PENDING
  );
  const originalScheduledAt = (existingPendingReschedule ? record.newbie_shift_original_scheduled_at : '')
    || record.newbie_shift_scheduled_at
    || record.newbie_shift_rescheduled_at
    || parseScheduledDateTime(existingNewbie.newbie_date, existingNewbie.newbie_time, existingNewbie.newbie_tz)
    || '';
  const requestedBy = String(intake.requestedBy || '').trim().toLowerCase();
  const priorAttempt = Number(
    existingPendingReschedule
      ? record.newbie_shift_current_attempt
      : record.newbie_shift_resulting_attempt || record.attempt_number || record.attempt_count || (record.final_attempt ? 2 : 1)
  ) || 1;
  const requestId = existingPendingReschedule && record.newbie_shift_request_id
    ? record.newbie_shift_request_id
    : `newbie-reschedule-${identity}-${Date.parse(now) || Date.now()}`;

  return {
    ...record,
    candidate_name: record.candidate_name || record.candidate || '',
    status: 'In Progress',
    final_status: record.final_status || record.status || 'Incomplete',
    history_id: record.history_id || identity,
    newbie_shift_request_id: requestId,
    newbie_shift_request_type: NEWBIE_REQUEST_TYPE.RESCHEDULE,
    newbie_shift_request_status: NEWBIE_REQUEST_STATUS.PENDING,
    newbie_shift_requested_by: requestedBy,
    newbie_shift_request_reason: String(intake.reason || '').trim(),
    newbie_shift_request_details: String(intake.details || '').trim(),
    newbie_shift_request_created_at: existingPendingReschedule && record.newbie_shift_request_created_at
      ? record.newbie_shift_request_created_at
      : now,
    newbie_shift_original_scheduled_at: originalScheduledAt,
    newbie_shift_scheduled_at: record.newbie_shift_scheduled_at || originalScheduledAt,
    newbie_shift_data: existingNewbie,
    newbie_shift_current_attempt: priorAttempt,
    newbie_shift_resulting_attempt: priorAttempt,
    newbie_shift_within_24_hours: false,
    newbie_shift_counts_as_attempt: false,
    newbie_shift_becomes_final_attempt: false,
    newbie_shift_attempt_rule: '',
    newbie_shift_terminal_outcome: '',
    newbie_shift_request_confirmed_at: existingPendingReschedule ? record.newbie_shift_request_confirmed_at || '' : '',
    newbie_shift_request_submission_fingerprint: existingPendingReschedule ? record.newbie_shift_request_submission_fingerprint || '' : '',
    newbie_shift_prior_final_status: record.final_status || record.status || 'Incomplete',
    newbie_shift_prior_auto_fail_reason: record.auto_fail_reason || null,
    auto_fail_reason: record.auto_fail_reason || null,
  };
}
