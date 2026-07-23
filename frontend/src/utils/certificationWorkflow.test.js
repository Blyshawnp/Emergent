import {
  CERTIFICATION_SUPPORT_EMAIL,
  NEWBIE_REQUESTED_BY,
  NEWBIE_REQUEST_TYPE,
  buildInitialNewbieShiftDiscordPost,
  buildNewbieShiftDiscordPost,
  buildRescheduleDiscordPost,
  buildRescheduleFailSummary,
  buildRescheduleSummary,
  canRescheduleNewbieShift,
  followUpStatusMeta,
  formFillStatusMeta,
  getNewbieShiftEligibility,
  newbieShiftStatusMeta,
  parseScheduledDateTime,
  computeWithin24Hours,
  buildHeadsetAutoFailReason,
  getHeadsetAutoFailReasons,
  sessionStatusMeta,
} from './certificationWorkflow';

test('scheduled timestamps use the selected region DST offset and exact 24-hour boundary', () => {
  expect(parseScheduledDateTime('03/07/2026', '10:00 AM', 'EST (Eastern)')).toBe('2026-03-07T10:00:00-05:00');
  expect(parseScheduledDateTime('03/09/2026', '10:00 AM', 'EST (Eastern)')).toBe('2026-03-09T10:00:00-04:00');
  expect(computeWithin24Hours('2026-03-09T10:00:00-04:00', '2026-03-08T10:00:00-04:00')).toBe(false);
  expect(computeWithin24Hours('2026-03-09T09:59:59-04:00', '2026-03-08T10:00:00-04:00')).toBe(true);
});

test('invalid wall-clock values are rejected', () => {
  expect(parseScheduledDateTime('07/21/2026', '13:00 PM', 'EST (Eastern)')).toBeNull();
  expect(parseScheduledDateTime('07/21/2026', '10:99 AM', 'EST (Eastern)')).toBeNull();
});

test.each([
  [false, false, ['Wrong headset (not USB)', 'Wrong headset (not noise cancelling)']],
  [true, false, ['Wrong headset (not noise cancelling)']],
  [false, true, ['Wrong headset (not USB)']],
  [true, true, []],
])('headset requirements map USB=%s noise=%s to exact auto-fail reasons', (usb, noise, expected) => {
  expect(getHeadsetAutoFailReasons(usb, noise)).toEqual(expected);
  expect(buildHeadsetAutoFailReason(usb, noise)).toBe(expected.join(' and '));
});

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
  const discordPost = buildRescheduleDiscordPost(finalAttemptReschedule);

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

test('temporary Newbie Shift posts never add automatic mentions', () => {
  const post = buildRescheduleDiscordPost(finalAttemptReschedule);
  const initial = buildInitialNewbieShiftDiscordPost({
    candidate_name: 'Taylor Example',
    newbie_shift_data: finalAttemptReschedule.newbie_shift_data,
  });

  expect(post).toMatch(/^Taylor Example /);
  expect(initial).toMatch(/^Taylor Example /);
  expect(post).not.toMatch(/(^|\s)@[\w-]+/);
  expect(initial).not.toMatch(/(^|\s)@[\w-]+/);
  expect(buildNewbieShiftDiscordPost({
    ...finalAttemptReschedule,
    newbie_shift_request_type: NEWBIE_REQUEST_TYPE.RESCHEDULE,
  })).toBe(post);
});

describe('Newbie Shift eligibility', () => {
  const actualPending = {
    status: 'Incomplete',
    newbie_shift_request_id: 'request-1',
    newbie_shift_request_type: 'initial',
    newbie_shift_request_status: 'pending',
    newbie_shift_request_created_at: '2026-07-18T12:00:00Z',
    newbie_shift_requested_by: 'tester',
    newbie_shift_request_reason: 'Initial Newbie Shift scheduling',
  };
  const scheduled = {
    ...actualPending,
    newbie_shift_data: { newbie_date: '07/20/2026', newbie_time: '10:00 AM', newbie_tz: 'EST (Eastern)' },
  };

  test.each([
    ['Pass', {}],
    ['RESUMED-PASS', {}],
    ['FAIL-Final Attempt', {}],
    ['Fail', { final_attempt: true }],
    ['Withdrawn', {}],
    ['Removed', {}],
    ['Deleted', {}],
    ['Archived', {}],
  ])('%s suppresses obsolete pending state', (status, extra) => {
    expect(getNewbieShiftEligibility({ ...scheduled, ...extra, status }).active).toBe(false);
    expect(newbieShiftStatusMeta({ ...scheduled, ...extra, status })).toBeNull();
  });

  test('completed Supervisor Transfer suppresses obsolete pending state', () => {
    expect(getNewbieShiftEligibility({ ...scheduled, sup_transfer_1: { result: 'Pass' } }).active).toBe(false);
  });

  test('stale pending flag or orphaned request id does not create a workflow', () => {
    expect(newbieShiftStatusMeta({ status: 'Incomplete', newbie_shift_request_status: 'pending' })).toBeNull();
    expect(newbieShiftStatusMeta({ status: 'Incomplete', newbie_shift_request_id: 'orphan', newbie_shift_request_status: 'pending' })).toBeNull();
  });

  test('actual initial and reschedule requests use distinct labels', () => {
    expect(newbieShiftStatusMeta(actualPending).label).toBe('Newbie Shift Pending');
    expect(newbieShiftStatusMeta({ ...actualPending, newbie_shift_request_type: 'reschedule' }).label).toBe('Newbie Shift Reschedule Pending');
  });

  test('reschedule requires an actual prior schedule and stays independent of form status', () => {
    expect(canRescheduleNewbieShift(actualPending)).toBe(false);
    for (const form_fill_status of ['filled', 'skipped', 'failed', 'not_attempted']) {
      expect(canRescheduleNewbieShift({ ...scheduled, form_fill_status })).toBe(true);
    }
  });

  test('approved is scheduled, denied is historical only, and neither is current pending work', () => {
    expect(newbieShiftStatusMeta({ ...scheduled, newbie_shift_request_status: 'approved' }).label).toBe('Newbie Shift Scheduled');
    expect(newbieShiftStatusMeta({ status: 'Incomplete', newbie_shift_data: scheduled.newbie_shift_data, newbie_shift_request_status: 'pending' }).label).toBe('Newbie Shift Scheduled');
    expect(getNewbieShiftEligibility({ ...scheduled, newbie_shift_request_status: 'denied' })).toMatchObject({ denied: true, pending: false, canReschedule: false });
  });
});
