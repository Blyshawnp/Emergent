import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NotificationEditorModal } from './NotificationManagerApp';
import {
  canonicalizeNotificationDate,
  canonicalizeNotificationTime,
  normalizeManagerNotification,
  validateNotification,
} from './utils/notificationManager';

global.IS_REACT_ACT_ENVIRONMENT = true;

describe('NotificationEditorModal Component Tests', () => {
  let container;
  let root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    container = null;
  });

  test('load API notification with no expiration -> renders empty expiration controls and no phantom 12:00 AM', () => {
    const rawApiItem = {
      ID: 'notif-1',
      Title: 'Test Notice',
      Message: 'This is a test notice',
      Enabled: true,
      Type: 'info',
      StartDate: '2026-05-01',
      StartTime: '4:03 AM',
      EndDate: '',
      EndTime: '',
    };

    const normalized = normalizeManagerNotification(rawApiItem);
    expect(normalized.StartDate).toBe('2026-05-01');
    expect(normalized.StartTime).toBe('4:03 AM');
    expect(normalized.EndDate).toBe('');
    expect(normalized.EndTime).toBe('');

    const validation = validateNotification(normalized);
    expect(validation.errors).toEqual([]);

    act(() => {
      root.render(
        <NotificationEditorModal
          open={true}
          selectedItem={normalized}
          validation={validation}
          sheetState={{ writeReady: true }}
          updateSelected={() => {}}
          onSubmit={() => {}}
          onDelete={() => {}}
          onClose={() => {}}
        />
      );
    });

    const startDateInput = document.getElementById('nm-start-date');
    const startTimeInput = document.getElementById('nm-start-time');
    const endDateInput = document.getElementById('nm-end-date');
    const endTimeInput = document.getElementById('nm-end-time');

    expect(startDateInput.value).toBe('2026-05-01');
    expect(startTimeInput.value).toBe('4:03 AM');
    expect(endDateInput.value).toBe('');
    expect(endTimeInput.value).toBe('');
    expect(endTimeInput.placeholder).not.toBe('12:00 AM');
  });

  test('save unchanged with no expiration keeps EndDate and EndTime empty', () => {
    const rawApiItem = {
      ID: 'notif-no-exp',
      Title: 'No Expiration Notice',
      Message: 'Active indefinitely',
      Enabled: true,
      Type: 'info',
      StartDate: '2026-05-01',
      StartTime: '4:03 AM',
      EndDate: '',
      EndTime: '',
    };

    let draft = normalizeManagerNotification(rawApiItem);
    const updateSelected = (patch) => {
      draft = normalizeManagerNotification({ ...draft, ...patch });
    };

    let submittedPayload = null;
    const onSubmit = () => {
      submittedPayload = { ...draft };
    };

    act(() => {
      root.render(
        <NotificationEditorModal
          open={true}
          selectedItem={draft}
          validation={validateNotification(draft)}
          sheetState={{ writeReady: true }}
          updateSelected={updateSelected}
          onSubmit={onSubmit}
          onDelete={() => {}}
          onClose={() => {}}
        />
      );
    });

    const submitBtn = document.querySelector('.nm-btn-success');
    expect(submitBtn).not.toBeNull();
    act(() => {
      submitBtn.click();
    });

    expect(submittedPayload).not.toBeNull();
    expect(submittedPayload.StartDate).toBe('2026-05-01');
    expect(submittedPayload.StartTime).toBe('4:03 AM');
    expect(submittedPayload.EndDate).toBe('');
    expect(submittedPayload.EndTime).toBe('');
  });

  test('load API notification with expiration -> fields show exact canonical values', () => {
    const rawApiItem = {
      ID: 'notif-with-exp',
      Title: 'Expiring Notice',
      Message: 'Expires soon',
      Enabled: true,
      Type: 'warning',
      StartDate: '2026-08-21',
      StartTime: '9:18 AM',
      EndDate: '2026-08-22',
      EndTime: '5:45 PM',
    };

    const normalized = normalizeManagerNotification(rawApiItem);
    expect(normalized.StartDate).toBe('2026-08-21');
    expect(normalized.StartTime).toBe('9:18 AM');
    expect(normalized.EndDate).toBe('2026-08-22');
    expect(normalized.EndTime).toBe('5:45 PM');

    act(() => {
      root.render(
        <NotificationEditorModal
          open={true}
          selectedItem={normalized}
          validation={validateNotification(normalized)}
          sheetState={{ writeReady: true }}
          updateSelected={() => {}}
          onSubmit={() => {}}
          onDelete={() => {}}
          onClose={() => {}}
        />
      );
    });

    const startDateInput = document.getElementById('nm-start-date');
    const startTimeInput = document.getElementById('nm-start-time');
    const endDateInput = document.getElementById('nm-end-date');
    const endTimeInput = document.getElementById('nm-end-time');

    expect(startDateInput.value).toBe('2026-08-21');
    expect(startTimeInput.value).toBe('9:18 AM');
    expect(endDateInput.value).toBe('2026-08-22');
    expect(endTimeInput.value).toBe('5:45 PM');
  });

  test('edit expiration -> payload correct and removing expiration clears both fields', () => {
    let draft = normalizeManagerNotification({
      ID: 'notif-edit',
      Title: 'Draft',
      Message: 'Test message',
      Enabled: true,
      StartDate: '2026-08-21',
      StartTime: '9:00 AM',
      EndDate: '',
      EndTime: '',
    });

    const updateSelected = (patch) => {
      draft = normalizeManagerNotification({ ...draft, ...patch });
      if (patch.EndDate === '') {
        draft.EndDate = '';
        draft.EndTime = '';
      }
    };

    updateSelected({ EndDate: '2026-08-22', EndTime: '3:45 PM' });
    expect(draft.EndDate).toBe('2026-08-22');
    expect(draft.EndTime).toBe('3:45 PM');
    expect(validateNotification(draft).errors).toEqual([]);

    updateSelected({ EndDate: '', EndTime: '' });
    expect(draft.EndDate).toBe('');
    expect(draft.EndTime).toBe('');
    expect(validateNotification(draft).errors).toEqual([]);
  });

  test('switch from expiring notification A to non-expiring notification B leaves no stale date/time', () => {
    const itemA = normalizeManagerNotification({
      ID: 'notif-a',
      Title: 'Expiring A',
      Message: 'Msg A',
      StartDate: '2026-08-20',
      StartTime: '10:00 AM',
      EndDate: '2026-08-25',
      EndTime: '6:00 PM',
    });

    const itemB = normalizeManagerNotification({
      ID: 'notif-b',
      Title: 'Non-expiring B',
      Message: 'Msg B',
      StartDate: '2026-08-21',
      StartTime: '11:00 AM',
      EndDate: '',
      EndTime: '',
    });

    act(() => {
      root.render(
        <NotificationEditorModal
          open={true}
          selectedItem={itemA}
          validation={validateNotification(itemA)}
          sheetState={{ writeReady: true }}
          updateSelected={() => {}}
          onSubmit={() => {}}
          onDelete={() => {}}
          onClose={() => {}}
        />
      );
    });

    expect(document.getElementById('nm-end-date').value).toBe('2026-08-25');
    expect(document.getElementById('nm-end-time').value).toBe('6:00 PM');

    act(() => {
      root.render(
        <NotificationEditorModal
          open={true}
          selectedItem={itemB}
          validation={validateNotification(itemB)}
          sheetState={{ writeReady: true }}
          updateSelected={() => {}}
          onSubmit={() => {}}
          onDelete={() => {}}
          onClose={() => {}}
        />
      );
    });

    expect(document.getElementById('nm-end-date').value).toBe('');
    expect(document.getElementById('nm-end-time').value).toBe('');
  });

  test('exact time round trips retain semantic values', () => {
    const testTimes = ['5:34 AM', '12:00 AM', '12:00 PM', '3:45 PM', '11:59 PM'];
    for (const time of testTimes) {
      const canonical = canonicalizeNotificationTime(time);
      expect(canonical).toBe(time);

      const norm = normalizeManagerNotification({
        ID: 'test',
        Message: 'Test',
        StartDate: '2026-08-21',
        StartTime: time,
        EndDate: '2026-08-22',
        EndTime: time,
      });
      expect(norm.StartTime).toBe(time);
      expect(norm.EndTime).toBe(time);
    }
  });

  test('partial expiration validation errors', () => {
    const dateOnly = normalizeManagerNotification({
      ID: 'test',
      Message: 'Test',
      StartDate: '2026-08-21',
      StartTime: '9:00 AM',
      EndDate: '2026-08-22',
      EndTime: '',
    });
    expect(validateNotification(dateOnly).errors).toContain('Enter an expiration time or choose No Expiration.');

    const timeOnly = normalizeManagerNotification({
      ID: 'test',
      Message: 'Test',
      StartDate: '2026-08-21',
      StartTime: '9:00 AM',
      EndDate: '',
      EndTime: '5:00 PM',
    });
    expect(validateNotification(timeOnly).errors).toContain('Enter an expiration date or choose No Expiration.');
  });
});
