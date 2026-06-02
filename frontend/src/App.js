import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import '@/App.css';
import api from './api';
import { ModalProvider, useModal } from './components/ModalProvider';
import NotificationBanner from './components/NotificationBanner';
import HomePage from './pages/HomePage';
import SetupPage from './pages/SetupPage';
import BasicsPage from './pages/BasicsPage';
import CallsPage from './pages/CallsPage';
import SupTransferPage from './pages/SupTransferPage';
import NewbieShiftPage from './pages/NewbieShiftPage';
import ReviewPage from './pages/ReviewPage';
import HistoryPage from './pages/HistoryPage';
import SettingsPage from './pages/SettingsPage';
import HelpPage from './pages/HelpPage';
import { setSoundsEnabled, unlockSounds } from './utils/sound';
import {
  DEFAULT_NOTIFICATION_GROUPS,
  resolveTickerDurationSeconds,
} from './utils/notifications';
import {
  BookOpenCheck,
  ClipboardList,
  CircleHelp,
  FileCheck2,
  History,
  Home,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  PhoneCall,
  Power,
  RefreshCw,
  Settings,
  Table2,
} from 'lucide-react';
import mtsLogo from './assets/images/MTSLogonew.png';
import updateGraphic from './assets/images/update.png';
import TutorialPreviewOverlay from "./tutorial/TutorialPreviewOverlay";

const LOGO_SRC = mtsLogo;
const APP_VERSION_FALLBACK = '1.0.1';
const INITIAL_SETTINGS_RETRY_DELAY_MS = 180;
const INITIAL_SETTINGS_MAX_RETRIES = 12;
const SIDEBAR_COLLAPSED_KEY = 'mts-sidebar-collapsed';
const TUTORIAL_STATUS_KEY = 'mts-tutorial-status';
const TUTORIAL_AFTER_SETUP_KEY = 'mts-start-tutorial-after-setup';
const DISMISSED_NOTIFICATION_POPUPS_KEY = 'mts-dismissed-notification-popups';
const DISMISSED_NOTIFICATION_BANNERS_KEY = 'mts-dismissed-notification-banners';
const TICKER_REFRESH_INTERVAL_MS = 30000;
const STARTUP_RECOVERY_RETRY_MS = 7000;

function emptyDefaults() {
  return { approved_headsets: [], discord_templates: [], discord_screenshots: [] };
}

function summarizePayload(data) {
  if (Array.isArray(data)) {
    return { type: 'array', length: data.length };
  }
  if (!data || typeof data !== 'object') {
    return { type: typeof data };
  }
  return Object.fromEntries(
    Object.entries(data)
      .filter(([key]) => !/token|secret|password|key/i.test(key))
      .slice(0, 10)
      .map(([key, value]) => [
        key,
        Array.isArray(value) ? `array(${value.length})` : typeof value,
      ])
  );
}

function logTimedRequest(name, event, startedAt, detail = {}) {
  const duration = typeof startedAt === 'number' ? Date.now() - startedAt : 0;
  console.log(`[STARTUP] ${name} ${event} (${duration}ms)`, detail);
}

const NAV_ITEMS = [
  { key: 'home', label: 'Home', icon: Home },
  { key: 'basics', label: 'The Basics', icon: BookOpenCheck },
  { key: 'calls', label: 'Calls', icon: PhoneCall },
  { key: 'suptransfer', label: 'Sup Transfer', icon: RefreshCw },
  { key: 'review', label: 'Review', icon: FileCheck2 },
  { key: 'history', label: 'History', icon: History },
  { key: 'settings', label: 'Settings', icon: Settings },
  { key: 'help', label: 'Help', icon: CircleHelp },
];

const UNSAVED_TRACKED_PAGES = new Set(['setup', 'basics', 'calls', 'suptransfer', 'newbieshift', 'review']);

function readStoredIds(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    if (Array.isArray(parsed)) {
      return new Set(parsed.map((value) => String(value || '').trim()).filter(Boolean));
    }
  } catch (_error) {
    // Ignore invalid local storage.
  }
  return new Set();
}

function writeStoredIds(key, values) {
  localStorage.setItem(key, JSON.stringify(Array.from(values)));
}

function openNotificationUrl(url) {
  const nextUrl = String(url || '').trim();
  if (!nextUrl) {
    return;
  }

  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(nextUrl).catch(() => {
      window.open(nextUrl, '_blank', 'noopener,noreferrer');
    });
    return;
  }

  window.open(nextUrl, '_blank', 'noopener,noreferrer');
}

function formatNotificationModalBody(notification) {
  const action = notification.actionURL
    ? `<div style="margin-top:14px;">Action available: <strong>${notification.actionText || 'Open'}</strong></div>`
    : '';

  return `<div>${notification.message}</div>${action}`;
}

function getNotificationModalTitle(notification) {
  const title = String(notification?.title || '').trim();
  if (title && title.toLowerCase() !== 'sam' && title.toLowerCase() !== 's.a.m.') {
    return title;
  }
  if (notification?.type === 'urgent') return 'System Alert';
  if (notification?.type === 'warning') return 'Alert';
  return 'Notification';
}

function getTickerMessage(notification) {
  if (!notification?.message) return '';
  if (notification.type === 'warning') return `WARNING: ${notification.message}`;
  if (notification.type === 'urgent') return `URGENT: ${notification.message}`;
  return notification.message;
}

function getTickerItemClass(notification) {
  if (notification?.type === 'urgent') return 'ticker-item ticker-item-urgent';
  if (notification?.type === 'warning') return 'ticker-item ticker-item-warning';
  return 'ticker-item ticker-item-info';
}

function getBackendUrl() {
  const electronUrl = (() => {
    try {
      return (window.electronAPI?.getBackendUrl?.() || '').trim();
    } catch (_error) {
      return '';
    }
  })();
  if (electronUrl) {
    return electronUrl.replace(/\/+$/, '');
  }

  const configuredUrl = (process.env.REACT_APP_BACKEND_URL || '').trim();
  if (configuredUrl) {
    return configuredUrl.replace(/\/+$/, '');
  }

  try {
    if (String(window.location?.hash || '').includes('notification-manager')) {
      return 'http://127.0.0.1:8601';
    }
  } catch (_error) {
    // Fall through to the main app backend port.
  }

  return 'http://127.0.0.1:8600';
}

