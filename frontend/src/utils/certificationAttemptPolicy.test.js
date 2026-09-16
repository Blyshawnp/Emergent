import {
  additionalAttemptContext,
  automaticFinalAttempt,
  canGrantAdditionalAttempt,
  isCertificationAllowanceExhausted,
  shouldConfirmFinalAttemptOverride,
} from './certificationAttemptPolicy';
import BasicsPage from '../pages/BasicsPage';
import NotificationManagerApp from '../NotificationManagerApp';

describe('certification attempt policy consumers', () => {
  test('MTS and SAM policy consumers compile', () => {
    expect(typeof BasicsPage).toBe('function');
    expect(typeof NotificationManagerApp).toBe('function');
  });
  test.each([
    [1, 3, false],
    [2, 3, false],
    [3, 3, true],
    [3, 4, false],
    [4, 4, true],
    [5, 5, true],
  ])('attempt %s of %s uses backend auto-final %s', (attempt, maximum, expected) => {
    expect(automaticFinalAttempt({ current_attempt: attempt, max_attempts: maximum, final_attempt: expected })).toBe(expected);
  });

  test('confirmation is limited to automatic Yes changing to No', () => {
    expect(shouldConfirmFinalAttemptOverride(true, true, false)).toBe(true);
    expect(shouldConfirmFinalAttemptOverride(true, false, true)).toBe(false);
    expect(shouldConfirmFinalAttemptOverride(false, false, false)).toBe(false);
  });

  test('exhaustion blocks normal starts but not supervisor completion', () => {
    expect(isCertificationAllowanceExhausted({ retry_allowed: false })).toBe(true);
    expect(isCertificationAllowanceExhausted({ retry_allowed: false }, { supervisor_only: true })).toBe(false);
    expect(isCertificationAllowanceExhausted(
      { retry_allowed: false },
      { newbie_shift_request_type: 'reschedule', newbie_shift_counts_as_attempt: false }
    )).toBe(false);
  });

  test('grant action is administrator-only and presents allowance context', () => {
    expect(canGrantAdditionalAttempt('administrator')).toBe(true);
    expect(canGrantAdditionalAttempt('evaluator')).toBe(false);
    expect(canGrantAdditionalAttempt('viewer')).toBe(false);
    expect(canGrantAdditionalAttempt('importer')).toBe(false);
    expect(additionalAttemptContext({ counted_attempts: 3, extra_attempts_granted: 1, allowed_attempt_count: 4 })).toEqual({
      used: 3,
      normalAllowance: 3,
      additional: 1,
      maximum: 4,
      remaining: 1,
    });
  });
});
