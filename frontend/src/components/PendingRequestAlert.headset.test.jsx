import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import PendingRequestAlert from './PendingRequestAlert';
import {
  HEADSET_REVIEW_REMINDER_MS,
  HEADSET_REVIEW_REMINDER_STORAGE_KEY,
} from '../utils/notificationManager';

global.IS_REACT_ACT_ENVIRONMENT = true;

const reviews = [
  { review_id: 'review-one', brand: 'Example Brand', model: 'Model One', status: 'pending' },
  { review_id: 'review-two', brand: 'Private Brand', model: 'Model Two', status: 'pending' },
];

describe('grouped headset review reminder cadence', () => {
  let container;
  let root;

  const renderAlert = (props = {}) => {
    if (!container) {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
    act(() => {
      root.render(<PendingRequestAlert requests={[]} refreshCycle={1} headsetReviews={reviews} {...props} />);
    });
  };

  const click = (label) => {
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent.trim() === label);
    expect(button).toBeTruthy();
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  };

  const unmount = () => {
    if (root) act(() => root.unmount());
    container?.remove();
    root = null;
    container = null;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    unmount();
    jest.useRealTimers();
  });

  test('groups multiple headsets into one immediate alert and repeats after two hours', () => {
    renderAlert();
    expect(container.querySelectorAll('[data-testid="sam-headset-review-alert"]')).toHaveLength(1);
    expect(container.textContent).toContain('2 headset reviews are waiting.');

    click('Remind Me in 2 Hours');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const storedText = sessionStorage.getItem(HEADSET_REVIEW_REMINDER_STORAGE_KEY);
    const stored = JSON.parse(storedText);
    expect(stored.next_eligible_at).toBe(Date.now() + HEADSET_REVIEW_REMINDER_MS);
    expect(storedText).not.toContain('Example Brand');
    expect(storedText).not.toContain('Private Brand');

    act(() => jest.advanceTimersByTime(HEADSET_REVIEW_REMINDER_MS - 1));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    act(() => jest.advanceTimersByTime(1));
    expect(container.textContent).toContain('2 headset reviews are waiting.');
  });

  test('alerts once per SAM session and opening Headset Review acknowledges the group', () => {
    const onViewHeadsets = jest.fn();
    renderAlert({ onViewHeadsets });
    click('Open Headset Review');
    expect(onViewHeadsets).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    unmount();
    renderAlert({ onViewHeadsets });
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    unmount();
    sessionStorage.clear();
    renderAlert({ onViewHeadsets });
    expect(container.textContent).toContain('2 headset reviews are waiting.');
  });

  test('resolution clears headset suppression metadata without affecting workflow storage', () => {
    localStorage.setItem('workflow-test-key', 'still-present');
    renderAlert();
    click('Remind Me in 2 Hours');
    expect(sessionStorage.getItem(HEADSET_REVIEW_REMINDER_STORAGE_KEY)).not.toBeNull();

    renderAlert({ headsetReviews: [] });
    expect(sessionStorage.getItem(HEADSET_REVIEW_REMINDER_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem('workflow-test-key')).toBe('still-present');
  });
});
