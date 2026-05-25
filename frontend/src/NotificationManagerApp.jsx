import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './notification-manager.css';
import api from './api';
import { playSound } from './utils/sound';
import {
  NOTIFICATION_CSV_COLUMNS,
  NOTIFICATION_MANAGER_STORAGE_KEY,
  createEmptyNotification,
  downloadCsv,
  ensureNotificationId,
  getEasternNowDefaults,
  normalizeManagerNotification,
  parseManagerCsv,
  serializeNotificationsToCsv,
  sortManagerItems,
  toTwelveHour,
  validateNotification,
  isExpiredNotification,
} from './utils/notificationManager';

const MANAGER_NOTIFICATION_TYPES = ['info', 'warning', 'urgent'];
const SAM_TITLE = 'S.A.M.';
const SAM_SUBTITLE = 'Smart Alert Manager';
const NOTIFICATION_VIEWS = [
  { key: 'active', label: 'Current' },
  { key: 'disabled', label: 'Disabled / Expired' },
  { key: 'all', label: 'All Notifications' },
];
const BACKEND_READY_TIMEOUT_MS = 45000;
const SAM_TUTORIAL_SEEN_KEY = 'sam:tutorial-seen';
const SAM_HELP_DISMISSED_KEY = 'sam:help-dismissed';
const SAM_ONBOARDING_STATE_KEY = 'sam:onboarding-state';
const SAM_BACKEND_RETRY_LIMIT = 6;
const SAM_BACKEND_RETRY_BASE_DELAY_MS = 2000;
const SAM_BACKEND_RETRY_MAX_DELAY_MS = 12000;
const SAM_TUTORIAL_STEPS = [
  {
    target: 'notification-list',
    title: 'Notification list',
    body: 'Current, disabled, expired, and all alert rows are managed from this table.',
    placement: 'left',
  },
  {
    target: 'add-notification',
    title: 'Add notifications',
    body: 'Add Notification opens the editor in a modal so the main screen stays focused on monitoring.',
    placement: 'bottom',
  },
  {
    target: 'status-chips',
    title: 'Statuses',
    body: 'These chips are passive health and sheet indicators, not controls.',
    placement: 'left',
  },
  {
    target: 'help-access',
    title: 'Help',
    body: 'Open Help for workflow guidance, Google Sheets sync details, and tutorial replay.',
    placement: 'bottom',
  },
  {
    target: 'notification-list',
    title: 'Enable and edit',
    body: 'Use Edit to open the modal. Use Enable or Disable to control whether a row is live.',
    placement: 'left',
  },
];
let notificationStartupSoundAttempted = false;

function getErrorMessage(error, fallback) {
  if (!error) return fallback;
  if (error.response?.data?.error) return error.response.data.error;
  if (error.code === 'ECONNABORTED') return 'Backend startup is taking longer than expected.';
  if (/network error/i.test(error.message || '')) return 'Waiting for backend services to start.';
  return error.message || fallback;
}

function PreviewBanner({ item }) {
  return (
    <div className={`nm-preview-banner ${item.Type === 'warning' ? 'is-warning' : ''} ${item.Type === 'urgent' ? 'is-urgent' : ''}`}>
      <p>{item.Message || 'Banner preview updates as you edit the notification.'}</p>
    </div>
  );
}

function PreviewPopup({ item }) {
  return (
    <div className="nm-preview-popup">
      <h4>{item.Type === 'urgent' ? 'Urgent' : item.Type === 'warning' ? 'Warning' : 'Notification'}</h4>
      <p>{item.Message || 'Popup preview updates as you edit the notification.'}</p>
      {item.ActionText && item.ActionURL ? (
        <div className="nm-actions" style={{ marginTop: 14 }}>
          <button type="button" className="nm-btn nm-btn-primary">{item.ActionText}</button>
          <button type="button" className="nm-btn nm-btn-secondary">Dismiss</button>
        </div>
      ) : (
        <div className="nm-actions" style={{ marginTop: 14 }}>
          <button type="button" className="nm-btn nm-btn-primary">OK</button>
        </div>
      )}
    </div>
  );
}

function getBadgeClass(type) {
  return `nm-badge nm-badge-${type}`;
}

function formatFlags(item) {
  return [
    item.ShowTicker ? 'Ticker' : null,
    item.ShowPopup ? 'Popup' : null,
    item.ShowBanner ? 'Banner' : null,
    item.Persistent ? 'Persistent' : 'Dismissible',
  ].filter(Boolean).join(' · ');
}

function getRowStatusLabel(item) {
  if (isExpiredNotification(item)) return 'Expired';
  return item.Enabled ? 'Enabled' : 'Disabled';
}

function getTickerPreviewMessage(item) {
  if (!item?.Message) return 'Ticker preview text';
  if (item.Type === 'warning') return `WARNING: ${item.Message}`;
  if (item.Type === 'urgent') return `URGENT: ${item.Message}`;
  return item.Message;
}

function isCurrentNotification(item) {
  return Boolean(item?.Enabled) && !isExpiredNotification(item);
}

function getAppVersion() {
  try {
    return window.electronAPI?.getVersion?.() || '1.0.1';
  } catch (_error) {
    return '1.0.1';
  }
}

