export const NORMAL_CERTIFICATION_ALLOWANCE = 3;

export function isSupervisorCompletion(session = {}) {
  const requestType = String(session.newbie_shift_request_type || '').trim().toLowerCase();
  return Boolean(
    session.supervisor_only
    || session.resumed_sup_transfer_only
    || ((requestType === 'reschedule' || requestType === 'newbie_shift_reschedule') && !session.newbie_shift_counts_as_attempt)
  );
}

export function isCertificationAllowanceExhausted(attemptState, session = {}) {
  if (isSupervisorCompletion(session)) return false;
  return Boolean(attemptState && attemptState.retry_allowed === false);
}

export function automaticFinalAttempt(attemptState, session = {}) {
  if (isSupervisorCompletion(session)) return false;
  return Boolean(attemptState?.final_attempt);
}

export function shouldConfirmFinalAttemptOverride(autoFinalAttempt, currentValue, nextValue) {
  return Boolean(autoFinalAttempt && currentValue === true && nextValue === false);
}

export function canGrantAdditionalAttempt(userRole) {
  return String(userRole || '').trim().toLowerCase() === 'administrator';
}

export function additionalAttemptContext(candidate = {}) {
  const used = Math.max(0, Number(candidate.counted_attempts ?? candidate.attempt_count ?? 0) || 0);
  const additional = Math.max(0, Number(candidate.extra_attempts_granted ?? 0) || 0);
  const maximum = Math.max(NORMAL_CERTIFICATION_ALLOWANCE + additional, Number(candidate.allowed_attempt_count ?? 0) || 0);
  return {
    used,
    normalAllowance: NORMAL_CERTIFICATION_ALLOWANCE,
    additional,
    maximum,
    remaining: Math.max(0, maximum - used),
  };
}
