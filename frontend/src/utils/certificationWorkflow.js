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
  OTHER: 'other',
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

export const CERTIFICATION_SUPPORT_EMAIL = 'certification@acdsupport.com';

export function getHeadsetAutoFailReasons(headsetUsb, noiseCancel) {
  const reasons = [];
  if (headsetUsb === false) reasons.push('Wrong headset (not USB)');
  if (noiseCancel === false) reasons.push('Wrong headset (not noise cancelling)');
  return reasons;
}

export function buildHeadsetAutoFailReason(headsetUsb, noiseCancel) {
  return getHeadsetAutoFailReasons(headsetUsb, noiseCancel).join(' and ');
}

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
  if (label === 'Form Skipped') return 'muted-warning';
  return 'neutral';
}

export function formFillStatusMeta(value, { legacy = false } = {}) {
  const status = normalizeFormFillStatus(value);
  const label = formFillStatusLabel(value, { legacy });
  const base = { category: 'form', title: label, ariaLabel: `Form status: ${label}` };
  if (status === FORM_FILL_STATUS.FILLED) {
    return { ...base, label, className: 'status-chip-form-filled', tone: 'success' };
  }
  if (status === FORM_FILL_STATUS.FAILED) {
    return { ...base, label, className: 'status-chip-form-failed', tone: 'danger' };
  }
  if (status === FORM_FILL_STATUS.SKIPPED) {
    return { ...base, label, className: 'status-chip-form-skipped', tone: 'muted-warning' };
  }
  if (legacy && !value) {
    return { category: 'form', label: 'Not Recorded', title: 'Not Recorded', ariaLabel: 'Form status: Not Recorded', className: 'status-chip-form-legacy', tone: 'neutral' };
  }
  return { ...base, label, className: 'status-chip-form-empty', tone: 'neutral' };
}

export function sessionStatusLabel(value) {
  const raw = String(value || '').trim();
  const normalized = raw.toLowerCase();
  if (!raw) return 'Unknown';
  if (normalized === 'resumed-pass' || normalized === 'resumed pass') return 'Resumed – Pass';
  if (normalized === 'fail-final attempt' || normalized === 'fail final attempt' || normalized === 'failed final attempt') return 'Fail – Final Attempt';
  if (normalized === 'nc/ns' || normalized === 'ncns') return 'NC/NS';
  if (normalized === 'pass') return 'Pass';
  if (normalized === 'fail') return 'Fail';
  if (normalized === 'incomplete') return 'Incomplete';
  if (normalized === 'withdrawn') return 'Withdrawn';
  if (normalized === 'archived') return 'Archived';
  if (normalized === 'needs retest / additional coaching') return 'Needs Retest / Additional Coaching';
  return raw.replace(/_/g, ' ');
}

export function sessionStatusMeta(value) {
  const label = sessionStatusLabel(value);
  const normalized = label.toLowerCase();
  const base = { category: 'session', label, title: label, ariaLabel: `Session status: ${label}` };
  if (normalized.includes('nc/ns')) return { ...base, className: 'status-chip-session-ncns', tone: 'ncns' };
  if (normalized.includes('pass')) return { ...base, className: 'status-chip-session-pass', tone: 'success' };
  if (normalized.includes('fail')) return { ...base, className: 'status-chip-session-fail', tone: 'danger' };
  if (normalized.includes('withdraw')) return { ...base, className: 'status-chip-session-withdrawn', tone: 'muted-danger' };
  if (normalized.includes('archive')) return { ...base, className: 'status-chip-session-archived', tone: 'neutral' };
  if (normalized.includes('incomplete') || normalized.includes('retest') || normalized.includes('coaching')) {
    return { ...base, className: 'status-chip-session-incomplete', tone: 'warning' };
  }
  return { ...base, className: 'status-chip-session-unknown', tone: 'neutral' };
}

export function followUpStatusMeta(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === NEWBIE_REQUEST_STATUS.APPROVED) {
    return { category: 'follow_up', label: 'Approved', title: 'Approved', ariaLabel: 'Follow-up status: Approved', className: 'status-chip-followup-approved', tone: 'success' };
  }
  if (normalized === NEWBIE_REQUEST_STATUS.DENIED) {
    return { category: 'follow_up', label: 'Denied', title: 'Denied', ariaLabel: 'Follow-up status: Denied', className: 'status-chip-followup-denied', tone: 'danger' };
  }
  if (normalized === NEWBIE_REQUEST_STATUS.PENDING) {
    return { category: 'follow_up', label: 'Pending', title: 'Pending', ariaLabel: 'Follow-up status: Pending', className: 'status-chip-followup-pending', tone: 'pending' };
  }
  return { category: 'follow_up', label: 'No follow-up', title: 'No follow-up', ariaLabel: 'Follow-up status: No follow-up', className: 'status-chip-followup-none', tone: 'neutral' };
}