function resolveScreenshotUrl(imageUrl) {
  const value = String(imageUrl || '').trim();
  if (!value) return '';
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  const backend = getBackendUrl();
  const cleanPath = value.replace(/^\/+/, '');
  if (/\.(png|jpe?g|gif|webp)$/i.test(cleanPath)) {
    const parts = cleanPath.split('/');
    const filename = parts[parts.length - 1];
    return `${backend}/api/screenshot-assets/${filename}`;
  }
  return `${backend}/${cleanPath}`;
}

function PageRouter({ page, navigate, navigationState, updateState, refreshUpdateState, appVersion, settings, defaults, history, historyStats, currentSession, onReplayTutorial, onSetupCompleted, startupStatuses, setMtsUpdateModal }) {
  const props = { onNavigate: navigate, navigationState, updateState, refreshUpdateState, appVersion, settings, defaults, history, historyStats, currentSession, onReplayTutorial, onSetupCompleted, startupStatuses, setMtsUpdateModal };
  switch (page) {
    case 'setup': return <SetupPage {...props} />;
    case 'home': return <HomePage {...props} />;
    case 'basics': return <BasicsPage {...props} />;
    case 'calls': return <CallsPage {...props} />;
    case 'suptransfer': return <SupTransferPage {...props} />;
    case 'newbieshift': return <NewbieShiftPage {...props} />;
    case 'review': return <ReviewPage {...props} />;
    case 'history': return <HistoryPage {...props} />;
    case 'settings': return <SettingsPage {...props} />;
    case 'help': return <HelpPage {...props} />;
    default: return <HomePage {...props} />;
  }
}

function StartupLoadingScreen({ status, progress }) {
  return (
    <div className="startup-loading-screen" data-testid="startup-loading-screen">
      <div className="startup-loading-card">
        <img src={LOGO_SRC} alt="Mock Testing Suite" className="startup-loading-logo" />
        <div className="startup-loading-eyebrow">Desktop Workspace</div>
        <h1 className="startup-loading-title">Mock Testing Suite</h1>
        <p className="startup-loading-status">{status}</p>
        <div className="startup-loading-progress">
          <div className="startup-loading-progress-track" aria-hidden="true">
            <div className="startup-loading-progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="startup-loading-percent">{Math.round(progress)}%</div>
        </div>
      </div>
    </div>
  );
}

function formatUpdateBody(updateInfo, includeDeferredNote = false, notesAsBullets = true) {
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
  const notes = (Array.isArray(updateInfo.notes) ? updateInfo.notes : [updateInfo.notes])
    .flatMap(cleanNote)
    .filter(Boolean);
  const notesContent = notesAsBullets
    ? notes.map((note) => `<li>${note}</li>`).join('')
    : notes.map((note) => `<div>${note}</div>`).join('');

  const detailLines = [
    '<div class="update-modal-content">',
    updateInfo.releaseTitle ? `<strong>${updateInfo.releaseTitle}</strong>` : '',
    updateInfo.releaseDate ? `<div class="text-muted">Released ${updateInfo.releaseDate}</div>` : '',
    `<div style="margin-top:12px;"><strong>Current:</strong> v${updateInfo.currentVersion}</div>`,
    `<div><strong>New:</strong> v${updateInfo.latestVersion}</div>`,
    updateInfo.requiredVersion ? `<div><strong>Required:</strong> v${updateInfo.requiredVersion}</div>` : '',
    updateInfo.manualError ? `<div class="update-error-note">${updateInfo.manualError}</div>` : '',
    notesContent
      ? `<div class="update-notes"><strong>Release Notes:</strong>${notesAsBullets ? `<ul>${notesContent}</ul>` : `<div>${notesContent}</div>`}</div>`
      : '',
    updateInfo.downloadUrl ? '' : '<div style="margin-top:12px;"><strong>Installer link:</strong> Not published in the update sheet yet.</div>',
    includeDeferredNote ? '<div style="margin-top:12px;">This update can be installed later from Settings by clicking <strong>Install Update</strong>.</div>' : '',
    '</div>',
  ].filter(Boolean);

  return detailLines.join('');
}

function ElectronEventBridge({ navigate, setUpdateState, setMtsUpdateModal }) {
  const modal = useModal();

  const showUpdateModal = useCallback(async (updateInfo) => {
    setMtsUpdateModal(updateInfo);
  }, [setMtsUpdateModal]);

  useEffect(() => {
    if (!window.electronAPI?.onAppEvent) {
      return undefined;
    }

    const unsubscribe = window.electronAPI.onAppEvent(async (type, payload) => {
      if (type === 'menu:navigate') {
        navigate(payload?.page || 'home', null);
        return;
      }

      if (type === 'menu:check-updates') {
        const result = await window.electronAPI.checkForUpdates();
        const nextState = await window.electronAPI.getUpdateState();
        setUpdateState(nextState || { pendingUpdate: null, installedUpdate: null });

        if (!result?.ok) {
          await modal.error('Update Check Failed', result?.error || 'Unable to check for updates right now.');
          return;
        }

        if (!result.updateAvailable) {
          await modal.showModal({
            type: 'alert',
            title: 'You’re Up to Date',
            body: `Mock Testing Suite version ${nextState?.currentVersion || payload?.currentVersion || APP_VERSION_FALLBACK} is already up to date.`,
            graphic: 'update',
            buttons: [{ label: 'OK', cls: 'btn-primary', value: true }],
          });
        }
        return;
      }

      if (type === 'menu:about') {
        await modal.showModal({
          type: 'alert',
          title: 'About Mock Testing Suite',
          graphic: 'logo',
          body: `
            <div><strong>Version:</strong> ${payload?.version || APP_VERSION_FALLBACK}</div>
            <div style="margin-top:8px;"><strong>Creator:</strong> ${payload?.creatorName || 'Shawn Bly'}</div>
            <div style="margin-top:8px;"><strong>Email:</strong> ${payload?.creatorEmail || 'support@example.com'}</div>
          `,
          buttons: [{ label: 'OK', cls: 'btn-primary', value: true }],
        });
        return;
      }

      if (type === 'update:state-changed') {
        setUpdateState(payload || { pendingUpdate: null, installedUpdate: null });
        return;
      }

      if (type === 'update:status') {
        setUpdateState((current) => ({ ...(current || {}), updaterStatus: payload }));
        return;
      }

      if (type === 'update:available') {
        setUpdateState((current) => ({ ...current, pendingUpdate: payload }));
        await showUpdateModal(payload);
        return;
      }

      if (type === 'app:confirm-quit') {
        const hasUnsavedChanges = Boolean(payload?.hasUnsavedChanges);
        const confirmed = await modal.showModal({
          type: 'confirm',
          title: 'Exit App',
          body: hasUnsavedChanges
            ? 'You have unsaved work. Are you sure you want to close the app?'
            : 'Are you sure you want to close the app?',
          graphic: 'exit',
          buttons: [
            { label: 'Yes', cls: 'btn-primary', value: true },
            { label: 'No', cls: 'btn-muted', value: false },
          ],
        });
        await window.electronAPI?.respondToQuitConfirmation?.(confirmed);
      }
    });

    return unsubscribe;
  }, [modal, navigate, setUpdateState, showUpdateModal]);

  return null;
}

