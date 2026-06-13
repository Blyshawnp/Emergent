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
    body: 'Notifications reads and writes alert rows from the master sam-notifications tab.',
    placement: 'left',
  },
  {
    target: 'add-notification',
    title: 'Add notifications',
    body: 'Add Notification opens the editor in a modal. New rows default to Ticker only. Save closes the modal and MTS should update within about a minute.',
    placement: 'bottom',
  },
  {
    target: 'status-chips',
    title: 'Statuses',
    body: 'These chips show backend health, the active master sheet source, and the configured SAM user.',
    placement: 'left',
  },
  {
    target: 'help-access',
    title: 'Help',
    body: 'Open Help for assigned name and PIN setup, master Google Sheet details, candidate admin workflows, updates, and tutorial replay.',
    placement: 'bottom',
  },
  {
    target: 'notification-list',
    title: 'Enable and edit',
    body: 'Use Edit to open the modal. Enable, Disable, and Delete update sam-notifications after confirmation.',
    placement: 'left',
  },
  {
    target: 'candidate-tracking',
    title: 'Candidate tracking',
    body: 'Use Candidate Tracking filters, candidate-name search, View Details, and confirmation popups to manage pending transfers, failed final attempts, withdrawn candidates, passed certifications, archived history, and extra attempts.',
    placement: 'top',
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

function sheetTruthy(value) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return false;
  return ['true', '1', 'yes', 'y', 'on', 'checked'].includes(String(value).trim().toLowerCase());
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
            <p><strong>SAM</strong> = Smart Alert Manager. It manages real-time alerts and candidate availability actions for the main testing workflow.</p>
            <p>Powered by Mock Testing Suite.</p>
            <p>Version {version}</p>
          </div>
          <div className="nm-help-card">
            <h3>First-Run Setup</h3>
            <p>SAM requires an assigned name and PIN from the master Google Sheet before the dashboard opens. The setup checks the sam-authorized-users tab. Disabled users cannot complete setup, and PINs should not be shared.</p>
          </div>
          <div className="nm-help-card">
            <h3>Access Management</h3>
            <p>Admins manage access in the master sheet sam-authorized-users tab. Add users, disable users, change PINs, and revoke access directly in that tab.</p>
          </div>
          <div className="nm-help-card">
            <h3>Central Sheet</h3>
            <p>The master Google Sheet stores sam-notifications, Candidate Sessions, Pending Sup Transfers, sam-authorized-users, update-MTS, and update-SAM. Do not casually rename tabs or headers.</p>
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
            <p>Start and expiration times are interpreted in Eastern Time. AM/PM is respected, including midnight as AM. Empty expiration fields keep a notification live until it is disabled or removed.</p>
          </div>
          <div className="nm-help-card">
            <h3>Views</h3>
            <p>The top section buttons are Notifications, Live Preview, Candidate Tracking, Pending Sup Transfers, and Settings/Help. Candidate categories such as Failed Final Attempts, Withdrawn, Extra Attempt Granted, Passed Certifications, and Archived Candidates are filters inside Candidate Tracking.</p>
          </div>
          <div className="nm-help-card">
            <h3>Create</h3>
            <p>Use Add Notification to open the editor. New rows default to Ticker checked and Popup, Banner, and Persistent unchecked. Scroll inside the editor for delivery, schedule, and action options, then submit to the sheet.</p>
          </div>
          <div className="nm-help-card">
            <h3>Edit</h3>
            <p>Select or edit a row from the table. The editor opens in a modal and updates the same Google Sheet columns as before.</p>
          </div>
          <div className="nm-help-card">
            <h3>Disable</h3>
            <p>Disable makes a row inactive without deleting it. Disable, Enable, and Delete require confirmation and show a success status after the sheet updates.</p>
          </div>
          <div className="nm-help-card">
            <h3>Google Sheets Sync</h3>
            <p>Refresh reads the master sam-notifications tab. Submit writes the selected notification back to that tab using the working schema and Google Sheets checkbox-compatible boolean fields. After success, the modal closes and MTS should update within about a minute.</p>
          </div>
          <div className="nm-help-card">
            <h3>Candidate Tracking</h3>
            <p>SAM can be used by admins to review candidate availability signals from shared tracking. Filters include Pending Sup Transfers, Incomplete, Failed Not Final, Failed Final Attempts, Withdrawn, Extra Attempt Granted, Passed Certifications, Archived Candidates, and All Active Candidates. Use candidate-name search to narrow long lists.</p>
          </div>
          <div className="nm-help-card">
            <h3>Details</h3>
            <p>Candidate rows stay compact by default. Notes show a preview. Use View Details to expand full notes, coaching, fail summary, Basics, call results, supervisor-transfer results, and attempt history. Admin candidate history remains searchable indefinitely, including records moved to the archive after 90 days.</p>
          </div>
          <div className="nm-help-card">
            <h3>Candidate Deletion</h3>
            <p>Tester local History can be cleared in MTS without deleting SAM admin records. Shared candidate history can only be deleted from SAM by an admin after a confirmation. Delete one candidate row or select multiple rows and use Delete Selected. Rows manually deleted from the Google Sheet no longer appear in SAM or MTS lookup/autocomplete.</p>
          </div>
          <div className="nm-help-card">
            <h3>Pending Sup Transfers</h3>
            <p>Pending supervisor-transfer rows represent candidates whose mock calls were saved but still need transfer completion. Completing or cancelling the pending work changes whether that candidate appears in the shared queue.</p>
          </div>
          <div className="nm-help-card">
            <h3>Attempts and Withdrawal</h3>
            <p>Failed final attempts have their own filter and can receive an Extra Attempt after confirmation. Withdrawn candidates stay blocked in MTS until an admin restores the withdrawal or grants an extra attempt.</p>
          </div>
          <div className="nm-help-card">
            <h3>Admin Actions</h3>
            <p>Withdraw, Restore/Revert Withdrawal, Extra Attempt, Pending Sup Transfer cancellation, and candidate-history deletion all require confirmation and refresh the shared candidate list after the Google Sheet update. Extra attempts and restored withdrawals can make a candidate eligible again in MTS.</p>
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
            <p>If the master sheet cannot be reached, SAM shows a non-blocking warning. If notifications do not save or candidate records do not update, check service account access, tab names, headers, and sheet sharing first.</p>
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
  const cleanNote = (value) => String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/p\s*>/gi, '\n\n')
    .replace(/<\s*\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<\s*\/li\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== '-' && line !== '*');
  const list = (Array.isArray(notes) ? notes : [notes]).flatMap(cleanNote).filter(Boolean);
  if (!list.length) return 'No release notes were published.';
  return list.map((note) => `- ${note}`).join('\n');
}

function UpdateTechnicalDetails({ details }) {
  const text = String(details || '').trim();
  if (!text) return null;
  return (
    <details className="nm-update-technical-details">
      <summary>Technical details</summary>
      <pre>{text}</pre>
    </details>
  );
}

