import { buildNewbieShiftRescheduleSession } from './newbieShiftWorkflow';

const scheduledRecord = {
  history_id: 'history-1',
  candidate: 'Taylor Example',
  status: 'Incomplete',
  form_fill_status: 'skipped',
  newbie_shift_request_id: 'approved-initial',
  newbie_shift_request_type: 'initial',
  newbie_shift_request_status: 'approved',
  newbie_shift_scheduled_at: '2026-07-20T10:00:00-05:00',
  newbie_shift_data: { newbie_date: '07/20/2026', newbie_time: '10:00 AM', newbie_tz: 'EST (Eastern)' },
};

test('reschedule draft carries identity, old schedule, who, and reason without changing form status', () => {
  const draft = buildNewbieShiftRescheduleSession(
    scheduledRecord,
    { requestedBy: 'tester', reason: 'Scheduling conflict', details: 'Trainer conflict.' },
    '2026-07-18T12:00:00Z'
  );

  expect(draft).toMatchObject({
    history_id: 'history-1',
    candidate_name: 'Taylor Example',
    form_fill_status: 'skipped',
    newbie_shift_request_id: 'newbie-reschedule-history-1-1784376000000',
    newbie_shift_request_type: 'reschedule',
    newbie_shift_request_status: 'pending',
    newbie_shift_requested_by: 'tester',
    newbie_shift_request_reason: 'Scheduling conflict',
    newbie_shift_request_details: 'Trainer conflict.',
    newbie_shift_original_scheduled_at: '2026-07-20T10:00:00-05:00',
  });
});

test('repeated intake for an existing pending reschedule reuses the request id', () => {
  const existing = {
    ...scheduledRecord,
    newbie_shift_request_id: 'pending-reschedule-1',
    newbie_shift_request_type: 'reschedule',
    newbie_shift_request_status: 'pending',
    newbie_shift_request_created_at: '2026-07-17T12:00:00Z',
  };
  const draft = buildNewbieShiftRescheduleSession(existing, { requestedBy: 'candidate', reason: 'Illness' }, '2026-07-18T12:00:00Z');
  expect(draft.newbie_shift_request_id).toBe('pending-reschedule-1');
  expect(draft.newbie_shift_request_created_at).toBe('2026-07-17T12:00:00Z');
});

test('a resolved reschedule gets a fresh request id and the latest approved schedule as its original', () => {
  const resolved = {
    ...scheduledRecord,
    newbie_shift_request_id: 'resolved-reschedule-1',
    newbie_shift_request_type: 'reschedule',
    newbie_shift_request_status: 'approved',
    newbie_shift_scheduled_at: '2026-07-25T11:00:00-04:00',
    newbie_shift_original_scheduled_at: '2026-07-20T10:00:00-05:00',
    newbie_shift_resulting_attempt: 2,
  };
  const draft = buildNewbieShiftRescheduleSession(
    resolved,
    { requestedBy: 'candidate', reason: 'Illness' },
    '2026-07-22T12:00:00Z'
  );

  expect(draft.newbie_shift_request_id).toBe('newbie-reschedule-history-1-1784721600000');
  expect(draft.newbie_shift_request_id).not.toBe('resolved-reschedule-1');
  expect(draft.newbie_shift_original_scheduled_at).toBe('2026-07-25T11:00:00-04:00');
  expect(draft.newbie_shift_current_attempt).toBe(2);
});