function HelpModal({ version, onClose, onReplayTutorial }) {
  return (
    <div className="nm-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="nm-help-modal" role="dialog" aria-modal="true" aria-labelledby="sam-help-title">
        <div className="nm-help-header">
          <div>
            <div className="nm-overline">HELP / ABOUT</div>
            <h2 id="sam-help-title">{SAM_TITLE}</h2>
            <p>Smart Alert Manager keeps live alert messages organized for Mock Testing Suite operators.</p>
          </div>
          <button type="button" className="nm-modal-close" onClick={onClose} aria-label="Close help">×</button>
        </div>
        <div className="nm-help-grid">
          <div className="nm-help-card">
            <h3>What SAM Is</h3>
            <p><strong>SAM</strong> = Smart Alert Manager. It manages real-time ticker, popup, and banner alerts used by the main testing workflow.</p>
            <p>Powered by Mock Testing Suite.</p>
            <p>Version {version}</p>
          </div>
          <div className="nm-help-card">
            <h3>Notification Types</h3>
            <p>Info, warning, and urgent levels control visual priority. Ticker, popup, banner, and persistent delivery options decide where the alert appears.</p>
          </div>
          <div className="nm-help-card">
            <h3>Ticker Alerts</h3>
            <p>Ticker messages scroll in the main app. Warning and urgent ticker rows are automatically prefixed so operators can scan them quickly.</p>
          </div>
          <div className="nm-help-card">
            <h3>Popup Alerts</h3>
            <p>Popup rows show as modal-style notifications. Optional action text and URLs create a clear follow-up action for the operator.</p>
          </div>
          <div className="nm-help-card">
            <h3>Scheduling</h3>
            <p>Start and expiration times are interpreted in Eastern Time. Empty expiration fields keep a notification live until it is disabled or removed.</p>
          </div>
          <div className="nm-help-card">
            <h3>Views</h3>
            <p>Current shows enabled, non-expired notifications. Disabled / Expired shows inactive rows. All Notifications keeps the full sheet view available.</p>
          </div>
          <div className="nm-help-card">
            <h3>Create</h3>
            <p>Use Add Notification to open the editor. Fill in the message, delivery options, schedule, and active status, then submit to the sheet.</p>
          </div>
          <div className="nm-help-card">
            <h3>Edit</h3>
            <p>Select or edit a row from the table. The editor opens in a modal and updates the same Google Sheet columns as before.</p>
          </div>
          <div className="nm-help-card">
            <h3>Disable</h3>
            <p>Disable makes a row inactive without deleting it. Re-enable it from the Disabled / Expired or All Notifications view when needed.</p>
          </div>
          <div className="nm-help-card">
            <h3>Google Sheets Sync</h3>
            <p>Refresh reads the configured sheet. Submit writes the selected notification back to the existing sheet schema.</p>
          </div>
          <div className="nm-help-card">
            <h3>Candidate Tracking</h3>
            <p>SAM can be used by admins to review candidate availability signals from shared tracking, including failed-not-final, incomplete, pending supervisor-transfer, and withdrawn candidate states.</p>
          </div>
          <div className="nm-help-card">
            <h3>Pending Sup Transfers</h3>
            <p>Pending supervisor-transfer rows represent candidates whose mock calls were saved but still need transfer completion. Completing or cancelling the pending work changes whether that candidate appears in the shared queue.</p>
          </div>
          <div className="nm-help-card">
            <h3>Attempts and Withdrawal</h3>
            <p>Failed, not-final attempts remain visible for tracking. Withdrawn candidates are not available for active testing until an admin reverses the withdrawal, and granted extra attempts allow the candidate to continue beyond the normal attempt warning.</p>
          </div>
          <div className="nm-help-card">
            <h3>Updates</h3>
            <p>SAM checks the master Google Sheet update-SAM tab for update version, required version, installer URL, release date, title, and multiline release notes. Required updates must be installed before normal use continues.</p>
          </div>
          <div className="nm-help-card">
            <h3>Manual Update Check</h3>
            <p>Use Check for Updates from SAM actions or Help to read the current update-SAM sheet row. Optional updates can be deferred; required updates only allow Update Now.</p>
          </div>
          <div className="nm-help-card">
            <h3>Local Fallback</h3>
            <p>If the sheet cannot be read, SAM keeps a local draft so alerts can still be prepared and exported.</p>
          </div>
          <div className="nm-help-card">
            <h3>Attribution</h3>
            <p>Developer/team: MTS Admin Team</p>
          </div>
        </div>
        <div className="nm-help-actions">
          <button type="button" className="nm-btn nm-btn-secondary" onClick={onReplayTutorial}>Replay Tutorial</button>
          <button type="button" className="nm-btn nm-btn-primary" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}

function formatUpdateNotes(notes) {
  const list = Array.isArray(notes) ? notes.filter(Boolean) : [];
  if (!list.length) return 'No release notes were published.';
  return list.map((note) => `- ${note}`).join('\n');
}

function UpdateModal({ updateInfo, onInstall, onLater }) {
  if (!updateInfo) return null;
  const required = Boolean(updateInfo.required);
  return (
    <div className="nm-modal-backdrop">
      <section className="nm-help-modal nm-update-modal" role="dialog" aria-modal="true">
        <div className="nm-help-header">
          <div>
            <div className="nm-overline">{required ? 'UPDATE REQUIRED' : 'UPDATE AVAILABLE'}</div>
            <h2>{required ? 'Update Required' : 'Update Available'}</h2>
            <p>{updateInfo.releaseTitle || 'A new SAM update is available.'}</p>
          </div>
        </div>
        <div className="nm-update-details">
          <div><strong>Current:</strong> v{updateInfo.currentVersion || '1.0.1'}</div>
          <div><strong>New:</strong> v{updateInfo.latestVersion}</div>
          {updateInfo.requiredVersion ? <div><strong>Required:</strong> v{updateInfo.requiredVersion}</div> : null}
          {updateInfo.releaseDate ? <div><strong>Released:</strong> {updateInfo.releaseDate}</div> : null}
          <pre>{formatUpdateNotes(updateInfo.notes)}</pre>
        </div>
        <div className="nm-help-actions">
          {!required ? <button type="button" className="nm-btn nm-btn-secondary" onClick={onLater}>Later</button> : null}
          <button type="button" className="nm-btn nm-btn-primary" onClick={onInstall}>Update Now</button>
        </div>
      </section>
    </div>
  );
}

const CANDIDATE_VIEW_LABELS = {
  pending: 'Pending Sup Transfers',
  failedNotFinal: 'Failed, Not Final',
  incomplete: 'Incomplete',
  withdrawn: 'Withdrawn',
  extraAttemptGranted: 'Extra Attempt Granted',
  allActive: 'All Active Candidates',
};

function CandidateTrackingPanel({ data, view, onViewChange, loading, onRefresh, onAction }) {
  const rows = data?.views?.[view] || [];
  const setup = data?.setup || {};
  const requiredSetup = Object.entries(setup)
    .map(([tab, headers]) => `${tab}: ${headers.join(', ')}`)
    .join('\n');

  const handleWithdraw = async (row) => {
    const confirmed = window.confirm('Mark this candidate as withdrew from certification?');
    if (!confirmed) return;
    await onAction({ action: 'withdraw', candidate_name: row.candidate_name, session_id: row.session_id || row.latest_session_id, pending_id: row.pending_id });
  };

  const handleExtraAttempt = async (row) => {
    const reason = window.prompt('Reason for granting an extra attempt?') || '';
    await onAction({ action: 'grant_extra_attempt', candidate_name: row.candidate_name, session_id: row.session_id || row.latest_session_id, pending_id: row.pending_id, reason });
  };

  const handleCancel = async (row) => {
    const confirmed = window.confirm('Cancel this pending supervisor transfer?');
    if (!confirmed) return;
    await onAction({ action: 'cancel_pending', candidate_name: row.candidate_name, pending_id: row.pending_id, session_id: row.original_session_id });
  };

  return (
    <section className="nm-panel nm-candidate-panel">
      <div className="nm-section-title">
        <div>
          <h2>Candidate Tracking</h2>
          <div className="nm-kicker">Shared admin queue from Candidate Sessions and Pending Sup Transfers.</div>
        </div>
        <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={onRefresh} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>
      {!data?.ok && data?.error ? (
        <div className="nm-status-card is-warning">
          <strong>Shared tracking unavailable</strong>
          <span>{data.error}</span>
          {requiredSetup ? <pre>{requiredSetup}</pre> : null}
        </div>
      ) : null}
      <div className="nm-view-tabs" role="tablist" aria-label="Candidate tracking views">
        {Object.entries(CANDIDATE_VIEW_LABELS).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`nm-view-tab ${view === key ? 'is-active' : ''}`}
            onClick={() => onViewChange(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="nm-table-wrap">
        <table className="nm-table nm-candidate-table">
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Tester</th>
              <th>Date</th>
              <th>Results</th>
              <th>Notes</th>
              <th className="nm-actions-column">Actions</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length ? (
              <tr><td colSpan={8}><div className="nm-empty">No candidates in this view.</div></td></tr>
            ) : rows.map((row, index) => {
              const results = [row.call_1_result, row.call_2_result, row.call_3_result, row.sup_transfer_1_result, row.sup_transfer_2_result].filter(Boolean).join(', ') || row.mock_call_summary || 'Recorded';
              return (
                <tr key={`${row.pending_id || row.session_id || row.latest_session_id || row.candidate_name}-${index}`}>
                  <td>
                    <div className="nm-row-title">{row.candidate_name || 'Unknown'}</div>
                    <div className="nm-meta">{row.final_attempt || row.final_attempt_risk ? 'Final-attempt risk' : row.extra_attempt_granted ? 'Extra attempt granted' : 'Active'}</div>
                  </td>
                  <td>{row.status || row.latest_status || 'Unknown'}</td>
                  <td>{row.attempt_count ?? row.attempt_number ?? '0'}</td>
                  <td>{row.original_tester_name || row.tester_name || 'Unknown'}</td>
                  <td className="nm-meta">{row.created_at || row.completed_at || row.last_session_date || 'Unknown'}</td>
                  <td className="nm-meta">{results}</td>
                  <td className="nm-meta nm-notes-cell">{row.notes || row.coaching_summary || row.fail_summary || 'None recorded'}</td>
                  <td>
                    <div className="nm-row-actions">
                      {row.pending_id ? <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={() => handleCancel(row)}>Cancel</button> : null}
                      <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={() => handleExtraAttempt(row)}>Extra Attempt</button>
                      <button type="button" className="nm-btn nm-btn-danger nm-btn-table" onClick={() => handleWithdraw(row)}>Withdraw</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function findTutorialTarget(target) {
  if (!target) return null;
  return document.querySelector(`[data-sam-tour="${target}"]`) || document.querySelector(target);
}

function getTargetRect(target) {
  const element = findTutorialTarget(target);
  if (!element) return null;
  return element.getBoundingClientRect();
}

function TutorialOverlay({ step, onNext, onBack, onClose }) {
  const [position, setPosition] = useState(null);
  const item = SAM_TUTORIAL_STEPS[step];

  useEffect(() => {
    if (!item) return undefined;
    let cancelled = false;

    const updatePosition = () => {
      if (cancelled) return;
      const rect = getTargetRect(item.target);
      if (!rect) {
        setPosition({ top: 88, left: 24, width: Math.min(340, window.innerWidth - 48), missing: true });
        return;
      }

      const tooltipWidth = Math.min(340, window.innerWidth - 32);
      const tooltipHeight = 172;
      const gap = 12;
      const centeredLeft = rect.left + rect.width / 2 - tooltipWidth / 2;
      const clampLeft = Math.max(16, Math.min(centeredLeft, window.innerWidth - tooltipWidth - 16));
      const topByPlacement = {
        top: rect.top - tooltipHeight - gap,
        bottom: rect.bottom + gap,
        left: rect.top,
        right: rect.top,
      };
      const leftByPlacement = {
        top: clampLeft,
        bottom: clampLeft,
        left: Math.max(16, rect.left - tooltipWidth - gap),
        right: Math.min(rect.right + gap, window.innerWidth - tooltipWidth - 16),
      };
      const nextTop = Math.max(16, Math.min(topByPlacement[item.placement] ?? rect.bottom + gap, window.innerHeight - tooltipHeight - 16));
      const nextLeft = Math.max(16, Math.min(leftByPlacement[item.placement] ?? clampLeft, window.innerWidth - tooltipWidth - 16));
      setPosition({ top: nextTop, left: nextLeft, width: tooltipWidth });
    };

    const target = findTutorialTarget(item.target);
    if (target?.scrollIntoView) {
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    const timer = window.setTimeout(updatePosition, 80);
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [item, onClose]);

  if (!item || !position) return null;
  const isLast = step >= SAM_TUTORIAL_STEPS.length - 1;

  return (
    <div className="nm-tour-layer" aria-live="polite">
      <div className="nm-tour-card" style={{ top: position.top, left: position.left, width: position.width }}>
        <div className="nm-tour-count">{step + 1} / {SAM_TUTORIAL_STEPS.length}</div>
        <h3>{item.title}</h3>
        <p>{position.missing ? 'This area is not visible right now. Continue to the next available step.' : item.body}</p>
        <div className="nm-tour-actions">
          <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={onClose}>Skip</button>
          <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={onBack} disabled={step === 0}>Back</button>
          <button type="button" className="nm-btn nm-btn-primary nm-btn-table" onClick={onNext}>{isLast ? 'Finish' : 'Next'}</button>
        </div>
      </div>
    </div>
  );
}

function ModalPortal({ children }) {
  const [mountNode, setMountNode] = useState(null);

  useEffect(() => {
    let node = document.getElementById('sam-modal-root');
    if (!node) {
      node = document.createElement('div');
      node.id = 'sam-modal-root';
      document.body.appendChild(node);
    }
    setMountNode(node);
  }, []);

  if (!mountNode) return null;
  return createPortal(children, mountNode);
}

function NotificationEditorModal({
  open,
  selectedItem,
  validation,
  importError,
  sheetState,
  updateSelected,
  onSubmit,
  onDelete,
  onClose,
}) {
  useEffect(() => {
    if (!open) return undefined;
    console.log('[SAM] Rendering NEW modal');
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <ModalPortal>
      <div
        className="nm-editor-modal-layer"
        onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      >
        <section className="nm-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="nm-editor-title">
          <div className="nm-editor-header">
            <div>
              <h3 id="nm-editor-title">Edit Notification</h3>
              <div className="nm-kicker">Choose active status, delivery options, schedule, and sheet-safe notification content.</div>
            </div>
            <div className="nm-editor-title-actions">
              <button type="button" className="nm-btn nm-btn-danger" onClick={onDelete}>Delete</button>
              <button type="button" className="nm-modal-close" onClick={onClose} aria-label="Close editor">×</button>
            </div>
          </div>

          <div className="nm-editor-scroll">
            {selectedItem ? (
              <div className="nm-form-layout">
                <div className="nm-fields">
                  <div className="nm-inline-help">
                    Edit this notification, then use the save bar at the bottom of the form to push only this row to the sheet.
                  </div>

                  <div className="nm-field-grid">
                    <div className="nm-field">
                      <label htmlFor="nm-type">Notification Level</label>
                      <select id="nm-type" value={selectedItem.Type} onChange={(event) => updateSelected({ Type: event.target.value })}>
                        {MANAGER_NOTIFICATION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                      </select>
                    </div>
                    <div className="nm-field">
                      <label htmlFor="nm-id">Notification ID</label>
                      <input
                        id="nm-id"
                        value={selectedItem.ID}
                        onChange={(event) => updateSelected({ ID: event.target.value })}
                        placeholder={validation.id}
                      />
                    </div>
                  </div>

                  <div className="nm-field-full">
                    <label htmlFor="nm-title">Title</label>
                    <input id="nm-title" value={selectedItem.Title} onChange={(event) => updateSelected({ Title: event.target.value })} />
                  </div>

                  <div className="nm-field-full">
                    <label htmlFor="nm-message">Message</label>
                    <textarea id="nm-message" value={selectedItem.Message} onChange={(event) => updateSelected({ Message: event.target.value })} />
                  </div>

                  <div className="nm-active-section" data-sam-tour="active-status">
                    <div>
                      <div className="nm-active-label">Active Status</div>
                      <div className="nm-inline-note">Enabled notifications can go live when their schedule allows it. Disabled rows stay in the sheet but do not display.</div>
                    </div>
                    <label className="nm-switch">
                      <input type="checkbox" checked={selectedItem.Enabled} onChange={(event) => updateSelected({ Enabled: event.target.checked })} />
                      <span>{selectedItem.Enabled ? 'Enabled' : 'Disabled'}</span>
                    </label>
                  </div>

                  <div className="nm-delivery-section">
                    <div className="nm-active-label">Delivery Types</div>
                    <div className="nm-inline">
                      <label className="nm-checkbox"><input type="checkbox" checked={selectedItem.ShowTicker} onChange={(event) => updateSelected({ ShowTicker: event.target.checked })} /> Ticker</label>
                      <label className="nm-checkbox"><input type="checkbox" checked={selectedItem.ShowPopup} onChange={(event) => updateSelected({ ShowPopup: event.target.checked })} /> Show Popup</label>
                      <label className="nm-checkbox"><input type="checkbox" checked={selectedItem.ShowBanner} onChange={(event) => updateSelected({ ShowBanner: event.target.checked })} /> Show Banner</label>
                      <label className="nm-checkbox"><input type="checkbox" checked={selectedItem.Persistent} onChange={(event) => updateSelected({ Persistent: event.target.checked })} /> Persistent</label>
                    </div>
                  </div>

                  <div className="nm-field-grid">
                    <div className="nm-field">
                      <label htmlFor="nm-start-date">Starts At Date</label>
                      <input id="nm-start-date" type="date" value={selectedItem.StartDate} onChange={(event) => updateSelected({ StartDate: event.target.value })} />
                    </div>
                    <div className="nm-field">
                      <label htmlFor="nm-start-time">Starts At Time</label>
                      <input id="nm-start-time" type="text" value={selectedItem.StartTime} onChange={(event) => updateSelected({ StartTime: event.target.value })} placeholder={toTwelveHour('09:00')} />
                    </div>
                    <div className="nm-field">
                      <label htmlFor="nm-end-date">Expires At Date (Optional)</label>
                      <input id="nm-end-date" type="date" value={selectedItem.EndDate} onChange={(event) => updateSelected({ EndDate: event.target.value })} />
                    </div>
                    <div className="nm-field">
                      <label htmlFor="nm-end-time">Expires At Time (Optional)</label>
                      <input id="nm-end-time" type="text" value={selectedItem.EndTime} onChange={(event) => updateSelected({ EndTime: event.target.value })} placeholder="12:00 AM" />
                    </div>
                  </div>

                  <div className="nm-inline">
                    <button
                      type="button"
                      className="nm-btn nm-btn-secondary nm-btn-inline"
                      onClick={() => updateSelected({ EndDate: '', EndTime: '' })}
                    >
                      No Expiration
                    </button>
                    <span className="nm-inline-note">End date and time are optional. Clear them if this notification should stay active until you disable or remove it.</span>
                  </div>

                  <div className="nm-field-grid">
                    <div className="nm-field">
                      <label htmlFor="nm-action-text">Action Text</label>
                      <input id="nm-action-text" value={selectedItem.ActionText} onChange={(event) => updateSelected({ ActionText: event.target.value })} />
                    </div>
                    <div className="nm-field">
                      <label htmlFor="nm-action-url">Action URL</label>
                      <input id="nm-action-url" value={selectedItem.ActionURL} onChange={(event) => updateSelected({ ActionURL: event.target.value })} />
                    </div>
                  </div>

                  {validation.errors.length > 0 ? (
                    <div className="nm-errors">
                      {validation.errors.map((error) => <div key={error} className="nm-error">{error}</div>)}
                    </div>
                  ) : null}
                  {importError ? <div className="nm-error">{importError}</div> : null}
                  {!sheetState.writeReady && sheetState.writeError ? <div className="nm-error">{sheetState.writeError}</div> : null}
                </div>

                <div className="nm-sidecard">
                  <h4>Submit Rules</h4>
                  <ul>
                    <li>`StartDate` defaults to today in Eastern Time.</li>
                    <li>`StartTime` defaults to the current Eastern time.</li>
                    <li>`Expires At` stays blank until you choose an end date.</li>
                    <li>When `EndDate` is set and `EndTime` is blank, submit uses `12:00 AM`.</li>
                    <li>If the `ID` already exists in the sheet, Submit updates that row instead of appending a duplicate.</li>
                    <li>Ticker speed is controlled in Mock Testing Suite Settings, not here.</li>
                  </ul>
                  <h4 style={{ marginTop: 18 }}>Current ID</h4>
                  <p style={{ margin: 0, fontFamily: '"IBM Plex Mono", monospace' }}>{validation.id}</p>
                  {sheetState.sheetId ? (
                    <>
                      <h4 style={{ marginTop: 18 }}>Sheet ID</h4>
                      <p style={{ margin: 0, fontFamily: '"IBM Plex Mono", monospace' }}>{sheetState.sheetId}</p>
                    </>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="nm-empty">Select a notification to edit.</div>
            )}
          </div>

          {selectedItem ? (
            <div className="nm-editor-footer">
              <div className="nm-submit-copy">
                <strong>Save this notification</strong>
                <span>{selectedItem.Title || selectedItem.Message || 'Selected draft notification'}</span>
              </div>
              <button
                type="button"
                className="nm-btn nm-btn-success"
                onClick={onSubmit}
                disabled={!selectedItem || sheetState.isSaving || sheetState.isLoading}
              >
                {sheetState.isSaving ? 'Submitting...' : 'Submit Selected Notification'}
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </ModalPortal>
  );
}

export default function NotificationManagerApp() {
  const fileInputRef = useRef(null);
  const backendStartupRetryRef = useRef({ attempt: 0, timer: null });
  const retryBackendStartupRef = useRef(null);
  const [items, setItems] = useState(() => {
    try {
      const stored = localStorage.getItem(NOTIFICATION_MANAGER_STORAGE_KEY);
      if (!stored) return [createEmptyNotification()];
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed) || !parsed.length) return [createEmptyNotification()];
      return parsed.map(normalizeManagerNotification);
    } catch (_error) {
      return [createEmptyNotification()];
    }
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [importError, setImportError] = useState('');
  const [sheetState, setSheetState] = useState({
    isLoading: true,
    isSaving: false,
    statusKind: '',
    statusMessage: 'Starting backend services...',
    writeReady: false,
    writeError: '',
    readError: '',
    sheetId: '',
    backendReady: false,
    backendStatus: 'initializing',
    backendStartedByNotificationApp: false,
    backendRetryCount: 0,
    tickerSource: '',
  });
  const [notificationView, setNotificationView] = useState('active');
  const [samBannerSrc, setSamBannerSrc] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(null);
  const [appVersion, setAppVersion] = useState(() => getAppVersion());
  const [updateModal, setUpdateModal] = useState(null);
  const [candidateView, setCandidateView] = useState('pending');
  const [candidateTracking, setCandidateTracking] = useState({ ok: true, views: {}, candidates: [], pending: [], error: '' });
  const [candidateTrackingLoading, setCandidateTrackingLoading] = useState(false);
  const closeEditor = useCallback(() => setEditorOpen(false), []);

  const clearBackendStartupRetryTimer = useCallback(() => {
    const timer = backendStartupRetryRef.current.timer;
    if (timer) {
      window.clearTimeout(timer);
      backendStartupRetryRef.current.timer = null;
    }
  }, []);

  const scheduleBackendStartupRetry = useCallback((message) => {
    clearBackendStartupRetryTimer();
    const nextAttempt = backendStartupRetryRef.current.attempt + 1;
    backendStartupRetryRef.current.attempt = nextAttempt;

    if (nextAttempt >= SAM_BACKEND_RETRY_LIMIT) {
      setSheetState((current) => ({
        ...current,
        isLoading: false,
        backendReady: false,
        backendStatus: 'error',
        statusKind: 'warning',
        statusMessage: message || 'Unable to load SAM data. Check connection or Google Sheet permissions. Retry.',
        readError: message || 'Unable to load SAM data. Check connection or Google Sheet permissions.',
      }));
      return false;
    }

    const delay = Math.min(
      SAM_BACKEND_RETRY_MAX_DELAY_MS,
      SAM_BACKEND_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, nextAttempt - 1)),
    );
    const retryMessage = message
      ? `${message} Retrying in ${Math.round(delay / 1000)} seconds.`
      : `Unable to load SAM data. Retrying in ${Math.round(delay / 1000)} seconds.`;

    setSheetState((current) => ({
      ...current,
      isLoading: false,
      backendReady: false,
      backendStatus: 'retrying',
      statusKind: 'warning',
      statusMessage: retryMessage,
      readError: message || current.readError,
    }));

    backendStartupRetryRef.current.timer = window.setTimeout(() => {
      backendStartupRetryRef.current.timer = null;
      void (retryBackendStartupRef.current ? retryBackendStartupRef.current(false) : window.electronAPI?.retryBackendStartup?.());
    }, delay);
    return true;
  }, [clearBackendStartupRetryTimer]);

  const handleInstallUpdate = useCallback(async () => {
    try {
      const result = await window.electronAPI?.installPendingUpdate?.();
      if (!result?.ok) {
        setSheetState((current) => ({
          ...current,
          statusKind: 'error',
          statusMessage: result?.error || 'Unable to launch the update installer.',
        }));
        return;
      }
      if (!updateModal?.required) {
        setUpdateModal(null);
      }
    } catch (error) {
      setSheetState((current) => ({
        ...current,
        statusKind: 'error',
        statusMessage: error instanceof Error ? error.message : 'Unable to launch the update installer.',
      }));
    }
  }, [updateModal]);

  const handleCheckForUpdates = useCallback(async () => {
    try {
      if (!window.electronAPI?.checkForUpdates) {
        setSheetState((current) => ({ ...current, statusKind: 'warning', statusMessage: 'Update checks are available only in the desktop app.' }));
        return;
      }
      const result = await window.electronAPI.checkForUpdates();
      if (!result?.ok) {
        setSheetState((current) => ({ ...current, statusKind: 'warning', statusMessage: result?.error || 'Unable to check for updates right now.' }));
        return;
      }
      if (result.updateAvailable) {
        setUpdateModal(result.updateInfo);
        return;
      }
      setSheetState((current) => ({ ...current, statusKind: 'success', statusMessage: `SAM version ${appVersion} is up to date.` }));
    } catch (error) {
      setSheetState((current) => ({ ...current, statusKind: 'warning', statusMessage: error instanceof Error ? error.message : 'Unable to check for updates right now.' }));
    }
  }, [appVersion]);

  const loadCandidateTracking = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setCandidateTrackingLoading(true);
    try {
      const result = await api.getSharedAdminCandidates();
      setCandidateTracking({
        ok: Boolean(result?.ok),
        views: result?.views || {},
        candidates: result?.candidates || [],
        pending: result?.pending || [],
        error: result?.error || '',
        setup: result?.setup || null,
      });
    } catch (error) {
      setCandidateTracking((current) => ({
        ...current,
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to load shared candidate tracking.',
      }));
    } finally {
      setCandidateTrackingLoading(false);
    }
  }, []);

  const runCandidateAction = useCallback(async (payload) => {
    const result = await api.updateSharedAdminCandidate(payload);
    if (!result?.ok) {
      setSheetState((current) => ({ ...current, statusKind: 'error', statusMessage: result?.error || 'Candidate tracking update failed.' }));
      return;
    }
    setSheetState((current) => ({ ...current, statusKind: 'success', statusMessage: 'Candidate tracking updated in the shared Google Sheet.' }));
    await loadCandidateTracking({ silent: true });
  }, [loadCandidateTracking]);

  useEffect(() => {
    const root = document.getElementById('root');
    document.documentElement.classList.add('notification-manager-html');
    document.body.classList.add('notification-manager-body');
    root?.classList.add('notification-manager-root');
    return () => {
      document.documentElement.classList.remove('notification-manager-html');
      document.body.classList.remove('notification-manager-body');
      root?.classList.remove('notification-manager-root');
    };
  }, []);

  useEffect(() => {
    const handleWindowError = (event) => {
      console.error('[SAM] Renderer error:', event.error || event.message || event);
      setSheetState((current) => ({
        ...current,
        backendReady: false,
        statusKind: 'warning',
        statusMessage: 'SAM encountered an error loading this section.',
      }));
    };

    const handleUnhandledRejection = (event) => {
      console.error('[SAM] Unhandled promise rejection:', event.reason);
      setSheetState((current) => ({
        ...current,
        backendReady: false,
        statusKind: 'warning',
        statusMessage: 'SAM encountered an error loading this section.',
      }));
    };

    window.addEventListener('error', handleWindowError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    return () => {
      window.removeEventListener('error', handleWindowError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(NOTIFICATION_MANAGER_STORAGE_KEY, JSON.stringify(items));
  }, [items]);

  useEffect(() => {
    if (!editorOpen) {
      document.body.classList.remove('nm-dialog-open');
      return undefined;
    }
    console.log('[SAM] Portal editor state open');
    document.body.classList.add('nm-dialog-open');
    return () => document.body.classList.remove('nm-dialog-open');
  }, [editorOpen]);

  useEffect(() => {
    if (!editorOpen) return undefined;
    const legacyEditor = document.querySelector('.nm-form-card.is-editor-modal, .nm-editor-backdrop');
    if (legacyEditor) {
      console.log('[SAM] Rendering OLD editor');
    }
    return undefined;
  }, [editorOpen]);

  useEffect(() => {
    if (notificationStartupSoundAttempted) return undefined;
    notificationStartupSoundAttempted = true;
    let completed = false;

    const tryPlay = async () => {
      if (completed) return;
      const played = await playSound('notificationApp');
      if (played) {
        completed = true;
        window.removeEventListener('pointerdown', tryPlay);
        window.removeEventListener('keydown', tryPlay);
      }
    };

    tryPlay();
    window.addEventListener('pointerdown', tryPlay, { once: true });
    window.addEventListener('keydown', tryPlay, { once: true });
    return () => {
      window.removeEventListener('pointerdown', tryPlay);
      window.removeEventListener('keydown', tryPlay);
    };
  }, []);

  useEffect(() => {
    if (localStorage.getItem(SAM_TUTORIAL_SEEN_KEY) === '1') return;
    const timer = window.setTimeout(() => {
      setTutorialStep(0);
      localStorage.setItem(SAM_TUTORIAL_SEEN_KEY, '1');
      localStorage.setItem(SAM_ONBOARDING_STATE_KEY, 'seen');
    }, 1200);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let isMounted = true;
    window.electronAPI?.getAssetUrl?.('sam-banner.png')
      .then((url) => {
        if (isMounted && url) setSamBannerSrc(url);
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onAppEvent) {
      return undefined;
    }
    return window.electronAPI.onAppEvent(async (type, payload) => {
      try {
        if (type === 'menu:about') {
          if (payload?.version) setAppVersion(payload.version);
          setHelpOpen(true);
          return;
        }
        if (type === 'menu:check-updates') {
          await handleCheckForUpdates();
          return;
        }
        if (type === 'update:available') {
          setUpdateModal(payload);
          return;
        }
        if (type === 'menu:replay-tutorial') {
          replayTutorial();
          return;
        }
        if (type !== 'backend:state') return;
        setSheetState((current) => ({
          ...current,
          backendStatus: payload?.status || current.backendStatus,
          backendStartedByNotificationApp: Boolean(payload?.startedByNotificationApp),
          backendRetryCount: Number(payload?.retryCount || current.backendRetryCount || 0),
        }));
      } catch (error) {
        console.error('[SAM] App event handler failed:', error);
        setSheetState((current) => ({
          ...current,
          statusKind: 'warning',
          statusMessage: 'SAM encountered an error loading this section.',
        }));
      }
    });
  }, [handleCheckForUpdates]);

  const selectedItem = items[selectedIndex] || items[0];
  const validation = useMemo(
    () => (selectedItem ? validateNotification(selectedItem, items) : { errors: [], id: '' }),
    [items, selectedItem],
  );

  const refreshDiagnostics = useCallback(async () => {
    try {
      const status = await api.getConfigStatus();
      setSheetState((current) => ({
        ...current,
        tickerSource: status?.tickerSource || current.tickerSource,
      }));
      return status;
    } catch (_error) {
      return null;
    }
  }, []);

  const loadSheetItems = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setSheetState((current) => ({
        ...current,
        isLoading: true,
        statusKind: '',
        statusMessage: '',
        readError: '',
      }));
    }

    try {
      const response = await api.getManagedNotifications();
      const nextItems = Array.isArray(response?.items)
        ? sortManagerItems(response.items.map(normalizeManagerNotification))
        : [];
      if (nextItems.length > 0) {
        setItems(nextItems);
        setSelectedIndex(0);
      }
      setSheetState((current) => ({
        ...current,
        isLoading: false,
        backendReady: true,
        backendStatus: 'connected',
        writeReady: Boolean(response?.write?.ready),
        writeError: response?.write?.error || '',
        readError: response?.ok === false ? (response?.error || 'Unable to read the configured notification sheet.') : '',
        sheetId: response?.sheet?.sheetId || '',
        statusKind: response?.ok === false ? 'warning' : current.statusKind,
        statusMessage: response?.ok === false ? (response?.error || 'Unable to read the configured notification sheet.') : current.statusMessage,
      }));
      refreshDiagnostics();
    } catch (error) {
      const message = getErrorMessage(error, 'Unable to read the configured notification sheet.');
      setSheetState((current) => ({
        ...current,
        isLoading: false,
        readError: message,
        statusKind: 'error',
        statusMessage: message,
      }));
    }
  }, [refreshDiagnostics]);

  const attemptBackendStartupRetry = useCallback(async (resetAttempt = false) => {
    if (resetAttempt) {
      clearBackendStartupRetryTimer();
      backendStartupRetryRef.current.attempt = 0;
    }
    setSheetState((current) => ({
      ...current,
      isLoading: true,
      backendReady: false,
      backendStatus: 'starting',
      statusKind: 'info',
      statusMessage: 'Retrying SAM startup...',
      readError: '',
    }));

    try {
      const result = await window.electronAPI?.retryBackendStartup?.();
      if (!result?.ok) {
        const message = result?.error || 'Unable to start SAM backend right now.';
        scheduleBackendStartupRetry(message);
        return;
      }

      await refreshDiagnostics();
      await loadSheetItems({ silent: false });
      await loadCandidateTracking({ silent: true });
    } catch (error) {
      const message = getErrorMessage(error, 'Unable to start SAM backend right now.');
      scheduleBackendStartupRetry(message);
    }
  }, [clearBackendStartupRetryTimer, loadCandidateTracking, loadSheetItems, refreshDiagnostics, scheduleBackendStartupRetry]);

  const retryBackendStartup = useCallback(() => attemptBackendStartupRetry(true), [attemptBackendStartupRetry]);

  useEffect(() => {
    retryBackendStartupRef.current = attemptBackendStartupRetry;
    return () => {
      retryBackendStartupRef.current = null;
    };
  }, [attemptBackendStartupRetry]);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    const updateBackendState = async () => {
      try {
        const state = await window.electronAPI?.getBackendState?.();
        if (!cancelled && state) {
          setSheetState((current) => ({
            ...current,
            backendStatus: state.status || current.backendStatus,
            backendStartedByNotificationApp: Boolean(state.startedByNotificationApp),
            backendRetryCount: Number(state.retryCount || current.backendRetryCount || 0),
          }));
        }
      } catch (_error) {}
    };

    const waitForBackend = async () => {
      await updateBackendState();
      try {
        await api.getRuntimeStatus();
        if (cancelled) return;
        setSheetState((current) => ({
          ...current,
          backendReady: true,
          backendStatus: 'connected',
          statusKind: '',
          statusMessage: '',
        }));
        await refreshDiagnostics();
        await loadSheetItems();
        await loadCandidateTracking({ silent: true });
      } catch (error) {
        if (cancelled) return;
        const elapsed = Date.now() - startedAt;
        const timedOut = elapsed >= BACKEND_READY_TIMEOUT_MS;
        const message = timedOut
          ? getErrorMessage(error, 'Backend services are still unavailable. Retrying in the background.')
          : 'Starting backend services...';
        setSheetState((current) => ({
          ...current,
          isLoading: true,
          backendReady: false,
          statusKind: timedOut ? 'warning' : 'info',
          statusMessage: message,
          readError: timedOut ? message : '',
        }));
        scheduleBackendStartupRetry(message);
      }
    };

    waitForBackend();
    return () => {
      cancelled = true;
      clearBackendStartupRetryTimer();
    };
  }, [clearBackendStartupRetryTimer, loadCandidateTracking, loadSheetItems, refreshDiagnostics, scheduleBackendStartupRetry]);

  const selectNotification = (index) => {
    setSelectedIndex(index);
  };

  const openEditor = (index = selectedIndex) => {
    if (Number.isInteger(index)) {
      setSelectedIndex(index);
    }
    setEditorOpen(true);
  };

  const persistNotification = useCallback(async (item, { successMessage = '' } = {}) => {
    const outgoing = normalizeManagerNotification({
      ...item,
      ID: item?.ID || ensureNotificationId(item),
      UpdatedAt: new Date().toISOString(),
    });

    setSheetState((current) => ({
      ...current,
      isSaving: true,
      statusKind: '',
      statusMessage: '',
    }));

    try {
      const result = await api.saveManagedNotification(outgoing);
      if (!result?.ok) {
        setSheetState((current) => ({
          ...current,
          isSaving: false,
          statusKind: 'error',
          statusMessage: result?.error || 'The backend did not confirm a successful sheet write.',
        }));
        return null;
      }

      const savedItem = normalizeManagerNotification(result.item || outgoing);
      setItems((current) => {
        const replaced = current.some((entry) => entry.ID === savedItem.ID)
          ? current.map((entry) => (entry.ID === savedItem.ID ? savedItem : entry))
          : current.map((entry, index) => (index === selectedIndex ? savedItem : entry));
        const nextItems = sortManagerItems(replaced);
        const nextIndex = nextItems.findIndex((entry) => entry.ID === savedItem.ID);
        setSelectedIndex(nextIndex >= 0 ? nextIndex : 0);
        return nextItems;
      });
      setSheetState((current) => ({
        ...current,
        isSaving: false,
        writeReady: true,
        statusKind: 'success',
        statusMessage: successMessage || `Notification ${result.action === 'updated' ? 'updated' : 'appended'} in Google Sheet${result.sheetTitle ? ` (${result.sheetTitle})` : ''}.`,
      }));
      await loadSheetItems({ silent: true });
      return savedItem;
    } catch (error) {
      setSheetState((current) => ({
        ...current,
        isSaving: false,
        statusKind: 'error',
        statusMessage: error instanceof Error ? error.message : 'Unable to submit the notification to Google Sheets.',
      }));
      return null;
    }
  }, [loadSheetItems, selectedIndex]);

  const updateSelected = (patch) => {
    if (Object.prototype.hasOwnProperty.call(patch, 'ID') && selectedItem?.ID && patch.ID !== selectedItem.ID) {
      const confirmed = window.confirm('Change this notification ID? Popups dismissed under the old ID will show again if the ID changes.');
      if (!confirmed) {
        return;
      }
    }

    setItems((current) => current.map((entry, index) => {
      if (index !== selectedIndex) return entry;
      const next = normalizeManagerNotification({
        ...entry,
        ...patch,
        UpdatedAt: new Date().toISOString(),
      });

      if (patch.EndDate && !entry.EndDate && !patch.EndTime) {
        next.EndTime = '12:00 AM';
      }

      if (patch.EndDate === '') {
        next.EndTime = '';
      }

      return next;
    }));
  };

  const handleAdd = () => {
    const defaults = getEasternNowDefaults();
    const next = normalizeManagerNotification({
      ...createEmptyNotification(),
      StartDate: defaults.startDate,
      StartTime: defaults.startTime,
      CreatedAt: new Date().toISOString(),
      UpdatedAt: new Date().toISOString(),
    });
    setItems((current) => sortManagerItems([...current, next]));
    setSelectedIndex(0);
    setEditorOpen(true);
  };

  const handleDuplicate = () => {
    if (!selectedItem) return;
    const duplicate = normalizeManagerNotification({
      ...selectedItem,
      ID: '',
      Title: selectedItem.Title ? `${selectedItem.Title} Copy` : '',
      CreatedAt: new Date().toISOString(),
      UpdatedAt: new Date().toISOString(),
    });
    setItems((current) => sortManagerItems([...current, duplicate]));
    setSelectedIndex(0);
    setEditorOpen(true);
  };

  const handleDeleteIndex = async (index) => {
    const target = items[index];
    const confirmed = window.confirm(`Delete "${target?.Title || target?.Message || 'this notification'}"?`);
    if (!confirmed) return;

    const targetId = target?.ID || ensureNotificationId(target);
    setSheetState((current) => ({
      ...current,
      isSaving: true,
      statusKind: '',
      statusMessage: '',
    }));

    try {
      const result = await api.deleteManagedNotification(targetId);
      if (!result?.ok) {
        setSheetState((current) => ({
          ...current,
          isSaving: false,
          statusKind: 'error',
          statusMessage: result?.error || 'The backend did not confirm the notification was deleted from the sheet.',
        }));
        return;
      }
    } catch (error) {
      setSheetState((current) => ({
        ...current,
        isSaving: false,
        statusKind: 'error',
        statusMessage: error instanceof Error ? error.message : 'Unable to delete the notification from Google Sheets.',
      }));
      return;
    }

    if (items.length === 1) {
      setItems([createEmptyNotification()]);
      setSelectedIndex(0);
      setEditorOpen(false);
    } else {
      setItems((current) => current.filter((_, rowIndex) => rowIndex !== index));
      setSelectedIndex((current) => {
        if (current > index) return current - 1;
        if (current === index) return Math.max(0, current - 1);
        return current;
      });
      setEditorOpen(false);
    }

    setSheetState((current) => ({
      ...current,
      isSaving: false,
      statusKind: 'success',
      statusMessage: 'Notification deleted from Google Sheet.',
    }));
    await loadSheetItems({ silent: true });
  };

  const handleDelete = () => {
    handleDeleteIndex(selectedIndex);
  };

  const handleToggleEnabled = async (index) => {
    const toggled = normalizeManagerNotification({
      ...items[index],
      Enabled: !items[index]?.Enabled,
      UpdatedAt: new Date().toISOString(),
    });
    const nextItems = sortManagerItems(items.map((entry, rowIndex) => (
      rowIndex === index ? toggled : entry
    )));
    const targetId = toggled.ID;
    setItems(nextItems);
    const nextIndex = nextItems.findIndex((entry) => entry.ID === targetId);
    setSelectedIndex(nextIndex >= 0 ? nextIndex : 0);
    await persistNotification(toggled, {
      successMessage: `Notification ${toggled.Enabled ? 'enabled' : 'disabled'} in Google Sheet.`,
    });
  };

  const handleExport = () => {
    const normalizedItems = items.map((entry) => {
      const id = ensureNotificationId(entry);
      return {
        ...entry,
        ID: id,
        UpdatedAt: entry.UpdatedAt || new Date().toISOString(),
      };
    });
    downloadCsv('mock-testing-suite-notifications.csv', serializeNotificationsToCsv(normalizedItems));
  };

  const handleExitApp = async () => {
    if (window.electronAPI?.quitApp) {
      await window.electronAPI.quitApp().catch(() => {});
      return;
    }

    if (window.confirm('Are you sure you want to exit Sam?')) {
      window.close();
    }
  };

  const closeTutorial = useCallback(() => {
    setTutorialStep(null);
    localStorage.setItem(SAM_ONBOARDING_STATE_KEY, 'closed');
  }, []);
  const replayTutorial = () => {
    setHelpOpen(false);
    setEditorOpen(false);
    localStorage.setItem(SAM_TUTORIAL_SEEN_KEY, '1');
    localStorage.setItem(SAM_ONBOARDING_STATE_KEY, 'replay');
    window.setTimeout(() => setTutorialStep(0), 160);
  };

  const handleSubmit = async () => {
    if (!selectedItem) return;
    if (validation.errors.length > 0) {
      setSheetState((current) => ({
        ...current,
        statusKind: 'error',
        statusMessage: validation.errors[0],
      }));
      return;
    }

    await persistNotification({ ...selectedItem, ID: validation.id });
  };

  const handleImport = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = parseManagerCsv(text);
      if (!parsed.length) {
        setImportError('The selected CSV did not contain any usable notification rows.');
        return;
      }
      setItems(sortManagerItems(parsed));
      setSelectedIndex(0);
      setImportError('');
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Unable to import the selected CSV.');
    } finally {
      event.target.value = '';
    }
  };

  const infoTiles = [
    `${items.length} total rows`,
    `${items.filter((item) => item.Enabled).length} enabled`,
    `${items.filter(isCurrentNotification).length} current`,
    `${items.filter((item) => !isCurrentNotification(item)).length} disabled or expired`,
    'All times interpreted as Eastern',
    `Backend ${sheetState.backendStatus || 'initializing'}`,
    `Backend started here: ${sheetState.backendStartedByNotificationApp ? 'yes' : 'no'}`,
    `Startup retries: ${sheetState.backendRetryCount || 0}`,
    `Ticker source: ${(sheetState.tickerSource || 'unknown').toUpperCase()}`,
    sheetState.writeReady ? 'Direct sheet write ready' : 'Direct sheet write not configured',
  ];

  const visibleItems = items
    .map((item, index) => ({ item: normalizeManagerNotification(item), index }))
    .filter(({ item }) => {
      if (notificationView === 'active') return isCurrentNotification(item);
      if (notificationView === 'disabled') return !isCurrentNotification(item);
      return true;
    });

  return (
    <div className="nm-app">
      <div className="nm-shell">
        <section className="nm-hero">
          <div>
            <div className="nm-overline">{SAM_SUBTITLE}</div>
            <h1 className="nm-title">{SAM_TITLE}</h1>
            <p className="nm-subtitle">
              Create, edit, preview, and push structured alerts directly into the configured Google Sheet.
              Starts At defaults to the current Eastern time, Expires At uses 12:00 AM Eastern when you leave the time blank, and the saved row matches the live app schema the main app already reads.
            </p>
            <div className="nm-hero-toolbar" data-sam-tour="help-access">
            <div className="nm-actions-panel">
                <div className="nm-toolbar-label">Actions</div>
                <div className="nm-actions">
                  <button type="button" className="nm-btn nm-btn-primary" onClick={handleAdd} data-sam-tour="add-notification">Add Notification</button>
                  <button type="button" className="nm-btn nm-btn-secondary" onClick={() => openEditor(selectedIndex)} disabled={!selectedItem}>Edit Selected</button>
                  <button type="button" className="nm-btn nm-btn-secondary" onClick={handleDuplicate} disabled={!selectedItem}>Duplicate Selected</button>
                  <button type="button" className="nm-btn nm-btn-secondary" onClick={loadSheetItems} disabled={sheetState.isLoading || sheetState.isSaving}>Refresh from Sheet</button>
                  <button type="button" className="nm-btn nm-btn-secondary" onClick={handleCheckForUpdates}>Check for Updates</button>
                  <button type="button" className="nm-btn nm-btn-secondary" onClick={handleExport}>Export Backup CSV</button>
                  <label className="nm-file-label" htmlFor="nm-import-file">
                    Import CSV
                    <input
                      id="nm-import-file"
                      ref={fileInputRef}
                      className="nm-file-input"
                      type="file"
                      accept=".csv,text/csv"
                      onChange={handleImport}
                    />
                  </label>
                  <button type="button" className="nm-btn nm-btn-secondary" onClick={() => setHelpOpen(true)}>Help</button>
                  <button type="button" className="nm-btn nm-btn-danger" onClick={handleExitApp}>Exit App</button>
                </div>
              </div>
            </div>
          </div>
          <div className="nm-status-panel">
            <div className="nm-toolbar-label">Status</div>
            <div className="nm-pill-row" data-sam-tour="status-chips">
              {infoTiles.map((tile) => <div key={tile} className="nm-pill">{tile}</div>)}
            </div>
            <div className="nm-sam-banner-frame">
              {samBannerSrc ? (
                <img className="nm-sam-banner" src={samBannerSrc} alt="Sam" />
              ) : (
                <div className="nm-sam-banner-fallback">Sam</div>
              )}
            </div>
            <div className="nm-powered">Powered by MTS</div>
          </div>
        </section>

        {sheetState.statusMessage ? (
          <section className={`nm-status-card is-${sheetState.statusKind || 'info'}`}>
            <strong>{sheetState.statusKind === 'success' ? 'Success' : sheetState.statusKind === 'warning' ? 'Warning' : sheetState.statusKind === 'error' ? 'Status' : 'Starting'}</strong>
            <span>{sheetState.statusMessage}</span>
            {!sheetState.backendReady && (sheetState.backendStatus === 'error' || sheetState.backendStatus === 'retrying' || sheetState.readError) ? (
              <div style={{ marginTop: 16 }}>
                <button type="button" className="nm-btn nm-btn-primary" onClick={retryBackendStartup} disabled={sheetState.isSaving}>
                  Retry
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        <div className="nm-grid">
          <section className="nm-panel nm-preview-panel">
            <div className="nm-preview-card">
              <div className="nm-section-title">
                <div>
                  <h3>Live Preview</h3>
                  <div className="nm-kicker">Ticker, banner, and popup rendering from the selected row</div>
                </div>
              </div>
              {selectedItem ? (
                  <div className="nm-preview-stack">
                  <div className="nm-preview-box" data-sam-tour="preview-ticker">
                    <div className="nm-preview-label">Ticker Preview</div>
                    <div className="nm-preview-ticker">
                      {getTickerPreviewMessage(selectedItem)}
                    </div>
                  </div>
                  <div className="nm-preview-box">
                    <div className="nm-preview-label">Banner Preview</div>
                    {selectedItem.ShowBanner ? <PreviewBanner item={selectedItem} /> : <div className="nm-empty">Enable Show Banner to preview the page banner.</div>}
                  </div>
                  <div className="nm-preview-box">
                    <div className="nm-preview-label">Popup Preview</div>
                    {selectedItem.ShowPopup ? <PreviewPopup item={selectedItem} /> : <div className="nm-empty">Enable Show Popup to preview the modal notification.</div>}
                  </div>
                </div>
              ) : (
                <div className="nm-empty">Select a notification to preview it.</div>
              )}
            </div>
          </section>

          <section className="nm-panel" data-sam-tour="notification-list">
            <div className="nm-section-title">
              <div>
                <h2>Notifications</h2>
                <div className="nm-kicker">
                  {sheetState.isLoading
                    ? 'Loading rows from the configured sheet...'
                    : sheetState.readError
                      ? 'Using local draft because the sheet could not be read.'
                      : `Editing ${items.length} row${items.length === 1 ? '' : 's'} from the live sheet or local draft.`}
                </div>
              </div>
            </div>
            <div className="nm-view-tabs" role="tablist" aria-label="Notification views">
              {NOTIFICATION_VIEWS.map((view) => (
                <button
                  key={view.key}
                  type="button"
                  className={`nm-view-tab ${notificationView === view.key ? 'is-active' : ''}`}
                  onClick={() => setNotificationView(view.key)}
                >
                  {view.label}
                </button>
              ))}
            </div>
            <div className="nm-table-wrap">
              <table className="nm-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Title</th>
                    <th>Status</th>
                    <th>Schedule</th>
                    <th className="nm-actions-column">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map(({ item: normalized, index }) => {
                    return (
                      <tr key={`${normalized.ID || 'new'}-${index}`} className={index === selectedIndex ? 'is-selected' : ''}>
                        <td className="nm-actions-column">
                          <button type="button" className="nm-row-select" onClick={() => selectNotification(index)}>
                            <span className={getBadgeClass(normalized.Type)}>{normalized.Type}</span>
                          </button>
                        </td>
                        <td>
                          <button type="button" className="nm-row-select nm-row-title-button" onClick={() => selectNotification(index)}>
                            <div className="nm-row-title">{normalized.Title || '(Untitled notification)'}</div>
                            <div className="nm-meta">{normalized.Message || 'No message yet.'}</div>
                          </button>
                        </td>
                        <td>
                        <div style={{ fontWeight: 700 }}>{getRowStatusLabel(normalized)}</div>
                          <div className="nm-meta">{formatFlags(normalized)}</div>
                        </td>
                        <td className="nm-meta">
                          <div>{normalized.StartDate || 'Starts immediately'} {normalized.StartTime || ''}</div>
                          <div>{normalized.EndDate ? `Expires ${normalized.EndDate} ${normalized.EndTime || '12:00 AM'}` : 'No auto-expiration'}</div>
                        </td>
                        <td>
                          <div className="nm-row-actions">
                            <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={() => openEditor(index)}>Edit</button>
                            <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={() => handleToggleEnabled(index)}>
                              {normalized.Enabled ? 'Disable' : 'Enable'}
                            </button>
                            <button type="button" className="nm-btn nm-btn-danger nm-btn-table" onClick={() => handleDeleteIndex(index)}>Delete</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {!visibleItems.length ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="nm-empty">No notifications in this view.</div>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        <CandidateTrackingPanel
          data={candidateTracking}
          view={candidateView}
          onViewChange={setCandidateView}
          loading={candidateTrackingLoading}
          onRefresh={() => loadCandidateTracking()}
          onAction={runCandidateAction}
        />
      </div>
      <NotificationEditorModal
        open={editorOpen}
        selectedItem={selectedItem}
        validation={validation}
        importError={importError}
        sheetState={sheetState}
        updateSelected={updateSelected}
        onSubmit={handleSubmit}
        onDelete={handleDelete}
        onClose={closeEditor}
      />
      {helpOpen ? (
        <HelpModal
          version={appVersion}
          onClose={() => {
            localStorage.setItem(SAM_HELP_DISMISSED_KEY, '1');
            setHelpOpen(false);
          }}
          onReplayTutorial={replayTutorial}
        />
      ) : null}
      {tutorialStep !== null ? (
        <TutorialOverlay
          step={tutorialStep}
          onBack={() => setTutorialStep((current) => Math.max(0, (current || 0) - 1))}
          onNext={() => {
            setTutorialStep((current) => {
              const next = (current || 0) + 1;
              return next >= SAM_TUTORIAL_STEPS.length ? null : next;
            });
          }}
          onClose={closeTutorial}
        />
      ) : null}
      <UpdateModal
        updateInfo={updateModal}
        onInstall={handleInstallUpdate}
        onLater={() => setUpdateModal(null)}
      />
    </div>
  );
}
