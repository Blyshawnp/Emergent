import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  Bell,
  Headphones,
  Users,
  Clock,
  Plus,
  RefreshCw,
  HelpCircle,
  Search,
  Download,
  Upload,
  DownloadCloud,
  LogOut,
  ChevronDown,
  Wifi,
  WifiOff,
  Inbox,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Key,
  Mail,
  Shield,
  Lock,
  Eye,
  EyeOff,
  UserCheck,
  UserX,
  User,
  Settings as SettingsIcon,
} from 'lucide-react';
import './notification-manager.css';
import './polish-sam.css';
import api from './api';
import {
  signInWithPassword,
  refreshAuthSession,
  resetPasswordForEmail,
  updateUserAccount,
  updateUserPassword,
  parseRecoveryUrl,
  signOutAuth,
} from './utils/supabaseAuth';
import PendingRequestAlert from './components/PendingRequestAlert';
import PostSetupQuickStart from './components/PostSetupQuickStart';
import { TutorialVideoLibrary } from './components/TutorialVideoPlayer';
import { normalizeTutorialVideos } from './utils/tutorialVideos';
import { createSamSnapshotCoordinator } from './utils/samSnapshotCoordinator';
import { newbieShiftStatusMeta } from './utils/certificationWorkflow';
import { buildHeadsetDisplayLabel, getCandidateHeadset } from './utils/headsetDisplay';
import { playSound, setSoundSettings } from './utils/sound';
import {
  NOTIFICATION_CSV_COLUMNS,
  NOTIFICATION_MANAGER_STORAGE_KEY,
  createEmptyNotification,
  createNotificationId,
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
  normalizeHeadsetNotificationMode,
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
const SAM_QUICK_START_STATE_KEY = 'sam:quick-start:v1';
const SAM_SETTINGS_KEY = 'sam:settings';
const SAM_BACKEND_RETRY_LIMIT = 6;
const SAM_BACKEND_RETRY_BASE_DELAY_MS = 2000;
const SAM_BACKEND_RETRY_MAX_DELAY_MS = 12000;
const SAM_AUTO_REFRESH_INTERVAL_MS = 60000;
const DEFAULT_SAM_SETTINGS = {
  soundVolume: 'medium',
  statusBannerDurationSeconds: 60,
  defaultCandidateView: 'pending',
  includeArchivedInSearchDefault: false,
  requireNewbieShiftApproval: true,
  headsetNotificationMode: 'all',
};
const SAM_SOUND_VOLUME_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];
const SAM_BANNER_DURATION_OPTIONS = [
  { value: 30, label: '30 seconds' },
  { value: 60, label: '60 seconds' },
  { value: 120, label: '120 seconds' },
];
const SAM_HELP_SECTIONS = [
  {
    id: 'dashboard',
    title: 'Dashboard',
    body: 'Dashboard gives admins a quick count of active notifications, pending headset reviews, pending supervisor transfers, pending approval requests, and the last sync time. Use it first to decide where attention is needed.',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    body: 'Create, edit, enable, disable, archive, withdraw, delete, import, export, and refresh trainer alerts. Success and error feedback appears in the status banner and can play sounds when enabled.',
  },
  {
    id: 'live-preview',
    title: 'Live Preview',
    body: 'Preview ticker, banner, and popup output for the selected notification before publishing it.',
  },
  {
    id: 'headset-review',
    title: 'Headset Review',
    body: 'Headset Review shows unknown headset submissions from MTS. Approve only when the model is confirmed USB with a noise-cancelling microphone, deny models that should not be used, archive completed rows, and refresh if the queue looks stale.',
  },
  {
    id: 'candidate-search',
    title: 'Candidate Search',
    body: 'Search by candidate name, include archived records when needed, and open the matching candidate in Candidate Tracking for the full record and available actions.',
  },
  {
    id: 'candidate-tracking',
    title: 'Candidate Tracking',
    body: 'Review pending transfers, incomplete candidates, failed attempts, withdrawn candidates, passed certifications, archived candidates, and all active candidates. Use View Details for the reading pane, Copy Selected for a quick handoff, Print Report for a paper review, Archive for history cleanup, Withdraw when a candidate leaves certification, Extra Attempt when admin approval allows another try, and Delete only when a shared row must be removed.',
  },
  {
    id: 'reports',
    title: 'Reports',
    body: 'Use Copy Selected, Print Report, and CSV export for an operational handoff. Review the selected rows before sharing or printing them.',
  },
  {
    id: 'pending-sup-transfers',
    title: 'Pending Sup Transfers',
    body: 'Pending transfer rows show candidates whose mock calls were saved but whose supervisor transfer still needs completion or correction.',
  },
  {
    id: 'pending-requests',
    title: 'Pending Requests',
    body: 'Pending Requests is the SAM inbox for initial Newbie Shift requests, Newbie Shift reschedules, and candidate-list deletion requests. Approve records the admin and timestamp. Deny requires a readable reason. Remind Me and Dismiss suppress only the immediate workflow alert for 30 minutes; unresolved requests stay in the inbox and bell count until approved or denied. Headset Review uses a separate grouped reminder after two hours and remains visible in its own badge.',
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    body: 'If information looks stale, wait a moment and select Refresh. Confirm the Live status, retry the action once, and use Request App Support if the issue continues.',
  },
  {
    id: 'sync-offline',
    title: 'Refresh, Sync, and Offline behavior',
    body: 'Refresh reloads shared data. If it is temporarily unavailable, wait about 60 seconds and retry. SAM keeps the current screen usable where possible and shows a friendly error message.',
  },
  {
    id: 'export-print-copy',
    title: 'Export, Print, and Copy Selected',
    body: 'Export CSV saves visible or selected candidate rows for offline review. Print Report prints selected rows. Copy Selected places selected candidate details on the clipboard for admin handoff.',
  },
  {
    id: 'candidate-admin-actions',
    title: 'Archive, Withdraw, Delete, and Extra Attempt',
    body: 'Archive hides closed history from active views. Withdraw blocks certification until restored or an extra attempt is granted. Delete removes shared candidate history and should be rare. Extra Attempt allows a candidate to continue after admin approval.',
  },
  {
    id: 'import-export-csv',
    title: 'Import/Export CSV',
    body: 'Export a backup CSV before bulk edits. Import replaces the local draft list so it can be reviewed before rows are submitted.',
  },
  {
    id: 'refresh-data',
    title: 'Refresh Data',
    body: 'Refresh reloads notifications and candidate tracking without restarting SAM.',
  },
  {
    id: 'check-for-updates',
    title: 'Check for Updates',
    body: 'Check for Updates reads the SAM release metadata. Required updates must be installed before normal use continues.',
  },
  {
    id: 'archiving-candidates',
    title: 'Archiving Candidates',
    body: 'Archived candidates move to Archived Candidates and stay out of active views. SAM auto-archives clearly closed Pass, Withdrawn, and Fail-Final Attempt records after 60 days when the closed date is clear.',
  },
  {
    id: 'sounds-status-banners',
    title: 'Sounds/status banners',
    body: 'Success banners auto-dismiss based on the setting below. Errors stay visible longer, remain dismissible, and can play the SAM error sound.',
  },
  {
    id: 'support',
    title: 'Support',
    body: 'For application assistance, please use the Request App Support form. Do not submit headset appeals or headset review requests here.',
  },
];
const SAM_TUTORIAL_STEPS = [
  {
    target: 'notification-list',
    title: 'Notification list',
    body: 'Notifications shows the shared alert list managed in SAM.',
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
    body: 'These chips show the live connection status, the active workspace, and the configured SAM user.',
    placement: 'left',
  },
  {
    target: 'help-access',
    title: 'Help',
      body: 'Open Help for assigned name and PIN setup, candidate administration workflows, updates, and tutorial replay.',
    placement: 'bottom',
  },
  {
    target: 'notification-list',
    title: 'Enable and edit',
    body: 'Use Edit to open the modal. Enable, Disable, and Delete update the shared notification after confirmation.',
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
const SAM_SHARED_DATA_TEMPORARY_MESSAGE = 'Shared data is taking longer than usual. SAM will keep trying.';
const SAM_SHARED_DATA_STALE_MESSAGE = 'Shared data is temporarily delayed. Showing the last successful data while SAM keeps trying.';
const SAM_SHARED_DATA_OFFLINE_MESSAGE = 'SAM is offline and showing the last successful shared data. SAM will keep trying.';
const SAM_CANDIDATE_TRACKING_TEMPORARY_MESSAGE = 'Candidate Tracking is temporarily unavailable. SAM will retry automatically.';
const SAM_PENDING_REQUESTS_TEMPORARY_MESSAGE = 'Pending Requests are temporarily unavailable. SAM will retry automatically. Please wait a moment and select Refresh if needed.';
const SAM_HEADSET_REVIEW_TEMPORARY_MESSAGE = 'Headset Review is temporarily unavailable. SAM will retry automatically.';
const SAM_SETUP_DEFAULT_MESSAGE = 'SAM could not verify your assigned access. Please try again or contact support.';
const SAM_SETUP_ERROR_MESSAGES = Object.freeze({
  setup_configuration_unavailable: 'SAM setup is temporarily unavailable because its administrator configuration could not be loaded.',
  setup_authorization_failed: 'SAM could not verify setup authorization. Contact support if this continues.',
  setup_admin_not_found: 'The administrator name or PIN was not recognized.',
  setup_invalid_admin: 'The administrator name or PIN was not recognized.',
  setup_invalid_pin: 'The administrator name or PIN was not recognized.',
  setup_transport_unavailable: 'SAM could not verify setup right now. Check the connection and try again.',
  setup_response_invalid: 'SAM received an invalid setup response. Please try again.',
  setup_persistence_failed: 'SAM verified the administrator, but could not save setup on this device. Please try again.',
});

export function getSamSetupErrorMessage(value, fallback = SAM_SETUP_DEFAULT_MESSAGE) {
  const errorCode = typeof value === 'string'
    ? value
    : value?.errorCode || value?.response?.data?.errorCode || '';
  return SAM_SETUP_ERROR_MESSAGES[errorCode] || fallback;
}

function getErrorMessage(error, fallback) {
  if (!error) return fallback;
  if (typeof error.response?.data?.error === 'string') return error.response.data.error;
  if (error.response?.data?.error) return fallback;
  if (typeof error.response?.data?.message === 'string') return error.response.data.message;
  if (error.response?.status === 429) return 'HTTP 429 rate limit';
  if (error.code === 'ECONNABORTED') return SAM_SHARED_DATA_TEMPORARY_MESSAGE;
  if (/network error/i.test(error.message || '')) return 'Unable to reach live content. Please try Refresh or contact support.';
  return typeof error.message === 'string' ? error.message : fallback;
}

function isSharedDataTemporaryError(value) {
  const text = String(value || '').toLowerCase();
  return /\[object object\]|quota|429|rate limit|rate_limit|too many requests|resource exhausted|auth|credential|unauthori[sz]ed|forbidden|google|sheet|temporary|temporarily|timeout|unavailable|api/.test(text);
}

function getSharedDataErrorMessage(error, fallback = SAM_SHARED_DATA_TEMPORARY_MESSAGE) {
  const raw = getErrorMessage(error, fallback);
  if (isSharedDataTemporaryError(raw)) {
        console.warn('[SAM] Shared data request failed; user-facing details were sanitized.');
    return fallback;
  }
  return raw || fallback;
}

function getCandidateTrackingErrorMessage(error) {
  return getSharedDataErrorMessage(error, SAM_CANDIDATE_TRACKING_TEMPORARY_MESSAGE);
}

function isSharedDataStatusMessage(value) {
  return [SAM_SHARED_DATA_TEMPORARY_MESSAGE, SAM_SHARED_DATA_STALE_MESSAGE, SAM_SHARED_DATA_OFFLINE_MESSAGE].includes(String(value || ''));
}

function formatSamTimestamp(value) {
  if (!value) return 'Unknown';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function normalizeSamSettings(settings = {}) {
  const soundVolume = SAM_SOUND_VOLUME_OPTIONS.some((item) => item.value === settings.soundVolume)
    ? settings.soundVolume
    : DEFAULT_SAM_SETTINGS.soundVolume;
  const statusBannerDurationSeconds = SAM_BANNER_DURATION_OPTIONS.some((item) => item.value === Number(settings.statusBannerDurationSeconds))
    ? Number(settings.statusBannerDurationSeconds)
    : DEFAULT_SAM_SETTINGS.statusBannerDurationSeconds;
  const defaultCandidateView = Object.prototype.hasOwnProperty.call(CANDIDATE_VIEW_LABELS, settings.defaultCandidateView)
    ? settings.defaultCandidateView
    : DEFAULT_SAM_SETTINGS.defaultCandidateView;
  const includeArchivedInSearchDefault = Boolean(settings.includeArchivedInSearchDefault);
  const requireNewbieShiftApproval = settings.requireNewbieShiftApproval !== undefined
    ? Boolean(settings.requireNewbieShiftApproval)
    : (settings.require_newbie_shift_approval !== undefined
      ? Boolean(settings.require_newbie_shift_approval)
      : DEFAULT_SAM_SETTINGS.requireNewbieShiftApproval);
  const headsetNotificationMode = normalizeHeadsetNotificationMode(
    settings.headsetNotificationMode || settings.headset_notification_mode
  );
  return {
    soundVolume,
    statusBannerDurationSeconds,
    defaultCandidateView,
    includeArchivedInSearchDefault,
    requireNewbieShiftApproval,
    headsetNotificationMode,
  };
}

function loadSamSettings() {
  try {
    return normalizeSamSettings(JSON.parse(localStorage.getItem(SAM_SETTINGS_KEY) || '{}'));
  } catch (_error) {
    return { ...DEFAULT_SAM_SETTINGS };
  }
}

function sheetTruthy(value) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return false;
  return ['true', '1', 'yes', 'y', 'on', 'checked'].includes(String(value).trim().toLowerCase());
}

function isCandidateArchived(row) {
  return sheetTruthy(row?.archived);
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

function getRowStatusTone(item) {
  if (isExpiredNotification(item)) return 'expired';
  return item.Enabled ? 'enabled' : 'disabled';
}

function formatRelativeSyncTime(timestamp) {
  if (!timestamp) return 'Not yet synced';
  const diffSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (diffSeconds < 10) return 'Just now';
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const minutes = Math.round(diffSeconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  try {
    return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch (_error) {
    return 'Earlier';
  }
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

function SettingsModal({
  initialTab = 'general',
  version,
  settings,
  samSetupStatus,
  onLogout,
  onSettingsChange,
  onCheckForUpdates,
  onClose,
}) {
  const [modalTab, setModalTab] = useState(initialTab); // 'general' | 'workflow' | 'notifications' | 'account' | 'users'

  // Account State
  const [accountPassword, setAccountPassword] = useState('');
  const [accountConfirmPassword, setAccountConfirmPassword] = useState('');
  const [accountEmail, setAccountEmail] = useState('');
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountSuccess, setAccountSuccess] = useState('');
  const [accountError, setAccountError] = useState('');
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [showEmailForm, setShowEmailForm] = useState(false);

  // User Management State
  const [userList, setUserList] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState('');
  const [usersSuccess, setUsersSuccess] = useState('');
  const [callerIsOwner, setCallerIsOwner] = useState(Boolean(samSetupStatus?.isOwner));

  // Edit User State
  const [editingUser, setEditingUser] = useState(null);
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState('administrator');
  const [editSaving, setEditSaving] = useState(false);
  const [actionInProgressId, setActionInProgressId] = useState(null);

  const accessToken = samSetupStatus?.session?.access_token || null;

  const loadUserManagementList = useCallback(async () => {
    if (!samSetupStatus?.authUid) return;
    setUsersLoading(true);
    setUsersError('');
    try {
      const res = await api.getSamUserManagementList(samSetupStatus.authUid, accessToken);
      if (res?.ok) {
        setUserList(res.users || []);
        setCallerIsOwner(Boolean(res.caller_is_owner));
      } else {
        setUsersError(res?.error || 'Unable to load user authorization list.');
      }
    } catch (err) {
      setUsersError(err?.message || 'Failed to connect to user management.');
    } finally {
      setUsersLoading(false);
    }
  }, [samSetupStatus?.authUid, accessToken]);

  useEffect(() => {
    if (modalTab === 'users') {
      void loadUserManagementList();
    }
  }, [modalTab, loadUserManagementList]);

  const updateSetting = (patch) => {
    onSettingsChange?.(normalizeSamSettings({ ...settings, ...patch }));
  };

  const activeOwnerCount = useMemo(() => {
    return userList.filter((u) => u.active && (u.role === 'owner' || u.is_owner)).length;
  }, [userList]);

  const handleToggleUserActive = async (targetUser) => {
    if (!samSetupStatus?.authUid || !targetUser?.id) return;
    const nextActive = !targetUser.active;
    const actionWord = nextActive ? 'activate' : 'deactivate';

    if (!nextActive && (targetUser.role === 'owner' || targetUser.is_owner) && activeOwnerCount <= 1) {
      alert('Cannot deactivate the sole active Owner. Promote another active user to Owner first.');
      return;
    }

    if (!window.confirm(`Are you sure you want to ${actionWord} administrator access for ${targetUser.display_name}? This change takes effect immediately without sending any email.`)) {
      return;
    }
    setActionInProgressId(targetUser.id);
    setUsersError('');
    setUsersSuccess('');
    try {
      const res = await api.setSamUserActive(samSetupStatus.authUid, targetUser.id, nextActive, accessToken);
      if (res?.ok) {
        setUsersSuccess(`Successfully updated status for ${targetUser.display_name}.`);
        await loadUserManagementList();
      } else {
        setUsersError(res?.error || `Failed to ${actionWord} user.`);
      }
    } catch (err) {
      setUsersError(err?.message || `Failed to ${actionWord} user.`);
    } finally {
      setActionInProgressId(null);
    }
  };

  const handleStartEdit = (u) => {
    setEditingUser(u);
    setEditEmail(u.email || '');
    setEditRole(u.role || 'administrator');
    setUsersError('');
    setUsersSuccess('');
  };

  const handleSaveEdit = async (e) => {
    e.preventDefault();
    if (!editingUser) return;
    const cleanEmail = editEmail.trim().toLowerCase();
    if (cleanEmail && !cleanEmail.includes('@')) {
      setUsersError('Please provide a valid email address.');
      return;
    }
    if (
      editingUser.is_owner &&
      editingUser.active &&
      editRole !== 'owner' &&
      activeOwnerCount <= 1
    ) {
      setUsersError('Cannot demote the sole active Owner. Promote another user to Owner first.');
      return;
    }

    setEditSaving(true);
    setUsersError('');
    setUsersSuccess('');
    try {
      const res = await api.updateSamUser(
        samSetupStatus.authUid,
        editingUser.id,
        { email: cleanEmail, role: editRole },
        accessToken
      );
      if (res?.ok) {
        setUsersSuccess(`Successfully updated ${editingUser.display_name}. Information saved without sending email.`);
        setEditingUser(null);
        await loadUserManagementList();
      } else {
        setUsersError(res?.error || 'Failed to update user.');
      }
    } catch (err) {
      setUsersError(err?.message || 'Failed to update user.');
    } finally {
      setEditSaving(false);
    }
  };

  const handleSendAccountSetup = async (targetUser) => {
    const email = (targetUser.email || '').trim();
    if (!email || !email.includes('@')) {
      alert('Cannot send account setup: User has no email address configured. Click "Edit" to configure their email first.');
      return;
    }
    if (!window.confirm(`Send account setup invitation to ${targetUser.display_name} (${email})? This will create or link their Supabase Auth identity and send a setup link.`)) {
      return;
    }
    setActionInProgressId(targetUser.id);
    setUsersError('');
    setUsersSuccess('');
    try {
      const enrollRes = await api.enrollSamUser(samSetupStatus.authUid, targetUser.id, accessToken);
      if (!enrollRes?.ok) {
        setUsersError(enrollRes?.error || 'Failed to send account setup.');
        return;
      }
      setUsersSuccess(enrollRes?.message || `Account setup invitation sent to ${email}.`);
      await loadUserManagementList();
    } catch (err) {
      setUsersError(err?.message || 'Failed to send account setup.');
    } finally {
      setActionInProgressId(null);
    }
  };

  const handleSendPasswordReset = async (targetUser) => {
    const email = (targetUser.email || '').trim();
    if (!email || !email.includes('@')) {
      alert('Cannot send password reset: User has no email address configured.');
      return;
    }
    if (!window.confirm(`Send password reset email to ${targetUser.display_name} (${email})?`)) {
      return;
    }
    setActionInProgressId(targetUser.id);
    setUsersError('');
    setUsersSuccess('');
    try {
      const res = await api.sendSamUserPasswordReset(email);
      if (res?.ok) {
        setUsersSuccess(`Password reset instructions sent to ${email}.`);
      } else {
        setUsersError(res?.error || 'Failed to send password reset email.');
      }
    } catch (err) {
      setUsersError(err?.message || 'Failed to send password reset email.');
    } finally {
      setActionInProgressId(null);
    }
  };

  const handleUpdatePassword = async (e) => {
    e.preventDefault();
    if (!accountPassword || accountPassword.length < 6) {
      setAccountError('Password must be at least 6 characters.');
      return;
    }
    if (accountPassword !== accountConfirmPassword) {
      setAccountError('Passwords do not match.');
      return;
    }
    setAccountLoading(true);
    setAccountError('');
    setAccountSuccess('');
    try {
      const configRes = await api.getSamAuthConfig();
      const supabaseUrl = configRes?.supabase_url;
      const anonKey = configRes?.supabase_anon_key;
      const token = samSetupStatus?.session?.access_token;
      if (!supabaseUrl || !anonKey || !token) {
        setAccountError('Authentication session expired. Please sign in again.');
        return;
      }
      await updateUserAccount(supabaseUrl, anonKey, token, { password: accountPassword });
      setAccountSuccess('Password successfully updated.');
      setAccountPassword('');
      setAccountConfirmPassword('');
      setShowPasswordForm(false);
    } catch (err) {
      setAccountError(err?.message || 'Password update failed.');
    } finally {
      setAccountLoading(false);
    }
  };

  const handleUpdateEmail = async (e) => {
    e.preventDefault();
    if (!accountEmail || !accountEmail.includes('@')) {
      setAccountError('Please enter a valid email address.');
      return;
    }
    setAccountLoading(true);
    setAccountError('');
    setAccountSuccess('');
    try {
      const configRes = await api.getSamAuthConfig();
      const supabaseUrl = configRes?.supabase_url;
      const anonKey = configRes?.supabase_anon_key;
      const token = samSetupStatus?.session?.access_token;
      if (!supabaseUrl || !anonKey || !token) {
        setAccountError('Authentication session expired. Please sign in again.');
        return;
      }
      await updateUserAccount(supabaseUrl, anonKey, token, { email: accountEmail });
      setAccountSuccess('Email change requested. Please check your inbox to confirm.');
      setAccountEmail('');
      setShowEmailForm(false);
    } catch (err) {
      setAccountError(err?.message || 'Email update failed.');
    } finally {
      setAccountLoading(false);
    }
  };

  const renderEnrollmentBadge = (u) => {
    const rawStatus = u.enrollment_status || (u.is_linked ? 'Active / Enrolled' : (u.active ? 'Active / Enrollment Required' : 'Inactive / No Email'));
    let badgeStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '2px 8px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 600,
      whiteSpace: 'nowrap',
    };

    if (rawStatus.includes('Enrolled') && u.active) {
      badgeStyle = {
        ...badgeStyle,
        background: 'rgba(34, 197, 94, 0.15)',
        color: '#4ade80',
        border: '1px solid rgba(34, 197, 94, 0.3)',
      };
    } else if (rawStatus.includes('Setup Sent')) {
      badgeStyle = {
        ...badgeStyle,
        background: 'rgba(56, 189, 248, 0.15)',
        color: '#38bdf8',
        border: '1px solid rgba(56, 189, 248, 0.3)',
      };
    } else if (rawStatus.includes('Ready') || rawStatus.includes('Setup Not Sent')) {
      badgeStyle = {
        ...badgeStyle,
        background: 'rgba(234, 179, 8, 0.15)',
        color: '#facc15',
        border: '1px solid rgba(234, 179, 8, 0.3)',
      };
    } else if (rawStatus.includes('Required')) {
      badgeStyle = {
        ...badgeStyle,
        background: 'rgba(249, 115, 22, 0.15)',
        color: '#fb923c',
        border: '1px solid rgba(249, 115, 22, 0.3)',
      };
    } else {
      badgeStyle = {
        ...badgeStyle,
        background: 'rgba(148, 163, 184, 0.15)',
        color: '#94a3b8',
        border: '1px solid rgba(148, 163, 184, 0.3)',
      };
    }

    return (
      <span style={badgeStyle} title={`Enrollment State: ${rawStatus}`}>
        {rawStatus}
      </span>
    );
  };

  return (
    <div className="nm-modal-backdrop" onKeyDown={(e) => { if (e.key === 'Escape') onClose?.(); }}>
      <section className="nm-help-modal" role="dialog" aria-modal="true" aria-labelledby="sam-settings-title" style={{ maxWidth: 880 }}>
        <div className="nm-help-header">
          <div>
            <div className="nm-overline">SAM SETTINGS</div>
            <h2 id="sam-settings-title">Application &amp; Administration Settings</h2>
            <p>Configure device preferences, workflow policies, and authorized operators.</p>
          </div>
          <button type="button" className="nm-modal-close" onClick={onClose} aria-label="Close settings">×</button>
        </div>

        {/* Modal Navigation Tabs */}
        <div className="nm-view-tabs" role="tablist" aria-label="Settings sections">
          <button
            type="button"
            role="tab"
            aria-selected={modalTab === 'general'}
            className={`nm-view-tab ${modalTab === 'general' ? 'is-active' : ''}`}
            onClick={() => setModalTab('general')}
          >
            General
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={modalTab === 'workflow'}
            className={`nm-view-tab ${modalTab === 'workflow' ? 'is-active' : ''}`}
            onClick={() => setModalTab('workflow')}
          >
            Workflow
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={modalTab === 'notifications'}
            className={`nm-view-tab ${modalTab === 'notifications' ? 'is-active' : ''}`}
            onClick={() => setModalTab('notifications')}
          >
            Notifications
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={modalTab === 'account'}
            className={`nm-view-tab ${modalTab === 'account' ? 'is-active' : ''}`}
            onClick={() => setModalTab('account')}
          >
            Account &amp; Security
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={modalTab === 'users'}
            className={`nm-view-tab ${modalTab === 'users' ? 'is-active' : ''}`}
            onClick={() => setModalTab('users')}
            data-testid="sam-admin-settings-tab"
          >
            User Management
          </button>
        </div>

        <div className="nm-help-modal-body">
          {modalTab === 'general' && (
            <div className="nm-help-settings" id="sam-help-settings">
              <div className="nm-help-settings-copy">
                <div className="nm-overline">LOCAL PREFERENCES</div>
                <h3>Device preferences</h3>
                <p>These settings apply on this device and take effect immediately.</p>
                <p className="nm-meta">Version {version} · Powered by MTS</p>
              </div>
              <label className="nm-field">
                <span>SAM sounds</span>
                <select value={settings.soundVolume} onChange={(event) => updateSetting({ soundVolume: event.target.value })}>
                  {SAM_SOUND_VOLUME_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
              <label className="nm-field">
                <span>Success banner duration</span>
                <select value={settings.statusBannerDurationSeconds} onChange={(event) => updateSetting({ statusBannerDurationSeconds: Number(event.target.value) })}>
                  {SAM_BANNER_DURATION_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
              <label className="nm-field">
                <span>Default candidate filter</span>
                <select value={settings.defaultCandidateView} onChange={(event) => updateSetting({ defaultCandidateView: event.target.value })}>
                  {Object.entries(CANDIDATE_VIEW_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select>
              </label>
              <label className="nm-checkbox nm-help-toggle">
                <input
                  type="checkbox"
                  checked={settings.includeArchivedInSearchDefault}
                  onChange={(event) => updateSetting({ includeArchivedInSearchDefault: event.target.checked })}
                />
                Include archived candidates in search by default
              </label>
              <button type="button" className="nm-btn nm-btn-secondary" onClick={() => onCheckForUpdates?.()}>Check for Updates</button>
            </div>
          )}

          {modalTab === 'workflow' && (
            <div className="nm-help-settings" id="sam-admin-settings" style={{ gridTemplateColumns: '1fr', gap: 20 }}>
              <div className="nm-help-settings-copy">
                <div className="nm-overline">WORKFLOW POLICY</div>
                <h3>Approval Controls</h3>
                <p>Configure operational approval policies across SAM and MTS.</p>
              </div>

              <div className="nm-admin-setting-group" style={{ padding: '16px', background: 'var(--nm-card-bg, rgba(255,255,255,0.03))', borderRadius: 8, border: '1px solid var(--nm-border, rgba(255,255,255,0.08))' }}>
                <h4 style={{ margin: '0 0 12px 0', fontSize: '1rem', fontWeight: 600 }}>Workflow Approvals</h4>
                <label className="nm-field" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontWeight: 600 }}>Require Admin Approval for Newbie Shift Requests</span>
                  <select
                    value={settings.requireNewbieShiftApproval ? 'on' : 'off'}
                    onChange={(event) => updateSetting({ requireNewbieShiftApproval: event.target.value === 'on' })}
                    data-testid="require-newbie-shift-approval-select"
                    style={{ maxWidth: 320 }}
                  >
                    <option value="on">ON (Approval Required)</option>
                    <option value="off">OFF (Auto-Approved by Policy)</option>
                  </select>
                  <span className="nm-meta" style={{ marginTop: 4, color: 'var(--nm-muted, #888)' }}>
                    When disabled, newbie shift requests are still recorded and visible, but do not require Admin approval before the workflow can continue.
                  </span>
                </label>
              </div>
            </div>
          )}

          {modalTab === 'notifications' && (
            <div className="nm-help-settings" style={{ gridTemplateColumns: '1fr', gap: 20 }}>
              <div className="nm-help-settings-copy">
                <div className="nm-overline">NOTIFICATION CONTROLS</div>
                <h3>Alert Preferences</h3>
                <p>Configure alert thresholds and sound triggers for operations.</p>
              </div>

              <div className="nm-admin-setting-group" style={{ padding: '16px', background: 'var(--nm-card-bg, rgba(255,255,255,0.03))', borderRadius: 8, border: '1px solid var(--nm-border, rgba(255,255,255,0.08))' }}>
                <h4 style={{ margin: '0 0 12px 0', fontSize: '1rem', fontWeight: 600 }}>Headset Review Alerts</h4>
                <label className="nm-field" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontWeight: 600 }}>Headset Review Notifications</span>
                  <select
                    value={settings.headsetNotificationMode || 'all'}
                    onChange={(event) => updateSetting({ headsetNotificationMode: event.target.value })}
                    data-testid="headset-notification-mode-select"
                    style={{ maxWidth: 320 }}
                  >
                    <option value="all">All (Standard Notifications)</option>
                    <option value="action_required_only">Action Required Only</option>
                    <option value="muted">Muted (Data Updates Only)</option>
                  </select>
                  <span className="nm-meta" style={{ marginTop: 4, color: 'var(--nm-muted, #888)' }}>
                    Controls headset review alerts only. Muting notifications does not stop headset review data from updating.
                  </span>
                </label>
              </div>
            </div>
          )}

          {modalTab === 'account' && (
            <div className="nm-help-settings" style={{ gridTemplateColumns: '1fr', gap: 16 }}>
              <div className="nm-help-settings-copy">
                <div className="nm-overline">ACCOUNT PROFILE</div>
                <h3>Administrator Identity</h3>
                <p>Your identity is verified with server-side authorization on every session.</p>
              </div>

              <div className="nm-account-profile-grid">
                <div className="nm-account-profile-card">
                  <span className="nm-account-profile-label">Signed In As</span>
                  <strong className="nm-account-profile-value">{samSetupStatus?.userName || 'Administrator'}</strong>
                </div>
                <div className="nm-account-profile-card">
                  <span className="nm-account-profile-label">Email Address</span>
                  <span className="nm-account-profile-value" style={{ fontSize: 14, color: '#cbd5e1' }}>{samSetupStatus?.userEmail || 'Assigned local session'}</span>
                </div>
                <div className="nm-account-profile-card">
                  <span className="nm-account-profile-label">Assigned Role</span>
                  <span className="nm-account-profile-value" style={{ fontSize: 14, textTransform: 'capitalize', color: '#7dd3fc' }}>{samSetupStatus?.userRole || 'Administrator'}</span>
                </div>
                <div className="nm-account-profile-card">
                  <span className="nm-account-profile-label">Account Status</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 700, background: 'rgba(34, 197, 94, 0.15)', color: '#4ade80', border: '1px solid rgba(34, 197, 94, 0.3)', width: 'fit-content' }}>
                    Active
                  </span>
                </div>
              </div>

              {accountSuccess && (
                <div className="nm-status-card is-success">
                  <strong>Success</strong>
                  <span>{accountSuccess}</span>
                </div>
              )}

              {accountError && (
                <div className="nm-status-card is-warning">
                  <strong>Action Failed</strong>
                  <span>{accountError}</span>
                </div>
              )}

              <div className="nm-account-actions-bar">
                <button
                  type="button"
                  className="nm-btn nm-btn-secondary"
                  onClick={() => { setShowPasswordForm(!showPasswordForm); setShowEmailForm(false); setAccountError(''); setAccountSuccess(''); }}
                >
                  {showPasswordForm ? 'Close Password Change' : 'Change Password'}
                </button>
                <button
                  type="button"
                  className="nm-btn nm-btn-secondary"
                  onClick={() => { setShowEmailForm(!showEmailForm); setShowPasswordForm(false); setAccountError(''); setAccountSuccess(''); }}
                >
                  {showEmailForm ? 'Close Email Change' : 'Change Email'}
                </button>
                <button
                  type="button"
                  className="nm-btn nm-btn-danger"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => {
                    if (window.confirm('Are you sure you want to log out of SAM?')) {
                      onLogout?.();
                    }
                  }}
                >
                  <LogOut size={14} style={{ marginRight: 6 }} /> Log Out
                </button>
              </div>

              {showPasswordForm && (
                <form onSubmit={handleUpdatePassword} className="nm-account-subform-card">
                  <div className="nm-overline">UPDATE PASSWORD</div>
                  <label className="nm-field">
                    <span>New Password</span>
                    <input
                      type="password"
                      value={accountPassword}
                      onChange={(e) => setAccountPassword(e.target.value)}
                      placeholder="Enter at least 6 characters"
                      autoFocus
                      required
                    />
                  </label>
                  <label className="nm-field">
                    <span>Confirm New Password</span>
                    <input
                      type="password"
                      value={accountConfirmPassword}
                      onChange={(e) => setAccountConfirmPassword(e.target.value)}
                      placeholder="Repeat new password"
                      required
                    />
                  </label>
                  <div className="nm-account-subform-actions">
                    <button type="submit" className="nm-btn nm-btn-primary" disabled={accountLoading || !accountPassword || !accountConfirmPassword}>
                      {accountLoading ? 'Updating...' : 'Save New Password'}
                    </button>
                    <button type="button" className="nm-btn nm-btn-secondary" onClick={() => { setShowPasswordForm(false); setAccountError(''); }}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              {showEmailForm && (
                <form onSubmit={handleUpdateEmail} className="nm-account-subform-card">
                  <div className="nm-overline">UPDATE EMAIL ADDRESS</div>
                  <label className="nm-field">
                    <span>New Email Address</span>
                    <input
                      type="email"
                      value={accountEmail}
                      onChange={(e) => setAccountEmail(e.target.value)}
                      placeholder="admin@example.com"
                      autoFocus
                      required
                    />
                  </label>
                  <div className="nm-account-subform-actions">
                    <button type="submit" className="nm-btn nm-btn-primary" disabled={accountLoading || !accountEmail}>
                      {accountLoading ? 'Updating...' : 'Save New Email'}
                    </button>
                    <button type="button" className="nm-btn nm-btn-secondary" onClick={() => { setShowEmailForm(false); setAccountError(''); }}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {modalTab === 'users' && (
            <div className="nm-help-settings" style={{ gridTemplateColumns: '1fr', gap: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                <div className="nm-help-settings-copy">
                  <div className="nm-overline">USER MANAGEMENT</div>
                  <h3>Authorized SAM Operators</h3>
                  <p>Manage access, configure contact emails, and view enrollment status for administrators.</p>
                </div>
                <button type="button" className="nm-btn nm-btn-secondary" onClick={() => loadUserManagementList()} disabled={usersLoading}>
                  <RefreshCw size={14} className={usersLoading ? 'is-spinning' : ''} style={{ marginRight: 6 }} /> Refresh
                </button>
              </div>

              {/* Status Banner */}
              <div style={{ padding: '12px 16px', background: 'rgba(56, 189, 248, 0.08)', border: '1px solid rgba(56, 189, 248, 0.25)', borderRadius: 8, fontSize: 13, color: '#cbd5e1', lineHeight: 1.5 }}>
                <strong style={{ color: '#38bdf8' }}>Status: AWAITING TWO OWNER-PROVIDED EMAIL MAPPINGS.</strong> Contact emails have not yet been provided by the Owner for inactive legacy administrators. Saving an email prepares the account without sending email. Email invitation is only sent when &ldquo;Send Account Setup&rdquo; is explicitly clicked.
              </div>

              {usersSuccess && (
                <div className="nm-status-card is-success">
                  <strong>Success</strong>
                  <span>{usersSuccess}</span>
                </div>
              )}

              {usersError && (
                <div className="nm-status-card is-warning">
                  <strong>Notice</strong>
                  <span>{usersError}</span>
                </div>
              )}

              {/* Edit User Modal Dialog */}
              {editingUser && (
                <div style={{ padding: 16, background: 'rgba(30, 41, 59, 0.8)', border: '1px solid rgba(56, 189, 248, 0.3)', borderRadius: 8, marginBottom: 12 }}>
                  <div className="nm-overline" style={{ color: '#38bdf8' }}>EDIT ADMINISTRATOR</div>
                  <h4 style={{ margin: '4px 0 12px 0', fontSize: '1.1rem' }}>{editingUser.display_name}</h4>
                  <p className="nm-meta" style={{ color: '#94a3b8', marginBottom: 12 }}>
                    Saving updates the email address and role assignment immediately <strong>without sending any email</strong>.
                  </p>
                  <form onSubmit={handleSaveEdit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <label className="nm-field">
                      <span>Contact Email Address</span>
                      <input
                        type="email"
                        value={editEmail}
                        onChange={(e) => setEditEmail(e.target.value)}
                        placeholder="admin@example.com"
                        autoFocus
                      />
                    </label>
                    <label className="nm-field">
                      <span>Application Role</span>
                      <select
                        value={editRole}
                        onChange={(e) => setEditRole(e.target.value)}
                        disabled={editingUser.is_owner && activeOwnerCount <= 1}
                      >
                        <option value="administrator">Administrator</option>
                        <option value="owner">Owner</option>
                      </select>
                    </label>
                    {editingUser.is_owner && activeOwnerCount <= 1 && (
                      <span className="nm-meta" style={{ color: '#facc15' }}>
                        This user is the sole active Owner and cannot be demoted.
                      </span>
                    )}
                    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                      <button type="submit" className="nm-btn nm-btn-primary" disabled={editSaving}>
                        {editSaving ? 'Saving...' : 'Save Changes'}
                      </button>
                      <button type="button" className="nm-btn nm-btn-secondary" onClick={() => setEditingUser(null)} disabled={editSaving}>
                        Cancel
                      </button>
                    </div>
                  </form>
                </div>
              )}

              <div className="nm-table-wrap">
                <table className="nm-table">
                  <thead>
                    <tr>
                      <th>Administrator</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Active Status</th>
                      <th>Enrollment Status</th>
                      {callerIsOwner && <th>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {userList.map((u) => {
                      const isSoleOwner = (u.role === 'owner' || u.is_owner) && u.active && activeOwnerCount <= 1;
                      const hasEmail = Boolean(u.email && u.email.trim());
                      const isActionBusy = actionInProgressId === u.id;

                      return (
                        <tr key={u.id}>
                          <td>
                            <strong>{u.display_name}</strong>
                            {u.is_owner && <span style={{ marginLeft: 8, fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'rgba(234, 179, 8, 0.15)', color: '#facc15', border: '1px solid rgba(234, 179, 8, 0.3)' }}>Owner</span>}
                          </td>
                          <td>
                            {hasEmail ? (
                              <span style={{ fontSize: 13, color: '#e2e8f0' }}>{u.email}</span>
                            ) : (
                              <span style={{ fontStyle: 'italic', color: 'var(--nm-muted)', fontSize: 12 }}>Awaiting Owner email</span>
                            )}
                          </td>
                          <td style={{ textTransform: 'capitalize' }}>{u.role || 'administrator'}</td>
                          <td>
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              padding: '2px 8px',
                              borderRadius: 999,
                              fontSize: 12,
                              fontWeight: 700,
                              background: u.active ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                              color: u.active ? '#4ade80' : '#f87171',
                              border: `1px solid ${u.active ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                            }}>
                              {u.active ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td>
                            {renderEnrollmentBadge(u)}
                          </td>
                          {callerIsOwner && (
                            <td>
                              <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                                <button
                                  type="button"
                                  className="nm-btn nm-btn-table nm-btn-secondary"
                                  onClick={() => handleStartEdit(u)}
                                  disabled={usersLoading || isActionBusy}
                                  title="Edit email and role"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className={`nm-btn nm-btn-table ${u.active ? 'nm-btn-danger' : 'nm-btn-primary'}`}
                                  onClick={() => handleToggleUserActive(u)}
                                  disabled={usersLoading || isActionBusy || isSoleOwner}
                                  title={isSoleOwner ? 'Cannot deactivate the sole active Owner' : (u.active ? 'Deactivate user' : 'Activate user')}
                                >
                                  {u.active ? 'Deactivate' : 'Activate'}
                                </button>
                                {hasEmail && !u.is_linked && (
                                  <button
                                    type="button"
                                    className="nm-btn nm-btn-table nm-btn-secondary"
                                    onClick={() => handleSendAccountSetup(u)}
                                    disabled={usersLoading || isActionBusy}
                                    title="Send account setup invitation email"
                                  >
                                    Send Setup
                                  </button>
                                )}
                                {hasEmail && (
                                  <button
                                    type="button"
                                    className="nm-btn nm-btn-table nm-btn-secondary"
                                    onClick={() => handleSendPasswordReset(u)}
                                    disabled={usersLoading || isActionBusy}
                                    title="Send password reset email"
                                  >
                                    Reset PW
                                  </button>
                                )}
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                    {!userList.length && !usersLoading && (
                      <tr>
                        <td colSpan={callerIsOwner ? 6 : 5} style={{ textAlign: 'center', color: 'var(--nm-muted)' }}>
                          No authorized users loaded.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="nm-help-modal-footer">
          <button type="button" className="nm-btn nm-btn-primary" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}

function HelpModal({ version, onClose, onOpenSettings, onReplayTutorial, onReplayQuickStart }) {
  const sectionRefs = useRef({});
  const [supportFormUrl, setSupportFormUrl] = useState('https://forms.gle/h3L8BZcFqpZ8RZf39');
  const [supportError, setSupportError] = useState('');
  const [query, setQuery] = useState('');
  const [helpContent, setHelpContent] = useState({});
  const [helpLoadError, setHelpLoadError] = useState('');
  const [selectedTutorial, setSelectedTutorial] = useState(null);

  useEffect(() => {
    let active = true;
    api.getSettings()
      .then((appSettings) => {
        if (active) {
          const url = appSettings?.support_form_url;
          if (url !== undefined) {
            setSupportFormUrl(url || '');
          }
        }
      })
      .catch((err) => {
        console.error('Failed to load support form URL:', err);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    api.getHelpContent().then((content) => {
      if (active) {
        setHelpContent(content || {});
        setHelpLoadError('');
      }
    }).catch(() => {
      if (active) {
        setHelpContent({});
        setHelpLoadError('Unable to load tutorial videos right now.');
      }
    });
    return () => { active = false; };
  }, []);

  const retryHelpContent = async () => {
    try {
      const content = await api.getHelpContent();
      setHelpContent(content || {});
      setHelpLoadError('');
    } catch (_error) {
      setHelpLoadError('Unable to load tutorial videos right now.');
    }
  };

  const handleRequestSupport = async () => {
    setSupportError('');
    if (!supportFormUrl || !supportFormUrl.trim()) {
      setSupportError('Support form is not configured yet.');
      alert('Support form is not configured yet.');
      return;
    }
    if (window.electronAPI?.openExternal) {
      await window.electronAPI.openExternal(supportFormUrl);
    } else {
      window.open(supportFormUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const jumpToSection = (id) => {
    sectionRefs.current[id]?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };
  const normalizedQuery = query.trim().toLowerCase();
  const visibleSections = useMemo(
    () => SAM_HELP_SECTIONS.filter((section) => !normalizedQuery || `${section.title} ${section.body}`.toLowerCase().includes(normalizedQuery)),
    [normalizedQuery],
  );
  const samTutorials = useMemo(() => normalizeTutorialVideos(helpContent?.tutorial_videos?.sam, 'sam'), [helpContent]);

  return (
    <div className="nm-modal-backdrop" onKeyDown={(e) => { if (e.key === 'Escape') onClose?.(); }}>
      <section className="nm-help-modal" role="dialog" aria-modal="true" aria-labelledby="sam-help-title">
        <div className="nm-help-header">
          <div>
            <div className="nm-overline">SAM HELP &amp; DOCUMENTATION</div>
            <h2 id="sam-help-title">{SAM_TITLE}</h2>
            <p>Smart Alert Manager keeps live alert messages and candidate administration organized for Mock Testing Suite operators.</p>
          </div>
          <button type="button" className="nm-modal-close" onClick={onClose} aria-label="Close help">×</button>
        </div>

        {/* Informative Settings Notice */}
        <div style={{ padding: '12px 16px', background: 'rgba(56, 189, 248, 0.08)', border: '1px solid rgba(56, 189, 248, 0.25)', borderRadius: 8, margin: '0 24px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 13, color: '#cbd5e1' }}>Workflow, notification, and administrative settings are available in Settings.</span>
          <button
            type="button"
            className="nm-btn nm-btn-secondary"
            style={{ whiteSpace: 'nowrap', padding: '4px 12px', fontSize: 12 }}
            onClick={() => {
              onClose?.();
              onOpenSettings?.('workflow');
            }}
          >
            Open Settings
          </button>
        </div>

        <div className="nm-help-modal-body">
          <div className="nm-help-toc" aria-label="SAM help sections">
            <label className="nm-field">
              <span>Search Help</span>
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search dashboard, requests, reports..." data-testid="sam-help-search" />
            </label>
            {visibleSections.map((section) => (
              <button key={section.id} type="button" className="nm-help-toc-button" onClick={() => jumpToSection(section.id)}>
                {section.title}
              </button>
            ))}
            <button type="button" className="nm-help-toc-button" onClick={() => document.getElementById('sam-tutorial-videos')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })}>
              Tutorial Videos
            </button>
          </div>

          <div className="nm-help-grid">
            {visibleSections.map((section) => (
              <article
                key={section.id}
                id={`sam-help-${section.id}`}
                className="nm-help-card"
                ref={(node) => { sectionRefs.current[section.id] = node; }}
              >
                <h3>{section.title}</h3>
                <h4>What this is</h4><p>{section.body}</p>
                <h4>When to use it</h4><p>Use this topic when you are working in {section.title} or deciding which administrator action is appropriate.</p>
                <h4>Steps</h4><ol><li>Open {section.title} from SAM.</li><li>Review the visible status and selected record.</li><li>Choose the applicable action and confirm the result.</li></ol>
                <h4>What happens next</h4><p>SAM refreshes the applicable view and keeps unresolved work visible until it is completed.</p>
                <h4>Common mistakes</h4><p>Do not treat Dismiss as a decision, approve without reviewing details, or deny a Pending Request without a clear reason.</p>
                <h4>Related topics</h4><p>Dashboard · Troubleshooting · Tutorial Videos</p>
                {section.id === 'support' && (
                  <div style={{ marginTop: 12 }}>
                    <button
                      type="button"
                      className="nm-btn nm-btn-secondary"
                      onClick={handleRequestSupport}
                      data-testid="support-request-btn"
                    >
                      Request App Support
                    </button>
                    {supportError && <p className="nm-meta" style={{ color: '#ff4d4d', marginTop: 8 }}>{supportError}</p>}
                  </div>
                )}
              </article>
            ))}
          </div>
          <div className="nm-help-grid">
            <TutorialVideoLibrary videos={samTutorials} title="SAM Tutorial Videos" selectedVideo={selectedTutorial} onSelectVideo={setSelectedTutorial} sectionId="sam-tutorial-videos" loadError={helpLoadError} onRetry={retryHelpContent} />
          </div>
        </div>

        <div className="nm-help-modal-footer">
          <button type="button" className="nm-btn nm-btn-secondary" onClick={onReplayQuickStart}>Quick Start Choices</button>
          <button type="button" className="nm-btn nm-btn-secondary" onClick={onReplayTutorial}>Replay Guided Walkthrough</button>
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
    <div className="nm-modal-backdrop">
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

function StatusModal({ message, kind = 'info', title: customTitle = '', actionLabel = 'OK', onClose }) {
  if (!message) return null;
  const title = customTitle || (kind === 'error' ? 'Action Failed' : kind === 'warning' ? 'Warning' : 'Success');
  const badgeIcon = kind === 'error' ? (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
  ) : kind === 'warning' ? (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><circle cx="12" cy="17" r="0.6" fill="currentColor" /></svg>
  ) : (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
  );
  return (
    <div className="nm-modal-backdrop">
      <section className={`nm-help-modal nm-status-modal nm-status-modal-${kind}`} role="dialog" aria-modal="true">
        <div className="nm-help-header">
          <div className="nm-status-modal-head">
            <span className={`nm-status-badge nm-status-badge-${kind}`} aria-hidden="true">{badgeIcon}</span>
            <div>
              <div className="nm-overline">{title}</div>
              <h2>{title}</h2>
              <p>{message}</p>
            </div>
          </div>
          <button type="button" className="nm-modal-close" onClick={onClose} aria-label="Close status">×</button>
        </div>
        <div className="nm-help-actions">
          <button type="button" className="nm-btn nm-btn-primary" onClick={onClose}>{actionLabel}</button>
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
  const isDanger = state.kind === 'danger';
  const badgeIcon = isDanger ? (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><circle cx="12" cy="17" r="0.6" fill="currentColor" /></svg>
  ) : (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><circle cx="12" cy="17" r="0.6" fill="currentColor" /></svg>
  );
  return (
    <div className="nm-modal-backdrop">
      <section className={`nm-help-modal nm-status-modal nm-status-modal-${isDanger ? 'danger' : 'confirm'}`} role="dialog" aria-modal="true">
        <div className="nm-help-header">
          <div className="nm-status-modal-head">
            <span className={`nm-status-badge nm-status-badge-${isDanger ? 'danger' : 'confirm'}`} aria-hidden="true">{badgeIcon}</span>
            <div>
              <div className="nm-overline">{isDanger ? 'CONFIRM ACTION' : 'CONFIRM'}</div>
              <h2>{state.title || 'Confirm'}</h2>
              <p>{state.message}</p>
            </div>
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

export function SamSetupWizard({ status, onComplete }) {
  const defaultMode = status?.initialMode || (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'test' && !status?.useSupabase ? 'legacy' : 'supabase');
  const [mode, setMode] = useState(defaultMode); // 'supabase' | 'legacy' | 'forgot_password' | 'reset_password' | 'reset_password_expired'
  const [form, setForm] = useState({ name: '', pin: '', email: '', password: '', showPassword: false });
  const [resetForm, setResetForm] = useState({ newPassword: '', confirmPassword: '', showPassword: false });
  const [recoverySession, setRecoverySession] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [infoMessage, setInfoMessage] = useState('');
  const submitInFlightRef = useRef(false);
  const statusErrorCode = status?.errorCode || '';
  const statusHasError = Boolean(statusErrorCode || status?.error);
  const [error, setError] = useState(
    statusHasError ? getSamSetupErrorMessage(statusErrorCode) : '',
  );

  const handleDeepLinkUrl = useCallback(async (rawUrl) => {
    if (!rawUrl) return;
    console.log('[SAM-AUTH] Processing recovery deep-link in setup wizard');
    const parsed = parseRecoveryUrl(rawUrl);
    if (!parsed.ok) {
      console.warn('[SAM-AUTH] Recovery deep-link invalid or expired:', parsed.error || 'unknown');
      setError(parsed.message || 'This password-reset link is no longer valid. Request a new reset email.');
      setMode('reset_password_expired');
      setRecoverySession(null);
      if (window.electronAPI?.consumePendingDeepLink) {
        await window.electronAPI.consumePendingDeepLink().catch(() => {});
      }
      return;
    }

    if (parsed.accessToken) {
      console.log('[SAM-AUTH] Establishing password reset state from recovery deep-link');
      setRecoverySession({
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
      });
      setResetForm({ newPassword: '', confirmPassword: '', showPassword: false });
      setError('');
      setInfoMessage('');
      setMode('reset_password');
      if (window.electronAPI?.consumePendingDeepLink) {
        await window.electronAPI.consumePendingDeepLink().catch(() => {});
      }
    } else {
      console.warn('[SAM-AUTH] Recovery deep-link missing access token');
      setError('The recovery link did not contain valid authentication credentials. Request a new reset email.');
      setMode('reset_password_expired');
      setRecoverySession(null);
      if (window.electronAPI?.consumePendingDeepLink) {
        await window.electronAPI.consumePendingDeepLink().catch(() => {});
      }
    }
  }, []);

  useEffect(() => {
    setError(statusHasError ? getSamSetupErrorMessage(statusErrorCode) : '');
  }, [statusErrorCode, statusHasError]);

  useEffect(() => {
    const handleAppEvent = (type, payload) => {
      if (type === 'auth:deep-link' && payload?.url) {
        void handleDeepLinkUrl(payload.url);
      }
    };
    const unsubscribe = window.electronAPI?.onAppEvent?.(handleAppEvent);

    if (status?.pendingDeepLinkUrl) {
      void handleDeepLinkUrl(status.pendingDeepLinkUrl);
    } else if (window.electronAPI?.consumePendingDeepLink) {
      window.electronAPI.consumePendingDeepLink().then((pendingUrl) => {
        if (pendingUrl) {
          void handleDeepLinkUrl(pendingUrl);
        }
      }).catch(() => {});
    } else if (window.electronAPI?.getPendingDeepLink) {
      window.electronAPI.getPendingDeepLink().then((pendingUrl) => {
        if (pendingUrl) {
          void handleDeepLinkUrl(pendingUrl);
        }
      }).catch(() => {});
    }

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [handleDeepLinkUrl, status?.pendingDeepLinkUrl]);

  const submitLegacySetup = async (event) => {
    event.preventDefault();
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    setError('');
    setInfoMessage('');
    try {
      const result = await api.completeSamSetup({
        name: form.name.trim(),
        pin: form.pin.trim(),
        device_name: getSamDeviceName(),
      });
      if (!result?.ok) {
        setError(getSamSetupErrorMessage(result));
        return result;
      }
      onComplete?.(result);
    } catch (setupError) {
      setError(getSamSetupErrorMessage(setupError));
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const submitSupabaseLogin = async (event) => {
    event.preventDefault();
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    setError('');
    setInfoMessage('');
    try {
      const configRes = await api.getSamAuthConfig();
      const supabaseUrl = configRes?.supabase_url;
      const anonKey = configRes?.supabase_anon_key;
      if (!supabaseUrl || !anonKey) {
        setError('Unable to reach the sign-in service.');
        return;
      }

      const authSession = await signInWithPassword(supabaseUrl, anonKey, form.email.trim(), form.password);
      const authUser = authSession?.user || authSession;
      const authUid = authUser?.id;
      const authEmail = authUser?.email || form.email.trim();
      if (!authUid) {
        setError('Email or password is incorrect.');
        return;
      }

      // Server-side SAM authorization verification
      const verifyResult = await api.verifySamAuth(authUid);
      if (!verifyResult?.ok) {
        const errCode = verifyResult?.error_code || verifyResult?.errorCode;
        if (errCode === 'inactive_account') {
          setError('This SAM account is inactive.');
        } else if (errCode === 'unauthorized_account') {
          setError('This account is not authorized for Smart Alert Manager.');
        } else {
          setError(verifyResult?.error || 'Sign in could not be completed. Please try again.');
        }
        return;
      }

      // Save encrypted session in Electron safeStorage
      if (window.electronAPI?.authSession?.save) {
        await window.electronAPI.authSession.save(authSession);
      }

      // Record local session setup
      await api.completeSamAuthSetup({
        name: verifyResult.display_name,
        role: verifyResult.role,
        auth_uid: authUid,
        email: authEmail,
      });

      onComplete?.({
        ok: true,
        name: verifyResult.display_name,
        role: verifyResult.role,
        authUid: authUid,
        email: authEmail,
        isOwner: Boolean(verifyResult.is_owner),
        session: authSession,
      });
    } catch (authError) {
      const msg = String(authError?.message || '').toLowerCase();
      const code = String(authError?.code || '').toLowerCase();
      const status = authError?.status || authError?.response?.status;

      if (code === 'invalid_credentials' || msg.includes('invalid') || msg.includes('credential') || status === 400) {
        setError('Email or password is incorrect.');
      } else if (code === 'network_failure' || msg.includes('network') || msg.includes('fetch') || msg.includes('econnrefused') || msg.includes('timeout')) {
        setError('Unable to reach the sign-in service.');
      } else if (code === 'inactive_account' || msg.includes('inactive')) {
        setError('This SAM account is inactive.');
      } else if (code === 'unauthorized_account' || msg.includes('not authorized') || msg.includes('unauthorized')) {
        setError('This account is not authorized for Smart Alert Manager.');
      } else {
        setError('Sign in could not be completed. Please try again.');
      }
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const submitForgotPassword = async (event) => {
    event.preventDefault();
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    setError('');
    setInfoMessage('');
    try {
      const configRes = await api.getSamAuthConfig();
      const supabaseUrl = configRes?.supabase_url;
      const anonKey = configRes?.supabase_anon_key;
      if (!supabaseUrl || !anonKey) {
        setError('Unable to reach the sign-in service.');
        return;
      }
      const res = await resetPasswordForEmail(supabaseUrl, anonKey, form.email.trim(), {
        redirectTo: 'smartalertmanager://reset-password',
      });
      console.log('[SAM-AUTH] Password recovery status:', res?.code || 'RECOVERY_REQUEST_ACCEPTED');
      setInfoMessage('If an account exists for this email, password reset instructions have been sent.');
    } catch (resetErr) {
      console.warn('[SAM-AUTH] Password recovery failed:', resetErr?.code || 'RECOVERY_REQUEST_FAILED');
      const msg = String(resetErr?.message || '').toLowerCase();
      if (msg.includes('network') || msg.includes('fetch') || msg.includes('timeout')) {
        setError('Unable to reach the sign-in service.');
      } else {
        setInfoMessage('If an account exists for this email, password reset instructions have been sent.');
      }
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const submitResetPassword = async (event) => {
    event.preventDefault();
    if (submitInFlightRef.current) return;
    if (resetForm.newPassword.length < 6) {
      setError('Password must be at least 6 characters long.');
      return;
    }
    if (resetForm.newPassword !== resetForm.confirmPassword) {
      setError('Passwords do not match. Please re-enter.');
      return;
    }
    if (!recoverySession?.accessToken) {
      setError('This password-reset link is no longer valid. Request a new reset email.');
      setMode('reset_password_expired');
      return;
    }

    submitInFlightRef.current = true;
    setSubmitting(true);
    setError('');
    setInfoMessage('');

    try {
      const configRes = await api.getSamAuthConfig();
      const supabaseUrl = configRes?.supabase_url;
      const anonKey = configRes?.supabase_anon_key;
      if (!supabaseUrl || !anonKey) {
        setError('Unable to reach the sign-in service.');
        return;
      }

      await updateUserPassword(supabaseUrl, anonKey, recoverySession.accessToken, resetForm.newPassword);

      // Cleanly sign out the temporary recovery session so it does not linger
      await signOutAuth(supabaseUrl, anonKey, recoverySession.accessToken);
      setRecoverySession(null);
      setResetForm({ newPassword: '', confirmPassword: '', showPassword: false });

      // Return to normal login screen with clear confirmation
      setMode('supabase');
      setInfoMessage('Password updated successfully. Please sign in with your new password.');
    } catch (resetErr) {
      const msg = String(resetErr?.message || '').toLowerCase();
      const code = String(resetErr?.code || '').toLowerCase();
      if (code === 'otp_expired' || msg.includes('expired') || msg.includes('invalid')) {
        setError('This password-reset link is no longer valid. Request a new reset email.');
        setMode('reset_password_expired');
      } else if (msg.includes('network') || msg.includes('fetch') || msg.includes('timeout')) {
        setError('Unable to reach the sign-in service.');
      } else {
        setError(resetErr?.message || 'Failed to update password. Please try again.');
      }
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="nm-app nm-setup-app">
      <div className="nm-setup-shell">
        <section className="nm-setup-panel">
          <div className="nm-overline">
            {mode === 'supabase'
              ? 'SAM AUTHENTICATION'
              : mode === 'reset_password'
                ? 'SAM AUTHENTICATION'
                : mode === 'reset_password_expired' || mode === 'forgot_password'
                  ? 'PASSWORD RECOVERY'
                  : 'SAM SETUP'}
          </div>
          <h1>
            {mode === 'reset_password'
              ? 'Reset Password'
              : mode === 'reset_password_expired'
                ? 'Link Invalid or Expired'
                : SAM_TITLE}
          </h1>
          <p>
            {mode === 'supabase'
              ? 'Enter your administrator email and password to access Smart Alert Manager.'
              : mode === 'reset_password'
                ? 'Enter a new password for your Smart Alert Manager administrator account.'
                : mode === 'reset_password_expired'
                  ? 'This password-reset link is no longer valid. Request a new reset email below.'
                  : mode === 'forgot_password'
                    ? 'Enter your registered email address to receive password reset instructions.'
                    : 'Enter the administrator name and PIN assigned to you to enable Smart Alert Manager on this device.'}
          </p>

          {mode === 'supabase' && (
            <form className="nm-setup-form" onSubmit={submitSupabaseLogin}>
              <label>
                <span>Email Address</span>
                <input
                  type="email"
                  value={form.email}
                  onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                  autoComplete="email"
                  placeholder="admin@example.com"
                  data-testid="login-email-input"
                  autoFocus
                  required
                />
              </label>
              <label>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Password</span>
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: '#7dd3fc', cursor: 'pointer', fontSize: 12, padding: 0 }}
                    onClick={() => setForm((current) => ({ ...current, showPassword: !current.showPassword }))}
                  >
                    {form.showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
                <input
                  type={form.showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  data-testid="login-password-input"
                  required
                />
              </label>

              {error ? (
                <div className="nm-status-card is-warning">
                  <strong>Sign In Blocked</strong>
                  <span>{error}</span>
                </div>
              ) : null}

              {infoMessage ? (
                <div className="nm-status-card is-success">
                  <strong>Notice</strong>
                  <span>{infoMessage}</span>
                </div>
              ) : null}

              <button type="submit" className="nm-btn nm-btn-primary" disabled={submitting || !form.email.trim() || !form.password.trim()} data-testid="login-submit-btn">
                {submitting ? 'Verifying Access...' : 'Sign In'}
              </button>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, fontSize: 13 }}>
                <button
                  type="button"
                  style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                  onClick={() => { setMode('forgot_password'); setError(''); setInfoMessage(''); }}
                >
                  Forgot Password?
                </button>
                <button
                  type="button"
                  style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                  onClick={() => { setMode('legacy'); setError(''); setInfoMessage(''); }}
                >
                  Use Legacy PIN Setup
                </button>
              </div>
            </form>
          )}

          {mode === 'forgot_password' && (
            <form className="nm-setup-form" onSubmit={submitForgotPassword}>
              <label>
                <span>Registered Email</span>
                <input
                  type="email"
                  value={form.email}
                  onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                  autoComplete="email"
                  placeholder="admin@example.com"
                  data-testid="forgot-password-email-input"
                  autoFocus
                  required
                />
              </label>

              {error ? (
                <div className="nm-status-card is-warning">
                  <strong>Request Failed</strong>
                  <span>{error}</span>
                </div>
              ) : null}

              {infoMessage ? (
                <div className="nm-status-card is-success">
                  <strong>Sent</strong>
                  <span>{infoMessage}</span>
                </div>
              ) : null}

              <button type="submit" className="nm-btn nm-btn-primary" disabled={submitting || !form.email.trim()} data-testid="forgot-password-submit-btn">
                {submitting ? 'Sending Instructions...' : 'Send Reset Link'}
              </button>

              <div style={{ textAlign: 'center', marginTop: 8 }}>
                <button
                  type="button"
                  style={{ background: 'none', border: 'none', color: '#7dd3fc', cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: 13 }}
                  onClick={() => { setMode('supabase'); setError(''); setInfoMessage(''); }}
                >
                  Back to Sign In
                </button>
              </div>
            </form>
          )}

          {mode === 'reset_password' && (
            <form className="nm-setup-form" onSubmit={submitResetPassword}>
              <label>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>New Password</span>
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: '#7dd3fc', cursor: 'pointer', fontSize: 12, padding: 0 }}
                    onClick={() => setResetForm((current) => ({ ...current, showPassword: !current.showPassword }))}
                  >
                    {resetForm.showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
                <input
                  type={resetForm.showPassword ? 'text' : 'password'}
                  value={resetForm.newPassword}
                  onChange={(event) => setResetForm((current) => ({ ...current, newPassword: event.target.value }))}
                  autoComplete="new-password"
                  placeholder="Enter new password (min. 6 characters)"
                  data-testid="reset-new-password-input"
                  autoFocus
                  required
                />
              </label>

              <label>
                <span>Confirm New Password</span>
                <input
                  type={resetForm.showPassword ? 'text' : 'password'}
                  value={resetForm.confirmPassword}
                  onChange={(event) => setResetForm((current) => ({ ...current, confirmPassword: event.target.value }))}
                  autoComplete="new-password"
                  placeholder="Confirm new password"
                  data-testid="reset-confirm-password-input"
                  required
                />
              </label>

              {error ? (
                <div className="nm-status-card is-warning">
                  <strong>Password Reset Blocked</strong>
                  <span>{error}</span>
                </div>
              ) : null}

              {infoMessage ? (
                <div className="nm-status-card is-success">
                  <strong>Notice</strong>
                  <span>{infoMessage}</span>
                </div>
              ) : null}

              <button
                type="submit"
                className="nm-btn nm-btn-primary"
                disabled={submitting || !resetForm.newPassword.trim() || !resetForm.confirmPassword.trim()}
                data-testid="reset-password-save-btn"
              >
                {submitting ? 'Saving New Password...' : 'Save New Password'}
              </button>

              <div style={{ textAlign: 'center', marginTop: 8 }}>
                <button
                  type="button"
                  style={{ background: 'none', border: 'none', color: '#7dd3fc', cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: 13 }}
                  onClick={() => {
                    setRecoverySession(null);
                    setMode('supabase');
                    setError('');
                    setInfoMessage('');
                  }}
                >
                  Cancel and Return to Sign In
                </button>
              </div>
            </form>
          )}

          {mode === 'reset_password_expired' && (
            <div className="nm-setup-form">
              {error ? (
                <div className="nm-status-card is-warning">
                  <strong>Link Invalid or Expired</strong>
                  <span>{error}</span>
                </div>
              ) : null}

              <button
                type="button"
                className="nm-btn nm-btn-primary"
                onClick={() => {
                  setRecoverySession(null);
                  setMode('forgot_password');
                  setError('');
                  setInfoMessage('');
                }}
                data-testid="request-new-reset-btn"
              >
                Request New Reset Email
              </button>

              <div style={{ textAlign: 'center', marginTop: 8 }}>
                <button
                  type="button"
                  style={{ background: 'none', border: 'none', color: '#7dd3fc', cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: 13 }}
                  onClick={() => {
                    setRecoverySession(null);
                    setMode('supabase');
                    setError('');
                    setInfoMessage('');
                  }}
                >
                  Back to Sign In
                </button>
              </div>
            </div>
          )}

          {mode === 'legacy' && (
            <form className="nm-setup-form" onSubmit={submitLegacySetup}>
              <label>
                <span>Name</span>
                <input
                  type="text"
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  autoComplete="name"
                  data-testid="legacy-name-input"
                  autoFocus
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
                  data-testid="legacy-pin-input"
                  required
                />
              </label>
              {error ? (
                <div className="nm-status-card is-warning">
                  <strong>Setup blocked</strong>
                  <span>{error}</span>
                </div>
              ) : null}
              <button type="submit" className="nm-btn nm-btn-primary" disabled={submitting || !form.name.trim() || !form.pin.trim()} data-testid="legacy-submit-btn">
                {submitting ? 'Verifying...' : 'Complete Setup'}
              </button>

              <div style={{ textAlign: 'center', marginTop: 8 }}>
                <button
                  type="button"
                  style={{ background: 'none', border: 'none', color: '#7dd3fc', cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: 13 }}
                  onClick={() => { setMode('supabase'); setError(''); setInfoMessage(''); }}
                >
                  Sign in with Email &amp; Password
                </button>
              </div>
            </form>
          )}
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

const CANDIDATE_SORT_OPTIONS = [
  { key: 'candidate', direction: 'asc', label: 'Candidate A-Z' },
  { key: 'candidate', direction: 'desc', label: 'Candidate Z-A' },
  { key: 'date', direction: 'desc', label: 'Date newest first' },
  { key: 'date', direction: 'asc', label: 'Date oldest first' },
  { key: 'status', direction: 'asc', label: 'Status A-Z' },
  { key: 'attempts', direction: 'desc', label: 'Attempts high to low' },
  { key: 'attempts', direction: 'asc', label: 'Attempts low to high' },
];

const SECTION_NAV_ITEMS = [
  { key: 'notifications', label: 'Notifications', target: 'sam-notifications', tone: 'notifications' },
  { key: 'preview', label: 'Live Preview', target: 'sam-live-preview', tone: 'preview' },
  { key: 'headsets', label: 'Headset Review', target: 'sam-headset-review', tone: 'headsets' },
  { key: 'candidates', label: 'Candidate Tracking', target: 'sam-candidate-tracking', candidateView: 'allActive', tone: 'candidates' },
  { key: 'candidates', label: 'Pending Sup Transfers', target: 'sam-candidate-tracking', candidateView: 'pending', tone: 'pending' },
  { key: 'requests', label: 'Pending Requests', target: 'sam-pending-requests', tone: 'pending' },
  { key: 'help', label: 'Help', target: 'sam-help', tone: 'help' },
];

const REQUEST_FILTERS = [
  { key: 'pending', label: 'All Pending' },
  { key: 'newbie', label: 'Newbie Shifts' },
  { key: 'reschedules', label: 'Reschedules' },
  { key: 'deletions', label: 'Candidate Deletions' },
  { key: 'corrections', label: 'Information Corrections' },
  { key: 'headsets', label: 'Headset Reviews' },
  { key: 'resolved', label: 'Resolved Requests' },
  { key: 'approved', label: 'Approved' },
  { key: 'denied', label: 'Denied' },
];

function approvalTone(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'approved') return 'approved';
  if (normalized === 'denied') return 'denied';
  return 'pending';
}

function approvalLabel(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'approved') return 'Approved';
  if (normalized === 'denied') return 'Denied';
  return 'Pending';
}

function formFillMeta(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'filled') return { label: 'Form Filled', tone: 'filled', Icon: CheckCircle };
  if (normalized === 'submitted') return { label: 'Form Submitted', tone: 'filled', Icon: CheckCircle };
  if (normalized === 'failed') return { label: 'Form Not Submitted', tone: 'failed', Icon: AlertTriangle };
  if (normalized === 'skipped') return { label: 'Form Not Submitted', tone: 'skipped', Icon: Clock };
  return { label: 'Form Not Submitted', tone: 'not-filled', Icon: Clock };
}

function workflowApprovalMeta(label, status) {
  const tone = approvalTone(status);
  const Icon = tone === 'approved' ? CheckCircle : tone === 'denied' ? XCircle : Clock;
  return { label: `${label} ${approvalLabel(status)}`, tone, Icon };
}

function newbieApprovalMeta(status, requestType) {
  const isReschedule = String(requestType || '').toLowerCase().includes('reschedule');
  return workflowApprovalMeta(isReschedule ? 'Newbie Shift Reschedule' : 'Newbie Shift', status);
}

export function candidateCertificationMeta(row = {}) {
  const override = sheetTruthy(row.readiness_override_applied) ? row.readiness_override_result : '';
  const raw = String(override || row.authoritative_status || row.latest_status || row.status || '').trim().toUpperCase();
  const callResults = [row.call_1_result, row.call_2_result, row.call_3_result]
    .map((value) => String(value || '').trim().toLowerCase());
  const supResults = [row.sup_transfer_1_result, row.sup_transfer_2_result]
    .map((value) => String(value || '').trim().toLowerCase());
  const failedRequiredSup = supResults.filter((value) => value === 'fail' || value === 'failed').length >= 2;
  if (override && ['PASS', 'PASSED'].includes(raw)) return { label: 'Pass', tone: 'approved', Icon: CheckCircle };
  if (raw === 'RESUMED-PASS') return { label: 'Resumed – Pass', tone: 'approved', Icon: CheckCircle };
  if (raw === 'FAIL-FINAL ATTEMPT') return { label: 'Fail – Final Attempt', tone: 'denied', Icon: XCircle };
  if (['FAIL', 'FAILED'].includes(raw)) return { label: 'Fail', tone: 'denied', Icon: XCircle };
  if (sheetTruthy(row.final_attempt) && failedRequiredSup) return { label: 'Fail – Final Attempt', tone: 'denied', Icon: XCircle };
  if (['PASS', 'PASSED'].includes(raw) || (!raw && !failedRequiredSup && callResults.filter((value) => value === 'pass').length >= 2)) {
    return { label: 'Pass', tone: 'approved', Icon: CheckCircle };
  }
  if (raw === 'WITHDREW FROM CERTIFICATION') return { label: 'Withdrawn', tone: 'denied', Icon: XCircle };
  if (raw === 'INCOMPLETE' || row.pending_id) return { label: 'Incomplete', tone: 'pending', Icon: Clock };
  if (raw === 'ARCHIVED') return { label: 'Archived', tone: 'neutral', Icon: Clock };
  return { label: 'In Progress', tone: 'pending', Icon: Clock };
}

function StatusChip({ meta, className = '', title }) {
  const Icon = meta.Icon || Clock;
  const label = meta.label || 'Unknown';
  return (
    <span className={`nm-status-chip is-${meta.tone || 'neutral'} ${className}`} title={title || label} aria-label={title || label}>
      <Icon size={13} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function formatRequestTime(value) {
  return formatSamTimestamp(value) || value || 'N/A';
}

export function getPendingRequestSchedules(request = {}) {
  return {
    requested: request.requested_schedule || request.requested_scheduled_at || request.rescheduled_at || request.scheduled_at || '',
    original: request.original_schedule || request.original_scheduled_at || request.newbie_shift_original_scheduled_at || '',
  };
}

export function getVisiblePendingRequests(requests = [], filter = 'pending') {
  return (Array.isArray(requests) ? requests : []).filter((request) => {
    const status = String(request.raw_status || request.status || '').toLowerCase();
    if (filter === 'pending') return status === 'pending';
    if (filter === 'newbie') return status === 'pending' && request.category === 'newbie_initial';
    if (filter === 'reschedules') return status === 'pending' && request.category === 'newbie_reschedule';
    if (filter === 'deletions') return status === 'pending' && request.category === 'candidate_deletion';
    if (filter === 'corrections') return status === 'pending' && request.category === 'candidate_correction';
    if (filter === 'resolved') return status === 'approved' || status === 'denied';
    if (filter === 'approved') return status === 'approved';
    if (filter === 'denied') return status === 'denied';
    return false;
  }).sort((left, right) => String(right.admin_decision_at || right.created_at || '').localeCompare(String(left.admin_decision_at || left.created_at || '')));
}

export function applyPendingRequestDecision(data = {}, payload = {}, result = {}) {
  const requestId = String(payload.request_id || '');
  const nextStatus = payload.decision === 'approved' ? 'approved' : 'denied';
  const categoryKeys = {
    newbie_initial: 'newbieInitial',
    newbie_reschedule: 'reschedules',
    candidate_deletion: 'candidateDeletions',
    candidate_correction: 'candidateCorrections',
  };
  let changedCategory = '';
  const requests = (Array.isArray(data.requests) ? data.requests : []).map((request) => {
    if (String(request.request_id || '') !== requestId) return request;
    changedCategory = request.category || payload.category || '';
    return {
      ...request,
      raw_status: nextStatus,
      status: nextStatus === 'approved' ? 'Approved' : 'Denied',
      admin_decision_at: result.decision_at || new Date().toISOString(),
      admin_decision_by: payload.actor || request.admin_decision_by || 'SAM administrator',
      denial_reason: nextStatus === 'denied' ? payload.denial_reason || '' : '',
      ...(nextStatus === 'approved' && ['newbie_initial', 'newbie_reschedule'].includes(request.category)
        ? { newbie_shift_number: String(payload.newbie_shift_number || '').trim() }
        : {}),
    };
  });
  const counts = { ...(data.counts || {}) };
  const decrement = (key) => {
    if (Number.isFinite(Number(counts[key]))) counts[key] = Math.max(0, Number(counts[key]) - 1);
  };
  decrement(categoryKeys[changedCategory]);
  ['workflowRequests', 'actionableTotal', 'unresolved'].forEach(decrement);
  return { ...data, requests, counts };
}

export function applyCandidateInformationUpdate(data = {}, payload = {}) {
  const sessionId = String(payload.session_id || payload.latest_session_id || '').trim();
  if (!sessionId) return data;
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const values = Object.fromEntries(changes.map((change) => [change.field || change.field_key, change.requested_value]));
  const updateRows = (rows) => (Array.isArray(rows) ? rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    let next = row;
    if (String(row.session_id || row.source_session_id || '').trim() === sessionId) {
      next = { ...row };
      if (values.candidate_name) {
        next.candidate_name = values.candidate_name;
        if ('candidate' in next) next.candidate = values.candidate_name;
      }
      const headset = getCandidateHeadset(row);
      if (headset.separate && (values.headset_brand || values.headset_model)) {
        const brand = values.headset_brand || headset.brand;
        const model = values.headset_model || headset.model;
        next.headset_brand = brand;
        next.headset_model = model;
        next.headset_label = buildHeadsetDisplayLabel(brand, model);
      } else if (values.headset_model) {
        next.headset_brand = values.headset_model;
        next.headset_label = values.headset_model;
      }
    }
    if (Array.isArray(row.attempts)) next = { ...next, attempts: updateRows(row.attempts) };
    return next;
  }) : rows);
  const views = Object.fromEntries(Object.entries(data.views || {}).map(([key, rows]) => [key, updateRows(rows)]));
  return { ...data, candidates: updateRows(data.candidates), views };
}

export function buildCandidateInformationChanges(current = {}, requested = {}) {
  const fields = [
    { field_key: 'candidate_name', label: 'Candidate Name' },
    ...(Object.prototype.hasOwnProperty.call(current, 'headset_brand') || Object.prototype.hasOwnProperty.call(requested, 'headset_brand')
      ? [{ field_key: 'headset_brand', label: 'Headset Brand' }]
      : []),
    { field_key: 'headset_model', label: 'Headset Model' },
  ];
  return fields.flatMap(({ field_key, label }) => {
    const previousValue = String(current[field_key] || '').trim();
    const requestedValue = String(requested[field_key] || '').trim();
    if (!requestedValue || requestedValue === previousValue) return [];
    return [{ field: field_key, field_key, label, previous_value: previousValue, requested_value: requestedValue }];
  });
}

export function getCandidateUpdateErrorMessage(result = {}) {
  const messages = {
    candidate_update_no_changes: 'No candidate information was changed.',
    candidate_update_target_not_found: 'The candidate session could not be found.',
    candidate_update_identity_mismatch: 'The candidate record no longer matches this session.',
    candidate_update_unauthorized: 'SAM is not authorized to update this candidate.',
    candidate_update_action_unavailable: 'The deployed Google service does not support this update yet.',
    candidate_update_transport_failed: 'The Google service is temporarily unavailable.',
    candidate_update_response_invalid: 'The update response was invalid.',
    candidate_update_audit_failed: 'The candidate was updated, but the audit record could not be saved.',
    candidate_update_failed: 'The candidate information could not be updated.',
  };
  return messages[result?.error_code] || result?.error || messages.candidate_update_failed;
}

function isTimestampLikeHeadsetLabel(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}[T\s]/.test(text) || /^\d{1,2}\/\d{1,2}\/\d{2,4}[,\s]/.test(text);
}

export function getHeadsetReviewDisplayTitle(item = {}) {
  const brand = isTimestampLikeHeadsetLabel(item.brand) ? '' : String(item.brand || '').trim();
  const model = isTimestampLikeHeadsetLabel(item.model) ? '' : String(item.model || '').trim();
  const headset = `${brand} ${model}`.trim();
  if (headset) return headset;
  const requestedLabel = String(item.requested_headset_label || item.candidate || '').trim();
  return requestedLabel && !isTimestampLikeHeadsetLabel(requestedLabel) ? requestedLabel : 'Unknown headset';
}

function PendingRequestsPanel({ data, filter, onFilterChange, loading, onRefresh, onDecision, onOpenHeadsets, actor }) {
  const [approvalRequest, setApprovalRequest] = useState(null);
  const [approvalShiftNumber, setApprovalShiftNumber] = useState('');
  const [denialRequest, setDenialRequest] = useState(null);
  const [denialReason, setDenialReason] = useState('');
  const [denialError, setDenialError] = useState('');
  const [submittingRequestId, setSubmittingRequestId] = useState('');
  const [decisionError, setDecisionError] = useState('');
  const requests = Array.isArray(data?.requests) ? data.requests : [];
  const headsetRows = Array.isArray(data?.headsetReviews) ? data.headsetReviews : [];
  const filteredRequests = getVisiblePendingRequests(requests, filter);

  const submitApproval = async (request) => {
    setSubmittingRequestId(request.request_id);
    setDecisionError('');
    try {
      const result = await onDecision({
        request_id: request.request_id,
        category: request.category,
        decision: 'approved',
        expected_status: request.raw_status || 'pending',
        actor,
        ...(['newbie_initial', 'newbie_reschedule'].includes(request.category)
          ? { newbie_shift_number: approvalShiftNumber.trim() }
          : {}),
      });
      if (!result?.ok) setDecisionError(result?.error || 'The request decision could not be saved.');
    } finally {
      setSubmittingRequestId('');
      setApprovalRequest(null);
    }
  };

  const approve = async (request) => {
    if (['candidate_correction', 'newbie_initial', 'newbie_reschedule'].includes(request.category)) {
      setApprovalShiftNumber(String(request.newbie_shift_number || '').trim());
      setApprovalRequest(request);
      return;
    }
    await submitApproval(request);
  };

  const openDeny = (request) => {
    setDenialRequest(request);
    setDenialReason('');
    setDenialError('');
  };

  const submitDeny = async () => {
    if (!denialReason.trim()) {
      setDenialError('A denial reason is required.');
      return;
    }
    setSubmittingRequestId(denialRequest.request_id);
    setDenialError('');
    try {
      const result = await onDecision({
        request_id: denialRequest.request_id,
        category: denialRequest.category,
        decision: 'denied',
        expected_status: denialRequest.raw_status || 'pending',
        denial_reason: denialReason.trim(),
        actor,
      });
      if (!result?.ok) {
        setDenialError(result?.error || 'The request decision could not be saved.');
        return;
      }
      setDenialRequest(null);
      setDenialReason('');
      setDecisionError('');
    } finally {
      setSubmittingRequestId('');
    }
  };

  const renderStatus = (request) => {
    const tone = approvalTone(request.raw_status || request.status);
    const Icon = tone === 'approved' ? CheckCircle : tone === 'denied' ? XCircle : Clock;
    return (
      <span className={`nm-request-status is-${tone}`}>
        <Icon size={14} aria-hidden="true" />
        {approvalLabel(request.raw_status || request.status)}
      </span>
    );
  };

  return (
    <section className="nm-panel nm-request-panel" id="sam-pending-requests" data-testid="sam-pending-requests">
      <div className="nm-section-title">
        <div>
          <h2>{['resolved', 'approved', 'denied'].includes(filter) ? 'Resolved Requests' : 'Pending Requests'}</h2>
          <div className="nm-kicker">Active requests remain separate from approved and denied request history.</div>
        </div>
        <div className="nm-section-title-actions">
          <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={onRefresh} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>
      {!data?.ok && data?.error ? (
        <div className="nm-status-card is-warning">
          <strong>Pending requests unavailable</strong>
          <span>{data.error}</span>
        </div>
      ) : null}
      {decisionError ? <div className="nm-status-card is-warning"><strong>Action failed</strong><span>{decisionError}</span></div> : null}
      <div className="nm-view-tabs" role="tablist" aria-label="Pending request filters">
        {REQUEST_FILTERS.map((item) => (
          <button key={item.key} type="button" className={`nm-view-tab ${filter === item.key ? 'is-active' : ''}`} onClick={() => onFilterChange(item.key)}>
            {item.label}
          </button>
        ))}
      </div>
      {filter === 'headsets' ? (
        <div className="nm-note-cards" role="list">
          {headsetRows.length ? headsetRows.map((row, index) => (
            <article key={row.review_id || `${row.brand}-${row.model}-${index}`} className="nm-note-card" role="listitem">
              <div className="nm-note-card-main">
                <div className="nm-note-card-head">
                  <span className="nm-badge nm-badge-info">Headset Review</span>
                  <span className="nm-request-status is-pending"><Clock size={14} aria-hidden="true" />Pending</span>
                </div>
                <div className="nm-note-title">{getHeadsetReviewDisplayTitle(row)}</div>
                <div className="nm-note-preview">{row.note || 'No note provided.'}</div>
                <div className="nm-note-meta">
                  <span className="nm-note-meta-chip">Tester: {row.tester || 'N/A'}</span>
                  <span className="nm-note-meta-chip">Candidate: {row.candidate || 'N/A'}</span>
                  <span className="nm-note-meta-chip">Submitted: {formatRequestTime(row.submitted_date)}</span>
                </div>
              </div>
              <div className="nm-note-card-actions">
                <button type="button" className="nm-btn nm-btn-primary nm-btn-table" onClick={onOpenHeadsets}>Open Headset Review</button>
              </div>
            </article>
          )) : <div className="nm-empty">No headset reviews match this filter.</div>}
        </div>
      ) : (
        <div className="nm-note-cards" role="list">
          {filteredRequests.length ? filteredRequests.map((request) => (
            <article key={`${request.category}-${request.request_id}`} className="nm-note-card" role="listitem">
              <div className="nm-note-card-main">
                <div className="nm-note-card-head">
                  <span className="nm-badge nm-badge-info">{request.categoryLabel}</span>
                  {renderStatus(request)}
                </div>
                <div className="nm-note-title">{request.candidate || 'Unknown candidate'}</div>
                <div className={`nm-note-preview ${['candidate_deletion', 'candidate_correction'].includes(request.category) ? 'nm-deletion-reason' : ''}`}>
                  {request.category === 'candidate_deletion' ? <><strong>Deletion Reason</strong><span>{request.reason || 'No reason provided.'}</span></>
                    : request.category === 'candidate_correction' ? <><strong>Correction Reason</strong><span>{request.reason || 'No reason provided.'}</span></>
                      : <>{request.reason || 'No reason provided.'}{request.details ? ` ${request.details}` : ''}</>}
                </div>
                <div className="nm-request-grid">
                  {request.category === 'candidate_correction' ? <>
                    <div><strong>Request Type</strong><span>Candidate Information Correction</span></div>
                    <div><strong>Requested By</strong><span>{request.tester || request.requester || 'Tester'}</span></div>
                    <div><strong>Submitted</strong><span>{formatRequestTime(request.created_at)}</span></div>
                    <div><strong>Current Status</strong><span>{approvalLabel(request.raw_status || request.status)}</span></div>
                    {(request.changes || []).map((change) => (
                      <div className="nm-request-grid-wide nm-change-row" key={change.field}>
                        <strong>{change.label || (change.field === 'candidate_name' ? 'Candidate Name' : 'Headset Model')}</strong>
                        <span><span className="nm-change-value"><small>Previous</small>{change.previous_value || 'Not recorded'}</span><span className="nm-change-arrow" aria-hidden="true">→</span><span className="nm-change-value"><small>Requested</small>{change.requested_value}</span></span>
                      </div>
                    ))}
                  </> : request.category === 'candidate_deletion' ? <>
                    <div><strong>Certification Result</strong><span><StatusChip meta={candidateCertificationMeta({ latest_status: request.session_status })} /></span></div>
                    <div><strong>Final Attempt</strong><span>{request.final_attempt ? 'Yes' : 'No'}</span></div>
                    {request.newbie_shift_number ? <div><strong>Newbie Shift Number</strong><span>Shift #{request.newbie_shift_number}</span></div> : null}
                    <div><strong>Form Status</strong><span><StatusChip meta={formFillMeta(request.form_fill_status)} /></span></div>
                    <div><strong>Requested By</strong><span>{request.tester ? `${request.tester} / Tester` : 'Tester'}</span></div>
                    <div><strong>Deletion Scope</strong><span>{request.deletion_scope || 'Session History and Candidate Tracking'}</span></div>
                    <div><strong>Requested</strong><span>{formatRequestTime(request.created_at)}</span></div>
                  </> : <>
                    <div><strong>Tester/Requester</strong><span>{request.tester || 'N/A'}</span></div>
                    <div><strong>Request Submitted</strong><span>{formatRequestTime(request.created_at)}</span></div>
                    <div><strong>Requested Schedule</strong><span>{formatRequestTime(getPendingRequestSchedules(request).requested)} {request.timezone || ''}</span></div>
                    {request.category === 'newbie_reschedule' ? <div><strong>Previous Schedule</strong><span>{formatRequestTime(getPendingRequestSchedules(request).original)}</span></div> : null}
                    <div><strong>{request.category === 'newbie_reschedule' ? 'Who Needs the Reschedule' : 'Requested By'}</strong><span>{request.requester || 'N/A'}</span></div>
                    <div className="nm-request-grid-wide"><strong>Reason</strong><span>{request.reason || 'No reason provided.'}{request.details ? ` — ${request.details}` : ''}</span></div>
                    <div><strong>Lead Time Category</strong><span>{request.lead_time_category === 'less_than_24_hours' || request.within_24_hours ? 'Less than 24 hours' : '24 hours or more'}</span></div>
                    <div><strong>Counts as Candidate Attempt</strong><span>{request.counts_as_attempt ? 'Yes' : 'No'}</span></div>
                    <div><strong>Current Attempt</strong><span>{request.current_attempt || 1}</span></div>
                    <div><strong>Resulting Attempt</strong><span>{request.resulting_attempt || request.current_attempt || 1}</span></div>
                    <div><strong>Final Attempt</strong><span>{request.final_attempt ? 'Yes' : 'No'}</span></div>
                    {request.terminal_outcome ? <div className="nm-request-grid-wide"><strong>Result if Applied</strong><span>{request.terminal_outcome === 'FAIL-Final Attempt' ? 'Fail – Final Attempt' : request.terminal_outcome}</span></div> : null}
                  </>}
                  {request.denial_reason ? <div className="nm-request-grid-wide"><strong>Denial Reason</strong><span>{request.denial_reason}</span></div> : null}
                  {String(request.raw_status || '').toLowerCase() !== 'pending' ? <>
                    <div><strong>Decision Date</strong><span>{formatRequestTime(request.admin_decision_at)}</span></div>
                    <div><strong>Decision Maker</strong><span>{request.admin_decision_by || 'SAM administrator'}</span></div>
                  </> : null}
                  {request.warning ? <div className="nm-request-grid-wide"><strong>Synchronization</strong><span>{request.warning}</span></div> : null}
                </div>
              </div>
              {String(request.raw_status || '').toLowerCase() === 'pending' ? (
                <div className="nm-note-card-actions">
                  <button type="button" className="nm-btn nm-btn-primary nm-btn-table" disabled={Boolean(submittingRequestId)} onClick={() => approve(request)}>{submittingRequestId === request.request_id ? 'Approving...' : 'Approve'}</button>
                  <button type="button" className="nm-btn nm-btn-danger nm-btn-table" disabled={Boolean(submittingRequestId)} onClick={() => openDeny(request)}>Deny</button>
                </div>
              ) : null}
            </article>
          )) : <div className="nm-empty">No requests match this filter.</div>}
        </div>
      )}
      {denialRequest ? (
        <div className="nm-modal-backdrop">
          <section className="nm-modal-card" role="dialog" aria-modal="true" aria-label="Deny request">
            <h3>Deny Request</h3>
            <p className="nm-muted">Enter a readable reason. Denials cannot be submitted without a reason.</p>
            <textarea
              value={denialReason}
              onChange={(event) => setDenialReason(event.target.value)}
              rows={4}
              placeholder="Reason for denial"
              data-testid="pending-request-denial-reason"
            />
            {denialError ? <div className="nm-form-error">{denialError}</div> : null}
            <div className="nm-modal-actions">
              <button type="button" className="nm-btn nm-btn-secondary" disabled={Boolean(submittingRequestId)} onClick={() => setDenialRequest(null)}>Cancel</button>
              <button type="button" className="nm-btn nm-btn-danger" disabled={Boolean(submittingRequestId)} onClick={submitDeny}>{submittingRequestId ? 'Denying...' : 'Deny Request'}</button>
            </div>
          </section>
        </div>
      ) : null}
      {approvalRequest ? (
        <div className="nm-modal-backdrop">
          <section className="nm-modal-card" role="dialog" aria-modal="true" aria-labelledby="approve-correction-title">
            <h3 id="approve-correction-title">{approvalRequest.category === 'candidate_correction' ? 'Approve Candidate Information Correction?' : `Approve ${approvalRequest.category === 'newbie_reschedule' ? 'Newbie Shift Reschedule' : 'Newbie Shift'}?`}</h3>
            {approvalRequest.category === 'candidate_correction' ? <>
              <p className="nm-muted">Confirm the exact authoritative changes. Certification results and attempt state will not change.</p>
              <div className="nm-correction-review-list">
                {(approvalRequest.changes || []).map((change) => (
                  <div key={change.field}><strong>{change.label}</strong><span>{change.previous_value || 'Not recorded'} → {change.requested_value}</span></div>
                ))}
              </div>
            </> : <label className="nm-field nm-approval-shift-number">
              <span>Newbie Shift Number</span>
              <input
                type="text"
                maxLength={64}
                value={approvalShiftNumber}
                onChange={(event) => setApprovalShiftNumber(event.target.value)}
                placeholder="Optional"
                data-testid="newbie-shift-number"
              />
              <small>Optional. Add the assigned Newbie Shift number so it appears in the shared candidate record and tester History.</small>
            </label>}
            <div className="nm-modal-actions">
              <button type="button" className="nm-btn nm-btn-secondary" disabled={Boolean(submittingRequestId)} onClick={() => setApprovalRequest(null)}>Cancel</button>
              <button type="button" className="nm-btn nm-btn-primary" disabled={Boolean(submittingRequestId)} onClick={() => submitApproval(approvalRequest)}>{submittingRequestId ? 'Approving...' : approvalRequest.category === 'candidate_correction' ? 'Approve Correction' : 'Approve'}</button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function CandidateTrackingPanel({ data, view, onViewChange, loading, onRefresh, onAction, onConfirm, search, onSearchChange, actor, includeArchivedDefault, showStatusModal }) {
  const [detailKey, setDetailKey] = useState(null);
  const [selectedTargets, setSelectedTargets] = useState({});
  const [includeArchivedSearch, setIncludeArchivedSearch] = useState(Boolean(includeArchivedDefault));
  const [sortConfig, setSortConfig] = useState({ key: 'date', direction: 'desc' });
  const [candidateActionMenu, setCandidateActionMenu] = useState(null);
  const [editCandidateDraft, setEditCandidateDraft] = useState(null);
  const [expandedRowPreviews, setExpandedRowPreviews] = useState({});
  useEffect(() => {
    if (!candidateActionMenu) return undefined;
    const close = () => setCandidateActionMenu(null);
    const focusTimer = window.setTimeout(() => document.querySelector('.nm-action-menu-portal [role="menuitem"]')?.focus(), 0);
    document.addEventListener('mousedown', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.clearTimeout(focusTimer);
    };
  }, [candidateActionMenu]);
  const rows = data?.views?.[view] || [];
  const searchText = search.trim().toLowerCase();
  const searchPool = searchText
    ? (data?.candidates || rows).filter((row) => view === 'archived' || includeArchivedSearch || !isCandidateArchived(row))
    : rows;
  const visibleRows = searchText
    ? searchPool.filter((row) => String(row.candidate_name || '').toLowerCase().includes(searchText))
    : rows;
  const getCandidateSortValue = useCallback((row, key) => {
    if (key === 'attempts') {
      const attempts = Array.isArray(row.attempts) ? row.attempts : [];
      return Number(row.attempt_count ?? row.attempt_number ?? attempts.length ?? 0) || 0;
    }
    if (key === 'date') {
      const rawDate = row.completed_at || row.last_session_date || row.updated_at || row.created_at || '';
      const timestamp = Date.parse(rawDate);
      return Number.isNaN(timestamp) ? 0 : timestamp;
    }
    if (key === 'status') return String(row.status || row.latest_status || 'Unknown').toLowerCase();
    if (key === 'tester') return String(row.original_tester_name || row.tester_name || 'Unknown').toLowerCase();
    if (key === 'results') {
      return String([row.call_1_result, row.call_2_result, row.call_3_result, row.sup_transfer_1_result, row.sup_transfer_2_result].filter(Boolean).join(', ') || row.mock_call_summary || 'Recorded').toLowerCase();
    }
    return String(row.candidate_name || 'Unknown').toLowerCase();
  }, []);
  const sortedRows = useMemo(() => {
    const direction = sortConfig.direction === 'asc' ? 1 : -1;
    return visibleRows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const aValue = getCandidateSortValue(a.row, sortConfig.key);
        const bValue = getCandidateSortValue(b.row, sortConfig.key);
        if (typeof aValue === 'number' && typeof bValue === 'number') {
          const numericCompare = aValue - bValue;
          return numericCompare ? numericCompare * direction : a.index - b.index;
        }
        const textCompare = String(aValue).localeCompare(String(bValue), undefined, { sensitivity: 'base' });
        return textCompare ? textCompare * direction : a.index - b.index;
      })
      .map((entry) => entry.row);
  }, [visibleRows, sortConfig, getCandidateSortValue]);
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
  const visibleEntries = sortedRows.map((row, index) => ({
    row,
    index,
    key: getCandidateRowKey(row) || `${row.candidate_name || 'candidate'}-${index}`,
  }));
  const selectedKeys = Object.keys(selectedTargets);
  const selectedList = Object.values(selectedTargets);
  const selectedCount = selectedKeys.length;
  const allVisibleSelected = visibleEntries.length > 0 && visibleEntries.every((entry) => selectedTargets[entry.key]);

  useEffect(() => {
    setIncludeArchivedSearch(Boolean(includeArchivedDefault));
  }, [includeArchivedDefault]);

  const setSortFromHeader = (key) => {
    setSortConfig((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  const setSortFromSelect = (value) => {
    const [key, direction] = value.split(':');
    setSortConfig({ key, direction: direction === 'desc' ? 'desc' : 'asc' });
  };

  const renderSortableHeader = (key, label) => {
    const active = sortConfig.key === key;
    const ariaSort = active ? (sortConfig.direction === 'asc' ? 'ascending' : 'descending') : 'none';
    return (
      <th aria-sort={ariaSort}>
        <button
          type="button"
          className={`nm-sort-header ${active ? 'is-active' : ''}`}
          onClick={() => setSortFromHeader(key)}
        >
          <span>{label}</span>
          <span className="nm-sort-indicator" aria-hidden="true">{active ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}</span>
        </button>
      </th>
    );
  };

  const serializeCandidatesToCsv = (rowList) => {
    if (!rowList.length) return '';
    const headers = ['Candidate Name', 'Status', 'Attempts', 'Tester', 'Date', 'Result', 'Newbie Shift Number', 'Notes'];
    const escapeCsv = (str) => {
      if (str === null || str === undefined) return '';
      const text = String(str).replace(/"/g, '""');
      return `"${text}"`;
    };
    const csvRows = [headers.join(',')];
    for (const row of rowList) {
      const meta = computeRowMeta(row);
      csvRows.push([
        escapeCsv(row.candidate_name),
        escapeCsv(meta.statusUpper),
        escapeCsv(meta.attempts.length),
        escapeCsv(row.tester_name || meta.attempts[0]?.tester_name || ''),
        escapeCsv(formatSamTimestamp(row.updated_at || meta.attempts[0]?.completed_at || '')),
        escapeCsv(meta.results),
        escapeCsv(row.newbie_shift_number || ''),
        escapeCsv(meta.notes)
      ].join(','));
    }
    return csvRows.join('\n');
  };

  const handleExportVisible = () => {
    const csvContent = serializeCandidatesToCsv(visibleEntries.map(e => e.row));
    downloadCsv('candidate-tracking-report.csv', csvContent);
  };

  const handleExportSelected = () => {
    const csvContent = serializeCandidatesToCsv(selectedKeys.map(key => visibleEntries.find(e => e.key === key)?.row).filter(Boolean));
    downloadCsv('candidate-tracking-selected.csv', csvContent);
  };

  const handleCopySelected = async () => {
    const rows = selectedKeys.map(key => visibleEntries.find(e => e.key === key)?.row).filter(Boolean);
    if (!rows.length) return;
    const textLines = [];
    for (const row of rows) {
      const meta = computeRowMeta(row);
      textLines.push(`Candidate Name: ${row.candidate_name || ''}`);
      textLines.push(`Status: ${meta.statusUpper}`);
      textLines.push(`Attempts: ${meta.attempts.length}`);
      textLines.push(`Tester: ${row.tester_name || meta.attempts[0]?.tester_name || ''}`);
      textLines.push(`Date: ${formatSamTimestamp(row.updated_at || meta.attempts[0]?.completed_at || '')}`);
      textLines.push(`Result: ${meta.results}`);
      textLines.push(`Notes: ${meta.notes}`);
      textLines.push('------------------------');
    }
    try {
      await navigator.clipboard.writeText(textLines.join('\n'));
      if (showStatusModal) showStatusModal('Selected candidates copied to clipboard.', 'success');
    } catch (err) {
      if (showStatusModal) showStatusModal('Failed to copy to clipboard.', 'error');
    }
  };

  const handlePrintSelected = () => {
    if (selectedCount === 0) {
      if (showStatusModal) showStatusModal('Select one or more candidates to print.', 'warning');
      return;
    }
    window.print();
  };

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
    await onAction({
      action: 'grant_extra_attempt', candidate_name: row.candidate_name,
      session_id: row.session_id || row.latest_session_id, pending_id: row.pending_id, reason, actor,
      expected_extra_attempts_granted: Number(row.extra_attempts_granted || (sheetTruthy(row.extra_attempt_granted) ? 1 : 0)),
    });
  };

  const handleArchive = async (row) => {
    const confirmed = await onConfirm(
      `Archive ${row.candidate_name || 'this candidate'}? This keeps the shared history but removes the candidate from active SAM views.`,
      {
        confirmLabel: 'Archive',
        kind: 'warning',
        collectNote: true,
        noteLabel: 'Optional archive note',
        notePlaceholder: 'Example: closed record older than retention window.',
      },
    );
    if (!confirmed) return;
    const reason = typeof confirmed === 'object' ? confirmed.note || '' : '';
    await onAction({
      action: 'archive_candidate',
      candidate_name: row.candidate_name,
      session_id: row.session_id || row.latest_session_id || row.original_session_id,
      pending_id: row.pending_id,
      reason,
      actor,
    });
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

  const openCandidateInformationEdit = (row) => {
    const headset = getCandidateHeadset(row);
    setCandidateActionMenu(null);
    setEditCandidateDraft({
      row,
      candidateName: row.candidate_name || '',
      headsetBrand: headset.brand,
      headsetModel: headset.model,
      headsetCombined: headset.label,
      separateHeadsetFields: headset.separate,
      reason: '', error: '', submitting: false,
    });
  };

  const submitCandidateInformationEdit = async () => {
    const current = editCandidateDraft.row;
    const reason = editCandidateDraft.reason.trim();
    if (!reason) {
      setEditCandidateDraft((draft) => ({ ...draft, error: 'Enter a reason for this correction.' }));
      return;
    }
    const currentHeadset = getCandidateHeadset(current);
    const changes = buildCandidateInformationChanges(
      currentHeadset.separate
        ? { candidate_name: current.candidate_name, headset_brand: currentHeadset.brand, headset_model: currentHeadset.model }
        : { candidate_name: current.candidate_name, headset_model: currentHeadset.label },
      currentHeadset.separate
        ? { candidate_name: editCandidateDraft.candidateName, headset_brand: editCandidateDraft.headsetBrand, headset_model: editCandidateDraft.headsetModel }
        : { candidate_name: editCandidateDraft.candidateName, headset_model: editCandidateDraft.headsetCombined },
    );
    if (!changes.length || changes.some((change) => !change.requested_value)) {
      setEditCandidateDraft((draft) => ({ ...draft, error: !changes.length ? 'Change at least one value.' : 'Corrected values cannot be empty.' }));
      return;
    }
    setEditCandidateDraft((draft) => ({ ...draft, submitting: true, error: '' }));
    const result = await onAction({
      action: 'edit_candidate_information',
      candidate_name: current.candidate_name,
      session_id: current.session_id || current.latest_session_id || current.original_session_id,
      candidate_id: current.candidate_id || '',
      changes,
      reason,
      actor,
    });
    if (!result?.ok) {
      setEditCandidateDraft((draft) => ({ ...draft, submitting: false, error: result?.error || 'The candidate information could not be updated.' }));
      return;
    }
    setEditCandidateDraft(null);
  };

  const toggleRowPreview = (rowKey) => {
    setExpandedRowPreviews((current) => ({ ...current, [rowKey]: !current[rowKey] }));
  };

  const hasExpandablePreview = (results, notes) => (
    String(results || '').length > 48 || String(notes || '').length > 72
  );

  const computeRowMeta = (row) => {
    const results = [row.call_1_result, row.call_2_result, row.call_3_result, row.sup_transfer_1_result, row.sup_transfer_2_result].filter(Boolean).join(', ') || row.mock_call_summary || 'Recorded';
    const notes = row.fail_summary || row.notes || row.coaching_summary || row.review_notes || 'None recorded';
    const hasFinalNotes = Boolean(row.final_notes_strengths || row.final_notes_needs_coaching || row.final_notes_other || row.evaluator_notes_summary);
    const isFinalNotesHistoryOnly = hasFinalNotes && (row.final_notes_history_only === true || row.final_notes_history_only === 'TRUE');
    const attempts = Array.isArray(row.attempts) ? row.attempts : [];
    const statusUpper = String(row.status || row.latest_status || '').toUpperCase();
    const isPendingTransfer = view === 'pending' || Boolean(row.pending_id);
    const isIncomplete = view === 'incomplete' || statusUpper === 'INCOMPLETE';
    const isWithdrawn = sheetTruthy(row.withdrawn) || statusUpper === 'WITHDREW FROM CERTIFICATION';
    const isArchived = isCandidateArchived(row);
    return { results, notes, hasFinalNotes, isFinalNotesHistoryOnly, attempts, statusUpper, isPendingTransfer, isIncomplete, isWithdrawn, isArchived };
  };

  const renderCandidateActions = (row, rowKey) => {
    const { isIncomplete, isPendingTransfer, isWithdrawn, isArchived } = computeRowMeta(row);
    const closeMenu = () => setCandidateActionMenu(null);
    const runMenuAction = async (action) => {
      closeMenu();
      await action();
    };
    const statusActions = [];
    if (!isArchived) {
      statusActions.push(
        { label: 'Mark Passed', kind: 'success', onClick: () => handleManualCorrection(row, 'mark_passed', 'Mark Passed') },
        { label: 'Mark Failed', kind: 'danger', onClick: () => handleManualCorrection(row, 'mark_failed', 'Mark Failed') },
      );
      if (isIncomplete && !isPendingTransfer) {
        statusActions.push({ label: 'Pending Supervisor Transfer', kind: 'action', onClick: () => handleManualCorrection(row, 'move_pending_sup_transfer', 'Move to Pending Supervisor Transfer') });
      }
      if (isPendingTransfer) {
        statusActions.push({ label: 'Mark Incomplete', kind: 'action', onClick: () => handleManualCorrection(row, 'remove_pending_sup_transfer', 'Mark Incomplete') });
      }
      statusActions.push({ label: 'Grant Extra Attempt', kind: 'info', onClick: () => handleExtraAttempt(row) });
    }

    const moreActions = [];
    if (row.pending_id) {
      moreActions.push({ label: 'Cancel Transfer', kind: 'danger', onClick: () => handleCancel(row) });
    }
    if (!isArchived) {
      moreActions.push({ label: 'Archive', kind: 'secondary', onClick: () => handleArchive(row) });
    }
    if (isArchived) {
      moreActions.push({ label: 'Restore', kind: 'primary', onClick: () => onAction({ action: 'restore_active', candidate_name: row.candidate_name, session_id: row.session_id || row.latest_session_id, actor }) });
    } else {
      moreActions.unshift({ label: 'Edit Candidate Information', kind: 'primary', onClick: () => openCandidateInformationEdit(row) });
      moreActions.push(isWithdrawn
        ? { label: 'Restore', kind: 'primary', onClick: () => handleRestore(row) }
        : { label: 'Withdraw', kind: 'danger', onClick: () => handleWithdraw(row) });
    }
    moreActions.push({ label: 'Delete', kind: 'danger', onClick: () => handleDeleteRow(row) });

    const renderMenu = (type, label, actions) => {
      if (!actions.length) return null;
      const menuKey = `${rowKey || getCandidateRowKey(row)}:${type}`;
      const isOpen = candidateActionMenu?.key === menuKey;
      return (
        <div className="nm-action-menu-wrap">
          <button
            type="button"
            className={`nm-btn nm-btn-table nm-menu-trigger ${type === 'status' ? 'nm-candidate-action-workflow' : 'nm-candidate-action-secondary'}`}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            aria-label={`${label} for ${row.candidate_name || 'candidate'}`}
            onClick={(event) => {
              event.stopPropagation();
              if (isOpen) setCandidateActionMenu(null);
              else {
                const rect = event.currentTarget.getBoundingClientRect();
                setCandidateActionMenu({ key: menuKey, rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width }, actions });
              }
            }}
          >
            {label}
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          {isOpen ? (
            <ModalPortal>
            <div
              className="nm-action-menu nm-action-menu-portal"
              role="menu"
              style={{
                position: 'fixed',
                top: candidateActionMenu.rect.bottom + 220 > window.innerHeight ? 'auto' : candidateActionMenu.rect.bottom + 6,
                bottom: candidateActionMenu.rect.bottom + 220 > window.innerHeight ? window.innerHeight - candidateActionMenu.rect.top + 6 : 'auto',
                left: Math.max(12, Math.min(candidateActionMenu.rect.left, window.innerWidth - Math.max(210, candidateActionMenu.rect.width) - 12)),
                width: Math.max(210, candidateActionMenu.rect.width),
              }}
              onMouseDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => { if (event.key === 'Escape') closeMenu(); }}
            >
              {actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  role="menuitem"
                  className={`nm-action-menu-item is-${action.kind}`}
                  onClick={() => runMenuAction(action.onClick)}
                >
                  {action.label}
                </button>
              ))}
            </div>
            </ModalPortal>
          ) : null}
        </div>
      );
    };

    return (
      <div className="nm-row-actions nm-row-actions-compact">
        <button type="button" className="nm-btn nm-btn-table nm-view-details-btn nm-candidate-action-secondary" onClick={() => setDetailKey(rowKey)}>
          View Details
        </button>
        {renderMenu('status', 'Update Status', statusActions)}
        {renderMenu('more', 'More Actions', moreActions)}
      </div>
    );
  };

  const renderCandidateDetails = (row) => {
    const { notes, hasFinalNotes, isFinalNotesHistoryOnly, attempts } = computeRowMeta(row);
    const formMeta = formFillMeta(row.form_fill_status);
    const approvalMeta = newbieShiftStatusMeta(row);
    const hasNewbieRequest = Boolean(approvalMeta);
    return (
      <div className="nm-candidate-details">
        <section className="nm-detail-card">
          <strong>Session Notes</strong>
          <div>{notes}</div>
          <div><strong>Coaching:</strong> {row.coaching_summary || 'N/A'}</div>
          <div><strong>Fail Summary:</strong> {row.fail_summary || 'N/A'}</div>
        </section>
        <section className="nm-detail-card">
          <strong>Basics</strong>
          <div>Headset: {getCandidateHeadset(row).label || 'N/A'}</div>
          <div>USB: {row.headset_usb === true ? 'Yes' : row.headset_usb === false ? 'No' : 'N/A'}</div>
          <div>Noise cancelling: {row.noise_cancel === true ? 'Yes' : row.noise_cancel === false ? 'No' : 'N/A'}</div>
          <div>VPN: {row.vpn_on === true ? 'Yes' : row.vpn_on === false ? 'No' : 'N/A'}</div>
        </section>
        <section className="nm-detail-card">
          <strong>Results</strong>
          <div>Calls: {[row.call_1_result, row.call_2_result, row.call_3_result].filter(Boolean).join(', ') || 'N/A'}</div>
          <div>Sup Transfers: {[row.sup_transfer_1_result, row.sup_transfer_2_result].filter(Boolean).join(', ') || 'N/A'}</div>
        </section>
        <section className="nm-detail-card">
          <strong>Request Status</strong>
          <div className="nm-status-stack">
            <StatusChip meta={formMeta} title={`Form fill status: ${formMeta.label}`} />
            {hasNewbieRequest ? <StatusChip meta={approvalMeta} title={`Newbie Shift approval status: ${approvalMeta.label}`} /> : null}
          </div>
          {row.form_filled_at ? <div>Form filled: {formatSamTimestamp(row.form_filled_at)}</div> : null}
          {row.newbie_shift_scheduled_at ? <div>Newbie Shift: {formatSamTimestamp(row.newbie_shift_scheduled_at)} {row.newbie_shift_timezone || ''}</div> : null}
          {row.newbie_shift_number ? <div>Newbie Shift Number: Shift #{row.newbie_shift_number}</div> : null}
          {row.newbie_shift_original_scheduled_at ? <div>Original schedule: {formatSamTimestamp(row.newbie_shift_original_scheduled_at)}</div> : null}
          {row.newbie_shift_rescheduled_at ? <div>Tentative reschedule: {formatSamTimestamp(row.newbie_shift_rescheduled_at)}</div> : null}
          {row.newbie_shift_denial_reason ? <div>Denial reason: {row.newbie_shift_denial_reason}</div> : null}
        </section>
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
            {row.final_notes_created_at ? <div className="nm-meta"><strong>Notes Created:</strong> {formatSamTimestamp(row.final_notes_created_at)}</div> : null}
          </div>
        ) : null}
        {attempts.length ? (
          <div className="nm-attempt-list">
            <strong>Attempt History</strong>
            {attempts.map((attempt, attemptIndex) => (
              <details key={`${attempt.session_id || attemptIndex}`} className="nm-attempt-detail">
                <summary>{formatSamTimestamp(attempt.completed_at || attempt.created_at) || `Attempt ${attemptIndex + 1}`} - {attempt.status || 'Unknown'} - {attempt.tester_name || 'Unknown tester'}</summary>
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
    );
  };

  const detailEntry = visibleEntries.find((entry) => entry.key === detailKey) || null;
  const detailRow = detailEntry?.row || null;
  const detailMeta = detailRow ? computeRowMeta(detailRow) : null;
  const editCandidateChanges = editCandidateDraft ? (() => {
    const headset = getCandidateHeadset(editCandidateDraft.row);
    return buildCandidateInformationChanges(
      headset.separate
        ? { candidate_name: editCandidateDraft.row.candidate_name, headset_brand: headset.brand, headset_model: headset.model }
        : { candidate_name: editCandidateDraft.row.candidate_name, headset_model: headset.label },
      headset.separate
        ? { candidate_name: editCandidateDraft.candidateName, headset_brand: editCandidateDraft.headsetBrand, headset_model: editCandidateDraft.headsetModel }
        : { candidate_name: editCandidateDraft.candidateName, headset_model: editCandidateDraft.headsetCombined },
    );
  })() : [];

  return (
    <section className="nm-panel nm-candidate-panel" id="sam-candidate-tracking" data-sam-tour="candidate-tracking">
      <div className="nm-section-title">
        <div>
          <h2>Candidate Tracking</h2>
          <div className="nm-kicker">Shared admin queue from Candidate Sessions and Pending Sup Transfers.</div>
        </div>
        <div className="nm-section-title-actions">
          <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={onRefresh} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
          <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={handleExportVisible}>Export CSV</button>
        </div>
      </div>
      {!data?.ok && data?.error ? (
        <div className="nm-status-card is-warning">
          <strong>Shared tracking unavailable</strong>
          <span>{data.error}</span>
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
        <label className="nm-checkbox nm-search-toggle">
          <input
            type="checkbox"
            checked={includeArchivedSearch}
            onChange={(event) => setIncludeArchivedSearch(event.target.checked)}
          />
          Include archived candidates
        </label>
        <label className="nm-sort-select-label" htmlFor="sam-candidate-sort">
          Sort by
          <select
            id="sam-candidate-sort"
            value={`${sortConfig.key}:${sortConfig.direction}`}
            onChange={(event) => setSortFromSelect(event.target.value)}
          >
            {CANDIDATE_SORT_OPTIONS.map((option) => (
              <option key={`${option.key}:${option.direction}`} value={`${option.key}:${option.direction}`}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {selectedCount > 0 ? (
        <div className="nm-bulk-action-bar">
          <span className="nm-bulk-count">✓ {selectedCount} candidate{selectedCount !== 1 ? 's' : ''} selected</span>
          <div className="nm-bulk-actions">
            <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={handleCopySelected}>Copy Selected</button>
            <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={handlePrintSelected}>Print Report</button>
            <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={handleExportSelected}>Export CSV</button>
            <button type="button" className="nm-btn nm-btn-danger nm-btn-table" onClick={() => handleDeleteTargets(selectedList, `${selectedCount} selected candidate record${selectedCount === 1 ? '' : 's'}`)}>Delete Selected</button>
          </div>
        </div>
      ) : null}
      <div className="nm-candidate-layout">
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
              {renderSortableHeader('candidate', 'Candidate')}
              {renderSortableHeader('status', 'Status')}
              {renderSortableHeader('attempts', 'Attempts')}
              {renderSortableHeader('tester', 'Tester')}
              {renderSortableHeader('date', 'Date')}
              {renderSortableHeader('results', 'Results')}
              <th>Notes</th>
              <th className="nm-actions-column">Actions</th>
            </tr>
          </thead>
          <tbody>
            {!visibleRows.length ? (
              <tr><td colSpan={9}><div className="nm-empty">No candidates in this view.</div></td></tr>
            ) : visibleEntries.map(({ row, index, key: rowKey }) => {
              const { results, notes, hasFinalNotes, isFinalNotesHistoryOnly, attempts, isArchived } = computeRowMeta(row);
              const formMeta = formFillMeta(row.form_fill_status);
              const approvalMeta = newbieShiftStatusMeta(row);
              const certificationMeta = candidateCertificationMeta(row);
              const supervisorTransferMeta = row.pending_id ? workflowApprovalMeta('Supervisor Transfer', 'pending') : null;
              const deletionMeta = row.deletion_request_status ? workflowApprovalMeta('Candidate Deletion', row.deletion_request_status) : null;
              const hasNewbieRequest = Boolean(approvalMeta);
              const isExpanded = detailKey === rowKey;
              const isPreviewExpanded = Boolean(expandedRowPreviews[rowKey]);
              const canExpandPreview = hasExpandablePreview(results, notes);
              return (
                <React.Fragment key={rowKey}>
                  <tr className={`${isExpanded ? 'is-selected' : ''} ${isPreviewExpanded ? 'is-preview-expanded' : ''}`}>
                    <td className="nm-select-column" data-label="Select">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.candidate_name || 'candidate'}`}
                        checked={Boolean(selectedTargets[rowKey])}
                        onChange={(event) => toggleRowSelection({ row, index, key: rowKey }, event.target.checked)}
                      />
                    </td>
                    <td data-label="Candidate">
                      <div className="nm-row-title" title={row.candidate_name || 'Unknown'} aria-label={row.candidate_name || 'Unknown'}>
                        {row.candidate_name || 'Unknown'}
                      </div>
                      <div className="nm-meta">{isArchived ? 'Archived' : sheetTruthy(row.final_attempt) || sheetTruthy(row.final_attempt_risk) ? 'Final-attempt risk' : sheetTruthy(row.extra_attempt_granted) ? 'Extra attempt granted' : 'Active'}</div>
                      <div className="nm-row-chip-list">
                        <StatusChip meta={formMeta} title={`Form fill status: ${formMeta.label}`} />
                        {hasNewbieRequest ? <StatusChip meta={approvalMeta} title={`Newbie Shift approval status: ${approvalMeta.label}`} /> : null}
                        {row.newbie_shift_number ? <span className="nm-meta">Shift #{row.newbie_shift_number}</span> : null}
                        {supervisorTransferMeta ? <StatusChip meta={supervisorTransferMeta} /> : null}
                        {deletionMeta ? <StatusChip meta={deletionMeta} /> : null}
                      </div>
                    </td>
                    <td data-label="Status"><StatusChip meta={certificationMeta} title={`Certification status: ${certificationMeta.label}`} /></td>
                    <td data-label="Attempts">{row.attempt_count ?? row.attempt_number ?? attempts.length ?? '0'}</td>
                    <td data-label="Tester" title={row.original_tester_name || row.tester_name || 'Unknown'}>{row.original_tester_name || row.tester_name || 'Unknown'}</td>
                    <td data-label="Date" className="nm-meta">{formatSamTimestamp(row.completed_at || row.last_session_date || row.created_at)}</td>
                    <td data-label="Results" className="nm-meta" title={results}>
                      <div className="nm-results-preview" title={results} tabIndex={0} aria-label={results}>{results}</div>
                    </td>
                    <td data-label="Notes" className="nm-meta nm-notes-cell">
                      <div className="nm-notes-preview" title={notes} tabIndex={0} aria-label={notes}>{notes}</div>
                      {hasFinalNotes ? <span className="nm-final-notes-badge" title={isFinalNotesHistoryOnly ? 'Final notes (history only — not in review summary)' : 'Final evaluator notes available'}>📝 Final Notes{isFinalNotesHistoryOnly ? ' (History)' : ''}</span> : null}
                      {canExpandPreview ? (
                        <button
                          type="button"
                          className="nm-row-preview-toggle"
                          aria-expanded={isPreviewExpanded}
                          aria-label={`${isPreviewExpanded ? 'Collapse' : 'Show more'} row preview for ${row.candidate_name || 'candidate'}`}
                          onClick={() => toggleRowPreview(rowKey)}
                        >
                          {isPreviewExpanded ? 'Show Less' : 'Show More'}
                        </button>
                      ) : null}
                    </td>
                    <td data-label="Actions">
                      {renderCandidateActions(row, rowKey)}
                    </td>
                  </tr>
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      </div>
      {detailRow ? (
        <ModalPortal>
          <div className="nm-modal-backdrop nm-candidate-detail-backdrop">
            <section className="nm-candidate-detail-modal" role="dialog" aria-modal="true" aria-labelledby="sam-candidate-detail-title">
              <div className="nm-candidate-detail-header">
                <div className="nm-detail-id">
                  <div className="nm-detail-name" id="sam-candidate-detail-title">{detailRow.candidate_name || 'Unknown'}</div>
                  <StatusChip meta={candidateCertificationMeta(detailRow)} title={`Certification status: ${candidateCertificationMeta(detailRow).label}`} />
                </div>
                <button type="button" className="nm-modal-close" aria-label="Close candidate details" onClick={() => setDetailKey(null)}>×</button>
              </div>
              <div className="nm-candidate-detail-scroll">
                <dl className="nm-detail-grid">
                  <div><dt>Attempts</dt><dd>{detailRow.attempt_count ?? detailRow.attempt_number ?? detailMeta.attempts.length ?? '0'}</dd></div>
                  <div><dt>Tester</dt><dd>{detailRow.original_tester_name || detailRow.tester_name || 'Unknown'}</dd></div>
                  <div><dt>Date</dt><dd>{formatSamTimestamp(detailRow.completed_at || detailRow.last_session_date || detailRow.created_at)}</dd></div>
                  <div><dt>Results</dt><dd>{detailMeta.results}</dd></div>
                </dl>
                <div className="nm-detail-section">
                  <div className="nm-detail-label">Actions</div>
                  {renderCandidateActions(detailRow)}
                </div>
                <div className="nm-detail-section">
                  <div className="nm-detail-label">Record</div>
                  {renderCandidateDetails(detailRow)}
                </div>
              </div>
              <div className="nm-candidate-detail-footer">
                <button type="button" className="nm-btn nm-btn-secondary" onClick={() => setDetailKey(null)}>Back / Close</button>
              </div>
            </section>
          </div>
        </ModalPortal>
      ) : null}
      {editCandidateDraft ? (
        <ModalPortal>
          <div className="nm-modal-backdrop">
            <section className="nm-modal-card nm-edit-candidate-modal" role="dialog" aria-modal="true" aria-labelledby="edit-candidate-information-title">
              <h3 id="edit-candidate-information-title">Edit Candidate Information</h3>
              <p className="nm-muted">Only candidate name and the headset recorded for this session can be corrected. Attempts, results, and workflow decisions are unchanged.</p>
              <label><span>Candidate name</span><small>Previous: {editCandidateDraft.row.candidate_name || 'Not recorded'}</small><input value={editCandidateDraft.candidateName} onChange={(event) => setEditCandidateDraft((draft) => ({ ...draft, candidateName: event.target.value, error: '' }))} /></label>
              {editCandidateDraft.separateHeadsetFields ? (
                <>
                  <label><span>Headset brand</span><small>Previous: {getCandidateHeadset(editCandidateDraft.row).brand || 'Not recorded'}</small><input value={editCandidateDraft.headsetBrand} onChange={(event) => setEditCandidateDraft((draft) => ({ ...draft, headsetBrand: event.target.value, error: '' }))} /></label>
                  <label><span>Headset model</span><small>Previous: {getCandidateHeadset(editCandidateDraft.row).model || 'Not recorded'}</small><input value={editCandidateDraft.headsetModel} onChange={(event) => setEditCandidateDraft((draft) => ({ ...draft, headsetModel: event.target.value, error: '' }))} /></label>
                </>
              ) : (
                <label><span>Headset</span><small>Previous: {getCandidateHeadset(editCandidateDraft.row).label || 'Not recorded'}</small><input value={editCandidateDraft.headsetCombined} onChange={(event) => setEditCandidateDraft((draft) => ({ ...draft, headsetCombined: event.target.value, error: '' }))} /></label>
              )}
              <label><span>Correction reason</span><textarea className="nm-correction-reason-input" rows={4} required aria-invalid={Boolean(editCandidateDraft.error && !editCandidateDraft.reason.trim())} value={editCandidateDraft.reason} onChange={(event) => setEditCandidateDraft((draft) => ({ ...draft, reason: event.target.value, error: '' }))} placeholder="Explain why this correction is needed, such as a misspelled candidate name or headset model." /></label>
              <div className="nm-correction-review-list" aria-live="polite">
                <strong>Changed fields</strong>
                {editCandidateChanges.map((change) => (
                  <div key={change.field_key}><strong>{change.label}</strong><span>{change.previous_value || 'Not recorded'} → {change.requested_value}</span></div>
                ))}
                {!editCandidateChanges.length ? <p className="nm-correction-empty">Change the candidate name or headset value to enable Save Correction.</p> : null}
              </div>
              {editCandidateDraft.error ? <div className="nm-form-error" role="alert">{editCandidateDraft.error}</div> : null}
              <div className="nm-modal-actions">
                <button type="button" className="nm-btn nm-btn-secondary" disabled={editCandidateDraft.submitting} onClick={() => setEditCandidateDraft(null)}>Cancel</button>
                <button type="button" className="nm-btn nm-btn-primary" disabled={editCandidateDraft.submitting || !editCandidateChanges.length || !editCandidateDraft.reason.trim()} onClick={submitCandidateInformationEdit}>{editCandidateDraft.submitting ? 'Saving...' : 'Save Correction'}</button>
              </div>
            </section>
          </div>
        </ModalPortal>
      ) : null}
      <div className="nm-print-layout" aria-hidden="true">
        <div className="nm-print-header">
          <img src="/assets/branding/mts-logo-white.svg" alt="MTS Logo" className="nm-print-logo" />
          <h1>Candidate Tracking Report</h1>
        </div>
        <div className="nm-print-meta">
          <div><strong>Generated:</strong> {formatSamTimestamp(new Date().toISOString())}</div>
          <div><strong>Selected Records:</strong> {selectedCount}</div>
          {searchText && <div><strong>Search:</strong> {searchText}</div>}
        </div>
        <table className="nm-print-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Tester</th>
              <th>Date</th>
              <th>Result</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {selectedKeys.map((key) => {
              const entry = visibleEntries.find((e) => e.key === key);
              if (!entry) return null;
              const row = entry.row;
              const meta = computeRowMeta(row);
              return (
                <tr key={key}>
                  <td>{row.candidate_name || 'Unknown'}</td>
                  <td>{meta.statusUpper}</td>
                  <td>{meta.attempts.length}</td>
                  <td>{row.tester_name || meta.attempts[0]?.tester_name || 'Unknown'}</td>
                  <td>{formatSamTimestamp(row.updated_at || meta.attempts[0]?.completed_at)}</td>
                  <td>{meta.results}</td>
                  <td>{meta.notes}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="nm-print-footer">
          Mock Testing Suite / Smart Alert Manager
        </div>
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

export function NotificationEditorModal({
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

                  <section className="nm-form-section">
                    <div className="nm-form-section-head"><span className="nm-form-section-title">Message</span></div>
                  <div className="nm-field-grid">
                    <div className="nm-field">
                      <label htmlFor="nm-type">Notification Level</label>
                      <select id="nm-type" value={selectedItem.Type} onChange={(event) => updateSelected({ Type: event.target.value })}>
                        {MANAGER_NOTIFICATION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                      </select>
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
                  </section>

                  <section className="nm-form-section">
                    <div className="nm-form-section-head"><span className="nm-form-section-title">Status &amp; priority</span></div>
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
                  </section>

                  <section className="nm-form-section">
                    <div className="nm-form-section-head"><span className="nm-form-section-title">Delivery</span></div>
                  <div className="nm-delivery-section">
                    <div className="nm-active-label">Delivery Types</div>
                    <div className="nm-inline">
                      <label className="nm-checkbox"><input type="checkbox" checked={selectedItem.ShowTicker} onChange={(event) => updateSelected({ ShowTicker: event.target.checked })} /> Ticker</label>
                      <label className="nm-checkbox"><input type="checkbox" checked={selectedItem.ShowPopup} onChange={(event) => updateSelected({ ShowPopup: event.target.checked })} /> Show Popup</label>
                      <label className="nm-checkbox"><input type="checkbox" checked={selectedItem.ShowBanner} onChange={(event) => updateSelected({ ShowBanner: event.target.checked })} /> Show Banner</label>
                      <label className="nm-checkbox"><input type="checkbox" checked={selectedItem.Persistent} onChange={(event) => updateSelected({ Persistent: event.target.checked })} /> Persistent</label>
                    </div>
                  </div>
                  </section>

                  <section className="nm-form-section">
                    <div className="nm-form-section-head"><span className="nm-form-section-title">Schedule</span></div>
                  <div className="nm-field-grid">
                    <div className="nm-field">
                      <label htmlFor="nm-start-date">Starts At Date</label>
                      <input id="nm-start-date" type="date" value={selectedItem.StartDate || ''} onChange={(event) => updateSelected({ StartDate: event.target.value })} />
                    </div>
                    <div className="nm-field">
                      <label htmlFor="nm-start-time">Starts At Time</label>
                      <input id="nm-start-time" type="text" value={selectedItem.StartTime || ''} onChange={(event) => updateSelected({ StartTime: event.target.value })} placeholder="9:00 AM" />
                    </div>
                    <div className="nm-field">
                      <label htmlFor="nm-end-date">Expires At Date (Optional)</label>
                      <input id="nm-end-date" type="date" value={selectedItem.EndDate || ''} onChange={(event) => updateSelected({ EndDate: event.target.value })} />
                    </div>
                    <div className="nm-field">
                      <label htmlFor="nm-end-time">Expires At Time (Optional)</label>
                      <input id="nm-end-time" type="text" value={selectedItem.EndTime || ''} onChange={(event) => updateSelected({ EndTime: event.target.value })} placeholder="e.g. 5:00 PM" />
                    </div>
                  </div>

                  <div className="nm-inline">
                    <button
                      type="button"
                      className="nm-btn nm-btn-secondary nm-btn-inline"
                      onClick={() => updateSelected({ EndDate: '', EndTime: '' })}
                      data-testid="nm-no-expiration-btn"
                    >
                      No Expiration
                    </button>
                    <span className="nm-inline-note">
                      {!selectedItem.EndDate && !selectedItem.EndTime
                        ? 'No expiration set. This notification stays active until disabled or removed.'
                        : 'End date and time are optional. Click "No Expiration" to clear them.'}
                    </span>
                  </div>
                  </section>

                  <section className="nm-form-section">
                    <div className="nm-form-section-head"><span className="nm-form-section-title">Action button</span></div>
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
                  </section>

                  {validation.errors.length > 0 ? (
                    <div className="nm-errors">
                      {validation.errors.map((error) => <div key={error} className="nm-error">{error}</div>)}
                    </div>
                  ) : null}
                  {importError ? <div className="nm-error">{importError}</div> : null}
                  {!sheetState.writeReady && sheetState.writeError ? <div className="nm-error">{sheetState.writeError}</div> : null}
                </div>

                <div className="nm-sidecard">
                  <h4>Save Rules</h4>
                  <ul>
                    <li>Start date defaults to today in Eastern Time.</li>
                    <li>Start time defaults to the current Eastern time.</li>
                    <li>Expiration stays blank until you choose an end date and time.</li>
                    <li>Choose No Expiration if this notification should stay active indefinitely.</li>
                    <li>SAM assigns and preserves the internal notification ID automatically.</li>
                    <li>Ticker speed is controlled in Mock Testing Suite Settings, not here.</li>
                  </ul>
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

const HEADSET_DENIAL_REASONS = [
  'Headset does not connect via USB',
  'Headset does not have a noise cancelling microphone',
  'Other',
];

export function buildSamHeadsetResearchUrl(item) {
  const headset = `${item?.brand || ''} ${item?.model || ''}`.trim().replace(/\s+/g, ' ');
  const query = `Does the headset ${headset || '[BRAND MODEL]'} have a noise cancelling microphone and connect via USB?`;
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function formatHeadsetSubmittedDate(value) {
  if (!value) return 'N/A';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}

function normalizedHeadsetValue(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function headsetRowIdentity(item, kind = '') {
  if (item?.catalog_identity) return `catalog:${item.catalog_identity}`;
  if (item?.review_id) return `review:${item.review_id}`;
  const rowNumber = Number(item?.catalog_row_number || 0);
  const parts = [kind, rowNumber, item?.brand, item?.model].map(normalizedHeadsetValue);
  return `headset:${parts.join(':')}`;
}

function canonicalHeadsetReviewData(value = {}) {
  const canonicalRows = (rows, kind) => (rows || []).map((item) => ({
    identity: headsetRowIdentity(item, kind),
    brand: normalizedHeadsetValue(item?.brand),
    model: normalizedHeadsetValue(item?.model),
    status: normalizedHeadsetValue(item?.status),
    note: String(item?.note || '').trim(),
    source_session_id: String(item?.source_session_id || '').trim(),
    submitted_date: String(item?.submitted_date || '').trim(),
    updated_at: String(item?.updated_at || '').trim(),
  })).sort((left, right) => left.identity.localeCompare(right.identity));
  return JSON.stringify({
    ok: value?.ok !== false,
    error: String(value?.error || ''),
    pending: canonicalRows(value?.pending, 'pending'),
    approved: canonicalRows(value?.approved, 'approved'),
    denied: canonicalRows(value?.denied, 'denied'),
  });
}

export function preserveEqualHeadsetReviewState(current, incoming) {
  const next = { ...current, ...incoming };
  return canonicalHeadsetReviewData(current) === canonicalHeadsetReviewData(next) ? current : next;
}

export function applyHeadsetDecisionToState(current, payload, result = {}) {
  const action = String(payload?.action || result?.operation || '').toLowerCase();
  if (!result?.ok || action === 'review_later') return current;
  const targetIdentity = payload?.catalog_identity
    ? `catalog:${payload.catalog_identity}`
    : payload?.review_id
      ? `review:${payload.review_id}`
      : headsetRowIdentity(payload, '');
  const matches = (item, kind) => headsetRowIdentity(item, kind) === targetIdentity
    || (payload?.catalog_identity && item?.catalog_identity === payload.catalog_identity)
    || (payload?.review_id && item?.review_id === payload.review_id);
  const removeTarget = (rows, kind) => (rows || []).filter((item) => !matches(item, kind));
  const pending = removeTarget(current?.pending, 'pending');
  const approved = removeTarget(current?.approved, 'approved');
  const denied = removeTarget(current?.denied, 'denied');
  if (action === 'delete' || action === 'archive') return { ...current, pending, approved, denied };

  const sourceRows = [...(current?.pending || []), ...(current?.approved || []), ...(current?.denied || [])];
  const source = sourceRows.find((item) => matches(item, item?.status || '')) || payload;
  const updated = {
    ...source,
    brand: result?.brand || payload?.brand || source?.brand || '',
    model: result?.model || payload?.model || source?.model || '',
    note: payload?.note || result?.note || source?.note || '',
    status: action === 'approve' ? 'approved' : action === 'deny' ? 'denied' : source?.status,
    catalog_identity: result?.new_catalog_identity || source?.catalog_identity || payload?.catalog_identity || '',
    catalog_row_number: result?.catalog_row_number || source?.catalog_row_number || payload?.catalog_row_number || 0,
  };
  if (action === 'edit') return { ...current, pending: [...pending, { ...updated, status: 'pending' }], approved, denied };
  if (action === 'approve') return { ...current, pending, approved: [...approved, updated], denied };
  if (action === 'deny') return { ...current, pending, approved, denied: [...denied, updated] };
  return current;
}

export function HeadsetReviewPanel({ data, loading, onRefresh, onDecision, onStatus, onConfirm }) {
  const [deferred, setDeferred] = useState({});
  const [denial, setDenial] = useState(null);
  const [editReview, setEditReview] = useState(null);
  const [lookupReview, setLookupReview] = useState(null);
  const [activeTab, setActiveTab] = useState('pending');
  const [pendingDecisionKeys, setPendingDecisionKeys] = useState({});
  const pendingDecisionKeysRef = useRef(new Set());
  const [decisionError, setDecisionError] = useState('');
  const pending = (data?.pending || []).filter((item) => !deferred[`${item.brand}::${item.model}`]);

  const lookUp = async (item) => {
    const url = buildSamHeadsetResearchUrl(item);
    if (window.electronAPI?.openExternal) {
      await window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
    setLookupReview(item);
  };

  const buildDecisionPayload = (item, action, extra = {}) => ({
    action,
    brand: item.brand,
    model: item.model,
    review_id: item.review_id || '',
    submitted_date: item.submitted_date || '',
    tester: item.tester || '',
    ...(item.catalog_identity ? {
      catalog_identity: item.catalog_identity,
      catalog_row_number: item.catalog_row_number || 0,
    } : {}),
    ...extra,
  });

  const decide = async (item, action, extra = {}) => {
    const decisionKey = headsetRowIdentity(item, item.status || 'pending');
    if (pendingDecisionKeysRef.current.has(decisionKey)) return { ok: false, busy: true };
    pendingDecisionKeysRef.current.add(decisionKey);
    setPendingDecisionKeys((current) => ({ ...current, [decisionKey]: action }));
    setDecisionError('');
    try {
      const result = await onDecision(buildDecisionPayload(item, action, extra));
      if (!result?.ok) {
        setDecisionError(result?.error || 'The headset decision could not be saved.');
        return result;
      }
      setDeferred((current) => {
        const next = { ...current };
        delete next[`${item.brand}::${item.model}`];
        return next;
      });
      setDenial(null);
      setLookupReview(null);
      return result;
    } finally {
      pendingDecisionKeysRef.current.delete(decisionKey);
      setPendingDecisionKeys((current) => {
        const next = { ...current };
        delete next[decisionKey];
        return next;
      });
    }
  };

  const pendingDecisionAction = (item) => pendingDecisionKeys[headsetRowIdentity(item, item.status || 'pending')] || '';
  const isDecisionPending = (item) => Boolean(pendingDecisionAction(item));

  const saveEdit = async () => {
    if (!editReview) return;
    const brand = String(editReview.brand || '').trim().replace(/\s+/g, ' ');
    const model = String(editReview.model || '').trim().replace(/\s+/g, ' ');
    if (!brand && !model) {
      setDecisionError('Enter a headset brand or model.');
      return;
    }
    const result = await decide(editReview.item, 'edit', {
      brand,
      model,
      note: String(editReview.note || '').trim(),
    });
    if (result?.ok) setEditReview(null);
  };

  const reviewLater = async (item) => {
    const result = await onDecision(buildDecisionPayload(item, 'review_later'));
    if (result?.ok) {
      setDeferred((current) => ({ ...current, [`${item.brand}::${item.model}`]: true }));
      setLookupReview(null);
      onStatus('Headset left pending for later review.', 'info');
    }
  };

  const archiveReview = async (item) => {
    const confirmed = await onConfirm?.(
      `Archive headset review for ${item.brand} ${item.model}? This keeps the row as archived instead of removing it.`,
      { kind: 'warning', confirmLabel: 'Archive' },
    );
    if (!confirmed) return;
    await decide(item, 'archive');
  };

  const deleteReview = async (item) => {
    const confirmed = await onConfirm?.(
      `Delete headset review for ${item.brand} ${item.model}? Use Delete only for mistakes.`,
      { kind: 'danger', confirmLabel: 'Delete' },
    );
    if (!confirmed) return;
    await decide(item, 'delete');
  };

  const renderRows = (rows, kind) => (
    <div className="nm-table-wrap">
      <table className="nm-table nm-headset-table">
        <thead><tr><th>Brand</th><th>Model</th>{kind === 'pending' ? <><th>Submitted</th><th>Tester</th></> : <th>Status</th>}<th className="nm-headset-note-column">Note</th><th className="nm-actions-column">Actions</th></tr></thead>
        <tbody>
          {rows.map((item) => (
            <tr key={headsetRowIdentity(item, kind)} data-headset-row-id={headsetRowIdentity(item, kind)}>
              <td>{item.brand}</td><td>{item.model}</td>
              {kind === 'pending' ? <><td>{formatHeadsetSubmittedDate(item.submitted_date)}</td><td>{item.tester || 'N/A'}</td></> : <td><strong>{item.status || kind}</strong></td>}
              <td className="nm-headset-note-cell">{item.note || 'N/A'}</td>
              {kind === 'pending' ? (
                <td className="nm-actions-column"><div className="nm-row-actions">
                  <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" disabled={isDecisionPending(item)} onClick={() => lookUp(item)}>Research Headset</button>
                  <button type="button" className="nm-btn nm-btn-primary nm-btn-table" disabled={isDecisionPending(item)} onClick={() => decide(item, 'approve')}>{pendingDecisionAction(item) === 'approve' ? 'Saving...' : 'Approve'}</button>
                  <button type="button" className="nm-btn nm-btn-danger nm-btn-table" disabled={isDecisionPending(item)} onClick={() => setDenial({ item, reason: '', note: '' })}>Deny</button>
                  <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" disabled={isDecisionPending(item)} onClick={() => reviewLater(item)}>Review Later</button>
                  <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" disabled={isDecisionPending(item)} onClick={() => archiveReview(item)}>Archive</button>
                  <button type="button" className="nm-btn nm-btn-danger nm-btn-table" disabled={isDecisionPending(item)} onClick={() => deleteReview(item)}>Delete</button>
                </div></td>
              ) : kind === 'approved' ? (
                <td className="nm-actions-column"><div className="nm-row-actions">
                  <button type="button" className="nm-btn nm-btn-danger nm-btn-table" disabled={isDecisionPending(item)} onClick={() => setDenial({ item, reason: '', note: '' })}>Change to Denied</button>
                  <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" disabled={isDecisionPending(item)} onClick={() => archiveReview(item)}>Archive</button>
                  <button type="button" className="nm-btn nm-btn-danger nm-btn-table" disabled={isDecisionPending(item)} onClick={() => deleteReview(item)}>{pendingDecisionAction(item) === 'delete' ? 'Deleting...' : 'Delete'}</button>
                </div></td>
              ) : (
                <td className="nm-actions-column"><div className="nm-row-actions">
                  <button type="button" className="nm-btn nm-btn-primary nm-btn-table" disabled={isDecisionPending(item)} onClick={() => decide(item, 'approve')}>{pendingDecisionAction(item) === 'approve' ? 'Saving...' : 'Approve'}</button>
                  <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" disabled={isDecisionPending(item)} onClick={() => archiveReview(item)}>Archive</button>
                  <button type="button" className="nm-btn nm-btn-danger nm-btn-table" disabled={isDecisionPending(item)} onClick={() => deleteReview(item)}>{pendingDecisionAction(item) === 'delete' ? 'Deleting...' : 'Delete'}</button>
                </div></td>
              )}
            </tr>
          ))}
          {!rows.length ? <tr><td colSpan={kind === 'pending' ? 6 : 5}><div className="nm-empty">No {kind} headsets.</div></td></tr> : null}
        </tbody>
      </table>
    </div>
  );

  const renderPendingQueue = (rows) => (
    !rows.length ? (
      <div className="nm-empty nm-ticket-empty">
        <strong>No headsets waiting for review</strong>
        <span>New unknown headsets submitted by testers appear here as review tickets.</span>
        <button type="button" className="nm-btn nm-btn-secondary nm-btn-inline" onClick={onRefresh} disabled={loading}>Refresh queue</button>
      </div>
    ) : (
      <div className="nm-ticket-queue">
        {rows.map((item) => (
          <article className="nm-ticket" key={headsetRowIdentity(item, 'pending')}>
            <div className="nm-ticket-head">
              <div className="nm-ticket-id">
                <div className="nm-ticket-title">{getHeadsetReviewDisplayTitle(item)}</div>
                <div className="nm-ticket-sub">Awaiting review decision</div>
              </div>
              <span className="nm-badge nm-badge-warning">Pending</span>
            </div>
            <dl className="nm-ticket-fields">
              <div><dt>Brand</dt><dd>{item.brand || 'N/A'}</dd></div>
              <div><dt>Model</dt><dd>{item.model || 'N/A'}</dd></div>
              <div><dt>Submitted</dt><dd>{formatHeadsetSubmittedDate(item.submitted_date)}</dd></div>
              <div><dt>Tester</dt><dd>{item.tester || 'N/A'}</dd></div>
              <div><dt>Candidate</dt><dd>{item.candidate || 'N/A'}</dd></div>
              <div className="nm-ticket-note-field"><dt>Notes</dt><dd>{item.note || 'N/A'}</dd></div>
            </dl>
            <div className="nm-ticket-actions nm-row-actions">
              <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={() => lookUp(item)}>Look Up</button>
              <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" disabled={isDecisionPending(item)} onClick={() => setEditReview({ item, brand: item.brand || '', model: item.model || '', note: item.note || '' })}>Edit Headset</button>
              <button type="button" className="nm-btn nm-btn-primary nm-btn-table" disabled={isDecisionPending(item)} onClick={() => decide(item, 'approve')}>{isDecisionPending(item) ? 'Saving...' : 'Approve'}</button>
              <button type="button" className="nm-btn nm-btn-danger nm-btn-table" disabled={isDecisionPending(item)} onClick={() => setDenial({ item, reason: '', note: '' })}>Deny</button>
              <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={() => reviewLater(item)}>Review Later</button>
              <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={() => archiveReview(item)}>Archive</button>
              <button type="button" className="nm-btn nm-btn-danger nm-btn-table" onClick={() => deleteReview(item)}>Delete</button>
            </div>
          </article>
        ))}
      </div>
    )
  );

  return (
    <section className="nm-panel nm-headset-panel" id="sam-headset-review">
      <div className="nm-section-title">
        <div><h2>Headset Review</h2><div className="nm-kicker">Review unknown headsets and keep MTS approval and denial behavior synchronized.</div></div>
        <button type="button" className="nm-btn nm-btn-secondary" onClick={onRefresh} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
      </div>
      {!data?.ok && data?.error ? <div className="nm-status-card is-warning"><strong>Headset review unavailable</strong><span>{data.error}</span></div> : null}
      {decisionError ? <div className="nm-status-card is-warning"><strong>Action failed</strong><span>{decisionError}</span></div> : null}
      <div className="nm-view-tabs" role="tablist" aria-label="Headset review views">
        {[
          ['pending', `Pending Review (${pending.length})`],
          ['approved', `Approved Headsets (${(data?.approved || []).length})`],
          ['denied', `Denied Headsets (${(data?.denied || []).length})`],
        ].map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={activeTab === key} className={`nm-view-tab ${activeTab === key ? 'is-active' : ''}`} onClick={() => setActiveTab(key)}>{label}</button>
        ))}
      </div>
      {activeTab === 'pending' ? renderPendingQueue(pending) : null}
      {activeTab === 'approved' ? renderRows(data?.approved || [], 'approved') : null}
      {activeTab === 'denied' ? renderRows(data?.denied || [], 'denied') : null}
      {lookupReview ? (
        <div className="modal-overlay open">
          <div className="modal" style={{ width: 560, maxWidth: '92vw' }} role="dialog" aria-modal="true" aria-label="Headset lookup decision">
            <div className="modal-header"><h2>Review Headset</h2><button className="modal-close" onClick={() => setLookupReview(null)}>&times;</button></div>
            <div className="modal-body">
              <p>Use the search results to decide whether <strong>{lookupReview.brand} {lookupReview.model}</strong> meets both headset requirements.</p>
              <div className="nm-row-actions" style={{ marginTop: 18 }}>
                <button type="button" className="nm-btn nm-btn-primary" disabled={isDecisionPending(lookupReview)} onClick={() => decide(lookupReview, 'approve')}>{isDecisionPending(lookupReview) ? 'Saving...' : 'Approve Headset'}</button>
                <button type="button" className="nm-btn nm-btn-danger" onClick={() => { setDenial({ item: lookupReview, reason: '', note: '' }); setLookupReview(null); }}>Deny Headset</button>
                <button type="button" className="nm-btn nm-btn-secondary" onClick={() => reviewLater(lookupReview)}>Review Later</button>
                <button type="button" className="nm-btn nm-btn-secondary" onClick={() => setLookupReview(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {editReview ? (
        <div className="modal-overlay open">
          <div className="modal" style={{ width: 560, maxWidth: '92vw' }} role="dialog" aria-modal="true" aria-label="Edit headset information">
            <div className="modal-header"><h2>Edit Headset Information</h2><button className="modal-close" disabled={isDecisionPending(editReview.item)} onClick={() => setEditReview(null)}>&times;</button></div>
            <div className="modal-body nm-headset-edit-form">
              <label>Headset brand<input value={editReview.brand} onChange={(event) => setEditReview((current) => ({ ...current, brand: event.target.value }))} /></label>
              <label>Headset model<input value={editReview.model} onChange={(event) => setEditReview((current) => ({ ...current, model: event.target.value }))} /></label>
              <label>Notes<textarea rows={3} value={editReview.note} onChange={(event) => setEditReview((current) => ({ ...current, note: event.target.value }))} /></label>
              <div className="nm-headset-edit-preview"><span>Combined preview</span><strong>{buildHeadsetDisplayLabel(editReview.brand, editReview.model) || 'Enter a brand or model'}</strong></div>
              {decisionError ? <div className="nm-form-error">{decisionError}</div> : null}
              <div className="nm-row-actions">
                <button type="button" className="nm-btn nm-btn-secondary" disabled={isDecisionPending(editReview.item)} onClick={() => setEditReview(null)}>Cancel</button>
                <button type="button" className="nm-btn nm-btn-primary" disabled={isDecisionPending(editReview.item) || (!editReview.brand.trim() && !editReview.model.trim())} onClick={saveEdit}>{isDecisionPending(editReview.item) ? 'Saving...' : 'Save Headset'}</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {denial ? (
        <div className="modal-overlay open">
          <div className="modal" style={{ width: 560, maxWidth: '92vw' }}>
            <div className="modal-header"><h2>Deny Headset</h2><button className="modal-close" onClick={() => setDenial(null)}>&times;</button></div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <strong>{denial.item.brand} {denial.item.model}</strong>
              {HEADSET_DENIAL_REASONS.map((reason) => (
                <label key={reason} className="nm-checkbox"><input type="radio" name="headset-denial-reason" checked={denial.reason === reason} onChange={() => setDenial((current) => ({ ...current, reason }))} /> {reason}</label>
              ))}
              {denial.reason === 'Other' ? <textarea rows={3} value={denial.note} onChange={(event) => setDenial((current) => ({ ...current, note: event.target.value }))} placeholder="Denial note is required" /> : null}
              {decisionError ? <div className="nm-form-error">{decisionError}</div> : null}
              <div className="nm-row-actions">
                <button type="button" className="nm-btn nm-btn-secondary" disabled={isDecisionPending(denial.item)} onClick={() => setDenial(null)}>Cancel</button>
                <button type="button" className="nm-btn nm-btn-danger" disabled={isDecisionPending(denial.item) || !denial.reason || (denial.reason === 'Other' && !denial.note.trim())} onClick={() => decide(denial.item, 'deny', { reason: denial.reason, note: denial.note })}>{isDecisionPending(denial.item) ? 'Saving...' : 'Deny'}</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default function NotificationManagerApp() {
  const fileInputRef = useRef(null);
  const backendStartupRetryRef = useRef({ attempt: 0, timer: null });
  const retryBackendStartupRef = useRef(null);
  const startupUpdateCheckRef = useRef(false);
  const manualUpdateCheckRef = useRef(false);
  const headsetPendingNoticeShownRef = useRef(false);
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
    statusMessage: 'Connecting to live data...',
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
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [samBannerSrc, setSamBannerSrc] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('general');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorDraft, setEditorDraft] = useState(null);
  const [editorIndex, setEditorIndex] = useState(null);
  const [statusModal, setStatusModal] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);
  const confirmResolverRef = useRef(null);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const exitConfirmResolverRef = useRef(null);
  const requestExitConfirmation = useCallback(() => {
    if (exitConfirmResolverRef.current) {
      return new Promise((resolve) => {
        // If already pending, chain with existing resolver
        const prevResolver = exitConfirmResolverRef.current;
        exitConfirmResolverRef.current = (val) => {
          if (prevResolver) prevResolver(val);
          resolve(val);
        };
      });
    }
    return new Promise((resolve) => {
      exitConfirmResolverRef.current = resolve;
      setShowExitConfirm(true);
    });
  }, []);
  const resolveExitConfirm = useCallback((value) => {
    const resolver = exitConfirmResolverRef.current;
    exitConfirmResolverRef.current = null;
    setShowExitConfirm(false);
    if (resolver) resolver(value);
  }, []);
  useEffect(() => {
    if (!showExitConfirm) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        resolveExitConfirm(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [resolveExitConfirm, showExitConfirm]);
  const [tutorialStep, setTutorialStep] = useState(null);
  const [quickStartOpen, setQuickStartOpen] = useState(false);
  const [appVersion, setAppVersion] = useState(() => getAppVersion());
  const [updateModal, setUpdateModal] = useState(null);
  const [updaterStatus, setUpdaterStatus] = useState(null);
  const [activeSection, setActiveSection] = useState('notifications');
  const [samSettings, setSamSettings] = useState(() => loadSamSettings());
  const [candidateView, setCandidateView] = useState(() => loadSamSettings().defaultCandidateView);
  const [candidateSearch, setCandidateSearch] = useState('');
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [candidateTracking, setCandidateTracking] = useState({ ok: true, views: {}, candidates: [], pending: [], error: '' });
  const [candidateTrackingLoading, setCandidateTrackingLoading] = useState(false);
  const [headsetReviews, setHeadsetReviews] = useState({ ok: true, pending: [], approved: [], denied: [], error: '' });
  const [headsetReviewsLoading, setHeadsetReviewsLoading] = useState(false);
  const [pendingRequests, setPendingRequests] = useState({ ok: true, loaded: false, requests: [], headsetReviews: [], counts: {}, error: '', targeting: {} });
  const [pendingRequestsLoading, setPendingRequestsLoading] = useState(false);
  const [pendingRequestFilter, setPendingRequestFilter] = useState('pending');
  const [requestBellOpen, setRequestBellOpen] = useState(false);
  const [pendingRequestsRefreshCycle, setPendingRequestsRefreshCycle] = useState(0);
  const samSnapshotCoordinatorRef = useRef(null);
  const samSnapshotRequestSequenceRef = useRef(0);
  const latestSamSnapshotRequestRef = useRef(0);
  const headsetMutationGenerationRef = useRef(0);
  if (!samSnapshotCoordinatorRef.current) {
    samSnapshotCoordinatorRef.current = createSamSnapshotCoordinator(() => api.getSharedAdminSnapshot());
  }
  const [samSetupStatus, setSamSetupStatus] = useState({ loading: true, setupComplete: false, userName: '', userRole: '', ok: true, error: '' });
  const showStatusModal = useCallback((message, kind = 'info', title = '', actionLabel = 'OK') => {
    setStatusModal({ message, kind, title, actionLabel });
  }, []);
  const updateSamSettings = useCallback((nextSettings) => {
    const normalized = normalizeSamSettings(nextSettings);
    setSamSettings(normalized);
    if (normalized.defaultCandidateView !== samSettings.defaultCandidateView) {
      setCandidateView(normalized.defaultCandidateView);
    }
    localStorage.setItem(SAM_SETTINGS_KEY, JSON.stringify(normalized));
    api.saveSettings({
      require_newbie_shift_approval: normalized.requireNewbieShiftApproval,
      headset_notification_mode: normalized.headsetNotificationMode,
    }).catch((err) => {
      console.warn('Failed to persist admin settings to backend:', err);
    });
  }, [samSettings.defaultCandidateView]);

  useEffect(() => {
    let active = true;
    api.getSettings()
      .then((backendSettings) => {
        if (!active || !backendSettings) return;
        setSamSettings((current) => {
          const merged = normalizeSamSettings({
            ...current,
            requireNewbieShiftApproval: backendSettings.require_newbie_shift_approval,
            headsetNotificationMode: backendSettings.headset_notification_mode,
          });
          try {
            localStorage.setItem(SAM_SETTINGS_KEY, JSON.stringify(merged));
          } catch (_error) {}
          return merged;
        });
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  const dismissStatusBanner = useCallback(() => {
    setSheetState((current) => ({ ...current, statusKind: '', statusMessage: '' }));
  }, []);
  const playSamActionSound = useCallback((kind) => {
    if (samSettings.soundVolume === 'off') return;
    void playSound(kind === 'error' ? 'samError' : 'samSuccess');
  }, [samSettings.soundVolume]);
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
    setCandidateView(isCandidateArchived(candidate) ? 'archived' : 'allActive');
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
        setUpdateModal(result.updateInfo);
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

  const loadSamSnapshot = useCallback(async ({ silent = false, force = false, showPendingNotice = false } = {}) => {
    const requestSequence = ++samSnapshotRequestSequenceRef.current;
    latestSamSnapshotRequestRef.current = requestSequence;
    const headsetMutationGeneration = headsetMutationGenerationRef.current;
    if (!silent) {
      setCandidateTrackingLoading(true);
      setHeadsetReviewsLoading(true);
      setPendingRequestsLoading(true);
    }
    try {
      const snapshot = await samSnapshotCoordinatorRef.current.load({ force });
      if (requestSequence !== latestSamSnapshotRequestRef.current) return snapshot;
      const candidateNext = snapshot?.candidateTracking || {};
      const headsetNext = snapshot?.headsetReviews || {};
      const pendingNext = snapshot?.pendingRequests || {};
      setCandidateTracking((current) => ({
        ...current,
        ...candidateNext,
        error: candidateNext.ok === false ? SAM_CANDIDATE_TRACKING_TEMPORARY_MESSAGE : (candidateNext.error || ''),
      }));
      if (headsetMutationGeneration === headsetMutationGenerationRef.current) {
        setHeadsetReviews((current) => preserveEqualHeadsetReviewState(current, {
          ...headsetNext,
          error: headsetNext.ok === false ? SAM_HEADSET_REVIEW_TEMPORARY_MESSAGE : (headsetNext.error || ''),
        }));
      }
      setPendingRequests((current) => ({
        ...current,
        ...pendingNext,
        loaded: true,
        error: pendingNext.ok === false ? SAM_PENDING_REQUESTS_TEMPORARY_MESSAGE : (pendingNext.error || ''),
      }));
      if (pendingNext.ok !== false) setPendingRequestsRefreshCycle((cycle) => cycle + 1);
      if (showPendingNotice && (headsetNext.pending || []).length > 0 && !headsetPendingNoticeShownRef.current) {
        headsetPendingNoticeShownRef.current = true;
        setSheetState((current) => ({ ...current, statusKind: 'info', statusMessage: 'Headset review queue updated.' }));
      }
      if (snapshot?.ok === false) {
        const message = snapshot?.coordinatorError
          ? SAM_SHARED_DATA_OFFLINE_MESSAGE
          : snapshot?.stale
            ? SAM_SHARED_DATA_STALE_MESSAGE
            : SAM_SHARED_DATA_TEMPORARY_MESSAGE;
        setSheetState((current) => current.statusMessage === message
          ? current
          : { ...current, statusKind: 'warning', statusMessage: message });
      } else if (snapshot?.ok !== false) {
        setSheetState((current) => isSharedDataStatusMessage(current.statusMessage)
          ? { ...current, statusKind: 'success', statusMessage: '' }
          : current);
      }
      return snapshot;
    } catch (error) {
      if (requestSequence !== latestSamSnapshotRequestRef.current) return null;
      console.warn('[SAM] Shared snapshot request failed; user-facing details were sanitized.');
      setCandidateTracking((current) => ({ ...current, ok: false, error: SAM_CANDIDATE_TRACKING_TEMPORARY_MESSAGE }));
      setHeadsetReviews((current) => ({ ...current, ok: false, error: SAM_HEADSET_REVIEW_TEMPORARY_MESSAGE }));
      setPendingRequests((current) => ({ ...current, ok: false, loaded: true, error: SAM_PENDING_REQUESTS_TEMPORARY_MESSAGE }));
      setSheetState((current) => current.statusMessage === SAM_SHARED_DATA_TEMPORARY_MESSAGE
        ? current
        : { ...current, statusKind: 'warning', statusMessage: SAM_SHARED_DATA_TEMPORARY_MESSAGE });
      return null;
    } finally {
      if (requestSequence === latestSamSnapshotRequestRef.current) {
        setCandidateTrackingLoading(false);
        setHeadsetReviewsLoading(false);
        setPendingRequestsLoading(false);
      }
    }
  }, []);

  const loadCandidateTracking = useCallback(async ({ silent = false, force = !silent } = {}) => {
    const snapshot = await loadSamSnapshot({ silent, force });
    return snapshot?.candidateTracking || null;
  }, [loadSamSnapshot]);

  const loadHeadsetReviews = useCallback(async ({ silent = false, force = !silent, showPendingNotice = false } = {}) => {
    const snapshot = await loadSamSnapshot({ silent, force, showPendingNotice });
    return snapshot?.headsetReviews || null;
  }, [loadSamSnapshot]);

  const loadPendingRequests = useCallback(async ({ silent = false, force = !silent } = {}) => {
    const snapshot = await loadSamSnapshot({ silent, force });
    return snapshot?.pendingRequests || null;
  }, [loadSamSnapshot]);

  const runHeadsetDecision = useCallback(async (payload) => {
    try {
      const result = await api.updateHeadsetReview({
        ...payload,
        actor: samSetupStatus.userName || samSetupStatus.userRole || 'SAM',
      });
      if (!result?.ok) {
        const message = getSharedDataErrorMessage({ message: result?.error }, 'Unable to save the headset review decision.');
        setSheetState((current) => ({ ...current, statusKind: 'error', statusMessage: message }));
        playSamActionSound('error');
        showStatusModal(message, 'error');
        return result;
      }
      if (payload.catalog_identity && Number(result.changed_rows || 0) !== 1 && !result.skipped) {
        const message = 'The approved headset catalog did not confirm exactly one changed row.';
        setSheetState((current) => ({ ...current, statusKind: 'error', statusMessage: message }));
        playSamActionSound('error');
        showStatusModal(message, 'error');
        return { ...result, ok: false, error: message };
      }
      const reviewLater = payload.action === 'review_later';
      const message = payload.action === 'approve'
        ? 'Headset approved.'
        : payload.action === 'edit'
          ? (result.approved_match ? 'Headset information updated. This now matches an approved headset.' : 'Headset information updated.')
        : payload.action === 'deny'
          ? 'Headset denied.'
          : payload.action === 'archive'
            ? 'Headset review archived.'
            : payload.action === 'delete'
              ? 'Headset review deleted.'
              : 'Headset left pending for later review.';
      if (!reviewLater) {
        headsetMutationGenerationRef.current += 1;
        samSnapshotCoordinatorRef.current.invalidate?.();
        setHeadsetReviews((current) => applyHeadsetDecisionToState(current, payload, result));
      }
      setSheetState((current) => ({ ...current, statusKind: reviewLater ? 'info' : 'success', statusMessage: message }));
      if (!reviewLater) {
        playSamActionSound('success');
        showStatusModal(message, 'success');
        const refreshed = await loadSamSnapshot({ silent: true, force: true });
        if (!refreshed || refreshed?.headsetReviews?.ok === false) {
          const warning = 'The headset change was saved, but the list could not be refreshed. Use Refresh to confirm current data.';
          setSheetState((current) => ({ ...current, statusKind: 'warning', statusMessage: warning }));
          showStatusModal(warning, 'warning');
        }
      }
      return result;
    } catch (error) {
      const message = getSharedDataErrorMessage(error, 'Unable to save the headset review decision.');
      setSheetState((current) => ({ ...current, statusKind: 'error', statusMessage: message }));
      playSamActionSound('error');
      showStatusModal(message, 'error');
      return { ok: false, error: message };
    }
  }, [loadSamSnapshot, playSamActionSound, samSetupStatus.userName, samSetupStatus.userRole, showStatusModal]);

  const runPendingRequestDecision = useCallback(async (payload) => {
    try {
      const result = await api.updateSharedAdminPendingRequest(payload);
      if (!result?.ok) {
        const message = getSharedDataErrorMessage({ message: result?.error }, 'Pending request update failed.');
        setSheetState((current) => ({ ...current, statusKind: 'error', statusMessage: message }));
        playSamActionSound('error');
        showStatusModal(message, 'error');
        return result;
      }
      const message = payload.decision === 'approved' ? 'Request approved.' : 'Request denied.';
      setPendingRequests((current) => applyPendingRequestDecision(current, payload, result));
      setSheetState((current) => ({ ...current, statusKind: 'success', statusMessage: message }));
      playSamActionSound('success');
      showStatusModal(message, 'success');
      void loadSamSnapshot({ silent: true, force: true });
      return result;
    } catch (error) {
      const message = getSharedDataErrorMessage(error, 'Pending request update failed.');
      setSheetState((current) => ({ ...current, statusKind: 'error', statusMessage: message }));
      playSamActionSound('error');
      showStatusModal(message, 'error');
      return { ok: false, error: message };
    }
  }, [loadSamSnapshot, playSamActionSound, showStatusModal]);

  const runCandidateAction = useCallback(async (payload) => {
    try {
      const result = await api.updateSharedAdminCandidate(payload);
      if (!result?.ok) {
        const message = getCandidateUpdateErrorMessage(result);
        setSheetState((current) => ({ ...current, statusKind: 'error', statusMessage: message }));
        playSamActionSound('error');
        showStatusModal(message, 'error');
        return { ...result, ok: false, error: message };
      }
      const actionLabels = {
        grant_extra_attempt: 'An extra attempt was successfully granted. MTS will now allow this candidate to re-certify.',
        withdraw: 'The candidate was successfully marked as withdrawn. MTS will block this candidate from further attempts.',
        restore_withdrawal: 'The candidate was successfully restored. MTS will allow this candidate to certify again.',
        cancel_pending: 'The pending supervisor transfer was successfully cancelled.',
        delete_candidate_history: 'The candidate history was permanently deleted. The record has been removed from Candidate Tracking and MTS autocomplete.',
        archive_candidate: 'The candidate was successfully archived and moved to the Archived view.',
        mark_passed: 'The candidate was successfully marked as Passed Certification.',
        mark_failed: 'The candidate was successfully marked as Failed Certification.',
        mark_incomplete: 'The candidate was successfully marked as incomplete.',
        move_pending_sup_transfer: 'The candidate was successfully moved to Pending Sup Transfers.',
        remove_pending_sup_transfer: 'The candidate was successfully removed from Pending Sup Transfers and marked incomplete.',
        edit_candidate_information: 'The candidate information was updated successfully. Certification results, attempts, and workflow decisions were not changed.',
      };
      setSheetState((current) => ({
        ...current,
        statusKind: 'success',
        statusMessage: actionLabels[payload?.action] || 'Candidate tracking successfully updated.',
      }));
      playSamActionSound('success');
      showStatusModal(
        actionLabels[payload?.action] || 'Candidate tracking successfully updated.',
        'success',
        payload?.action === 'edit_candidate_information' ? 'Candidate Information Updated' : '',
        payload?.action === 'edit_candidate_information' ? 'Done' : 'OK',
      );
      if (payload?.action === 'edit_candidate_information') {
        setCandidateTracking((current) => applyCandidateInformationUpdate(current, payload));
      }
      void loadCandidateTracking({ silent: true, force: true });
      return result;
    } catch (error) {
      const responseData = error?.response?.data || {};
      const message = getCandidateUpdateErrorMessage({
        error_code: responseData.error_code || responseData.detail?.error_code,
        error: responseData.error || responseData.detail?.message,
      });
      setSheetState((current) => ({
        ...current,
        statusKind: 'error',
        statusMessage: message,
      }));
      playSamActionSound('error');
      showStatusModal(message, 'error');
      return { ok: false, error: message };
    }
  }, [loadCandidateTracking, playSamActionSound, showStatusModal]);

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
    localStorage.setItem(SAM_SETTINGS_KEY, JSON.stringify(samSettings));
    setSoundSettings({
      enable_sounds: samSettings.soundVolume !== 'off',
      sound_volume: samSettings.soundVolume,
    });
  }, [samSettings]);

  useEffect(() => {
    if (!sheetState.statusMessage) return undefined;
    const kind = sheetState.statusKind || 'info';
    if (kind === 'error' || kind === 'warning') return undefined;
    const duration = Math.max(5, Number(samSettings.statusBannerDurationSeconds) || 60) * 1000;
    const timer = window.setTimeout(() => {
      setSheetState((current) => {
        if (current.statusMessage !== sheetState.statusMessage || current.statusKind !== sheetState.statusKind) {
          return current;
        }
        return { ...current, statusKind: '', statusMessage: '' };
      });
    }, duration);
    return () => window.clearTimeout(timer);
  }, [samSettings.statusBannerDurationSeconds, sheetState.statusKind, sheetState.statusMessage]);

  useEffect(() => {
    if (!editorOpen) {
      document.body.classList.remove('nm-dialog-open');
      return undefined;
    }
    document.body.classList.add('nm-dialog-open');
    return () => document.body.classList.remove('nm-dialog-open');
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
    if (localStorage.getItem(SAM_QUICK_START_STATE_KEY) === 'seen') return undefined;
    const timer = window.setTimeout(() => {
      localStorage.setItem(SAM_QUICK_START_STATE_KEY, 'pending');
      setQuickStartOpen(true);
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
        if (type === 'app:confirm-quit') {
          const confirmed = await requestExitConfirmation();
          await window.electronAPI?.respondToQuitConfirmation?.(confirmed);
          return;
        }
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
        if (type === 'auth:deep-link' && payload?.url) {
          console.log('[SAM] Received recovery deep-link in main app handler');
          setSamSetupStatus((current) => ({
            ...current,
            loading: false,
            setupComplete: false,
            pendingDeepLinkUrl: payload.url,
          }));
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
  }, [handleCheckForUpdates, requestExitConfirmation]);

  useEffect(() => {
    if (!sheetState.backendReady || samSetupStatus.loading || !samSetupStatus.setupComplete) {
      return;
    }
    void runStartupUpdateCheck();
  }, [runStartupUpdateCheck, samSetupStatus.loading, samSetupStatus.setupComplete, sheetState.backendReady]);

  useEffect(() => {
    if (!sheetState.backendReady || samSetupStatus.loading || !samSetupStatus.setupComplete) return;
    void loadSamSnapshot({ silent: true, showPendingNotice: true });
  }, [loadSamSnapshot, samSetupStatus.loading, samSetupStatus.setupComplete, sheetState.backendReady]);

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

  const handleSamLogout = useCallback(async () => {
    try {
      const configRes = await api.getSamAuthConfig().catch(() => ({}));
      if (configRes?.supabase_url && configRes?.supabase_anon_key && samSetupStatus?.session?.access_token) {
        await signOutAuth(configRes.supabase_url, configRes.supabase_anon_key, samSetupStatus.session.access_token).catch(() => {});
      }
      if (window.electronAPI?.authSession?.clear) {
        await window.electronAPI.authSession.clear().catch(() => {});
      }
      await api.resetSamSetup().catch(() => {});
    } finally {
      setSamSetupStatus({
        loading: false,
        setupComplete: false,
        userName: '',
        userRole: '',
        userEmail: '',
        authUid: '',
        isOwner: false,
        session: null,
        ok: true,
        error: '',
      });
      setHelpOpen(false);
      setSettingsOpen(false);
    }
  }, [samSetupStatus?.session?.access_token]);

  const loadSamSetupStatus = useCallback(async () => {
    try {
      // 1. Check Electron safeStorage for persistent Supabase Auth session
      if (window.electronAPI?.authSession?.get) {
        const storedSession = await window.electronAPI.authSession.get().catch(() => null);
        if (storedSession?.user?.id) {
          const verify = await api.verifySamAuth(storedSession.user.id).catch(() => null);
          if (verify?.ok) {
            const nextStatus = {
              loading: false,
              setupComplete: true,
              userName: verify.display_name,
              userRole: verify.role,
              userEmail: storedSession.user.email || '',
              authUid: storedSession.user.id,
              isOwner: Boolean(verify.is_owner),
              session: storedSession,
              ok: true,
              error: '',
            };
            setSamSetupStatus(nextStatus);
            return nextStatus;
          } else if (verify && !verify.ok) {
            // Revoked or deactivated session
            await window.electronAPI.authSession.clear().catch(() => {});
            const nextStatus = {
              loading: false,
              setupComplete: false,
              userName: '',
              userRole: '',
              userEmail: '',
              authUid: '',
              isOwner: false,
              session: null,
              ok: false,
              error: verify.error || 'Your account access has changed. Please sign in again.',
            };
            setSamSetupStatus(nextStatus);
            return nextStatus;
          }
        }
      }

      // 2. Fall back to local SQLite/Sheets setup status
      const status = await api.getSamSetupStatus();
      const nextStatus = {
        loading: false,
        setupComplete: Boolean(status?.setupComplete),
        userName: status?.userName || '',
        userRole: status?.userRole || status?.role || '',
        userEmail: status?.email || '',
        authUid: '',
        isOwner: status?.role === 'owner',
        session: null,
        ok: status?.ok !== false,
        errorCode: status?.errorCode || '',
        error: status?.errorCode || status?.error ? getSamSetupErrorMessage(status) : '',
      };
      setSamSetupStatus(nextStatus);
      return nextStatus;
    } catch (error) {
      const message = getSamSetupErrorMessage(error);
      const nextStatus = { loading: false, setupComplete: false, userName: '', userRole: '', userEmail: '', authUid: '', isOwner: false, session: null, ok: false, errorCode: error?.response?.data?.errorCode || '', error: message };
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
        readError: response?.ok === false ? getSharedDataErrorMessage({ message: response?.error }, 'Unable to read the master sam-notifications tab.') : '',
        sheetId: response?.sheet?.sheetId || '',
        statusKind: response?.ok === false ? 'warning' : current.statusKind,
        statusMessage: response?.ok === false ? getSharedDataErrorMessage({ message: response?.error }, 'Unable to read the master sam-notifications tab.') : current.statusMessage,
      }));
      refreshDiagnostics();
    } catch (error) {
      const message = getSharedDataErrorMessage(error, 'Unable to read the master sam-notifications tab.');
      setSheetState((current) => ({
        ...current,
        isLoading: false,
        readError: message,
        statusKind: 'error',
        statusMessage: message,
      }));
    }
  }, [refreshDiagnostics]);

  useEffect(() => {
    if (!sheetState.backendReady || samSetupStatus.loading || !samSetupStatus.setupComplete) return undefined;
    const interval = window.setInterval(() => {
      if (sheetState.isSaving || editorOpen || confirmModal) {
        return;
      }
      void loadSheetItems({ silent: true });
      void loadSamSnapshot({ silent: true });
    }, SAM_AUTO_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [
    confirmModal,
    editorOpen,
    loadSamSnapshot,
    loadSheetItems,
    samSetupStatus.loading,
    samSetupStatus.setupComplete,
    sheetState.backendReady,
    sheetState.isSaving,
  ]);

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
        const message = result?.error || 'Unable to connect to live data right now. Please try again in a moment.';
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
      await loadCandidateTracking({ silent: true, startup: true });
    } catch (error) {
      const message = getSharedDataErrorMessage(error, 'Unable to connect to live data right now. Please try again in a moment.');
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
        await loadCandidateTracking({ silent: true, startup: true });
      } catch (error) {
        if (cancelled) return;
        const elapsed = Date.now() - startedAt;
        const timedOut = elapsed >= BACKEND_READY_TIMEOUT_MS;
        const message = timedOut
          ? getSharedDataErrorMessage(error, 'Live content is still unavailable. We will keep retrying in the background.')
          : 'Connecting to live data...';
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
        playSamActionSound('error');
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
      playSamActionSound('success');
      showStatusModal(successMessage || 'Notification saved. MTS should update within about a minute.', 'success');
      return savedItem;
    } catch (error) {
      const message = getSharedDataErrorMessage(error, 'Unable to submit the notification to Google Sheets.');
      setSheetState((current) => ({
        ...current,
        isSaving: false,
        statusKind: 'error',
        statusMessage: message,
      }));
      playSamActionSound('error');
      showStatusModal(message, 'error');
      return null;
    }
  }, [editorIndex, loadSheetItems, playSamActionSound, showStatusModal]);

  const updateSelected = (patch) => {
    setEditorDraft((currentDraft) => {
      if (!currentDraft) return currentDraft;
      const next = normalizeManagerNotification({
        ...currentDraft,
        ...patch,
        UpdatedAt: new Date().toISOString(),
      });

      if (patch.EndDate === '') {
        next.EndDate = '';
        next.EndTime = '';
      }

      return next;
    });
  };

  const handleAdd = () => {
    const defaults = getEasternNowDefaults();
    const next = normalizeManagerNotification({
      ...createEmptyNotification(),
      ID: createNotificationId(),
      StartDate: defaults.startDate,
      StartTime: defaults.startTime,
      CreatedAt: new Date().toISOString(),
      UpdatedAt: new Date().toISOString(),
    });
    setEditorDraft(next);
    setEditorIndex(null);
    setEditorOpen(true);
  };

  const handleDuplicate = (index = selectedIndex) => {
    const source = Number.isInteger(index) && items[index] ? items[index] : selectedItem;
    if (!source) return;
    const duplicate = normalizeManagerNotification({
      ...source,
      ID: createNotificationId(),
      Title: source.Title ? `${source.Title} Copy` : '',
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
        playSamActionSound('error');
        showStatusModal(message, 'error');
        return;
      }
    } catch (error) {
      const message = getSharedDataErrorMessage(error, 'Unable to delete the notification from Google Sheets.');
      setSheetState((current) => ({
        ...current,
        isSaving: false,
        statusKind: 'error',
        statusMessage: message,
      }));
      playSamActionSound('error');
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
    playSamActionSound('success');
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
    setSheetState((current) => ({
      ...current,
      statusKind: 'success',
      statusMessage: 'Notification backup CSV exported.',
    }));
    playSamActionSound('success');
  };

  const openSection = (item) => {
    if (item.key === 'help') {
      setHelpOpen(true);
      return;
    }
    if (item.key === 'settings') {
      setSettingsInitialTab('general');
      setSettingsOpen(true);
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
  const replayQuickStart = () => {
    setHelpOpen(false);
    setTutorialStep(null);
    setQuickStartOpen(true);
  };

  const handleSubmit = async () => {
    if (!editorDraft) return;
    if (sheetState.isSaving) return;
    if (editorValidation.errors.length > 0) {
      setSheetState((current) => ({
        ...current,
        statusKind: 'error',
        statusMessage: editorValidation.errors[0],
      }));
      playSamActionSound('error');
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
      setSheetState((current) => ({
        ...current,
        statusKind: 'success',
        statusMessage: `Imported ${parsed.length} notification row${parsed.length === 1 ? '' : 's'} from CSV.`,
      }));
      playSamActionSound('success');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to import the selected CSV.';
      setImportError(message);
      setSheetState((current) => ({
        ...current,
        statusKind: 'error',
        statusMessage: message,
      }));
      playSamActionSound('error');
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
    samSetupStatus.userName ? `Operator: ${samSetupStatus.userName}` : null,
    `Status: ${sheetState.backendStatus === 'connected' ? 'Online' : 'Offline'}`
  ].filter(Boolean);

  // ----- Operations Center derived metrics -----
  const isOnline = sheetState.backendStatus === 'connected';
  const isConnecting = sheetState.backendStatus === 'initializing' || sheetState.backendStatus === 'retrying' || sheetState.isLoading;
  const activeNotificationCount = items.filter(isCurrentNotification).length;
  const enabledCount = items.filter((item) => item.Enabled).length;
  const pendingHeadsetCount = Array.isArray(headsetReviews?.pending) ? headsetReviews.pending.length : 0;
  const pendingRequestCounts = pendingRequests?.counts || {};
  const pendingWorkflowRequestCount = Number(
    pendingRequestCounts.workflowRequests
      ?? ((pendingRequestCounts.newbieInitial || 0) + (pendingRequestCounts.reschedules || 0) + (pendingRequestCounts.candidateDeletions || 0))
  );
  const combinedActionableCount = pendingWorkflowRequestCount + pendingHeadsetCount;
  const pendingCandidateCount = Array.isArray(candidateTracking?.views?.pending)
    ? candidateTracking.views.pending.length
    : (Array.isArray(candidateTracking?.pending) ? candidateTracking.pending.length : 0);
  const syncTone = isOnline ? 'ok' : (isConnecting ? 'pending' : 'warn');
  const syncLabel = isOnline ? 'Live' : (isConnecting ? 'Connecting' : 'Offline');
  const syncSub = isOnline
    ? 'Connected to sheet'
    : (isConnecting ? 'Reaching data source' : 'Working from local draft');
  const lastSyncLabel = formatRelativeSyncTime(lastSyncAt);
  const operatorName = samSetupStatus.userName || samSetupStatus.userRole || '';

  useEffect(() => {
    if (sheetState.backendStatus === 'connected' && !sheetState.isLoading && !sheetState.readError) {
      setLastSyncAt(Date.now());
    }
    // Track last successful sync whenever a fresh, error-free load completes.
  }, [sheetState.backendStatus, sheetState.isLoading, sheetState.readError, items.length]);

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
    localStorage.setItem(SAM_QUICK_START_STATE_KEY, 'pending');
    setQuickStartOpen(true);
    setSheetState((current) => ({
      ...current,
      backendReady: true,
      backendStatus: 'connected',
      statusKind: 'success',
      statusMessage: `SAM setup complete${nextStatus.userName ? ` for ${nextStatus.userName}` : ''}.`,
      readError: '',
    }));
    playSamActionSound('success');
    await loadSheetItems({ silent: false });
    await loadCandidateTracking({ silent: true, startup: true });
    await loadPendingRequests({ silent: true });
  };

  const isWizardActive = sheetState.backendReady && !samSetupStatus.loading && !samSetupStatus.setupComplete;

  return (
    <div className="nm-app">
      {isWizardActive ? (
        <SamSetupWizard status={samSetupStatus} onComplete={handleSamSetupComplete} />
      ) : (
        <>
          <div className="nm-shell">
            {/* ===== Operations Center topbar ===== */}
            <header className="nm-ops-topbar">
          <div className="nm-ops-brand">
            <div className="nm-ops-mark" aria-hidden="true">
              {samBannerSrc ? <img src={samBannerSrc} alt="" /> : <span>SAM</span>}
            </div>
            <div className="nm-ops-brand-text">
              <div className="nm-overline">{SAM_SUBTITLE}</div>
              <h1 className="nm-ops-title">Operations Center</h1>
              <p className="nm-ops-tagline">Manage alerts, headset reviews, and candidate tracking.</p>
            </div>
          </div>
          <div className="nm-ops-topbar-actions" data-sam-tour="help-access">
            <span className={`nm-ops-conn is-${syncTone}`}>
              {isOnline ? <Wifi size={14} aria-hidden="true" /> : <WifiOff size={14} aria-hidden="true" />}
              {syncLabel}
            </span>
            <button type="button" className="nm-btn nm-btn-primary nm-ops-primary" onClick={handleAdd} data-sam-tour="add-notification">
              <Plus size={16} aria-hidden="true" /> Add Notification
            </button>
            <div className="nm-request-bell-wrap">
              <button
                type="button"
                className={`nm-ops-icon-btn nm-request-bell ${combinedActionableCount ? 'has-attention' : ''}`}
                onClick={() => setRequestBellOpen((open) => !open)}
                title="Pending request summary"
                aria-label={`Pending request summary: ${combinedActionableCount} unresolved actionable items`}
                aria-expanded={requestBellOpen}
              >
                <Bell size={18} aria-hidden="true" />
                {combinedActionableCount ? <span className="nm-request-bell-badge">{combinedActionableCount}</span> : null}
              </button>
              {requestBellOpen ? (
                <div className="nm-request-popover" role="dialog" aria-label="Pending request category summary">
                  {[
                    ['Workflow Requests', pendingWorkflowRequestCount, 'pending'],
                    ['Headset Reviews', pendingHeadsetCount, 'headsets'],
                  ].map(([label, count, targetFilter]) => (
                    <button
                      key={label}
                      type="button"
                      className="nm-request-popover-row"
                      onClick={() => {
                        setPendingRequestFilter(targetFilter);
                        setActiveSection('requests');
                        setRequestBellOpen(false);
                      }}
                    >
                      <span>{label}</span>
                      <strong>{count}</strong>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="nm-ops-icon-btn"
              onClick={loadSheetItems}
              disabled={sheetState.isLoading || sheetState.isSaving}
              title="Refresh from sheet"
              aria-label="Refresh from sheet"
            >
              <RefreshCw size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="nm-ops-icon-btn nm-ops-settings-btn"
              onClick={() => {
                setSettingsInitialTab('general');
                setSettingsOpen(true);
              }}
              title="Settings"
              aria-label="Settings"
            >
              <SettingsIcon size={18} aria-hidden="true" />
              <span>Settings</span>
            </button>
            <button
              type="button"
              className="nm-ops-icon-btn"
              onClick={() => setHelpOpen(true)}
              title="Help"
              aria-label="Help and settings"
            >
              <HelpCircle size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="nm-btn nm-ops-exit"
              onClick={handleExitApp}
              aria-label="Exit Smart Alert Manager"
            >
              <LogOut size={16} aria-hidden="true" /> Exit
            </button>
          </div>
        </header>

        {/* ===== Metrics strip ===== */}
        <section className="nm-ops-metrics" aria-label="Operations overview" data-sam-tour="status-chips">
          <div className={`nm-metric nm-metric-status is-${syncTone}`}>
            <div className="nm-metric-icon"><Activity size={20} aria-hidden="true" /></div>
            <div className="nm-metric-body">
              <div className="nm-metric-label">Sync Status</div>
              <div className="nm-metric-value">{syncLabel}</div>
              <div className="nm-metric-sub">{syncSub} · Last sync: {lastSyncLabel}</div>
            </div>
          </div>
          <button type="button" className="nm-metric nm-metric-btn" onClick={() => setActiveSection('notifications')}>
            <div className="nm-metric-icon"><Bell size={20} aria-hidden="true" /></div>
            <div className="nm-metric-body">
              <div className="nm-metric-label">Active Notifications</div>
              <div className="nm-metric-value">{activeNotificationCount}</div>
              <div className="nm-metric-sub">{enabledCount} enabled · {items.length} total</div>
            </div>
          </button>
          <button type="button" className={`nm-metric nm-metric-btn ${pendingHeadsetCount ? 'has-attention' : ''}`} onClick={() => setActiveSection('headsets')} data-testid="sam-headset-review-button">
            <div className="nm-metric-icon"><Headphones size={20} aria-hidden="true" /></div>
            <div className="nm-metric-body">
              <div className="nm-metric-label">Pending Headsets</div>
              <div className="nm-metric-value">{pendingHeadsetCount}</div>
              <div className="nm-metric-sub">{pendingHeadsetCount} awaiting review</div>
            </div>
          </button>
          <button type="button" className={`nm-metric nm-metric-btn ${pendingCandidateCount ? 'has-attention' : ''}`} onClick={() => { setActiveSection('candidates'); setCandidateView('pending'); }}>
            <div className="nm-metric-icon"><Users size={20} aria-hidden="true" /></div>
            <div className="nm-metric-body">
              <div className="nm-metric-label">Pending Candidates</div>
              <div className="nm-metric-value">{pendingCandidateCount}</div>
              <div className="nm-metric-sub">{pendingCandidateCount ? 'Sup transfers due' : 'Nothing pending'}</div>
            </div>
          </button>
          <button type="button" className="nm-metric nm-metric-btn nm-metric-action" onClick={handleAdd}>
            <div className="nm-metric-icon"><Plus size={20} aria-hidden="true" /></div>
            <div className="nm-metric-body">
              <div className="nm-metric-label">Add Notification</div>
              <div className="nm-metric-value nm-metric-value-sm">Create</div>
              <div className="nm-metric-sub">Start a new alert</div>
            </div>
          </button>
          <button type="button" className={`nm-metric nm-metric-btn ${pendingWorkflowRequestCount ? 'has-attention' : ''}`} onClick={() => { setActiveSection('requests'); setPendingRequestFilter('pending'); }}>
            <div className="nm-metric-icon"><Inbox size={20} aria-hidden="true" /></div>
            <div className="nm-metric-body">
              <div className="nm-metric-label">Pending Requests</div>
              <div className="nm-metric-value">{pendingWorkflowRequestCount}</div>
              <div className="nm-metric-sub">{pendingWorkflowRequestCount} workflow request{pendingWorkflowRequestCount === 1 ? '' : 's'}</div>
            </div>
          </button>
        </section>

        {/* ===== Quick actions (grouped) ===== */}
        <section className="nm-ops-quick" aria-label="Quick actions">
          <div className="nm-ops-quick-group">
            <span className="nm-ops-quick-label">Data</span>
            <div className="nm-ops-quick-buttons">
              <button type="button" className="nm-ops-action" onClick={loadSheetItems} disabled={sheetState.isLoading || sheetState.isSaving}>
                <RefreshCw size={15} aria-hidden="true" /> Refresh
              </button>
              <button type="button" className="nm-ops-action" onClick={handleExport}>
                <Download size={15} aria-hidden="true" /> Export CSV
              </button>
            </div>
          </div>
          <div className="nm-ops-quick-group">
            <span className="nm-ops-quick-label">Workflow</span>
            <div className="nm-ops-quick-buttons">
              <button type="button" className="nm-ops-action" onClick={handleAdd}>
                <Plus size={15} aria-hidden="true" /> Add Notification
              </button>
              <button type="button" className="nm-ops-action" onClick={() => setSearchModalOpen(true)} data-sam-tour="candidate-search-btn">
                <Search size={15} aria-hidden="true" /> Candidate Search
              </button>
              <button type="button" className="nm-ops-action" onClick={() => { setActiveSection('requests'); setPendingRequestFilter('pending'); }}>
                <Inbox size={15} aria-hidden="true" /> Pending Requests
              </button>
            </div>
          </div>
          <div className="nm-ops-quick-group">
            <span className="nm-ops-quick-label">System</span>
            <div className="nm-ops-quick-buttons">
              <button type="button" className="nm-ops-action" onClick={handleCheckForUpdates}>
                <DownloadCloud size={15} aria-hidden="true" /> Check for Updates
              </button>
            </div>
          </div>
        </section>

        {/* ===== Section tabs ===== */}
        <nav className="nm-ops-tabs" role="tablist" aria-label="SAM sections">
          {SECTION_NAV_ITEMS.filter((item) => item.key !== 'help').map((item) => {
            const isActive = item.key === 'candidates'
              ? (activeSection === 'candidates' && item.candidateView === candidateView)
              : (activeSection === item.key);
            const badge = item.target === 'sam-headset-review'
              ? pendingHeadsetCount
              : item.target === 'sam-pending-requests'
                ? pendingWorkflowRequestCount
                : (item.candidateView === 'pending' ? pendingCandidateCount : 0);
            return (
              <button
                key={`${item.target}-${item.label}`}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`nm-ops-tab is-${item.tone || 'default'} ${isActive ? 'is-active' : ''}`}
                onClick={() => openSection(item)}
                data-sam-tour={item.target === 'sam-candidate-tracking' && item.candidateView === 'allActive' ? 'candidate-tracking-btn' : undefined}
              >
                {item.label}
                {badge ? <span className="nm-ops-tab-badge">{badge}</span> : null}
              </button>
            );
          })}
        </nav>

        <PendingRequestAlert
          requests={pendingRequests.requests || []}
          requestsAvailable={pendingRequests.loaded === true && pendingRequests.ok !== false}
          refreshCycle={pendingRequestsRefreshCycle}
          headsetReviews={headsetReviews.pending || []}
          headsetReviewsAvailable={headsetReviews.ok !== false}
          headsetNotificationMode={samSettings.headsetNotificationMode}
          onViewHeadsets={() => setActiveSection('headsets')}
          onAlertSound={() => playSamActionSound('error')}
          onView={(request) => {
            setActiveSection('requests');
            setPendingRequestFilter(request.category === 'newbie_reschedule'
              ? 'reschedules'
              : request.category === 'candidate_deletion'
                ? 'deletions'
                : request.category === 'candidate_correction'
                  ? 'corrections'
                : 'newbie');
          }}
        />

        {sheetState.statusMessage ? (
          <section className={`nm-status-card is-${sheetState.statusKind || 'info'}`}>
            <div className="nm-status-card-main">
              <strong>{sheetState.statusKind === 'success' ? 'Success' : sheetState.statusKind === 'warning' ? 'Warning' : sheetState.statusKind === 'error' ? 'Status' : 'Starting'}</strong>
              <span>{sheetState.statusMessage}</span>
            </div>
            <button type="button" className="nm-status-dismiss" onClick={dismissStatusBanner} aria-label="Dismiss status message">×</button>
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
            <div className="nm-note-cards" role="list">
              {visibleItems.map(({ item: normalized, index }) => {
                const statusTone = getRowStatusTone(normalized);
                return (
                  <article
                    role="listitem"
                    key={`${normalized.ID || 'new'}-${index}`}
                    className={`nm-note-card ${index === selectedIndex ? 'is-selected' : ''}`}
                  >
                    <button
                      type="button"
                      className="nm-note-card-main"
                      onClick={() => selectNotification(index)}
                      aria-pressed={index === selectedIndex}
                    >
                      <div className="nm-note-card-head">
                        <span className={getBadgeClass(normalized.Type)}>{normalized.Type}</span>
                        <span className={`nm-note-status is-${statusTone}`}>{getRowStatusLabel(normalized)}</span>
                      </div>
                      <div className="nm-note-title">{normalized.Title || '(Untitled notification)'}</div>
                      <div className="nm-note-preview">{normalized.Message || 'No message yet.'}</div>
                      <div className="nm-note-meta">
                        <span className="nm-note-meta-chip">
                          <Clock size={13} aria-hidden="true" />
                          {normalized.StartDate ? `${normalized.StartDate} ${normalized.StartTime || ''}`.trim() : 'Starts immediately'}
                        </span>
                        <span className="nm-note-meta-chip">
                          {normalized.EndDate ? `Expires ${normalized.EndDate} ${normalized.EndTime || '12:00 AM'}` : 'No auto-expiration'}
                        </span>
                        <span className="nm-note-meta-flags">{formatFlags(normalized)}</span>
                      </div>
                    </button>
                    <div className="nm-note-card-actions">
                      <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={() => openEditor(index)}>Edit</button>
                      <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={() => handleDuplicate(index)}>Duplicate</button>
                      <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={() => handleToggleEnabled(index)}>
                        {normalized.Enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button type="button" className="nm-btn nm-btn-danger nm-btn-table" onClick={() => handleDeleteIndex(index)}>Delete</button>
                    </div>
                  </article>
                );
              })}
              {!visibleItems.length ? (
                <div className="nm-empty nm-empty-state">
                  <div className="nm-empty-icon" aria-hidden="true"><Inbox size={30} /></div>
                  <div className="nm-empty-title">
                    {sheetState.isLoading ? 'Loading notifications…' : 'No notifications here'}
                  </div>
                  <div className="nm-empty-text">
                    {sheetState.isLoading
                      ? 'Fetching the latest rows from the data source.'
                      : notificationView === 'active'
                        ? 'There are no current notifications. Create one to alert testers.'
                        : 'Nothing matches this view yet.'}
                  </div>
                  {!sheetState.isLoading ? (
                    <button type="button" className="nm-btn nm-btn-primary nm-ops-primary" onClick={handleAdd}>
                      <Plus size={16} aria-hidden="true" /> Add Notification
                    </button>
                  ) : null}
                </div>
              ) : null}
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
            includeArchivedDefault={samSettings.includeArchivedInSearchDefault}
            showStatusModal={showStatusModal}
          />
        ) : null}
        {activeSection === 'headsets' ? (
      <HeadsetReviewPanel
            data={headsetReviews}
            loading={headsetReviewsLoading}
            onRefresh={() => loadHeadsetReviews()}
            onDecision={runHeadsetDecision}
            onConfirm={requestConfirm}
            onStatus={(message, kind = 'info') => setSheetState((current) => ({ ...current, statusKind: kind, statusMessage: message }))}
          />
        ) : null}
        {activeSection === 'requests' ? (
          <PendingRequestsPanel
            data={pendingRequests}
            filter={pendingRequestFilter}
            onFilterChange={setPendingRequestFilter}
            loading={pendingRequestsLoading}
            onRefresh={() => loadPendingRequests()}
            onDecision={runPendingRequestDecision}
            onOpenHeadsets={() => setActiveSection('headsets')}
            actor={samSetupStatus.userName || samSetupStatus.userRole || 'SAM'}
          />
        ) : null}

        {/* ===== System health / diagnostics (relocated developer detail) ===== */}
        <section className="nm-ops-diagnostics">
          <button
            type="button"
            className="nm-ops-diag-toggle"
            aria-expanded={diagnosticsOpen}
            onClick={() => setDiagnosticsOpen((open) => !open)}
          >
            <span className="nm-ops-diag-title">
              <span className={`nm-ops-diag-dot is-${syncTone}`} aria-hidden="true" />
              System Health &amp; Diagnostics
            </span>
            <span className="nm-ops-diag-summary">{syncLabel} · {lastSyncLabel}</span>
            <ChevronDown size={16} aria-hidden="true" className={`nm-ops-diag-chevron ${diagnosticsOpen ? 'is-open' : ''}`} />
          </button>
          {diagnosticsOpen ? (
            <div className="nm-ops-diag-body">
              {infoTiles.map((tile) => (
                <div key={tile} className="nm-ops-diag-item">{tile}</div>
              ))}
              {sheetState.tickerSource ? (
                <div className="nm-ops-diag-item">Ticker source: {sheetState.tickerSource}</div>
              ) : null}
              <div className="nm-ops-diag-item">App version {appVersion}</div>
            </div>
          ) : null}
        </section>
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
      {settingsOpen ? (
        <SettingsModal
          initialTab={settingsInitialTab}
          version={appVersion}
          settings={samSettings}
          samSetupStatus={samSetupStatus}
          onLogout={handleSamLogout}
          onSettingsChange={updateSamSettings}
          onCheckForUpdates={handleCheckForUpdates}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {helpOpen ? (
        <HelpModal
          version={appVersion}
          onOpenSettings={(tab = 'general') => {
            setHelpOpen(false);
            setSettingsInitialTab(tab);
            setSettingsOpen(true);
          }}
          onClose={() => {
            localStorage.setItem(SAM_HELP_DISMISSED_KEY, '1');
            setHelpOpen(false);
          }}
          onReplayTutorial={replayTutorial}
          onReplayQuickStart={replayQuickStart}
        />
      ) : null}
      {quickStartOpen ? (
        <PostSetupQuickStart
          app="sam"
          onWatch={() => {
            localStorage.setItem(SAM_QUICK_START_STATE_KEY, 'seen');
            setQuickStartOpen(false);
            replayTutorial();
          }}
          onGuide={() => {
            localStorage.setItem(SAM_QUICK_START_STATE_KEY, 'seen');
            setQuickStartOpen(false);
            setHelpOpen(true);
          }}
          onContinue={() => {
            localStorage.setItem(SAM_QUICK_START_STATE_KEY, 'seen');
            localStorage.setItem(SAM_ONBOARDING_STATE_KEY, 'seen');
            setQuickStartOpen(false);
            setActiveSection('notifications');
          }}
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
        </>
      )}
      <CandidateSearchModal
        open={searchModalOpen}
        data={candidateTracking}
        onClose={() => setSearchModalOpen(false)}
        onViewInTracking={handleViewInTracking}
        includeArchivedDefault={samSettings.includeArchivedInSearchDefault}
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
        title={statusModal?.title || ''}
        actionLabel={statusModal?.actionLabel || 'OK'}
        onClose={() => setStatusModal(null)}
      />
      <ConfirmModal
        state={confirmModal}
        onConfirm={(value) => resolveConfirm(value)}
        onCancel={() => resolveConfirm(false)}
      />
      {showExitConfirm && (
        <div className="sam-exit-backdrop">
          <section className="sam-exit-modal" role="dialog" aria-modal="true">
            <div className="sam-exit-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </div>
            <h2 className="sam-exit-title">Exit Smart Alert Manager</h2>
            <p className="sam-exit-body">Are you sure you want to exit Smart Alert Manager?</p>
            <div className="sam-exit-buttons">
              <button
                type="button"
                className="nm-btn nm-btn-secondary"
                onClick={() => resolveExitConfirm(false)}
              >
                No
              </button>
              <button
                type="button"
                className="nm-btn nm-btn-danger"
                style={{ backgroundColor: '#ef4444', borderColor: '#ef4444' }}
                onClick={() => resolveExitConfirm(true)}
              >
                Yes
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function CandidateSearchModal({ open, data, onClose, onViewInTracking, includeArchivedDefault }) {
  const [search, setSearch] = useState('');
  const [includeArchived, setIncludeArchived] = useState(Boolean(includeArchivedDefault));

  useEffect(() => {
    setIncludeArchived(Boolean(includeArchivedDefault));
  }, [includeArchivedDefault, open]);

  if (!open) return null;

  const candidates = data?.candidates || [];
  const searchText = search.trim().toLowerCase();
  const visible = searchText
    ? candidates.filter(c => (includeArchived || !isCandidateArchived(c)) && String(c.candidate_name || '').toLowerCase().includes(searchText))
    : [];

  return (
    <div className="modal-overlay open">
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
            <label className="nm-checkbox nm-search-toggle">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(event) => setIncludeArchived(event.target.checked)}
              />
              Include archived candidates
            </label>
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
                      {isCandidateArchived(c) ? <span className="nm-archive-badge">Archived</span> : null}
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
