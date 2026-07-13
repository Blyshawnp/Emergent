export const FORM_FILL_STATUS = Object.freeze({
  NOT_ATTEMPTED: 'not_attempted',
  FILLED: 'filled',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  NOT_RECORDED: 'not_recorded',
});

export const NEWBIE_REQUEST_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
});

export const NEWBIE_REQUESTED_BY = Object.freeze({
  TESTER: 'tester',
  CANDIDATE: 'candidate',
});

export const NEWBIE_REQUEST_TYPE = Object.freeze({
  INITIAL: 'initial',
  RESCHEDULE: 'reschedule',
});

export const DELETION_REQUEST_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
});

export const CERTIFICATION_SUPPORT_EMAIL = 'certification@acddirect.com';

export const RESCHEDULE_REASONS = [
  'Unexpected emergency',
  'Internet outage',
  'Power outage',
  'Technical issue',
  'Login issue',
  'Scheduling conflict',
  'Illness',
  'Other',
];

export function normalizeFormFillStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === FORM_FILL_STATUS.FILLED) return FORM_FILL_STATUS.FILLED;
  if (normalized === FORM_FILL_STATUS.SKIPPED) return FORM_FILL_STATUS.SKIPPED;
  if (normalized === FORM_FILL_STATUS.FAILED) return FORM_FILL_STATUS.FAILED;
  if (normalized === FORM_FILL_STATUS.NOT_RECORDED) return FORM_FILL_STATUS.NOT_RECORDED;
  return FORM_FILL_STATUS.NOT_ATTEMPTED;
}

export function formFillStatusLabel(value, { legacy = false } = {}) {
  const status = normalizeFormFillStatus(value);
  if (legacy && !value) return 'Not Recorded';
  if (status === FORM_FILL_STATUS.FILLED) return 'Form Filled';
  if (status === FORM_FILL_STATUS.SKIPPED) return 'Form Skipped';
  if (status === FORM_FILL_STATUS.FAILED) return 'Fill Failed';
  if (status === FORM_FILL_STATUS.NOT_RECORDED) return 'Not Recorded';
  return 'Not Yet Filled';
}

export function formFillStatusTone(value, { legacy = false } = {}) {
  const label = formFillStatusLabel(value, { legacy });
  if (label === 'Form Filled') return 'success';
  if (label === 'Fill Failed') return 'danger';
  return 'warning';
}

export function splitCandidateFirstName(name) {
  return String(name || '').trim().split(/\s+/).filter(Boolean)[0] || 'Candidate';
}

export function buildReasonSentence(reason, details = '') {
  const base = String(reason || '').trim();
  const extra = String(details || '').trim();
  if (!base && !extra) return 'the schedule needed to change';
  if (base.toLowerCase() === 'other') return extra.replace(/[.!?]+$/g, '') || 'another reason';
  if (!extra) return base.charAt(0).toLowerCase() + base.slice(1);
  return `${base.charAt(0).toLowerCase()}${base.slice(1)} (${extra.replace(/[.!?]+$/g, '')})`;
}

export function parseScheduledDateTime(dateValue, timeValue, timezoneValue = '') {
  const dateText = String(dateValue || '').trim();
  const timeText = String(timeValue || '').trim();
  if (!dateText || !timeText) return null;
  const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(dateText)
    ? dateText
    : (() => {
        const match = dateText.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!match) return '';
        return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
      })();
  if (!isoDate) return null;
  const timeMatch = timeText.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!timeMatch) return null;
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const ampm = timeMatch[3].toUpperCase();
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const offset = timezoneOffsetForLabel(timezoneValue);
  return `${isoDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${offset}`;
}

export function timezoneOffsetForLabel(label = '') {
  const text = String(label || '').toUpperCase();
  if (text.includes('PST') || text.includes('PACIFIC')) return '-08:00';
  if (text.includes('MST') || text.includes('MOUNTAIN')) return '-07:00';
  if (text.includes('CST') || text.includes('CENTRAL')) return '-06:00';
  return '-05:00';
}

export function computeWithin24Hours(originalIso, requestedAtIso) {
  const original = new Date(originalIso);
  const requested = new Date(requestedAtIso);
  if (Number.isNaN(original.getTime()) || Number.isNaN(requested.getTime())) {
    return false;
  }
  return original.getTime() - requested.getTime() < 24 * 60 * 60 * 1000;
}

