const {
  validateNotification,
  normalizeManagerNotification,
  createEmptyNotification,
  toTwelveHour,
  parseTimeForValidation,
  buildEasternDateTime,
  serializeNotificationsToCsv,
  parseManagerCsv,
  isExpiredNotification,
} = require('./notificationManager');

describe('SAM Notification Date/Time and Expiration Scheduling', () => {
  test('parseTimeForValidation handles 24-hour, 12-hour, compact, and AM/PM time strings', () => {
    expect(parseTimeForValidation('05:34')).toEqual({ hours: 5, minutes: 34, seconds: 0 });
    expect(parseTimeForValidation('5:34')).toEqual({ hours: 5, minutes: 34, seconds: 0 });
    expect(parseTimeForValidation('17:34')).toEqual({ hours: 17, minutes: 34, seconds: 0 });
    expect(parseTimeForValidation('5:34 AM')).toEqual({ hours: 5, minutes: 34, seconds: 0 });
    expect(parseTimeForValidation('5:34 PM')).toEqual({ hours: 17, minutes: 34, seconds: 0 });
    expect(parseTimeForValidation('534AM')).toEqual({ hours: 5, minutes: 34, seconds: 0 });
    expect(parseTimeForValidation('534pm')).toEqual({ hours: 17, minutes: 34, seconds: 0 });
    expect(parseTimeForValidation('12:00 AM')).toEqual({ hours: 0, minutes: 0, seconds: 0 });
    expect(parseTimeForValidation('12:00 PM')).toEqual({ hours: 12, minutes: 0, seconds: 0 });
  });

  test('toTwelveHour converts HH:mm properly without corrupting time', () => {
    expect(toTwelveHour('05:34')).toBe('5:34 AM');
    expect(toTwelveHour('17:34')).toBe('5:34 PM');
    expect(toTwelveHour('00:00')).toBe('12:00 AM');
    expect(toTwelveHour('12:00')).toBe('12:00 PM');
    expect(toTwelveHour('534am')).toBe('5:34 AM');
  });

  test('Start-time round trip preserves time across normalization', () => {
    const item = {
      Enabled: true,
      ID: 'notif-1',
      Type: 'info',
      Message: 'Test message',
      StartDate: '2026-08-21',
      StartTime: '5:34 AM',
      EndDate: '',
      EndTime: '',
    };
    const normalized = normalizeManagerNotification(item);
    expect(normalized.StartDate).toBe('2026-08-21');
    expect(normalized.StartTime).toBe('5:34 AM');
    expect(normalized.EndDate).toBe('');
    expect(normalized.EndTime).toBe('');

    const validation = validateNotification(normalized);
    expect(validation.errors).toEqual([]);
    expect(validation.startsAt).not.toBeNull();
    expect(validation.expiresAt).toBeNull();
  });

  test('No-expiration round trip keeps expires_at null and empty strings', () => {
    const item = {
      Enabled: true,
      ID: 'notif-no-exp',
      Type: 'info',
      Message: 'No expiration notification',
      StartDate: '2026-08-21',
      StartTime: '9:00 AM',
      EndDate: '',
      EndTime: '',
    };
    const normalized = normalizeManagerNotification(item);
    expect(normalized.EndDate).toBe('');
    expect(normalized.EndTime).toBe('');

    const validation = validateNotification(normalized);
    expect(validation.errors).toEqual([]);
    expect(validation.expiresAt).toBeNull();
  });

  test('Expiration round trip constructs valid timestamp when both date and time present', () => {
    const item = {
      Enabled: true,
      ID: 'notif-exp',
      Type: 'warning',
      Message: 'Expires at 5 PM',
      StartDate: '2026-08-21',
      StartTime: '9:00 AM',
      EndDate: '2026-08-21',
      EndTime: '5:00 PM',
    };
    const validation = validateNotification(item);
    expect(validation.errors).toEqual([]);
    expect(validation.startsAt).not.toBeNull();
    expect(validation.expiresAt).not.toBeNull();
    expect(validation.expiresAt > validation.startsAt).toBe(true);
  });

  test('Invalid expiration before start returns error', () => {
    const item = {
      Enabled: true,
      ID: 'notif-invalid',
      Type: 'info',
      Message: 'Invalid schedule',
      StartDate: '2026-08-21',
      StartTime: '5:00 PM',
      EndDate: '2026-08-21',
      EndTime: '9:00 AM',
    };
    const validation = validateNotification(item);
    expect(validation.errors).toContain('Expires At must be after Starts At.');
  });

  test('Same start and expiration time returns error', () => {
    const item = {
      Enabled: true,
      ID: 'notif-same',
      Type: 'info',
      Message: 'Same time',
      StartDate: '2026-08-21',
      StartTime: '9:00 AM',
      EndDate: '2026-08-21',
      EndTime: '9:00 AM',
    };
    const validation = validateNotification(item);
    expect(validation.errors).toContain('Expires At must be after Starts At.');
  });

  test('Next-day expiration is valid', () => {
    const item = {
      Enabled: true,
      ID: 'notif-next-day',
      Type: 'info',
      Message: 'Next day expiry',
      StartDate: '2026-08-21',
      StartTime: '11:00 PM',
      EndDate: '2026-08-22',
      EndTime: '8:00 AM',
    };
    const validation = validateNotification(item);
    expect(validation.errors).toEqual([]);
    expect(validation.expiresAt > validation.startsAt).toBe(true);
  });

  test('Partial expiration: date present but time missing returns clear validation error', () => {
    const item = {
      Enabled: true,
      ID: 'notif-missing-time',
      Type: 'info',
      Message: 'Missing expiry time',
      StartDate: '2026-08-21',
      StartTime: '9:00 AM',
      EndDate: '2026-08-22',
      EndTime: '',
    };
    const validation = validateNotification(item);
    expect(validation.errors).toContain('Enter an expiration time or choose No Expiration.');
  });

  test('Partial expiration: time present but date missing returns clear validation error', () => {
    const item = {
      Enabled: true,
      ID: 'notif-missing-date',
      Type: 'info',
      Message: 'Missing expiry date',
      StartDate: '2026-08-21',
      StartTime: '9:00 AM',
      EndDate: '',
      EndTime: '5:00 PM',
    };
    const validation = validateNotification(item);
    expect(validation.errors).toContain('Enter an expiration date or choose No Expiration.');
  });

  test('Disable without expiration succeeds with 0 validation errors', () => {
    const existing = {
      Enabled: true,
      ID: 'notif-active',
      Type: 'info',
      Message: 'Disable me',
      StartDate: '2026-08-21',
      StartTime: '5:34 AM',
      EndDate: '',
      EndTime: '',
    };
    const disabled = normalizeManagerNotification({
      ...existing,
      Enabled: false,
      UpdatedAt: new Date().toISOString(),
    });
    const validation = validateNotification(disabled);
    expect(validation.errors).toEqual([]);
    expect(disabled.Enabled).toBe(false);
    expect(disabled.EndDate).toBe('');
    expect(disabled.EndTime).toBe('');
  });

  test('Disable with expiration preserves schedule and succeeds with 0 validation errors', () => {
    const existing = {
      Enabled: true,
      ID: 'notif-active-exp',
      Type: 'info',
      Message: 'Disable me with exp',
      StartDate: '2026-08-21',
      StartTime: '9:00 AM',
      EndDate: '2026-08-22',
      EndTime: '5:00 PM',
    };
    const disabled = normalizeManagerNotification({
      ...existing,
      Enabled: false,
      UpdatedAt: new Date().toISOString(),
    });
    const validation = validateNotification(disabled);
    expect(validation.errors).toEqual([]);
    expect(disabled.Enabled).toBe(false);
    expect(disabled.EndDate).toBe('2026-08-22');
    expect(disabled.EndTime).toBe('5:00 PM');
  });

  test('Edit start time only without changing expiration succeeds', () => {
    const existing = {
      Enabled: true,
      ID: 'notif-edit-start',
      Type: 'info',
      Message: 'Edit start time only',
      StartDate: '2026-08-21',
      StartTime: '5:34 AM',
      EndDate: '',
      EndTime: '',
    };
    const edited = normalizeManagerNotification({
      ...existing,
      StartTime: '6:00 AM',
    });
    const validation = validateNotification(edited);
    expect(validation.errors).toEqual([]);
    expect(edited.StartTime).toBe('6:00 AM');
    expect(edited.EndDate).toBe('');
    expect(edited.EndTime).toBe('');
  });

  test('CSV serialization does not output 12:00 AM for items with no expiration', () => {
    const item = {
      Enabled: true,
      ID: 'notif-csv',
      Type: 'info',
      Title: 'Title',
      Message: 'Message',
      StartDate: '2026-08-21',
      StartTime: '9:00 AM',
      EndDate: '',
      EndTime: '',
    };
    const csv = serializeNotificationsToCsv([item]);
    expect(csv).not.toContain('12:00 AM');

    const parsed = parseManagerCsv(csv);
    expect(parsed[0].EndDate).toBe('');
    expect(parsed[0].EndTime).toBe('');
  });
});
