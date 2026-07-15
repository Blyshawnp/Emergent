import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getNearestPendingRequestSuppressionExpiry,
  loadPendingRequestSuppressions,
  normalizePendingRequestSuppressions,
  prunePendingRequestSuppressions,
  savePendingRequestSuppressions,
  selectPendingRequestAlert,
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
}) {
  const [suppressions, setSuppressions] = useState(() => (
    loadPendingRequestSuppressions(typeof window === 'undefined' ? null : window.localStorage)
  ));
  const [handledRequestIds, setHandledRequestIds] = useState([]);
  const [closedForCycle, setClosedForCycle] = useState(false);

  useEffect(() => {
    setHandledRequestIds([]);
    setClosedForCycle(false);
  }, [refreshCycle]);

  useEffect(() => {
    if (!requestsAvailable) return;
    setSuppressions((current) => {
      const next = prunePendingRequestSuppressions(current, requests);
      savePendingRequestSuppressions(window.localStorage, next);
      return entriesEqual(current, next) ? current : next;
    });
  }, [requests, requestsAvailable]);

  useEffect(() => {
    const now = Date.now();
    const nearestExpiry = getNearestPendingRequestSuppressionExpiry(suppressions, now);
    if (!nearestExpiry) return undefined;
    const delay = Math.min(MAX_BROWSER_TIMER_MS, Math.max(1, nearestExpiry - now));
    const timer = window.setTimeout(() => {
      setSuppressions((current) => {
        const currentTime = Date.now();
        const next = requestsAvailable
          ? prunePendingRequestSuppressions(current, requests, currentTime)
          : normalizePendingRequestSuppressions(current, currentTime);
        savePendingRequestSuppressions(window.localStorage, next, currentTime);
        return entriesEqual(current, next) ? current : next;
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [requests, requestsAvailable, suppressions]);

  const activeRequest = useMemo(() => (
    closedForCycle ? null : selectPendingRequestAlert(requests, suppressions, handledRequestIds)
  ), [closedForCycle, handledRequestIds, requests, suppressions]);
  const activeRequestId = String(activeRequest?.request_id || '');

  const closeImmediateAlert = useCallback(() => {
    setClosedForCycle(true);
  }, []);

  useEffect(() => {
    if (!activeRequestId) return undefined;
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeImmediateAlert();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeRequestId, closeImmediateAlert]);

  const suppressActiveRequest = useCallback((suppressionType) => {
    if (!activeRequestId) return;
    const now = Date.now();
    setSuppressions((current) => {
      const next = suppressPendingRequest(current, activeRequestId, suppressionType, now);
      savePendingRequestSuppressions(window.localStorage, next, now);
      return next;
    });
  }, [activeRequestId]);

  const viewActiveRequest = useCallback(() => {
    if (!activeRequest) return;
    setHandledRequestIds((current) => (
      current.includes(activeRequestId) ? current : [...current, activeRequestId]
    ));
    onView?.(activeRequest);
  }, [activeRequest, activeRequestId, onView]);

  if (!activeRequest) return null;

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
        <strong id="sam-pending-request-alert-title">Pending Requests await review.</strong>
        <span id="sam-pending-request-alert-description">
          {activeRequest.categoryLabel || 'A pending request'} is ready in the Pending Requests inbox.
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
