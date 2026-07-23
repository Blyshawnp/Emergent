import React from 'react';

export default function FinalAttemptBanner({ visible, attemptState = null }) {
  if (!visible) return null;
  const attemptText = attemptState?.current_attempt && attemptState?.max_attempts
    ? ` Attempt ${attemptState.current_attempt} of ${attemptState.max_attempts}.`
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
