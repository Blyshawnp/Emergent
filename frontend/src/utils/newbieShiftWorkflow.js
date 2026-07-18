import {
  computeWithin24Hours,
  NEWBIE_REQUESTED_BY,
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
  const originalScheduledAt = record.newbie_shift_original_scheduled_at
    || record.newbie_shift_scheduled_at
    || parseScheduledDateTime(existingNewbie.newbie_date, existingNewbie.newbie_time, existingNewbie.newbie_tz)
    || '';
  const existingPendingReschedule = (
    String(record.newbie_shift_request_type || '').toLowerCase() === NEWBIE_REQUEST_TYPE.RESCHEDULE
    && String(record.newbie_shift_request_status || '').toLowerCase() === NEWBIE_REQUEST_STATUS.PENDING
  );
  const requestedBy = String(intake.requestedBy || '').trim().toLowerCase();
  const within24 = requestedBy === NEWBIE_REQUESTED_BY.CANDIDATE
    ? computeWithin24Hours(originalScheduledAt, now)
    : false;

  return {
    ...record,
    candidate_name: record.candidate_name || record.candidate || '',
    status: 'In Progress',
    final_status: within24 ? 'NC/NS' : 'Incomplete',
    history_id: record.history_id || identity,
    newbie_shift_request_id: existingPendingReschedule && record.newbie_shift_request_id
      ? record.newbie_shift_request_id
      : `newbie-reschedule-${identity}`,
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
    newbie_shift_within_24_hours: within24,
    newbie_shift_counts_as_attempt: within24,
    auto_fail_reason: within24 ? 'NC/NS' : record.auto_fail_reason || null,
  };
}
