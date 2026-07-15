import {
  CERTIFICATION_SUPPORT_EMAIL,
  DEFAULT_NEWBIE_SHIFT_RESCHEDULE_ADMIN_MENTION,
  NEWBIE_REQUESTED_BY,
  buildRescheduleDiscordPost,
  buildRescheduleFailSummary,
  buildRescheduleSummary,
  followUpStatusMeta,
  formFillStatusMeta,
  sessionStatusMeta,
} from './certificationWorkflow';

const finalAttemptReschedule = {
  candidate_name: 'Taylor Example',
  newbie_shift_requested_by: NEWBIE_REQUESTED_BY.CANDIDATE,
  newbie_shift_request_reason: 'Scheduling conflict',
  newbie_shift_within_24_hours: true,
  final_attempt: true,
  newbie_shift_data: {
    newbie_date: '07/15/2026',
    newbie_time: '10:00 AM',
    newbie_tz: 'EST (Eastern)',
  },
};

test('certification support email is canonical in generated reschedule text', () => {
  const legacy = `certification@${'acddirect'}.com`;
  const summary = buildRescheduleSummary(finalAttemptReschedule);
  const failSummary = buildRescheduleFailSummary(finalAttemptReschedule);
  const discordPost = buildRescheduleDiscordPost(finalAttemptReschedule, '@admins');

  expect(CERTIFICATION_SUPPORT_EMAIL).toBe('certification@acdsupport.com');
  expect(summary).toContain('certification@acdsupport.com');
  expect(failSummary).toContain('certification@acdsupport.com');
  expect(discordPost).toContain('certification@acdsupport.com');
  expect(summary).not.toContain(legacy);
  expect(failSummary).not.toContain(legacy);
  expect(discordPost).not.toContain(legacy);
});

test('form fill status metadata uses compact semantic labels and classes', () => {
  expect(formFillStatusMeta('filled')).toMatchObject({
    label: 'Form Filled',
    className: 'status-chip-form-filled',
    tone: 'success',
  });
  expect(formFillStatusMeta('failed')).toMatchObject({
    label: 'Fill Failed',
    className: 'status-chip-form-failed',
    tone: 'danger',
  });
  expect(formFillStatusMeta('skipped')).toMatchObject({
    label: 'Form Skipped',
    className: 'status-chip-form-skipped',
    tone: 'muted-warning',
  });
  expect(formFillStatusMeta('not_attempted')).toMatchObject({
    label: 'Not Yet Filled',
    className: 'status-chip-form-empty',
    tone: 'neutral',
  });
  expect(formFillStatusMeta('', { legacy: true })).toMatchObject({
    label: 'Not Recorded',
    className: 'status-chip-form-legacy',
    tone: 'neutral',
  });
  expect(formFillStatusMeta('filled').icon).toBeUndefined();
  expect(formFillStatusMeta('not_attempted').icon).toBeUndefined();
});

test('session, follow-up, and form pending states use distinct chip classes', () => {
  expect(sessionStatusMeta('Incomplete').className).toBe('status-chip-session-incomplete');
  expect(followUpStatusMeta('pending').className).toBe('status-chip-followup-pending');
  expect(formFillStatusMeta('not_attempted').className).toBe('status-chip-form-empty');
  expect(new Set([
    sessionStatusMeta('Incomplete').className,
    followUpStatusMeta('pending').className,
    formFillStatusMeta('not_attempted').className,
  ]).size).toBe(3);
});

test('session status labels are trainer-facing and do not expose raw enum text', () => {
  expect(sessionStatusMeta('RESUMED-PASS')).toMatchObject({
    label: 'Resumed – Pass',
    ariaLabel: 'Session status: Resumed – Pass',
  });
  expect(sessionStatusMeta('FAIL-Final Attempt')).toMatchObject({
    label: 'Fail – Final Attempt',
    ariaLabel: 'Session status: Fail – Final Attempt',
  });
  expect(sessionStatusMeta('NC/NS')).toMatchObject({
    label: 'NC/NS',
  });
  expect(sessionStatusMeta('RESUMED-PASS').label).not.toContain('OK');
  expect(sessionStatusMeta('FAIL-Final Attempt').label).not.toContain('x');
});

test('default reschedule Discord mention targets certification admin account', () => {
  const post = buildRescheduleDiscordPost(finalAttemptReschedule);

  expect(DEFAULT_NEWBIE_SHIFT_RESCHEDULE_ADMIN_MENTION).toBe('@beckysowlesacdadmin');
  expect(post.startsWith('@beckysowlesacdadmin ')).toBe(true);
});