function MtsUpdateModal({ updateInfo, updaterStatus, onClose }) {
  if (!updateInfo) return null;
  const required = Boolean(updateInfo.required);
  
  const state = updaterStatus?.state || 'idle';
  const isDownloading = state === 'downloading';
  const isDownloaded = state === 'downloaded' || Boolean(updateInfo.downloaded);
  const isInstalling = state === 'installing';
  const isError = state === 'error' || state === 'manual-available';
  const canManualDownload = Boolean(updateInfo.manualDownloadAvailable || state === 'manual-available' || state === 'error');

  let buttonText = 'Download Update';
  let buttonDisabled = false;

  if (isDownloading) {
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

  let statusMessage = updaterStatus?.message || '';
  if (isDownloading) {
    const percentVal = updaterStatus?.percent || 0;
    statusMessage = `Downloading update... ${percentVal.toFixed(0)}%`;
  } else if (isDownloaded) {
    statusMessage = 'Download complete. Ready to install and restart.';
  } else if (isInstalling) {
    statusMessage = 'Installing update and restarting...';
  } else if (isError) {
    const rawError = updaterStatus?.message || '';
    let shortError = rawError;
    if (rawError.includes('{') || rawError.includes('Error:')) {
      shortError = rawError.split('\n')[0].replace(/^Error:\s*/, '');
    }
    if (shortError.length > 120) {
      shortError = shortError.substring(0, 117) + '...';
    }
    statusMessage = `Update failed: ${shortError}`;
  }

  const handleAction = async () => {
    if (isDownloaded) {
      const result = await window.electronAPI?.updaterQuitAndInstall?.();
      if (!result?.ok) {
        // Handled via state change
      }
    } else {
      const result = await window.electronAPI?.installPendingUpdate?.();
      if (!result?.ok) {
        // Handled via state change
      }
    }
  };

  const handleManual = async () => {
    await window.electronAPI?.updaterManualDownload?.();
  };

  const cleanNote = (value) => String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const notes = (Array.isArray(updateInfo.notes) ? updateInfo.notes : [updateInfo.notes])
    .flatMap(cleanNote)
    .filter(Boolean);

  return (
    <div className="cmodal-overlay open" onClick={(e) => { if (!required && !isInstalling && e.target === e.currentTarget) onClose(); }}>
      <div className="cmodal" style={{ maxWidth: '600px', width: '90%' }}>
        <img className="cmodal-graphic" src={updateGraphic} alt="" style={{ height: '60px', objectFit: 'contain' }} />
        <div className="cmodal-title" style={{ fontSize: '1.4rem', marginBottom: '8px' }}>
          {required ? 'Update Required' : 'Update Available'} — Version {updateInfo.latestVersion}
        </div>
        <div className="cmodal-body" style={{ width: '100%', textAlign: 'left', fontSize: '0.95rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px', padding: '10px', background: 'rgba(255, 255, 255, 0.05)', borderRadius: '4px' }}>
            <div><strong>Current:</strong> v{updateInfo.currentVersion}</div>
            <div><strong>New:</strong> v{updateInfo.latestVersion}</div>
            {updateInfo.releaseDate && <div style={{ gridColumn: 'span 2' }}><strong>Released:</strong> {updateInfo.releaseDate}</div>}
          </div>

          {statusMessage && (
            <div style={{
              padding: '10px',
              borderRadius: '4px',
              marginBottom: '12px',
              fontWeight: 'bold',
              background: isError ? 'rgba(224, 108, 117, 0.1)' : 'rgba(152, 195, 121, 0.1)',
              color: isError ? '#e06c75' : '#98c379',
              border: `1px solid ${isError ? 'rgba(224, 108, 117, 0.2)' : 'rgba(152, 195, 121, 0.2)'}`
            }}>
              {statusMessage}
            </div>
          )}

          {notes.length > 0 && (
            <div style={{ marginBottom: '12px' }}>
              <strong>Release Notes:</strong>
              <div style={{
                maxHeight: '180px',
                overflowY: 'auto',
                padding: '10px',
                background: 'rgba(0, 0, 0, 0.2)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '4px',
                marginTop: '6px',
                whiteSpace: 'pre-wrap',
                fontFamily: 'monospace',
                fontSize: '0.85rem'
              }}>
                {notes.join('\n')}
              </div>
            </div>
          )}
        </div>
        <div className="cmodal-btns" style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', width: '100%', marginTop: '16px' }}>
          {!required && (
            <button className="btn btn-muted" onClick={onClose} disabled={isInstalling}>
              Cancel
            </button>
          )}
          {canManualDownload && (
            <button className="btn btn-primary" onClick={handleManual}>
              Manual Download
            </button>
          )}
          <button className="btn btn-success" onClick={handleAction} disabled={buttonDisabled}>
            {buttonText}
          </button>
        </div>
      </div>
    </div>
  );
}

function AppShell() {
  const [page, setPage] = useState('home');
  const [pageState, setPageState] = useState(null);
  const [settings, setSettings] = useState({});
  const [defaults, setDefaults] = useState({ approved_headsets: [], discord_templates: [], discord_screenshots: [] });
  const [history, setHistory] = useState([]);
  const [historyStats, setHistoryStats] = useState({});
  const [currentSession, setCurrentSession] = useState(null);
  const [startupStatuses, setStartupStatuses] = useState({
    backend: 'pending',
    settings: 'pending',
    defaults: 'pending',
    session: 'pending',
    history: 'pending',
    stats: 'pending',
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.sessionStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
  const [tutorialRun, setTutorialRun] = useState(false);
  const [tutorialStepIndex, setTutorialStepIndex] = useState(0);
  const [appVersion, setAppVersion] = useState(() => window.electronAPI?.getVersion?.() || APP_VERSION_FALLBACK);
  const [updateState, setUpdateState] = useState({ currentVersion: APP_VERSION_FALLBACK, pendingUpdate: null, installedUpdate: null });
  const [mtsUpdateModal, setMtsUpdateModal] = useState(null);
  const [tickerMessages, setTickerMessages] = useState([]);
  const [notificationGroups, setNotificationGroups] = useState(DEFAULT_NOTIFICATION_GROUPS);
  const [dismissedBannerIds, setDismissedBannerIds] = useState(() => readStoredIds(DISMISSED_NOTIFICATION_BANNERS_KEY));
  const [discordOpen, setDiscordOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState('Starting app...');
  const [loadingProgress, setLoadingProgress] = useState(10);
  const installedUpdateNoticeRef = useRef(null);
  const popupSessionIdsRef = useRef(new Set());
  const popupFlowActiveRef = useRef(false);
  const tutorialAutoStartRef = useRef(false);
  const modal = useModal();

  useEffect(() => {
    const saved = localStorage.getItem('mts-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    window.electronAPI?.setUnsavedChanges?.(false).catch(() => {});
  }, []);

  useEffect(() => {
    const resolvedVersion = window.electronAPI?.getVersion?.();
    if (resolvedVersion) {
      setAppVersion(resolvedVersion);
    }
  }, []);

  useEffect(() => {
    window.sessionStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  const refreshUpdateState = useCallback(async () => {
    if (!window.electronAPI?.getUpdateState) {
      return;
    }

    const nextState = await window.electronAPI.getUpdateState();
    if (nextState) {
      setUpdateState(nextState);
      if (nextState.currentVersion) {
        setAppVersion(nextState.currentVersion);
      }
    }
  }, []);

  useEffect(() => {
    refreshUpdateState().catch(() => {});
  }, [refreshUpdateState]);

  useEffect(() => {
    if (!updateState?.installedUpdate) {
      installedUpdateNoticeRef.current = null;
      return;
    }

    const installedNoticeKey = updateState.installedUpdate.latestVersion || 'installed-update';
    if (installedUpdateNoticeRef.current === installedNoticeKey) {
      return;
    }
    installedUpdateNoticeRef.current = installedNoticeKey;

    let active = true;

    const showInstalledPopup = async () => {
      await modal.showModal({
        type: 'alert',
        title: `Updated Successfully — Version ${updateState.installedUpdate.latestVersion}`,
        body: formatUpdateBody(updateState.installedUpdate, false, false),
        graphic: 'update',
        buttons: [{ label: 'OK', cls: 'btn-primary', value: true }],
      });

      if (active) {
        await window.electronAPI?.acknowledgeInstalledUpdate?.();
        refreshUpdateState().catch(() => {});
      }
    };

    showInstalledPopup();

  }, [modal, refreshUpdateState, updateState]);

  useEffect(() => {
    console.log("app component mounted");
  }, []);

  useEffect(() => {
    console.log("ticker mounted");
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retryTimeout = null;
    const recoveryTimeouts = [];

    const scheduleRecoveryRetry = (name, requestFn, onSuccess, onFallback, statusKey, delay = STARTUP_RECOVERY_RETRY_MS) => {
      console.log(`[STARTUP] ${name} retry scheduled in ${delay}ms`);
      const timeoutId = window.setTimeout(async () => {
        if (cancelled) return;
        const retryStartedAt = Date.now();
        console.log(`[STARTUP] ${name} retry started`);
        try {
          const data = await requestFn();
          if (cancelled) return;
          onSuccess(data, true);
          setStartupStatuses(prev => ({ ...prev, [statusKey]: 'loaded' }));
          logTimedRequest(name, 'retry succeeded', retryStartedAt, { shape: summarizePayload(data), fallbackUsed: false });
        } catch (err) {
          if (cancelled) return;
          onFallback?.(true);
          setStartupStatuses(prev => ({ ...prev, [statusKey]: 'fallback' }));
          logTimedRequest(name, 'retry failed', retryStartedAt, { error: err?.message || String(err), fallbackUsed: true });
        }
      }, delay);
      recoveryTimeouts.push(timeoutId);
    };

    const runStartupRequest = (name, statusKey, requestFn, onSuccess, onFallback) => {
      const startedAt = Date.now();
      console.log(`[STARTUP] ${name} started`);
      setStartupStatuses(prev => ({ ...prev, [statusKey]: 'pending' }));
      requestFn().then(data => {
        if (!cancelled) {
          onSuccess(data, false);
          setStartupStatuses(prev => ({ ...prev, [statusKey]: 'loaded' }));
          logTimedRequest(name, 'succeeded', startedAt, { shape: summarizePayload(data), fallbackUsed: false });
        }
      }).catch(err => {
        if (!cancelled) {
          onFallback?.(false);
          setStartupStatuses(prev => ({ ...prev, [statusKey]: 'fallback' }));
          logTimedRequest(name, 'failed', startedAt, { error: err?.message || String(err), fallbackUsed: true });
          scheduleRecoveryRetry(name, requestFn, onSuccess, onFallback, statusKey);
        }
      });
    };

    const loadInitialSettings = async (attempt = 0) => {
      try {
        if (attempt === 0) {
          setLoadingStatus('Starting backend...');
          setLoadingProgress(20);
        } else {
          setLoadingStatus('Starting backend...');
          setLoadingProgress(Math.min(50, 20 + attempt * 4));
        }

        console.log("backend health check started");
        await api.getHealth();
        console.log("backend health ready");

        if (cancelled) return;

        setStartupStatuses(prev => ({ ...prev, backend: 'ready' }));
        setLoading(false);

        runStartupRequest(
          'settings',
          'settings',
          () => api.getSettings(5000),
          (s) => {
            setSettings(s || {});
            setSoundsEnabled(s?.enable_sounds !== false);
            if (s?.setup_complete === false) {
              setPage('setup');
            } else {
              setPage('home');
            }
          },
          () => {
            setSettings({});
            setPage('home');
          }
        );

        runStartupRequest(
          'defaults',
          'defaults',
          () => api.getDefaults(8000),
          (defs) => {
            setDefaults(defs || emptyDefaults());
            console.log("Discord final template count: " + (defs?.discord_templates?.length || 0));
            console.log("Discord final screenshot count: " + (defs?.discord_screenshots?.length || 0));
          },
          () => setDefaults(emptyDefaults())
        );

        // 2. Load Current Session asynchronously in background
        setStartupStatuses(prev => ({ ...prev, session: 'pending' }));
        api.getCurrentSession(5000).then(session => {
          if (!cancelled) {
            setCurrentSession(session);
            setStartupStatuses(prev => ({ ...prev, session: 'loaded' }));
          }
        }).catch(err => {
          if (!cancelled) {
            setCurrentSession(null);
            setStartupStatuses(prev => ({ ...prev, session: 'fallback' }));
          }
        });

        runStartupRequest(
          'history',
          'history',
          () => api.getHistory(5000),
          (hist) => {
            setHistory(hist || []);
          },
          () => setHistory([])
        );

        runStartupRequest(
          'historyStats',
          'stats',
          () => api.getHistoryStats(5000),
          (stats) => {
            setHistoryStats(stats || {});
          },
          () => setHistoryStats({})
        );

      } catch (_err) {
        if (cancelled) return;
        if (attempt < INITIAL_SETTINGS_MAX_RETRIES) {
          setLoadingStatus('Starting backend...');
          retryTimeout = window.setTimeout(() => {
            loadInitialSettings(attempt + 1);
          }, INITIAL_SETTINGS_RETRY_DELAY_MS);
          return;
        }
        console.log("backend health request failed: " + _err.message);
        setStartupStatuses(prev => ({ ...prev, backend: 'failed' }));
        setLoadingStatus('Backend connection timed out');
        setLoadingProgress(100);
        setLoading(false);
      }
    };

    loadInitialSettings();

    return () => {
      cancelled = true;
      if (retryTimeout) {
        window.clearTimeout(retryTimeout);
      }
      recoveryTimeouts.forEach(timeoutId => window.clearTimeout(timeoutId));
    };
  }, []);

  useEffect(() => {
    const handleFirstInteraction = () => {
      unlockSounds();
      window.removeEventListener('pointerdown', handleFirstInteraction);
      window.removeEventListener('keydown', handleFirstInteraction);
    };

    window.addEventListener('pointerdown', handleFirstInteraction, { once: true });
    window.addEventListener('keydown', handleFirstInteraction, { once: true });

    return () => {
      window.removeEventListener('pointerdown', handleFirstInteraction);
      window.removeEventListener('keydown', handleFirstInteraction);
    };
  }, []);

  useEffect(() => {
    if (loading) {
      return undefined;
    }

    const fetchTicker = async () => {
      const startedAt = Date.now();
      console.log('[STARTUP] ticker started');
      try {
        const data = await api.getTicker();
        setTickerMessages(Array.isArray(data.messages) ? data.messages : []);
        logTimedRequest('ticker', 'succeeded', startedAt, {
          shape: summarizePayload(data),
          fallbackUsed: Boolean(data?.fallback),
          source: data?.source || 'unknown',
        });
      } catch (_err) {
        logTimedRequest('ticker', 'failed', startedAt, { error: _err?.message || String(_err), fallbackUsed: true });
      }
    };
    fetchTicker();
    const interval = setInterval(fetchTicker, TICKER_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loading]);

  useEffect(() => {
    if (loading) {
      return undefined;
    }

    let cancelled = false;

    const refreshNotifications = async () => {
      try {
        const groups = await api.getNotifications();
        if (!cancelled) {
          setNotificationGroups(groups || DEFAULT_NOTIFICATION_GROUPS);
        }
      } catch (error) {
        if (!cancelled) {
          setNotificationGroups(DEFAULT_NOTIFICATION_GROUPS);
        }
        console.warn('[NOTIFICATIONS] Failed to load notifications:', error?.message || error);
      }
    };

    refreshNotifications();
    const interval = window.setInterval(refreshNotifications, TICKER_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [loading]);

  useEffect(() => {
    writeStoredIds(DISMISSED_NOTIFICATION_BANNERS_KEY, dismissedBannerIds);
  }, [dismissedBannerIds]);

  useEffect(() => {
    if (loading || !notificationGroups.popups.length || popupFlowActiveRef.current) {
      return undefined;
    }

    let cancelled = false;
    const dismissedPopupIds = readStoredIds(DISMISSED_NOTIFICATION_POPUPS_KEY);
    const queue = notificationGroups.popups.filter((notification) => {
      if (popupSessionIdsRef.current.has(notification.id)) {
        return false;
      }

      if (!notification.persistent && dismissedPopupIds.has(notification.id)) {
        return false;
      }

      return true;
    });

    if (!queue.length) {
      return undefined;
    }

    popupFlowActiveRef.current = true;

    const showQueuedPopups = async () => {
      for (const notification of queue) {
        if (cancelled) {
          break;
        }

        popupSessionIdsRef.current.add(notification.id);

        const result = await modal.showModal({
          type: notification.type === 'urgent' ? 'warning' : 'alert',
          title: getNotificationModalTitle(notification),
          body: formatNotificationModalBody(notification),
          graphic: notification.type === 'warning' || notification.type === 'urgent' ? 'warning' : 'notification',
          buttons: notification.actionURL
            ? [
                { label: notification.actionText || 'Open', cls: 'btn-primary', value: 'open' },
                { label: 'Dismiss', cls: 'btn-muted', value: 'dismiss' },
              ]
            : [{ label: 'OK', cls: 'btn-primary', value: true }],
        });

        if (result === 'open' && notification.actionURL) {
          openNotificationUrl(notification.actionURL);
        }

        if (!notification.persistent) {
          dismissedPopupIds.add(notification.id);
          writeStoredIds(DISMISSED_NOTIFICATION_POPUPS_KEY, dismissedPopupIds);
        }
      }

      popupFlowActiveRef.current = false;
    };

    showQueuedPopups();

    return () => {
      cancelled = true;
      popupFlowActiveRef.current = false;
    };
  }, [loading, modal, notificationGroups.popups]);

  useEffect(() => {
    if (!UNSAVED_TRACKED_PAGES.has(page)) {
      return undefined;
    }

    const markUnsaved = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const isFormControl = target.matches('input, select, textarea');
      if (!isFormControl) {
        return;
      }

      if (target.hasAttribute('readonly') || target.hasAttribute('disabled')) {
        return;
      }

      window.electronAPI?.setUnsavedChanges?.(true).catch(() => {});
    };

    document.addEventListener('input', markUnsaved, true);
    document.addEventListener('change', markUnsaved, true);

    return () => {
      document.removeEventListener('input', markUnsaved, true);
      document.removeEventListener('change', markUnsaved, true);
    };
  }, [page]);

  const navigate = useCallback((p, nextState = null) => {
    setPage(p);
    setPageState(nextState);
    if (page === 'settings') {
      api.getSettings().then(s => {
        setSettings(s);
        setSoundsEnabled(s.enable_sounds !== false);
      }).catch(() => {});
    }
  }, [page]);

  const handleSetupCompleted = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setSettings(s);
      setSoundsEnabled(s.enable_sounds !== false);
    } catch (_error) {
      // Ignore settings refresh errors here; the user can still proceed to Home.
    }

    localStorage.setItem(TUTORIAL_AFTER_SETUP_KEY, '1');
    navigate('home', null);
  }, [navigate]);

  const stopTutorial = useCallback(async (status = 'skipped') => {
    setTutorialRun(false);
    setTutorialStepIndex(0);
    localStorage.setItem(TUTORIAL_STATUS_KEY, status);

    if (status === 'failed') {
      await modal.warning(
        'Tutorial Could Not Start',
        'The tutorial could not find the next screen element. The walkthrough was closed so you can keep using the app.'
      );
      return;
    }

    if (status === 'completed' || status === 'skipped') {
      try {
        await api.saveSettings({ tutorial_completed: true });
        setSettings((current) => current ? { ...current, tutorial_completed: true } : current);
      } catch (_error) {
        // Ignore tutorial completion persistence errors; the walkthrough still closes.
      }
    }
  }, [modal]);

  const startFullTutorial = useCallback(() => {
    setSidebarCollapsed(false);
    setTutorialStepIndex(0);
    navigate('home', null);
    window.setTimeout(() => {
      setTutorialRun(true);
    }, 0);
  }, [navigate]);

  useEffect(() => {
    if (loading || tutorialRun) {
      return;
    }

    if (localStorage.getItem(TUTORIAL_AFTER_SETUP_KEY) !== '1') {
      return;
    }

    if (page !== 'home') {
      navigate('home', null);
      return;
    }

    localStorage.removeItem(TUTORIAL_AFTER_SETUP_KEY);
    localStorage.removeItem(TUTORIAL_STATUS_KEY);
    startFullTutorial();
  }, [loading, navigate, page, startFullTutorial, tutorialRun]);

  useEffect(() => {
    if (loading || tutorialRun || tutorialAutoStartRef.current) {
      return;
    }

    if (!settings?.setup_complete || settings?.tutorial_completed === true) {
      return;
    }

    if (page !== 'home') {
      navigate('home', null);
      return;
    }

    tutorialAutoStartRef.current = true;
    localStorage.removeItem(TUTORIAL_STATUS_KEY);
    startFullTutorial();
  }, [loading, navigate, page, settings, startFullTutorial, tutorialRun]);

  const handleExit = useCallback(async () => {
    if (window.electronAPI?.quitApp) {
      await window.electronAPI.quitApp().catch((err) => {
        console.error('[APP] Failed to quit desktop app:', err);
      });
      return;
    }

    const confirmed = await modal.showModal({
      type: 'confirm',
      title: 'Exit App',
      body: 'Are you sure you want to close the app?',
      graphic: 'exit',
      buttons: [
        { label: 'Yes', cls: 'btn-primary', value: true },
        { label: 'No', cls: 'btn-muted', value: false },
      ],
    });

    if (confirmed) {
      window.close();
    }
  }, [modal]);

  const notificationTickerMessages = notificationGroups.tickerMessages
    .map((notification) => ({
      id: notification.id,
      className: getTickerItemClass(notification),
      text: getTickerMessage(notification),
    }))
    .filter((notification) => notification.text);

  const fallbackTickerMessages = tickerMessages
    .map((message, index) => ({
      id: `fallback-${index}`,
      className: 'ticker-item ticker-item-info',
      text: String(message || '').replace(/^\d+[\.\)]\s+/, '').trim(),
    }))
    .filter((message) => message.text);

  const displayTickerMessages = notificationTickerMessages.length > 0
    ? notificationTickerMessages
    : fallbackTickerMessages;

  const tickerDurationSeconds = resolveTickerDurationSeconds(
    settings?.ticker_speed || 'normal',
  );

  const visibleBanners = notificationGroups.banners.filter((notification) => (
    notification.persistent || !dismissedBannerIds.has(notification.id)
  ));

  const tickerContent = displayTickerMessages.length > 0
    ? displayTickerMessages
    : [{ id: 'default-welcome', className: 'ticker-item ticker-item-info', text: `Welcome to Mock Testing Suite v${appVersion}` }];

  return (
    <>
      <TutorialPreviewOverlay
        run={tutorialRun}
        stepIndex={tutorialStepIndex}
        setStepIndex={setTutorialStepIndex}
        setRun={setTutorialRun}
        navigate={navigate}
        currentPage={page}
        onStop={stopTutorial}
      />

      <div className="app-root" data-testid="app-root">
        <div className="ticker-bar" style={{ '--ticker-duration': `${tickerDurationSeconds}s` }}>
          <div className="ticker-track">
            <span className="ticker-content">
              {tickerContent.map((item, index) => (
                <React.Fragment key={item.id || `ticker-${index}`}>
                  {index > 0 ? <span className="ticker-separator" aria-hidden="true">{' \u25C6 '}</span> : null}
                  <span className={item.className}>{item.text}</span>
                </React.Fragment>
              ))}
            </span>
          </div>
        </div>
        <div className="app-shell">
          <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : 'expanded'}`} data-testid="sidebar">
            <div className="sidebar-brand">
              <button
                className="sidebar-toggle"
                type="button"
                onClick={() => setSidebarCollapsed((current) => !current)}
                aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-pressed={sidebarCollapsed}
                title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                data-testid="sidebar-toggle"
              >
                {sidebarCollapsed ? <PanelLeftOpen size={17} strokeWidth={2.25} /> : <PanelLeftClose size={17} strokeWidth={2.25} />}
              </button>
              <img src={LOGO_SRC} alt="Mock Testing Suite" className="sidebar-logo-img" />
              <div className="sidebar-version">{`v${appVersion}`}</div>
            </div>
            <nav className="sidebar-nav">
              {NAV_ITEMS.map(item => {
                const Icon = item.icon || ClipboardList;
                return (
                <button
                  key={item.key}
                  className={`nav-btn ${page === item.key ? 'active' : ''}`}
                  onClick={() => navigate(item.key, null)}
                  data-testid={`nav-${item.key}`}
                  title={sidebarCollapsed ? item.label : `Open ${item.label}`}
                >
                  <span className="nav-icon"><Icon size={18} strokeWidth={2.15} /></span>
                  <span className="nav-label">{item.label}</span>
                </button>
                );
              })}
            </nav>
            <div className="sidebar-divider" />
            <div className="sidebar-actions">
              <button className="action-btn action-discord" onClick={() => setDiscordOpen(true)} data-testid="link-discord" data-tour="sidebar-discord" title={sidebarCollapsed ? 'Discord Post' : 'Open Discord message templates'}>
                <span className="action-icon"><MessageSquareText size={17} strokeWidth={2.2} /></span><span className="action-label">Discord Post</span>
              </button>
              <button className="action-btn action-cert" onClick={() => { if (settings?.cert_sheet_url) window.open(settings.cert_sheet_url, '_blank'); }} data-testid="link-cert" data-tour="sidebar-cert-sheet" title={sidebarCollapsed ? 'Cert Spreadsheet' : 'Open Cert Spreadsheet'}>
                <span className="action-icon"><Table2 size={17} strokeWidth={2.2} /></span><span className="action-label">Cert Spreadsheet</span>
              </button>
            </div>
            <div className="sidebar-footer">
              <button className="exit-btn" onClick={handleExit} data-testid="exit-btn" data-tour="sidebar-exit" title={sidebarCollapsed ? 'Exit App' : 'Close the desktop app'}>
                <span className="exit-btn-icon"><Power size={17} strokeWidth={2.3} /></span>
                <span className="exit-btn-label">Exit App</span>
              </button>
            </div>
          </aside>

          <main className="content-area">
            {!loading && visibleBanners.length > 0 ? (
              <div className="notification-banner-stack" data-testid="notification-banner-stack">
                {visibleBanners.map((notification) => (
                  <NotificationBanner
                    key={notification.id}
                    notification={notification}
                    onAction={(item) => openNotificationUrl(item.actionURL)}
                    onDismiss={(notificationId) => {
                      setDismissedBannerIds((current) => {
                        const next = new Set(current);
                        next.add(notificationId);
                        return next;
                      });
                    }}
                  />
                ))}
              </div>
            ) : null}
            <div className="page-content" data-testid="page-content">
              {loading ? (
                <StartupLoadingScreen status={loadingStatus} progress={loadingProgress} />
              ) : (
                <PageRouter
                  page={page}
                  navigate={navigate}
                  navigationState={pageState}
                  updateState={updateState}
                  refreshUpdateState={refreshUpdateState}
                  appVersion={appVersion}
                  settings={settings}
                  defaults={defaults}
                  history={history}
                  historyStats={historyStats}
                  currentSession={currentSession}
                  onReplayTutorial={startFullTutorial}
                  onSetupCompleted={handleSetupCompleted}
                  startupStatuses={startupStatuses}
                  setMtsUpdateModal={setMtsUpdateModal}
                />
              )}
            </div>
            <div className="status-bar">
              <span id="status-text"></span>
              <span className="status-spacer" />
              <span>{`Mock Testing Suite v${appVersion} — By Shawn P. Bly`}</span>
            </div>
          </main>
        </div>

        {discordOpen && <DiscordModal settings={settings} defaults={defaults} onClose={() => setDiscordOpen(false)} />}
        <ElectronEventBridge navigate={navigate} setUpdateState={setUpdateState} setMtsUpdateModal={setMtsUpdateModal} />
        {mtsUpdateModal && (
          <MtsUpdateModal
            updateInfo={mtsUpdateModal}
            updaterStatus={updateState?.updaterStatus}
            onClose={() => setMtsUpdateModal(null)}
          />
        )}
      </div>
     </>  
  );
}

function DiscordModal({ settings, defaults, onClose }) {
  const [modalDefaults, setModalDefaults] = useState(defaults || emptyDefaults());
  const [defaultsLoadStatus, setDefaultsLoadStatus] = useState('idle');
  const defaultsFetchStartedRef = useRef(false);

  useEffect(() => {
    setModalDefaults(defaults || emptyDefaults());
  }, [defaults]);

  const activeDefaults = modalDefaults || emptyDefaults();
  const hasDefaultDiscordData = Boolean(
    activeDefaults?.discord_templates?.length || activeDefaults?.discord_screenshots?.length
  );
  const hasSettingsDiscordData = Boolean(
    settings?.discord_templates?.length || settings?.discord_screenshots?.length
  );
  const hasSettingsTemplateData = Boolean(settings?.discord_templates?.length);
  const discordTemplateSource = activeDefaults?._content_sources?.discord_templates?.source || '';

  useEffect(() => {
    if (hasDefaultDiscordData || defaultsFetchStartedRef.current) {
      return undefined;
    }

    let cancelled = false;
    defaultsFetchStartedRef.current = true;
    const startedAt = Date.now();
    setDefaultsLoadStatus('loading');
    console.log('[STARTUP] discordDefaults started');

    api.getDefaults(8000).then((defs) => {
      if (cancelled) return;
      setModalDefaults(defs || emptyDefaults());
      setDefaultsLoadStatus('loaded');
      logTimedRequest('discordDefaults', 'succeeded', startedAt, { shape: summarizePayload(defs), fallbackUsed: false });
    }).catch((err) => {
      if (cancelled) return;
      setDefaultsLoadStatus('failed');
      logTimedRequest('discordDefaults', 'failed', startedAt, { error: err?.message || String(err), fallbackUsed: true });
    });

    return () => {
      cancelled = true;
    };
  }, [hasDefaultDiscordData]);

  const usingSettingsOverride = Boolean(settings?.discord_override && settings?.discord_templates?.length);
  const templatesSrc = useMemo(() => (
    usingSettingsOverride
      ? settings.discord_templates
      : activeDefaults?.discord_templates?.length > 0
        ? activeDefaults.discord_templates
        : (settings?.discord_templates || [])
  ), [activeDefaults?.discord_templates, settings?.discord_templates, usingSettingsOverride]);
  const templatesUsedSource = usingSettingsOverride
    ? 'settings_override'
    : activeDefaults?.discord_templates?.length > 0
      ? 'defaults'
      : hasSettingsTemplateData
        ? 'settings_fallback'
        : 'empty';

  const screenshotsSrc = (!settings?.discord_override && activeDefaults?.discord_screenshots?.length > 0)
    ? activeDefaults.discord_screenshots
    : (settings?.discord_screenshots || []);

  const templates = templatesSrc.map(t => {
    if (!t) return null;
    if (Array.isArray(t)) {
      return { title: String(t[0] || ''), message: String(t[1] || '') };
    }
    if (typeof t === 'object') {
      const title = t.title || t.Title || t.name || t.Name || t.label || t.Label || '';
      const message = t.message || t.Message || t.text || t.Text || t.content || t.Content || t.body || t.Body || '';
      return { title: String(title), message: String(message) };
    }
    return null;
  }).filter(Boolean);

  useEffect(() => {
    console.log('[DISCORD DEFAULTS] templates', {
      rawCount: Array.isArray(templatesSrc) ? templatesSrc.length : 0,
      normalizedCount: templates.length,
      defaultsRawCount: activeDefaults?.discord_templates?.length || 0,
      settingsRawCount: settings?.discord_templates?.length || 0,
      backendSource: discordTemplateSource || 'unknown',
      frontendUsedSource: templatesUsedSource,
    });
  }, [activeDefaults?.discord_templates?.length, discordTemplateSource, settings?.discord_templates?.length, templates.length, templatesSrc, templatesUsedSource]);

  const screenshots = screenshotsSrc.map(s => {
    if (!s) return null;
    if (typeof s === 'object') {
      const title = s.title || s.name || 'Screenshot';
      const imageUrl = s.image_url || s.imageUrl || s.url || s.src || '';
      return { title: String(title), imageUrl: String(imageUrl) };
    }
    return null;
  }).filter(Boolean);

  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('templates');

  const filteredTemplates = templates.filter(({ title, message }) =>
    title.toLowerCase().includes(search.toLowerCase()) || message.toLowerCase().includes(search.toLowerCase())
  );

  const filteredScreenshots = screenshots.filter(s =>
    s.title.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="modal-overlay open" onClick={e => { if (e.target.classList.contains('modal-overlay')) onClose(); }} data-testid="discord-modal">
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 700, maxHeight: '85vh' }}>
        <div className="modal-header">
          <h2>Discord Post</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div style={{ padding: '0 24px 8px', display: 'flex', gap: 8 }}>
          <button className={`tab-btn ${tab === 'templates' ? 'active' : ''}`} onClick={() => setTab('templates')} style={{ padding: '6px 14px' }}>Templates</button>
          <button className={`tab-btn ${tab === 'screenshots' ? 'active' : ''}`} onClick={() => setTab('screenshots')} style={{ padding: '6px 14px' }}>Screenshots</button>
        </div>
        <div style={{ padding: '0 24px 12px' }}>
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder={tab === 'templates' ? 'Search templates...' : 'Search screenshots...'} data-testid="discord-search" style={{ width: '100%' }} />
        </div>
        <div className="modal-body" style={{ maxHeight: '55vh', overflowY: 'auto' }}>
          {tab === 'templates' ? (
            filteredTemplates.length === 0 ? (
              <p className="text-muted" style={{ padding: 20 }}>
                {defaultsLoadStatus === 'loading'
                  ? 'Loading templates...'
                  : defaultsLoadStatus === 'failed'
                    ? 'Discord templates could not be loaded.'
                    : 'No templates match your search.'}
              </p>
            ) : filteredTemplates.map(({ title, message }, i) => (
              <DiscordRow key={i} title={title} message={message} />
            ))
          ) : (
            filteredScreenshots.length === 0 ? (
              <p className="text-muted" style={{ padding: 20 }}>
                {defaultsLoadStatus === 'loading'
                  ? 'Loading screenshots...'
                  : defaultsLoadStatus === 'failed'
                    ? 'Discord screenshots could not be loaded.'
                    : 'No screenshots match your search.'}
              </p>
            ) : filteredScreenshots.map((ss, i) => (
              <DiscordScreenshotRow key={i} title={ss.title} imageUrl={ss.imageUrl} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function DiscordRow({ title, message }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="discord-row">
      <div className="discord-title">{title}</div>
      <div className="discord-msg">{message}</div>
      <button className={`discord-copy ${copied ? 'copied' : ''}`} onClick={() => {
        navigator.clipboard.writeText(message);
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
      }}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

function DiscordScreenshotRow({ title, imageUrl }) {
  const [copied, setCopied] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const resolvedImageUrl = resolveScreenshotUrl(imageUrl);

  useEffect(() => {
    setPreviewError(false);
  }, [resolvedImageUrl]);

  useEffect(() => {
    console.log("[SCREENSHOT PREVIEW] Render Details:", {
      title,
      rawImageUrl: imageUrl,
      resolvedImageUrl
    });
  }, [title, imageUrl, resolvedImageUrl]);

  const handleCopy = async () => {
    if (!resolvedImageUrl) return;
    try {
      const resp = await fetch(resolvedImageUrl);
      if (!resp.ok) throw new Error(`Image request failed with status ${resp.status}`);
      const blob = await resp.blob();
      if (!blob.type.startsWith('image/')) throw new Error('Referenced file is not an image.');
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch (_e) {
      try {
        await navigator.clipboard.writeText(`${window.location.origin}/${resolvedImageUrl.replace(/^\/+/, '')}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
      } catch (_fallbackError) {
        window.open(resolvedImageUrl, '_blank');
      }
    }
  };
  return (
    <div className="discord-row" style={{ flexDirection: 'column', gap: 8 }}>
      <div className="discord-screenshot-header">
        <div className="discord-title">{title}</div>
        <button className={`discord-copy ${copied ? 'copied' : ''}`} onClick={handleCopy} disabled={!resolvedImageUrl || previewError}>{copied ? 'Copied' : 'Copy Image'}</button>
      </div>
      {resolvedImageUrl && !previewError ? (
        <img
          src={resolvedImageUrl}
          alt={title}
          onLoad={() => {
            console.log(`[SCREENSHOT PREVIEW] Load SUCCESS for: "${title}" | Resolved: ${resolvedImageUrl}`);
          }}
          onError={() => {
            console.error(`[SCREENSHOT PREVIEW] Load FAILURE for: "${title}" | Resolved: ${resolvedImageUrl}`);
            setPreviewError(true);
          }}
          style={{ width: '100%', maxHeight: 300, objectFit: 'contain', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}
        />
      ) : (
        <div className="text-muted" style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: 16 }}>
          Screenshot image not found or unavailable: {imageUrl || 'No image path configured'}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ModalProvider>
      <AppShell />
    </ModalProvider>
  );
}