function UpdateModal({ updateInfo, updaterStatus, onInstall, onManualDownload, onLater }) {
  const [manualOpenStatus, setManualOpenStatus] = useState('');
  const [manualOpening, setManualOpening] = useState(false);
  if (!updateInfo) return null;
  const required = Boolean(updateInfo.required);
  const signedAutoUpdatesEnabled = Boolean(updateInfo.signedAutoUpdatesEnabled);
  const manualMode = !signedAutoUpdatesEnabled;
  const manualModeMessage = updateInfo.manualModeMessage || 'Automatic in-app installation is not enabled yet because the Windows installer is not code-signed. Click Download Update to open the release page, then download and run the installer.';
  
  const state = updaterStatus?.state || 'idle';
  const isChecking = state === 'checking';
  const isDownloading = signedAutoUpdatesEnabled && state === 'downloading';
  const isDownloaded = signedAutoUpdatesEnabled && (state === 'downloaded' || Boolean(updateInfo.downloaded));
  const isInstalling = signedAutoUpdatesEnabled && state === 'installing';
  const isError = state === 'error' || state === 'manual-available';

  let buttonText = 'Download Update';
  let buttonDisabled = manualOpening || Boolean(manualOpenStatus);
  let statusMessage = updaterStatus?.message || '';

  if (manualMode) {
    statusMessage = manualOpenStatus || manualModeMessage;
    buttonText = manualOpening ? 'Opening...' : 'Download Update';
    buttonDisabled = manualOpening || Boolean(manualOpenStatus);
  } else if (isChecking) {
    buttonText = 'Checking...';
    buttonDisabled = true;
  } else if (isDownloading) {
    const percentStr = updaterStatus?.percent ? ` (${updaterStatus.percent.toFixed(0)}%)` : '';
    buttonText = `Downloading...${percentStr}`;
    buttonDisabled = true;
  } else if (isDownloaded) {
    buttonText = 'Install and Restart';
    buttonDisabled = false;
  } else if (isInstalling) {
    buttonText = 'Installing...';
    buttonDisabled = true;
  }

  if (manualMode) {
    statusMessage = manualOpenStatus || manualModeMessage;
  } else if (isChecking) {
    statusMessage = 'Checking for updates...';
  } else if (state === 'available') {
    statusMessage = 'Update available.';
  } else if (isDownloading) {
    const percentVal = updaterStatus?.percent || 0;
    statusMessage = `Downloading update... ${percentVal.toFixed(0)}%`;
  } else if (isDownloaded) {
    statusMessage = 'Download complete. Ready to install and restart.';
  } else if (isInstalling) {
    statusMessage = 'Installing update and restarting...';
  } else if (isError) {
    statusMessage = updaterStatus?.message || 'Update failed. Manual Download is available.';
  }
  const technicalDetails = signedAutoUpdatesEnabled ? (updaterStatus?.details || updateInfo.details || updateInfo.manualError || '') : '';

  const handleDownloadUpdate = async () => {
    if (manualMode) {
      if (manualOpening || manualOpenStatus) return;
      setManualOpening(true);
      try {
        const result = await onManualDownload?.();
        if (result?.ok) {
          setManualOpenStatus('The update page opened in your browser. Download and run the installer to update.');
        } else {
          setManualOpenStatus(result?.error || 'Manual update link is invalid. Please check update-SAM.');
        }
      } finally {
        setManualOpening(false);
      }
      return;
    }
    await onInstall?.();
  };

  return (
    <div className="nm-modal-backdrop" onMouseDown={(event) => { if ((manualMode || !required) && !isInstalling && event.target === event.currentTarget) onLater(); }}>
      <section className="nm-help-modal nm-update-modal" role="dialog" aria-modal="true">
        <div className="nm-help-header">
          <div>
            <div className="nm-overline">UPDATE AVAILABLE</div>
            <h2>Smart Alert Manager Update Available</h2>
            <p>{updateInfo.releaseTitle || 'A new Smart Alert Manager update is available.'}</p>
          </div>
        </div>
        <div className="nm-update-details">
          <div className="nm-update-meta">
            <div><strong>Current:</strong> v{updateInfo.currentVersion || '1.0.1'}</div>
            <div><strong>New:</strong> v{updateInfo.latestVersion}</div>
            {updateInfo.requiredVersion ? <div><strong>Required:</strong> v{updateInfo.requiredVersion}</div> : null}
            {updateInfo.releaseDate ? <div><strong>Released:</strong> {updateInfo.releaseDate}</div> : null}
          </div>
          {statusMessage ? (
            <div className="nm-update-status" style={{
              color: isError ? '#e06c75' : '#98c379',
              fontWeight: 'bold',
              margin: '8px 0',
              padding: '8px',
              borderRadius: '4px',
              background: isError ? 'rgba(224, 108, 117, 0.1)' : 'rgba(152, 195, 121, 0.1)',
              border: `1px solid ${isError ? 'rgba(224, 108, 117, 0.2)' : 'rgba(152, 195, 121, 0.2)'}`
            }}>
              {statusMessage}
            </div>
          ) : null}
          <UpdateTechnicalDetails details={technicalDetails} />
          <div className="nm-update-notes">
            <div className="nm-update-notes-title">Release Notes</div>
            <pre style={{ maxHeight: '180px', overflowY: 'auto' }}>{formatUpdateNotes(updateInfo.notes)}</pre>
          </div>
        </div>
        <div className="nm-help-actions">
          {(manualMode || !required) ? <button type="button" className="nm-btn nm-btn-secondary" onClick={onLater} disabled={isInstalling}>Close</button> : null}
          <button type="button" className="nm-btn nm-btn-primary" onClick={handleDownloadUpdate} disabled={buttonDisabled}>
            {manualOpening ? 'Opening...' : buttonText}
          </button>
        </div>
      </section>
    </div>
  );
}

function StatusModal({ message, kind = 'info', onClose }) {
  if (!message) return null;
  const title = kind === 'error' ? 'Action Failed' : kind === 'warning' ? 'Warning' : 'Success';
  return (
    <div className="nm-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="nm-help-modal nm-status-modal" role="dialog" aria-modal="true">
        <div className="nm-help-header">
          <div>
            <div className="nm-overline">{title}</div>
            <h2>{title}</h2>
            <p>{message}</p>
          </div>
          <button type="button" className="nm-modal-close" onClick={onClose} aria-label="Close status">×</button>
        </div>
        <div className="nm-help-actions">
          <button type="button" className="nm-btn nm-btn-primary" onClick={onClose}>OK</button>
        </div>
      </section>
    </div>
  );
}

function ConfirmModal({ state, onConfirm, onCancel }) {
  const [note, setNote] = useState('');
  useEffect(() => {
    setNote(state?.initialNote || '');
  }, [state]);
  if (!state?.message) return null;
  return (
    <div className="nm-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="nm-help-modal nm-status-modal" role="dialog" aria-modal="true">
        <div className="nm-help-header">
          <div>
            <div className="nm-overline">{state.kind === 'danger' ? 'CONFIRM ACTION' : 'CONFIRM'}</div>
            <h2>{state.title || 'Confirm'}</h2>
            <p>{state.message}</p>
          </div>
          <button type="button" className="nm-modal-close" onClick={onCancel} aria-label="Cancel">×</button>
        </div>
        {state.collectNote ? (
          <div className="nm-confirm-note">
            <label htmlFor="nm-confirm-note-input">{state.noteLabel || 'Optional note'}</label>
            <textarea
              id="nm-confirm-note-input"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={state.notePlaceholder || 'Add a reason for the audit trail...'}
              rows={3}
            />
          </div>
        ) : null}
        <div className="nm-help-actions">
          <button type="button" className="nm-btn nm-btn-secondary" onClick={onCancel}>{state.cancelLabel || 'Cancel'}</button>
          <button
            type="button"
            className={`nm-btn ${state.kind === 'danger' ? 'nm-btn-danger' : 'nm-btn-primary'}`}
            onClick={() => onConfirm(state.collectNote ? { confirmed: true, note } : true)}
          >
            {state.confirmLabel || 'OK'}
          </button>
        </div>
      </section>
    </div>
  );
}