export function formatNewbieSchedule(newbie = {}) {
  const date = newbie.newbie_date || '';
  const time = newbie.newbie_time || '';
  const tz = newbie.newbie_tz || newbie.newbie_shift_timezone || '';
  return [date, time ? `at ${time}` : '', tz].filter(Boolean).join(' ').trim() || 'Not scheduled';
}

export function buildRescheduleSummary(session = {}) {
  const candidateName = session.candidate_name || session.candidate || 'The candidate';
  const firstName = splitCandidateFirstName(candidateName);
  const reason = buildReasonSentence(session.newbie_shift_request_reason, session.newbie_shift_request_details);
  const schedule = formatNewbieSchedule(session.newbie_shift_data);
  const requestedBy = session.newbie_shift_requested_by;
  const within24 = Boolean(session.newbie_shift_within_24_hours);
  const finalAttempt = Boolean(session.final_attempt);

  if (requestedBy === NEWBIE_REQUESTED_BY.TESTER) {
    return `This form was filled to document a Newbie Shift reschedule. The tester requested that ${firstName}'s supervisor transfer test calls be rescheduled because ${reason}. The new date and time is ${schedule}. This tester-requested change should not count as a candidate attempt.`;
  }

  if (within24) {
    let text = `This form was filled to document a Newbie Shift reschedule. ${firstName} requested that their supervisor transfer test calls be rescheduled because ${reason}. The new tentative date and time is ${schedule}. The request was received less than 24 hours before the Newbie Shift and will count as an attempt.`;
    if (finalAttempt) {
      text += ` This session was their final attempt. ${firstName} was instructed to email ${CERTIFICATION_SUPPORT_EMAIL}; rescheduling approval is not guaranteed.`;
    }
    return text;
  }

  return `This form was filled to document a Newbie Shift reschedule. ${firstName} requested that their supervisor transfer test calls be rescheduled because ${reason}. The new date and time is ${schedule}. The request was received 24 hours or more before the Newbie Shift and should not count as an attempt.`;
}

export function buildRescheduleFailSummary(session = {}) {
  if (session.newbie_shift_requested_by !== NEWBIE_REQUESTED_BY.CANDIDATE || !session.newbie_shift_within_24_hours) {
    return 'N/A';
  }
  const firstName = splitCandidateFirstName(session.candidate_name || session.candidate);
  let text = `${firstName} requested that their supervisor transfer test calls be rescheduled. The request was received less than 24 hours before the Newbie Shift and will count as an attempt.`;
  if (session.final_attempt) {
    text += ` This session was their final attempt. ${firstName} was instructed to email ${CERTIFICATION_SUPPORT_EMAIL}; rescheduling approval is not guaranteed.`;
  }
  return text;
}

export function buildRescheduleDiscordPost(session = {}, adminMention = '@admin') {
  const candidateName = session.candidate_name || session.candidate || 'Candidate';
  const reason = buildReasonSentence(session.newbie_shift_request_reason, session.newbie_shift_request_details);
  const schedule = formatNewbieSchedule(session.newbie_shift_data);
  const requestedBy = session.newbie_shift_requested_by;
  const timing = session.newbie_shift_within_24_hours ? 'less than 24 hours' : '24 hours or more';
  const finalAttempt = Boolean(session.final_attempt && session.newbie_shift_within_24_hours && requestedBy === NEWBIE_REQUESTED_BY.CANDIDATE);

  let post = `${adminMention || '@admin'} ${candidateName} `;
  if (requestedBy === NEWBIE_REQUESTED_BY.TESTER) {
    post += `needs their supervisor transfer test calls (Newbie Shift) rescheduled because ${reason}. Please add a Newbie Shift for me for ${schedule}.`;
  } else {
    post += `requested to reschedule their supervisor transfer test calls (Newbie Shift) because ${reason}. The request was received ${timing} before the shift. Please add a Newbie Shift for me for ${schedule}.`;
  }
  if (finalAttempt) {
    post += ` This was the candidate's final attempt. They were instructed to email ${CERTIFICATION_SUPPORT_EMAIL}; rescheduling approval is not guaranteed.`;
  }
  return post;
}
