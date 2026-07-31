import React from 'react';

export default function FinalAttemptBanner({ visible, attemptState = null }) {
  if (!visible) return null;
  const currentAttempt = Number(attemptState?.current_attempt || attemptState?.current_attempt_number || 0);
  const allowedAttempts = Number(attemptState?.max_attempts || attemptState?.allowed_attempt_count || 0);
  const hasCanonicalNumbers = currentAttempt > 0 && allowedAttempts > 0;
  if (hasCanonicalNumbers && currentAttempt !== allowedAttempts) {
    return (
      <div className="banner banner-warning" role="status" aria-live="polite" data-testid="attempt-consistency-warning" style={{ marginBottom: 16, fontWeight: 700 }}>
        Attempt {currentAttempt} of {allowedAttempts}. Final-attempt status is being reconciled.
      </div>
    );
  }
  const attemptText = hasCanonicalNumbers
    ? ` Attempt ${currentAttempt} of ${allowedAttempts}.`
    : '';
  return (
    <div
      className="banner banner-fail"
      role="status"
      aria-live="polite"
      data-testid="final-attempt-banner"
      style={{ marginBottom: 16, fontWeight: 800 }}
    >
      FINAL ATTEMPT — This is the candidate&apos;s last allowed attempt.{attemptText}
    </div>
  );
}