function getSamDeviceName() {
  try {
    return window.electronAPI?.getDeviceName?.() || window.navigator?.platform || '';
  } catch (_error) {
    return '';
  }
}

function SamSetupWizard({ status, onComplete }) {
  const [form, setForm] = useState({ name: '', pin: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(status?.error || '');

  useEffect(() => {
    setError(status?.error || '');
  }, [status?.error]);

  const submitSetup = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const result = await api.completeSamSetup({
        name: form.name.trim(),
        pin: form.pin.trim(),
        device_name: getSamDeviceName(),
      });
      if (!result?.ok) {
        setError(result?.error || 'Name or PIN was not recognized or access has been disabled.');
        return;
      }
      onComplete?.(result);
    } catch (setupError) {
      setError(getErrorMessage(setupError, 'SAM setup requires access to the admin configuration sheet.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="nm-app nm-setup-app">
      <div className="nm-setup-shell">
        <section className="nm-setup-panel">
          <div className="nm-overline">SAM SETUP</div>
          <h1>{SAM_TITLE}</h1>
          <p>Enter the assigned admin name and PIN from the master Google Sheet to enable Smart Alert Manager on this device.</p>
          <form className="nm-setup-form" onSubmit={submitSetup}>
            <label>
              <span>Name</span>
              <input
                type="text"
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                autoComplete="name"
                required
              />
            </label>
            <label>
              <span>PIN</span>
              <input
                type="password"
                inputMode="numeric"
                value={form.pin}
                onChange={(event) => setForm((current) => ({ ...current, pin: event.target.value }))}
                autoComplete="one-time-code"
                required
              />
            </label>
            {error ? (
              <div className="nm-status-card is-warning">
                <strong>Setup blocked</strong>
                <span>{error}</span>
              </div>
            ) : null}
            <button type="submit" className="nm-btn nm-btn-primary" disabled={submitting || !form.name.trim() || !form.pin.trim()}>
              {submitting ? 'Verifying...' : 'Complete Setup'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

const CANDIDATE_VIEW_LABELS = {
  pending: 'Pending Sup Transfers',
  incomplete: 'Incomplete',
  failedNotFinal: 'Failed, Not Final',
  failedFinalAttempts: 'Failed Final Attempts',
  withdrawn: 'Withdrawn',
  extraAttemptGranted: 'Extra Attempt Granted',
  passedCertifications: 'Passed Certifications',
  archived: 'Archived Candidates',
  allActive: 'All Active Candidates',
};

const SECTION_NAV_ITEMS = [
  { key: 'notifications', label: 'Notifications', target: 'sam-notifications' },
  { key: 'preview', label: 'Live Preview', target: 'sam-live-preview' },
  { key: 'candidates', label: 'Candidate Tracking', target: 'sam-candidate-tracking', candidateView: 'allActive' },
  { key: 'candidates', label: 'Pending Sup Transfers', target: 'sam-candidate-tracking', candidateView: 'pending' },
  { key: 'help', label: 'Settings/Help', target: 'sam-help-settings' },
];

function CandidateTrackingPanel({ data, view, onViewChange, loading, onRefresh, onAction, onConfirm, search, onSearchChange, actor }) {
  const [expanded, setExpanded] = useState({});
  const [selectedTargets, setSelectedTargets] = useState({});
  const rows = data?.views?.[view] || [];
  const searchText = search.trim().toLowerCase();
  const searchPool = searchText ? (data?.candidates || rows) : rows;
  const visibleRows = searchText
    ? searchPool.filter((row) => String(row.candidate_name || '').toLowerCase().includes(searchText))
    : rows;
  const getCandidateRowKey = (row) => [
    row.pending_id || '',
    row.session_id || row.latest_session_id || row.original_session_id || '',
    row.candidate_name || '',
    row.completed_at || row.last_session_date || row.created_at || '',
  ].join('::');
  const buildCandidateTarget = (row) => ({
    candidate_name: row.candidate_name || '',
    session_id: row.session_id || row.latest_session_id || row.original_session_id || '',
    pending_id: row.pending_id || '',
  });
  const visibleEntries = visibleRows.map((row, index) => ({
    row,
    index,
    key: getCandidateRowKey(row) || `${row.candidate_name || 'candidate'}-${index}`,
  }));
  const selectedList = Object.values(selectedTargets);
  const selectedCount = selectedList.length;
  const allVisibleSelected = visibleEntries.length > 0 && visibleEntries.every((entry) => selectedTargets[entry.key]);
  const setup = data?.setup || {};
  const requiredSetup = Object.entries(setup)
    .map(([tab, headers]) => `${tab}: ${Array.isArray(headers) ? headers.join(', ') : String(headers || '')}`)
    .join('\n');

  const handleWithdraw = async (row) => {
    const confirmed = await onConfirm(`Mark ${row.candidate_name || 'this candidate'} as withdrew from certification?`, { kind: 'danger', confirmLabel: 'Withdraw' });
    if (!confirmed) return;
    await onAction({ action: 'withdraw', candidate_name: row.candidate_name, session_id: row.session_id || row.latest_session_id, pending_id: row.pending_id });
  };

  const handleRestore = async (row) => {
    const confirmed = await onConfirm(`Restore ${row.candidate_name || 'this candidate'} from withdrew from certification status?`, { confirmLabel: 'Restore' });
    if (!confirmed) return;
    await onAction({ action: 'restore_withdrawal', candidate_name: row.candidate_name, session_id: row.session_id || row.latest_session_id, pending_id: row.pending_id });
  };

  const handleExtraAttempt = async (row) => {
    const confirmed = await onConfirm(`Grant an additional attempt for ${row.candidate_name || 'this candidate'}?`, { confirmLabel: 'Grant' });
    if (!confirmed) return;
    const reason = '';
    await onAction({ action: 'grant_extra_attempt', candidate_name: row.candidate_name, session_id: row.session_id || row.latest_session_id, pending_id: row.pending_id, reason });
  };

  const handleCancel = async (row) => {
    const confirmed = await onConfirm(`Cancel pending supervisor transfer for ${row.candidate_name || 'this candidate'}?`, { kind: 'danger', confirmLabel: 'Cancel Transfer' });
    if (!confirmed) return;
    await onAction({ action: 'cancel_pending', candidate_name: row.candidate_name, pending_id: row.pending_id, session_id: row.original_session_id });
  };

  const handleManualCorrection = async (row, action, targetLabel, options = {}) => {
    const response = await onConfirm(
      `${targetLabel} for ${row.candidate_name || 'this candidate'}?`,
      {
        confirmLabel: options.confirmLabel || targetLabel,
        kind: options.kind || 'info',
        collectNote: true,
        noteLabel: 'Optional correction note',
        notePlaceholder: 'Example: Supervisor transfer completed outside app.',
      },
    );
    if (!response) return;
    const reason = typeof response === 'object' ? response.note || '' : '';
    await onAction({
      action,
      candidate_name: row.candidate_name,
      session_id: row.session_id || row.latest_session_id || row.original_session_id,
      pending_id: row.pending_id,
      reason,
      actor,
    });
  };

  const handleDeleteTargets = async (targets, label) => {
    if (!targets.length) return;
    const confirmed = await onConfirm(
      `Permanently delete ${label} from shared Candidate Sessions and Pending Sup Transfers? This removes the record from SAM admin views and MTS autocomplete/lookup. Tester local History is not changed.`,
      { kind: 'danger', confirmLabel: 'Delete' },
    );
    if (!confirmed) return;
    await onAction({ action: 'delete_candidate_history', targets });
    setSelectedTargets({});
  };

  const handleDeleteRow = async (row) => {
    await handleDeleteTargets([buildCandidateTarget(row)], `candidate history for ${row.candidate_name || 'this candidate'}`);
  };

  const toggleRowSelection = (entry, checked) => {
    const target = buildCandidateTarget(entry.row);
    setSelectedTargets((current) => {
      const next = { ...current };
      if (checked) {
        next[entry.key] = target;
      } else {
        delete next[entry.key];
      }
      return next;
    });
  };

  const toggleVisibleSelection = (checked) => {
    setSelectedTargets((current) => {
      const next = { ...current };
      visibleEntries.forEach((entry) => {
        if (checked) {
          next[entry.key] = buildCandidateTarget(entry.row);
        } else {
          delete next[entry.key];
        }
      });
      return next;
    });
  };

  return (
    <section className="nm-panel nm-candidate-panel" id="sam-candidate-tracking" data-sam-tour="candidate-tracking">
      <div className="nm-section-title">
        <div>
          <h2>Candidate Tracking</h2>
          <div className="nm-kicker">Shared admin queue from Candidate Sessions and Pending Sup Transfers.</div>
        </div>
        <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={onRefresh} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
        <button
          type="button"
          className="nm-btn nm-btn-danger nm-btn-table"
          onClick={() => handleDeleteTargets(selectedList, `${selectedCount} selected candidate record${selectedCount === 1 ? '' : 's'}`)}
          disabled={!selectedCount || loading}
        >
          Delete Selected
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
      <div className="nm-search-row">
        <label htmlFor="sam-candidate-search">Search by candidate name</label>
        <input
          id="sam-candidate-search"
          type="search"
          value={search || ''}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Type a candidate name..."
        />
      </div>
      <div className="nm-table-wrap">
        <table className="nm-table nm-candidate-table">
          <thead>
            <tr>
              <th className="nm-select-column">
                <input
                  type="checkbox"
                  aria-label="Select all visible candidate rows"
                  checked={allVisibleSelected}
                  onChange={(event) => toggleVisibleSelection(event.target.checked)}
                />
              </th>
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
            {!visibleRows.length ? (
              <tr><td colSpan={9}><div className="nm-empty">No candidates in this view.</div></td></tr>
            ) : visibleEntries.map(({ row, index, key: rowKey }) => {
              const results = [row.call_1_result, row.call_2_result, row.call_3_result, row.sup_transfer_1_result, row.sup_transfer_2_result].filter(Boolean).join(', ') || row.mock_call_summary || 'Recorded';
              const notes = row.fail_summary || row.notes || row.coaching_summary || row.review_notes || 'None recorded';
              const hasFinalNotes = Boolean(row.final_notes_strengths || row.final_notes_needs_coaching || row.final_notes_other || row.evaluator_notes_summary);
              const isFinalNotesHistoryOnly = hasFinalNotes && (row.final_notes_history_only === true || row.final_notes_history_only === 'TRUE');
              const attempts = Array.isArray(row.attempts) ? row.attempts : [];
              const isExpanded = Boolean(expanded[rowKey]);
              const statusUpper = String(row.status || row.latest_status || '').toUpperCase();
              const isPendingTransfer = view === 'pending' || Boolean(row.pending_id);
              const isIncomplete = view === 'incomplete' || statusUpper === 'INCOMPLETE';
              const isWithdrawn = sheetTruthy(row.withdrawn) || statusUpper === 'WITHDREW FROM CERTIFICATION';
              return (
                <React.Fragment key={rowKey}>
                  <tr>
                    <td className="nm-select-column">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.candidate_name || 'candidate'}`}
                        checked={Boolean(selectedTargets[rowKey])}
                        onChange={(event) => toggleRowSelection({ row, index, key: rowKey }, event.target.checked)}
                      />
                    </td>
                    <td>
                      <div className="nm-row-title">{row.candidate_name || 'Unknown'}</div>
                      <div className="nm-meta">{sheetTruthy(row.final_attempt) || sheetTruthy(row.final_attempt_risk) ? 'Final-attempt risk' : sheetTruthy(row.extra_attempt_granted) ? 'Extra attempt granted' : 'Active'}</div>
                    </td>
                    <td>{row.status || row.latest_status || 'Unknown'}</td>
                    <td>{row.attempt_count ?? row.attempt_number ?? attempts.length ?? '0'}</td>
                    <td>{row.original_tester_name || row.tester_name || 'Unknown'}</td>
                    <td className="nm-meta">{row.completed_at || row.last_session_date || row.created_at || 'Unknown'}</td>
                    <td className="nm-meta">{results}</td>
                    <td className="nm-meta nm-notes-cell">
                      <div className="nm-notes-preview">{notes}</div>
                      {hasFinalNotes ? <span className="nm-final-notes-badge" title={isFinalNotesHistoryOnly ? 'Final notes (history only — not in review summary)' : 'Final evaluator notes available'}>📝 Final Notes{isFinalNotesHistoryOnly ? ' (History)' : ''}</span> : null}
                      <button type="button" className="nm-link-button" onClick={() => setExpanded((current) => ({ ...current, [rowKey]: !current[rowKey] }))}>
                        {isExpanded ? 'Hide Details' : 'View Details'}
                      </button>
                    </td>
                    <td>
                      <div className="nm-row-actions">
                        {(isIncomplete || isPendingTransfer || isWithdrawn) ? (
                          <>
                            <button type="button" className="nm-btn nm-btn-primary nm-btn-table" onClick={() => handleManualCorrection(row, 'mark_passed', 'Mark Passed')}>Mark Passed</button>
                            <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={() => handleManualCorrection(row, 'mark_failed', 'Mark Failed')}>Mark Failed</button>
                          </>
                        ) : null}
                        {isIncomplete && !isPendingTransfer ? (
                          <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={() => handleManualCorrection(row, 'move_pending_sup_transfer', 'Move to Pending Sup Transfer')}>Move to Pending Sup</button>
                        ) : null}
                        {isPendingTransfer ? (
                          <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={() => handleManualCorrection(row, 'remove_pending_sup_transfer', 'Mark Incomplete')}>Mark Incomplete</button>
                        ) : null}
                        {row.pending_id ? <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={() => handleCancel(row)}>Cancel</button> : null}
                        <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={() => handleExtraAttempt(row)}>Extra Attempt</button>
                        {isWithdrawn ? (
                          <button type="button" className="nm-btn nm-btn-primary nm-btn-table" onClick={() => handleRestore(row)}>Restore</button>
                        ) : (
                          <button type="button" className="nm-btn nm-btn-danger nm-btn-table" onClick={() => handleWithdraw(row)}>Withdraw</button>
                        )}
                        <button type="button" className="nm-btn nm-btn-danger nm-btn-table" onClick={() => handleDeleteRow(row)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                  {isExpanded ? (
                    <tr className="nm-candidate-detail-row">
                      <td colSpan={9}>
                        <div className="nm-candidate-details">
                          <div><strong>Notes:</strong> {notes}</div>
                          <div><strong>Coaching:</strong> {row.coaching_summary || 'N/A'}</div>
                          <div><strong>Fail Summary:</strong> {row.fail_summary || 'N/A'}</div>
                          <div><strong>Basics:</strong> Headset {row.headset_brand || 'N/A'}; USB {row.headset_usb === true ? 'Yes' : row.headset_usb === false ? 'No' : 'N/A'}; Noise cancelling {row.noise_cancel === true ? 'Yes' : row.noise_cancel === false ? 'No' : 'N/A'}; VPN {row.vpn_on === true ? 'Yes' : row.vpn_on === false ? 'No' : 'N/A'}</div>
                          <div><strong>Call Results:</strong> {[row.call_1_result, row.call_2_result, row.call_3_result].filter(Boolean).join(', ') || 'N/A'}</div>
                          <div><strong>Sup Transfer Results:</strong> {[row.sup_transfer_1_result, row.sup_transfer_2_result].filter(Boolean).join(', ') || 'N/A'}</div>
                          {hasFinalNotes ? (
                            <div className="nm-final-notes-section">
                              <strong className="nm-final-notes-heading">Final Evaluator Notes</strong>
                              {isFinalNotesHistoryOnly ? (
                                <div className="nm-final-notes-history-warning">⚠ History only — not included in the Review summary</div>
                              ) : null}
                              {row.final_notes_strengths ? <div><strong>Strengths:</strong> {row.final_notes_strengths}</div> : null}
                              {row.final_notes_needs_coaching ? <div><strong>Needs Coaching:</strong> {row.final_notes_needs_coaching}</div> : null}
                              {row.final_notes_other ? <div><strong>Other:</strong> {row.final_notes_other}</div> : null}
                              {row.evaluator_notes_summary ? <div><strong>Evaluator Summary:</strong> {row.evaluator_notes_summary}</div> : null}
                              {row.final_notes_created_at ? <div className="nm-meta"><strong>Notes Created:</strong> {row.final_notes_created_at}</div> : null}
                            </div>
                          ) : null}
                          {attempts.length ? (
                            <div className="nm-attempt-list">
                              <strong>Attempt History</strong>
                              {attempts.map((attempt, attemptIndex) => (
                                <details key={`${attempt.session_id || attemptIndex}`} className="nm-attempt-detail">
                                  <summary>{attempt.completed_at || attempt.created_at || `Attempt ${attemptIndex + 1}`} - {attempt.status || 'Unknown'} - {attempt.tester_name || 'Unknown tester'}</summary>
                                  <div>Final attempt: {sheetTruthy(attempt.final_attempt) ? 'Yes' : 'No'}</div>
                                  <div>Coaching: {attempt.coaching_summary || 'N/A'}</div>
                                  <div>Fail: {attempt.fail_summary || 'N/A'}</div>
                                  <div>Calls: {[attempt.call_1_result, attempt.call_2_result, attempt.call_3_result].filter(Boolean).join(', ') || 'N/A'}</div>
                                  <div>Sup Transfers: {[attempt.sup_transfer_1_result, attempt.sup_transfer_2_result].filter(Boolean).join(', ') || 'N/A'}</div>
                                  <div>Review Notes: {attempt.review_notes || 'N/A'}</div>
                                  {(attempt.final_notes_strengths || attempt.final_notes_needs_coaching || attempt.final_notes_other) ? (
                                    <div className="nm-final-notes-section">
                                      <strong className="nm-final-notes-heading">Final Notes</strong>
                                      {(attempt.final_notes_history_only === true || attempt.final_notes_history_only === 'TRUE') ? (
                                        <div className="nm-final-notes-history-warning">⚠ History only — not in review summary</div>
                                      ) : null}
                                      {attempt.final_notes_strengths ? <div>Strengths: {attempt.final_notes_strengths}</div> : null}
                                      {attempt.final_notes_needs_coaching ? <div>Needs Coaching: {attempt.final_notes_needs_coaching}</div> : null}
                                      {attempt.final_notes_other ? <div>Other: {attempt.final_notes_other}</div> : null}
                                    </div>
                                  ) : null}
                                </details>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
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

          <div className="nm-editor-scroll-cue">Scroll for delivery and schedule options.</div>
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
  const startupUpdateCheckRef = useRef(false);
  const manualUpdateCheckRef = useRef(false);
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
  const [editorDraft, setEditorDraft] = useState(null);
  const [editorIndex, setEditorIndex] = useState(null);
  const [statusModal, setStatusModal] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);
  const confirmResolverRef = useRef(null);
  const [tutorialStep, setTutorialStep] = useState(null);
  const [appVersion, setAppVersion] = useState(() => getAppVersion());
  const [updateModal, setUpdateModal] = useState(null);
  const [updaterStatus, setUpdaterStatus] = useState(null);
  const [activeSection, setActiveSection] = useState('notifications');
  const [candidateView, setCandidateView] = useState('pending');
  const [candidateSearch, setCandidateSearch] = useState('');
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [candidateTracking, setCandidateTracking] = useState({ ok: true, views: {}, candidates: [], pending: [], error: '' });
  const [candidateTrackingLoading, setCandidateTrackingLoading] = useState(false);
  const [samSetupStatus, setSamSetupStatus] = useState({ loading: true, setupComplete: false, userName: '', userRole: '', ok: true, error: '' });
  const showStatusModal = useCallback((message, kind = 'info') => {
    setStatusModal({ message, kind });
  }, []);
  const requestConfirm = useCallback((message, options = {}) => new Promise((resolve) => {
    confirmResolverRef.current = resolve;
    setConfirmModal({
      message,
      title: options.title || 'Confirm',
      kind: options.kind || 'info',
      confirmLabel: options.confirmLabel || 'OK',
      cancelLabel: options.cancelLabel || 'Cancel',
      collectNote: Boolean(options.collectNote),
      noteLabel: options.noteLabel || '',
      notePlaceholder: options.notePlaceholder || '',
      initialNote: options.initialNote || '',
    });
  }), []);
  const resolveConfirm = useCallback((value) => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmModal(null);
    if (resolver) resolver(value);
  }, []);
  const handleViewInTracking = useCallback((candidate) => {
    setActiveSection('candidates');
    setCandidateView('allActive');
    setCandidateSearch(candidate.candidate_name || '');
  }, []);
  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    setEditorDraft(null);
    setEditorIndex(null);
  }, []);

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
      void (retryBackendStartupRef.current ? retryBackendStartupRef.current(false) : window.electronAPI?.retryBackendStartup?.({ resetAttempts: false }));
    }, delay);
    return true;
  }, [clearBackendStartupRetryTimer]);

  const handleManualDownloadUpdate = useCallback(async () => {
    try {
      const result = await window.electronAPI?.updaterManualDownload?.();
      if (!result?.ok) {
        setSheetState((current) => ({
          ...current,
          statusKind: 'error',
          statusMessage: result?.error || 'Manual update link is invalid or unavailable.',
        }));
        return result;
      }
      setSheetState((current) => ({
        ...current,
        statusKind: 'info',
        statusMessage: 'The update page opened in your browser. Download and run the installer to update.',
      }));
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Manual update link is invalid or unavailable.';
      setSheetState((current) => ({
        ...current,
        statusKind: 'error',
        statusMessage: message,
      }));
      return { ok: false, error: message };
    }
  }, []);

  const handleInstallUpdate = useCallback(async () => {
    if (updateModal?.signedAutoUpdatesEnabled !== true) {
      return handleManualDownloadUpdate();
    }
    try {
      if (updaterStatus?.state === 'downloaded' || updateModal?.downloaded) {
        const installResult = await window.electronAPI?.updaterQuitAndInstall?.();
        if (!installResult?.ok) {
          setUpdateModal((current) => ({
            ...(current || updateModal || {}),
            downloaded: true,
            manualDownloadAvailable: Boolean(installResult?.manualDownloadAvailable),
            manualUrl: installResult?.manualUrl,
            manualError: installResult?.error,
          }));
          setSheetState((current) => ({
            ...current,
            statusKind: installResult?.manualDownloadAvailable ? 'warning' : 'error',
            statusMessage: installResult?.error || 'Unable to install and restart.',
          }));
        }
        return;
      }
      const result = await window.electronAPI?.installPendingUpdate?.();
      if (!result?.ok) {
        if (result?.manualDownloadAvailable) {
          setUpdateModal((current) => ({
            ...(current || updateModal || {}),
            manualDownloadAvailable: true,
            manualUrl: result.manualUrl,
            manualError: result.error,
          }));
        }
        setSheetState((current) => ({
          ...current,
          statusKind: result?.manualDownloadAvailable ? 'warning' : 'error',
          statusMessage: result?.error || 'Unable to download and install the update.',
        }));
        return;
      }
      if (result?.action === 'downloaded') {
        setUpdateModal((current) => ({
          ...(current || updateModal || {}),
          downloaded: true,
        }));
        return;
      }
    } catch (error) {
      setSheetState((current) => ({
        ...current,
        statusKind: 'error',
        statusMessage: error instanceof Error ? error.message : 'Unable to download and install the update.',
      }));
    }
  }, [handleManualDownloadUpdate, updateModal, updaterStatus]);

  const handleCheckForUpdates = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      manualUpdateCheckRef.current = true;
    }
    try {
      if (!window.electronAPI?.checkForUpdates) {
        if (!silent) {
          setSheetState((current) => ({ ...current, statusKind: 'warning', statusMessage: 'Update checks are available only in the desktop app.' }));
        }
        return;
      }
      const result = await window.electronAPI.checkForUpdates();
      if (!result?.ok) {
        if (!silent) {
          setSheetState((current) => ({ ...current, statusKind: 'warning', statusMessage: result?.error || 'Unable to check for updates right now.' }));
        }
        return;
      }
      if (result.updateAvailable) {
        if (!silent) {
          setUpdateModal(result.updateInfo);
        }
        return;
      }
      if (!silent) {
        setSheetState((current) => ({ ...current, statusKind: 'success', statusMessage: `SAM version ${appVersion} is up to date.` }));
      }
    } catch (error) {
      if (!silent) {
        setSheetState((current) => ({ ...current, statusKind: 'warning', statusMessage: error instanceof Error ? error.message : 'Unable to check for updates right now.' }));
      }
    }
  }, [appVersion]);

  const runStartupUpdateCheck = useCallback(async () => {
    if (startupUpdateCheckRef.current) {
      return;
    }
    startupUpdateCheckRef.current = true;

    try {
      const state = await window.electronAPI?.getUpdateState?.();
      if (state?.pendingUpdate) {
        setUpdateModal(state.pendingUpdate);
        return;
      }
    } catch (_error) {}

    await handleCheckForUpdates({ silent: true });
  }, [handleCheckForUpdates]);

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
    try {
      const result = await api.updateSharedAdminCandidate(payload);
      if (!result?.ok) {
        const message = result?.error || 'Candidate tracking update failed.';
        setSheetState((current) => ({ ...current, statusKind: 'error', statusMessage: message }));
        showStatusModal(message, 'error');
        return;
      }
      const actionLabels = {
        grant_extra_attempt: 'Extra attempt granted in the shared Google Sheet. MTS should allow this candidate again after refresh.',
        withdraw: 'Candidate withdrawn in the shared Google Sheet. MTS should block this candidate after refresh.',
        restore_withdrawal: 'Candidate restored in the shared Google Sheet. MTS should allow lookup again after refresh.',
        cancel_pending: 'Pending supervisor transfer cancelled in the shared Google Sheet.',
        delete_candidate_history: 'Candidate history deleted from the shared Google Sheet. It will no longer appear in SAM or MTS lookup/autocomplete after refresh.',
        mark_passed: 'Candidate manually marked as passed in the shared Google Sheet.',
        mark_failed: 'Candidate manually marked as failed in the shared Google Sheet.',
        mark_incomplete: 'Candidate manually marked as incomplete in the shared Google Sheet.',
        move_pending_sup_transfer: 'Candidate moved to Pending Sup Transfers in the shared Google Sheet.',
        remove_pending_sup_transfer: 'Candidate removed from Pending Sup Transfers and marked incomplete in the shared Google Sheet.',
      };
      setSheetState((current) => ({
        ...current,
        statusKind: 'success',
        statusMessage: actionLabels[payload?.action] || 'Candidate tracking updated in the shared Google Sheet.',
      }));
      showStatusModal(actionLabels[payload?.action] || 'Candidate tracking updated in the shared Google Sheet.', 'success');
      await loadCandidateTracking({ silent: true });
    } catch (error) {
      const message = getErrorMessage(error, 'Candidate tracking update failed.');
      setSheetState((current) => ({
        ...current,
        statusKind: 'error',
        statusMessage: message,
      }));
      showStatusModal(message, 'error');
    }
  }, [loadCandidateTracking, showStatusModal]);

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
    if (!samSetupStatus.setupComplete) return undefined;
    if (localStorage.getItem(SAM_TUTORIAL_SEEN_KEY) === '1') return;
    const timer = window.setTimeout(() => {
      setTutorialStep(0);
      localStorage.setItem(SAM_TUTORIAL_SEEN_KEY, '1');
      localStorage.setItem(SAM_ONBOARDING_STATE_KEY, 'seen');
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [samSetupStatus.setupComplete]);

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
          if (manualUpdateCheckRef.current) {
            setUpdateModal(payload);
            manualUpdateCheckRef.current = false;
          }
          return;
        }
        if (type === 'update:status') {
          setUpdaterStatus(payload || null);
          if (manualUpdateCheckRef.current) {
            setSheetState((current) => ({
              ...current,
              statusKind: payload?.state === 'error' ? 'warning' : 'info',
              statusMessage: payload?.message || current.statusMessage,
            }));
            if (payload?.state === 'downloaded' || payload?.state === 'error') {
              manualUpdateCheckRef.current = false;
            }
          }
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

  useEffect(() => {
    if (!sheetState.backendReady || samSetupStatus.loading || !samSetupStatus.setupComplete) {
      return;
    }
    // Do not show update status on normal startup
    // void runStartupUpdateCheck();
  }, [runStartupUpdateCheck, samSetupStatus.loading, samSetupStatus.setupComplete, sheetState.backendReady]);

  const selectedItem = items[selectedIndex] || items[0];
  const editorValidation = useMemo(() => {
    if (!editorDraft) return { errors: [], id: '' };
    const comparisonItems = editorIndex === null
      ? items
      : items.filter((_, index) => index !== editorIndex);
    return validateNotification(editorDraft, comparisonItems);
  }, [editorDraft, editorIndex, items]);

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

  const loadSamSetupStatus = useCallback(async () => {
    try {
      const status = await api.getSamSetupStatus();
      const nextStatus = {
        loading: false,
        setupComplete: Boolean(status?.setupComplete),
        userName: status?.userName || '',
        userRole: status?.userRole || status?.role || '',
        ok: status?.ok !== false,
        error: status?.error || '',
      };
      setSamSetupStatus(nextStatus);
      return nextStatus;
    } catch (error) {
      const message = getErrorMessage(error, 'SAM setup requires access to the admin configuration sheet.');
      const nextStatus = { loading: false, setupComplete: false, userName: '', userRole: '', ok: false, error: message };
      setSamSetupStatus(nextStatus);
      return nextStatus;
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
        readError: response?.ok === false ? (response?.error || 'Unable to read the master sam-notifications tab.') : '',
        sheetId: response?.sheet?.sheetId || '',
        statusKind: response?.ok === false ? 'warning' : current.statusKind,
        statusMessage: response?.ok === false ? (response?.error || 'Unable to read the master sam-notifications tab.') : current.statusMessage,
      }));
      refreshDiagnostics();
    } catch (error) {
      const message = getErrorMessage(error, 'Unable to read the master sam-notifications tab.');
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
      const result = await window.electronAPI?.retryBackendStartup?.({ resetAttempts: resetAttempt });
      if (!result?.ok) {
        const message = result?.error || 'Unable to start SAM backend right now.';
        scheduleBackendStartupRetry(message);
        return;
      }

      await refreshDiagnostics();
      const setup = await loadSamSetupStatus();
      if (!setup.setupComplete) {
        setSheetState((current) => ({
          ...current,
          isLoading: false,
          backendReady: true,
          backendStatus: 'connected',
          statusKind: setup.ok ? 'info' : 'warning',
          statusMessage: setup.error || 'SAM setup is required before the dashboard can open.',
          readError: setup.error || '',
        }));
        return;
      }
      await loadSheetItems({ silent: false });
      await loadCandidateTracking({ silent: true });
    } catch (error) {
      const message = getErrorMessage(error, 'Unable to start SAM backend right now.');
      scheduleBackendStartupRetry(message);
    }
  }, [clearBackendStartupRetryTimer, loadCandidateTracking, loadSamSetupStatus, loadSheetItems, refreshDiagnostics, scheduleBackendStartupRetry]);

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
        const setup = await loadSamSetupStatus();
        if (!setup.setupComplete) {
          setSheetState((current) => ({
            ...current,
            isLoading: false,
            backendReady: true,
            backendStatus: 'connected',
            statusKind: setup.ok ? 'info' : 'warning',
            statusMessage: setup.error || 'SAM setup is required before the dashboard can open.',
            readError: setup.error || '',
          }));
          return;
        }
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
  }, [clearBackendStartupRetryTimer, loadCandidateTracking, loadSamSetupStatus, loadSheetItems, refreshDiagnostics, scheduleBackendStartupRetry]);

  const selectNotification = (index) => {
    setSelectedIndex(index);
  };

  const openEditor = (index = selectedIndex) => {
    const safeIndex = Number.isInteger(index) && items[index] ? index : selectedIndex;
    if (items[safeIndex]) {
      setSelectedIndex(safeIndex);
      setEditorIndex(safeIndex);
      setEditorDraft(normalizeManagerNotification({ ...items[safeIndex] }));
    }
    setEditorOpen(true);
  };

  const persistNotification = useCallback(async (item, { successMessage = '', sourceIndex = editorIndex } = {}) => {
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
        const message = result?.error || 'The backend did not confirm a successful sheet write.';
        setSheetState((current) => ({
          ...current,
          isSaving: false,
          statusKind: 'error',
          statusMessage: message,
        }));
        showStatusModal(message, 'error');
        return null;
      }

      const savedItem = normalizeManagerNotification(result.item || outgoing);
      setItems((current) => {
        const replaced = current.some((entry) => entry.ID === savedItem.ID)
          ? current.map((entry) => (entry.ID === savedItem.ID ? savedItem : entry))
          : (sourceIndex === null
            ? [...current, savedItem]
            : current.map((entry, index) => (index === sourceIndex ? savedItem : entry)));
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
        statusMessage: successMessage || 'Notification saved. MTS should update within about a minute.',
      }));
      await loadSheetItems({ silent: true });
      showStatusModal(successMessage || 'Notification saved. MTS should update within about a minute.', 'success');
      return savedItem;
    } catch (error) {
      const message = getErrorMessage(error, 'Unable to submit the notification to Google Sheets.');
      setSheetState((current) => ({
        ...current,
        isSaving: false,
        statusKind: 'error',
        statusMessage: message,
      }));
      showStatusModal(message, 'error');
      return null;
    }
  }, [editorIndex, loadSheetItems, showStatusModal]);

  const updateSelected = (patch) => {
    setEditorDraft((currentDraft) => {
      if (!currentDraft) return currentDraft;
      const next = normalizeManagerNotification({
        ...currentDraft,
        ...patch,
        UpdatedAt: new Date().toISOString(),
      });

      if (patch.EndDate && !currentDraft.EndDate && !patch.EndTime) {
        next.EndTime = '12:00 AM';
      }

      if (patch.EndDate === '') {
        next.EndTime = '';
      }

      return next;
    });
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
    setEditorDraft(next);
    setEditorIndex(null);
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
    setEditorDraft(duplicate);
    setEditorIndex(null);
    setEditorOpen(true);
  };

  const handleDeleteIndex = async (index) => {
    const target = items[index];
    if (!target) {
      closeEditor();
      return;
    }
    const confirmed = await requestConfirm(`Delete "${target?.Title || target?.Message || 'this notification'}"?`, {
      kind: 'danger',
      confirmLabel: 'Delete',
    });
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
        const message = result?.error || 'The backend did not confirm the notification was deleted from the sheet.';
        setSheetState((current) => ({
          ...current,
          isSaving: false,
          statusKind: 'error',
          statusMessage: message,
        }));
        showStatusModal(message, 'error');
        return;
      }
    } catch (error) {
      const message = getErrorMessage(error, 'Unable to delete the notification from Google Sheets.');
      setSheetState((current) => ({
        ...current,
        isSaving: false,
        statusKind: 'error',
        statusMessage: message,
      }));
      showStatusModal(message, 'error');
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
      statusMessage: 'Notification deleted from sam-notifications. MTS should update within about a minute.',
    }));
    await loadSheetItems({ silent: true });
    showStatusModal('Notification deleted.', 'success');
  };

  const handleDelete = () => {
    if (editorIndex === null) {
      closeEditor();
      return;
    }
    handleDeleteIndex(editorIndex);
  };

  const handleToggleEnabled = async (index) => {
    const target = items[index];
    const nextEnabled = !target?.Enabled;
    const confirmed = await requestConfirm(`${nextEnabled ? 'Enable' : 'Disable'} "${target?.Title || target?.Message || 'this notification'}"?`, {
      kind: nextEnabled ? 'info' : 'danger',
      confirmLabel: nextEnabled ? 'Enable' : 'Disable',
    });
    if (!confirmed) return;
    const toggled = normalizeManagerNotification({
      ...target,
      Enabled: nextEnabled,
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
      successMessage: toggled.Enabled ? 'Notification enabled.' : 'Notification disabled.',
      sourceIndex: index,
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

  const openSection = (item) => {
    if (item.key === 'help') {
      setHelpOpen(true);
      return;
    }
    setActiveSection(item.key || 'notifications');
    if (item.candidateView) setCandidateView(item.candidateView);
  };

  const handleExitApp = async () => {
    if (window.electronAPI?.quitApp) {
      await window.electronAPI.quitApp().catch(() => {});
      return;
    }

    if (await requestConfirm('Are you sure you want to exit Sam?', { kind: 'danger', confirmLabel: 'Exit' })) {
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
    if (!editorDraft) return;
    if (editorValidation.errors.length > 0) {
      setSheetState((current) => ({
        ...current,
        statusKind: 'error',
        statusMessage: editorValidation.errors[0],
      }));
      showStatusModal(editorValidation.errors[0], 'error');
      return;
    }

    const saved = await persistNotification({ ...editorDraft, ID: editorValidation.id }, {
      successMessage: 'Notification saved. MTS should update within about a minute.',
      sourceIndex: editorIndex,
    });
    if (saved) closeEditor();
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
    samSetupStatus.userName ? `SAM user: ${samSetupStatus.userName}` : null,
    sheetState.writeReady ? 'Direct sheet write ready' : 'Direct sheet write not configured',
  ].filter(Boolean);

  const visibleItems = items
    .map((item, index) => ({ item: normalizeManagerNotification(item), index }))
    .filter(({ item }) => {
      if (notificationView === 'active') return isCurrentNotification(item);
      if (notificationView === 'disabled') return !isCurrentNotification(item);
      return true;
    });

  const handleSamSetupComplete = async (result) => {
    const nextStatus = {
      loading: false,
      setupComplete: true,
      userName: result?.name || result?.userName || '',
      userRole: result?.role || result?.userRole || '',
      ok: true,
      error: '',
    };
    setSamSetupStatus(nextStatus);
    setSheetState((current) => ({
      ...current,
      backendReady: true,
      backendStatus: 'connected',
      statusKind: 'success',
      statusMessage: `SAM setup complete${nextStatus.userName ? ` for ${nextStatus.userName}` : ''}.`,
      readError: '',
    }));
    await loadSheetItems({ silent: false });
    await loadCandidateTracking({ silent: true });
  };

  if (sheetState.backendReady && !samSetupStatus.loading && !samSetupStatus.setupComplete) {
    return <SamSetupWizard status={samSetupStatus} onComplete={handleSamSetupComplete} />;
  }

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
                  <button type="button" className="nm-btn nm-btn-secondary" onClick={() => { setActiveSection('candidates'); setCandidateView('allActive'); setCandidateSearch(''); }} data-sam-tour="candidate-tracking-btn">Candidate Tracking</button>
                  <button type="button" className="nm-btn nm-btn-secondary" onClick={() => setSearchModalOpen(true)} data-sam-tour="candidate-search-btn">Candidate Search</button>
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

        <section className="nm-section-nav" aria-label="SAM sections">
          <div>
            <div className="nm-toolbar-label">Sections</div>
            <div className="nm-kicker">Jump directly to notification work or candidate administration.</div>
          </div>
          <div className="nm-section-nav-buttons">
            {SECTION_NAV_ITEMS.map((item) => (
              <button
                key={`${item.target}-${item.label}`}
                type="button"
                className={`nm-btn nm-btn-secondary nm-btn-table ${
                  item.key === 'candidates'
                    ? (activeSection === 'candidates' && item.candidateView === candidateView ? 'is-active' : '')
                    : (activeSection === item.key ? 'is-active' : '')
                }`}
                onClick={() => openSection(item)}
              >
                {item.label}
              </button>
            ))}
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

        <div className={`nm-grid nm-screen-grid nm-screen-${activeSection}`}>
          {activeSection === 'preview' ? (
          <section className="nm-panel nm-preview-panel" id="sam-live-preview">
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
          ) : null}

          {activeSection === 'notifications' ? (
          <section className="nm-panel" id="sam-notifications" data-sam-tour="notification-list">
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
          ) : null}
        </div>
        {activeSection === 'candidates' ? (
          <CandidateTrackingPanel
            data={candidateTracking}
            view={candidateView}
            onViewChange={setCandidateView}
            loading={candidateTrackingLoading}
            onRefresh={() => loadCandidateTracking()}
            onAction={runCandidateAction}
            onConfirm={requestConfirm}
            search={candidateSearch}
            onSearchChange={setCandidateSearch}
            actor={samSetupStatus.userName || samSetupStatus.userRole || 'SAM'}
          />
        ) : null}
      </div>
      <NotificationEditorModal
        open={editorOpen}
        selectedItem={editorDraft}
        validation={editorValidation}
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
      <CandidateSearchModal
        open={searchModalOpen}
        data={candidateTracking}
        onClose={() => setSearchModalOpen(false)}
        onViewInTracking={handleViewInTracking}
      />
      <UpdateModal
        updateInfo={updateModal}
        updaterStatus={updaterStatus}
        onInstall={handleInstallUpdate}
        onManualDownload={handleManualDownloadUpdate}
        onLater={() => setUpdateModal(null)}
      />
      <StatusModal
        message={statusModal?.message || ''}
        kind={statusModal?.kind || 'info'}
        onClose={() => setStatusModal(null)}
      />
      <ConfirmModal
        state={confirmModal}
        onConfirm={(value) => resolveConfirm(value)}
        onCancel={() => resolveConfirm(false)}
      />
    </div>
  );
}

function CandidateSearchModal({ open, data, onClose, onViewInTracking }) {
  const [search, setSearch] = useState('');
  if (!open) return null;

  const candidates = data?.candidates || [];
  const searchText = search.trim().toLowerCase();
  const visible = searchText
    ? candidates.filter(c => String(c.candidate_name || '').toLowerCase().includes(searchText))
    : [];

  return (
    <div className="modal-overlay open" onClick={e => { if (e.target.classList.contains('modal-overlay')) onClose(); }}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 600, maxHeight: '80vh' }}>
        <div className="modal-header">
          <h2>Candidate Search</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="nm-search-row" style={{ margin: 0 }}>
            <label htmlFor="modal-candidate-search">Search by candidate name</label>
            <input
              id="modal-candidate-search"
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Type a candidate name..."
              autoFocus
              style={{ width: '100%', padding: '8px 12px', fontSize: 14, borderRadius: 4, border: '1px solid var(--border-subtle)' }}
            />
          </div>
          <div style={{ maxHeight: '45vh', overflowY: 'auto' }}>
            {searchText === '' ? (
              <p className="text-muted" style={{ textAlign: 'center', padding: '24px 0' }}>Type a name above to search all candidates.</p>
            ) : visible.length === 0 ? (
              <p className="text-muted" style={{ textAlign: 'center', padding: '24px 0' }}>No candidates found matching "{search}".</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {visible.map((c, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderRadius: 4, backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
                    <div>
                      <strong style={{ display: 'block', fontSize: 14 }}>{c.candidate_name || 'Unknown'}</strong>
                      <span className="nm-meta" style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                        Status: {c.status || c.latest_status || 'Active'} | Tester: {c.original_tester_name || c.tester_name || 'N/A'}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="nm-btn nm-btn-primary nm-btn-sm"
                      onClick={() => {
                        onViewInTracking(c);
                        onClose();
                      }}
                      style={{ padding: '4px 10px', fontSize: 12 }}
                    >
                      View in Tracking
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
