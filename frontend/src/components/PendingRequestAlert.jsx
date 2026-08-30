import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HEADSET_REVIEW_REMINDER_STORAGE_KEY,
  getHeadsetReviewReminderSignature,
  getNearestPendingRequestSuppressionExpiry,
  loadHeadsetReviewReminder,
  loadPendingRequestSuppressions,
  normalizePendingRequestSuppressions,
  prunePendingRequestSuppressions,
  savePendingRequestSuppressions,
  saveHeadsetReviewReminder,
  selectPendingRequestAlert,
  shouldDisplayHeadsetAlert,
  suppressPendingRequest,
} from '../utils/notificationManager';

const MAX_BROWSER_TIMER_MS = 2_147_483_647;

function entriesEqual(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

export default function PendingRequestAlert({
  requests,
  requestsAvailable = true,
  refreshCycle = 0,
  onView,
  onAlertSound,
  headsetReviews = [],
  headsetReviewsAvailable = true,
  onViewHeadsets,
  headsetNotificationMode = 'all',
}) {
  const [suppressions, setSuppressions] = useState(() => (
    loadPendingRequestSuppressions(typeof window === 'undefined' ? null : window.localStorage)
  ));
  const [workflowAlert, setWorkflowAlert] = useState(null);
  const workflowBaselineReadyRef = useRef(false);
  const seenWorkflowRequestIdsRef = useRef(new Set());
  const [headsetReminder, setHeadsetReminder] = useState(() => (
    loadHeadsetReviewReminder(typeof window === 'undefined' ? null : window.sessionStorage)
  ));
  const [reminderClock, setReminderClock] = useState(() => Date.now());
  const headsetSignature = useMemo(() => getHeadsetReviewReminderSignature(headsetReviews), [headsetReviews]);
  const headsetCount = Array.isArray(headsetReviews) ? headsetReviews.filter((review) => String(review?.status || 'pending').toLowerCase() === 'pending').length : 0;

  useEffect(() => {
    if (!requestsAvailable) return;
    const unresolved = (Array.isArray(requests) ? requests : []).filter((request) => (
      String(request?.request_id || '').trim()
      && String(request?.raw_status || request?.status || '').trim().toLowerCase() === 'pending'
    ));
    const unresolvedIds = new Set(unresolved.map((request) => String(request.request_id)));
    setWorkflowAlert((current) => {
      if (!current) return current;
      const ids = current.ids.filter((requestId) => unresolvedIds.has(requestId));
      return ids.length ? { ...current, ids } : null;
    });

    if (!workflowBaselineReadyRef.current) {
      workflowBaselineReadyRef.current = true;
      unresolvedIds.forEach((requestId) => seenWorkflowRequestIdsRef.current.add(requestId));
      if (unresolved.length) {
        setWorkflowAlert({ ids: Array.from(unresolvedIds), startup: true });
        onAlertSound?.();
      }
      return;
    }

    const newIds = Array.from(unresolvedIds).filter((requestId) => !seenWorkflowRequestIdsRef.current.has(requestId));
    unresolvedIds.forEach((requestId) => seenWorkflowRequestIdsRef.current.add(requestId));
    if (newIds.length) {
      setWorkflowAlert({ ids: newIds, startup: false });
      onAlertSound?.();
    }
  }, [onAlertSound, refreshCycle, requests, requestsAvailable]);

  useEffect(() => {
    if (!requestsAvailable) return;
    setSuppressions((current) => {
      const next = prunePendingRequestSuppressions(current, requests);
      savePendingRequestSuppressions(window.localStorage, next);
      return entriesEqual(current, next) ? current : next;
    });
  }, [requests, requestsAvailable]);

  useEffect(() => {
    if (!headsetReviewsAvailable) return;
    if (!headsetSignature) {
      window.sessionStorage.removeItem(HEADSET_REVIEW_REMINDER_STORAGE_KEY);
      setHeadsetReminder(null);
      return;
    }
    setHeadsetReminder((current) => {
      if (current?.signature === headsetSignature) return current;
      return { signature: headsetSignature, next_eligible_at: 0 };
    });
  }, [headsetReviewsAvailable, headsetSignature]);

  useEffect(() => {
    const now = Date.now();
    const nearestExpiry = getNearestPendingRequestSuppressionExpiry(suppressions, now);
    const headsetExpiry = headsetReminder?.signature === headsetSignature
      ? Number(headsetReminder.next_eligible_at || 0)
      : 0;
    const futureExpiries = [nearestExpiry, headsetExpiry].filter((expiry) => expiry && expiry > now);
    if (!futureExpiries.length) return undefined;
    const delay = Math.min(MAX_BROWSER_TIMER_MS, Math.max(1, Math.min(...futureExpiries) - now));
    const timer = window.setTimeout(() => {
      setSuppressions((current) => {
        const currentTime = Date.now();
        const next = requestsAvailable
          ? prunePendingRequestSuppressions(current, requests, currentTime)
          : normalizePendingRequestSuppressions(current, currentTime);
        savePendingRequestSuppressions(window.localStorage, next, currentTime);
        return entriesEqual(current, next) ? current : next;
      });
      setReminderClock(Date.now());
    }, delay);
    return () => window.clearTimeout(timer);
  }, [headsetReminder, headsetSignature, requests, requestsAvailable, suppressions]);

  const activeRequest = useMemo(() => (
    selectPendingRequestAlert(
      (Array.isArray(requests) ? requests : []).filter((request) => workflowAlert?.ids?.includes(String(request?.request_id || ''))),
      suppressions,
    )
  ), [requests, suppressions, workflowAlert]);
  const activeRequestId = String(activeRequest?.request_id || '');
  const shouldAlertHeadset = shouldDisplayHeadsetAlert(headsetNotificationMode, headsetCount, headsetReviews);
  const activeHeadsetReminder = !activeRequest
    && !workflowAlert
    && headsetReviewsAvailable
    && shouldAlertHeadset
    && (!headsetReminder || headsetReminder.signature !== headsetSignature || Number(headsetReminder.next_eligible_at || 0) <= reminderClock);

  const closeImmediateAlert = useCallback(() => {
    setWorkflowAlert(null);
  }, []);

  useEffect(() => {
    if (!activeRequestId && !activeHeadsetReminder) return undefined;
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeImmediateAlert();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeHeadsetReminder, activeRequestId, closeImmediateAlert]);

  const suppressHeadsetReminder = useCallback(() => {
    const next = saveHeadsetReviewReminder(window.sessionStorage, headsetSignature);
    setHeadsetReminder(next);
    setReminderClock(Date.now());
  }, [headsetSignature]);

  const suppressActiveRequest = useCallback((suppressionType) => {
    if (!activeRequestId) return;
    const now = Date.now();
    setSuppressions((current) => {
      const next = suppressPendingRequest(current, activeRequestId, suppressionType, now);
      savePendingRequestSuppressions(window.localStorage, next, now);
      return next;
    });
    setWorkflowAlert(null);
  }, [activeRequestId]);

  const viewActiveRequest = useCallback(() => {
    if (!activeRequest) return;
    setWorkflowAlert(null);
    onView?.(activeRequest);
  }, [activeRequest, onView]);

  if (!activeRequest && !activeHeadsetReminder) return null;

  if (activeHeadsetReminder) {
    return (
      <section className="nm-status-card nm-pending-request-alert is-warning" role="dialog" aria-modal="false" aria-labelledby="sam-headset-reminder-title" data-testid="sam-headset-review-alert">
        <div className="nm-status-card-main">
          <strong id="sam-headset-reminder-title">{headsetCount} headset review{headsetCount === 1 ? ' is' : 's are'} waiting.</strong>
          <span>Open Headset Review to approve or deny the grouped pending submissions.</span>
        </div>
        <div className="nm-status-actions">
          <button type="button" className="nm-btn nm-btn-primary nm-btn-table" onClick={() => { suppressHeadsetReminder(); onViewHeadsets?.(); }}>Open Headset Review</button>
          <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={suppressHeadsetReminder}>Remind Me in 2 Hours</button>
        </div>
      </section>
    );
  }

  return (
    <section
      className="nm-status-card nm-pending-request-alert is-warning"
      role="dialog"
      aria-modal="false"
      aria-labelledby="sam-pending-request-alert-title"
      aria-describedby="sam-pending-request-alert-description"
      data-testid="sam-pending-request-alert"
    >
      <div className="nm-status-card-main">
        <strong id="sam-pending-request-alert-title">
          {workflowAlert?.ids?.length === 1 ? '1 request needs review.' : `${workflowAlert?.ids?.length || 0} requests need review.`}
        </strong>
        <span id="sam-pending-request-alert-description">
          {workflowAlert?.startup ? 'SAM found unresolved actionable work at startup.' : `${activeRequest.categoryLabel || 'A pending request'} just arrived.`}
        </span>
      </div>
      <div className="nm-status-actions">
        <button
          type="button"
          className="nm-btn nm-btn-primary nm-btn-table"
          onClick={viewActiveRequest}
          aria-label="View pending request"
        >
          View
        </button>
        <button
          type="button"
          className="nm-btn nm-btn-secondary nm-btn-table"
          onClick={() => suppressActiveRequest('remind')}
          aria-label="Remind me about this pending request in 30 minutes"
        >
          Remind Me in 30 Minutes
        </button>
        <button
          type="button"
          className="nm-btn nm-btn-secondary nm-btn-table"
          onClick={() => suppressActiveRequest('dismiss')}
          aria-label="Dismiss this pending request alert for 30 minutes"
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}