const TERMINAL_NEWBIE_STATUS_TOKENS = new Set([
  'pass',
  'resumed pass',
  'fail final attempt',
  'failed final attempt',
  'withdrawn',
  'withdrew from certification',
  'removed',
  'deleted',
  'archived',
]);

function normalizedWorkflowStatus(record = {}) {
  return String(record.final_status || record.latest_status || record.status || '')
    .trim()
    .toLowerCase()
    .replace(/[–—_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export function isTerminalNewbieShiftRecord(record = {}) {
  const status = normalizedWorkflowStatus(record);
  if (TERMINAL_NEWBIE_STATUS_TOKENS.has(status)) return true;
  return Boolean(record.final_attempt && (status === 'fail' || status === 'failed'));
}

export function hasCompletedSupervisorTransfer(record = {}) {
  return [record.sup_transfer_1?.result, record.sup_transfer_2?.result, record.sup_transfer_1_result, record.sup_transfer_2_result]
    .some((result) => String(result || '').trim().toLowerCase() === 'pass');
}

export function hasNewbieShiftSchedule(record = {}) {
  const newbie = record.newbie_shift_data || {};
  return Boolean(
    String(record.newbie_shift_scheduled_at || '').trim()
    || String(record.newbie_shift_rescheduled_at || '').trim()
    || String(record.newbie_shift_original_scheduled_at || '').trim()
    || (String(newbie.newbie_date || '').trim() && String(newbie.newbie_time || '').trim())
  );
}

export function hasActualNewbieShiftRequest(record = {}) {
  const requestId = String(record.newbie_shift_request_id || '').trim();
  if (!requestId) return false;
  return Boolean(
    String(record.newbie_shift_request_created_at || '').trim()
    && (
      String(record.newbie_shift_requested_by || '').trim()
      || String(record.newbie_shift_request_reason || '').trim()
      || String(record.newbie_shift_request_details || '').trim()
      || hasNewbieShiftSchedule(record)
    )
  );
}

export function getNewbieShiftEligibility(record = {}) {
  const status = String(record.newbie_shift_request_status || '').trim().toLowerCase();
  const requestType = String(record.newbie_shift_request_type || NEWBIE_REQUEST_TYPE.INITIAL).trim().toLowerCase();
  const hasSchedule = hasNewbieShiftSchedule(record);
  const hasRequest = hasActualNewbieShiftRequest(record);
  const terminal = isTerminalNewbieShiftRecord(record);
  const supervisorTransfersComplete = hasCompletedSupervisorTransfer(record);
  const cancelled = status === 'cancelled' || status === 'canceled';
  const active = !terminal && !supervisorTransfersComplete && !cancelled && (hasSchedule || hasRequest);
  const pending = active && status === NEWBIE_REQUEST_STATUS.PENDING && hasRequest;
  const approved = active && hasSchedule && (
    status === NEWBIE_REQUEST_STATUS.APPROVED
    || (!hasRequest && status !== NEWBIE_REQUEST_STATUS.DENIED)
  );
  const denied = !terminal && !supervisorTransfersComplete && status === NEWBIE_REQUEST_STATUS.DENIED && (hasSchedule || hasRequest);
  const canReschedule = active && hasSchedule && status !== NEWBIE_REQUEST_STATUS.DENIED && status !== 'completed';
  return { active, pending, approved, denied, canReschedule, hasSchedule, hasRequest, requestType };
}

export function newbieShiftStatusMeta(record = {}) {
  const eligibility = getNewbieShiftEligibility(record);
  if (eligibility.pending) {
    const reschedule = eligibility.requestType === NEWBIE_REQUEST_TYPE.RESCHEDULE;
    const label = reschedule ? 'Newbie Shift Reschedule Pending' : 'Newbie Shift Pending';
    return { ...followUpStatusMeta(NEWBIE_REQUEST_STATUS.PENDING), label, title: label, ariaLabel: `Follow-up status: ${label}` };
  }
  if (eligibility.approved) {
    const label = 'Newbie Shift Scheduled';
    return { ...followUpStatusMeta(NEWBIE_REQUEST_STATUS.APPROVED), label, title: label, ariaLabel: `Follow-up status: ${label}` };
  }
  if (eligibility.denied) {
    const label = 'Newbie Shift Denied';
    return { ...followUpStatusMeta(NEWBIE_REQUEST_STATUS.DENIED), label, title: label, ariaLabel: `Follow-up status: ${label}` };
  }
  return null;
}

export function canRescheduleNewbieShift(record = {}) {
  return getNewbieShiftEligibility(record).canReschedule;
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
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const offset = timezoneOffsetForLabel(timezoneValue, isoDate, hour, minute);
  return `${isoDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${offset}`;
}

const TIMEZONE_IANA_BY_LABEL = Object.freeze({
  PACIFIC: 'America/Los_Angeles',
  MOUNTAIN: 'America/Denver',
  CENTRAL: 'America/Chicago',
  EASTERN: 'America/New_York',
});

function offsetForWallTime(timeZone, isoDate, hour, minute) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = desiredUtc;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let pass = 0; pass < 3; pass += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(instant))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)])
    );
    const observedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const observedOffset = observedAsUtc - instant;
    const nextInstant = desiredUtc - observedOffset;
    if (nextInstant === instant) break;
    instant = nextInstant;
  }
  const offsetMinutes = Math.round((desiredUtc - instant) / 60000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

export function timezoneOffsetForLabel(label = '', isoDate = '', hour = 12, minute = 0) {
  const text = String(label || '').toUpperCase();
  const region = text.includes('PST') || text.includes('PACIFIC') ? 'PACIFIC'
    : text.includes('MST') || text.includes('MOUNTAIN') ? 'MOUNTAIN'
      : text.includes('CST') || text.includes('CENTRAL') ? 'CENTRAL'
        : 'EASTERN';
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    try {
      return offsetForWallTime(TIMEZONE_IANA_BY_LABEL[region], isoDate, hour, minute);
    } catch (_error) {
      // Fall through to the standard offset when Intl timezone data is unavailable.
    }
  }
  return { PACIFIC: '-08:00', MOUNTAIN: '-07:00', CENTRAL: '-06:00', EASTERN: '-05:00' }[region];
}

