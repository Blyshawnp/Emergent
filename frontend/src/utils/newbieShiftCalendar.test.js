import { buildNewbieShiftAppointment, buildNewbieShiftCalendarUrl } from './newbieShiftCalendar';

test.each([
  ['10:30 PM', '2026-09-15T02:30:00.000Z', '2026-09-15T03:00:00.000Z'],
  ['10:30 AM', '2026-09-14T14:30:00.000Z', '2026-09-14T15:00:00.000Z'],
  ['12:00 AM', '2026-09-14T04:00:00.000Z', '2026-09-14T04:30:00.000Z'],
  ['12:00 PM', '2026-09-14T16:00:00.000Z', '2026-09-14T16:30:00.000Z'],
  ['1:05 PM', '2026-09-14T17:05:00.000Z', '2026-09-14T17:35:00.000Z'],
  ['11:45 PM', '2026-09-15T03:45:00.000Z', '2026-09-15T04:15:00.000Z'],
])('%s Eastern preserves AM/PM, UTC rollover and thirty-minute duration', (time, startUtc, endUtc) => {
  const appointment = buildNewbieShiftAppointment('2026-09-14', time);
  expect(appointment).toEqual(expect.objectContaining({ startUtc, endUtc, timeZone: 'America/New_York' }));
  const url = new URL(buildNewbieShiftCalendarUrl(appointment, 'Supervisor Test Call - Taylor E.', ''));
  expect(url.searchParams.get('dates')).toMatch(/^\d{8}T\d{6}Z\/\d{8}T\d{6}Z$/);
  expect(url.searchParams.get('ctz')).toBe('America/New_York');
});

test('Eastern standard time uses UTC-5 and configured duration is preserved', () => {
  const appointment = buildNewbieShiftAppointment('12/14/2026', '10:30 PM', 'EST (Eastern)', 45);
  expect(appointment.scheduledAt).toBe('2026-12-14T22:30:00-05:00');
  expect(appointment.startUtc).toBe('2026-12-15T03:30:00.000Z');
  expect(appointment.endUtc).toBe('2026-12-15T04:15:00.000Z');
});

test('DST boundary preserves elapsed duration', () => {
  const appointment = buildNewbieShiftAppointment('03/08/2026', '1:45 AM');
  expect(appointment.startUtc).toBe('2026-03-08T06:45:00.000Z');
  expect(appointment.endUtc).toBe('2026-03-08T07:15:00.000Z');
});

test.each(['CST (Central)', 'MST (Mountain)', 'PST (Pacific)'])('preserves existing %s selection', (zone) => {
  const appointment = buildNewbieShiftAppointment('09/14/2026', '10:30 PM', zone);
  expect(appointment.timeZone).not.toBe('America/New_York');
  expect(new Date(appointment.scheduledAt).toISOString()).toBe(appointment.startUtc);
});

test.each([
  ['ET (Eastern Time)', 'America/New_York'],
  ['CT (Central Time)', 'America/Chicago'],
  ['MT (Mountain Time)', 'America/Denver'],
  ['PT (Pacific Time)', 'America/Los_Angeles'],
])('supports neutral regional label %s', (zone, expectedIana) => {
  const appointment = buildNewbieShiftAppointment('09/14/2026', '10:30 PM', zone);
  expect(appointment.timeZone).toBe(expectedIana);
  expect(new Date(appointment.scheduledAt).toISOString()).toBe(appointment.startUtc);
});

test('09/14/2026 10:30 PM ET produces 20260915T023000Z for Google Calendar', () => {
  const appointment = buildNewbieShiftAppointment('09/14/2026', '10:30 PM', 'ET (Eastern Time)');
  expect(appointment.startUtc).toBe('2026-09-15T02:30:00.000Z');
  const url = new URL(buildNewbieShiftCalendarUrl(appointment, 'Supervisor Test Call', 'Notes'));
  expect(url.searchParams.get('dates')).toBe('20260915T023000Z/20260915T030000Z');
  expect(url.searchParams.get('ctz')).toBe('America/New_York');
});


test.each([
  ['03/08/2026', '2:30 AM'],
  ['02/30/2026', '10:30 AM'],
  ['09/14/2026', '13:30 PM'],
  ['09/14/2026', '10:60 AM'],
  ['', '10:30 PM'],
])('rejects invalid or nonexistent appointment %s %s', (date, time) => {
  expect(buildNewbieShiftAppointment(date, time)).toBeNull();
});

test('Calendar template encodes title and details and contains the required timed UTC values', () => {
  const appointment = buildNewbieShiftAppointment('09/14/2026', '10:30 PM');
  const title = 'Supervisor Test Call - Taylor & Renée';
  const details = 'Line one\nNotes: A&B + #1';
  const url = new URL(buildNewbieShiftCalendarUrl(appointment, title, details));
  expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
  expect(url.searchParams.get('action')).toBe('TEMPLATE');
  expect(url.searchParams.get('text')).toBe(title);
  expect(url.searchParams.get('details')).toBe(details);
  expect(url.searchParams.get('dates')).toBe('20260915T023000Z/20260915T030000Z');
  expect(url.searchParams.get('ctz')).toBe('America/New_York');
});