export function computeWithin24Hours(originalIso, requestedAtIso) {
  const original = new Date(originalIso);
  const requested = new Date(requestedAtIso);
  if (Number.isNaN(original.getTime()) || Number.isNaN(requested.getTime())) {
    return false;
  }
  return original.getTime() - requested.getTime() < 24 * 60 * 60 * 1000;
}

export function formatTimezoneLabel(value = '') {
  const raw = String(value || '').trim();
  const match = raw.match(/\(([^)]+)\)/);
  if (match?.[1]) return match[1].trim();
  return raw.replace(/\s*\([^)]*\)\s*/g, '').trim();
}

export function formatNewbieScheduleParts(newbie = {}) {
  const date = newbie.newbie_date || '';
  const time = newbie.newbie_time || '';
  const tz = newbie.newbie_tz || newbie.newbie_shift_timezone || '';
  return {
    date: String(date || '').trim(),
    time: String(time || '').trim(),
    timezone: formatTimezoneLabel(tz),
  };
}

export function formatNewbieSchedule(newbie = {}) {
  const parts = formatNewbieScheduleParts(newbie);
  return [parts.date, parts.time ? `at ${parts.time}` : '', parts.timezone].filter(Boolean).join(' ').trim() || 'Not scheduled';
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

export function buildInitialNewbieShiftDiscordPost(session = {}) {
  const candidateName = session.candidate_name || session.candidate || 'Candidate';
  const schedule = formatNewbieSchedule(session.newbie_shift_data);
  return `${candidateName} needs their supervisor transfer test calls (Newbie Shift) scheduled. Please add a Newbie Shift for me for ${schedule}.`;
}

export function buildRescheduleDiscordPost(session = {}) {
  const candidateName = session.candidate_name || session.candidate || 'Candidate';
  const reason = buildReasonSentence(session.newbie_shift_request_reason, session.newbie_shift_request_details);
  const schedule = formatNewbieSchedule(session.newbie_shift_data);
  const requestedBy = session.newbie_shift_requested_by;
  const timing = session.newbie_shift_within_24_hours ? 'less than 24 hours' : '24 hours or more';
  const finalAttempt = Boolean(session.final_attempt && session.newbie_shift_within_24_hours && requestedBy === NEWBIE_REQUESTED_BY.CANDIDATE);

  let post = `${candidateName} `;
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

export function buildNewbieShiftDiscordPost(session = {}) {
  return session.newbie_shift_request_type === NEWBIE_REQUEST_TYPE.RESCHEDULE
    ? buildRescheduleDiscordPost(session)
    : buildInitialNewbieShiftDiscordPost(session);
}
