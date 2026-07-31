import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import '@/App.css';
import '@/polish-mts.css';
import api from './api';
import { ModalProvider, useModal } from './components/ModalProvider';
import NotificationBanner from './components/NotificationBanner';
import MtsTickerBar from './components/MtsTickerBar';
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
import { setSoundSettings, unlockSounds } from './utils/sound';
import { DEFAULT_NOTIFICATION_GROUPS } from './utils/notifications';
import {
  createTickerRequestGuard,
  normalizeTickerGroups,
  readTickerCache,
  refreshTickerNotifications,
  writeTickerCache,
} from './utils/tickerStartup';
import { normalizeDiscordKeyList, nextDiscordFavoriteKeys } from './utils/discordFavorites';
import { normalizeDiscordMessageWhitespace } from './utils/discordContent';
import {
  DISCORD_CATEGORY_SHORTCUTS,
  DISCORD_GLOBAL_SHORTCUTS,
  getDefaultFavoriteShortcut,
  getDiscordCommandSearchText,
  getDiscordCategoryMeta,
  normalizeDiscordProductivitySettings,
  shortcutMatchesEvent,
} from './utils/discordProductivity';
import {
  getDiscordPostSuggestedScreenshotPaths,
  resolveDiscordSuggestedScreenshots,
} from './utils/discordScreenshotSuggestions';
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
  Search,
  Settings,
  Table2,
} from 'lucide-react';
import mtsLogo from './assets/images/MTSLogonew.png';
import updateGraphic from './assets/images/update.png';
import TutorialPreviewOverlay from "./tutorial/TutorialPreviewOverlay";
import PostSetupQuickStart from './components/PostSetupQuickStart';

const LOGO_SRC = mtsLogo;
const APP_VERSION_FALLBACK = '1.0.1';
const INITIAL_SETTINGS_RETRY_DELAY_MS = 180;
const INITIAL_SETTINGS_MAX_RETRIES = 12;
const SIDEBAR_COLLAPSED_KEY = 'mts-sidebar-collapsed';
const TUTORIAL_STATUS_KEY = 'mts-tutorial-status';
const TUTORIAL_AFTER_SETUP_KEY = 'mts-start-tutorial-after-setup';
const MTS_QUICK_START_STATE_KEY = 'mts:quick-start:v1';
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

function PageRouter({ page, navigate, navigationState, updateState, refreshUpdateState, appVersion, settings, defaults, history, historyStats, currentSession, onReplayTutorial, onReplayQuickStart, onSetupCompleted, startupStatuses, setMtsUpdateModal, onHistoryRefresh }) {
  const props = { onNavigate: navigate, navigationState, updateState, refreshUpdateState, appVersion, settings, defaults, history, historyStats, currentSession, onReplayTutorial, onReplayQuickStart, onSetupCompleted, startupStatuses, setMtsUpdateModal, onHistoryRefresh };
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
    includeDeferredNote ? '<div style="margin-top:12px;">This update can be opened later from Settings by clicking <strong>Download Update</strong>.</div>' : '',
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
            { label: 'No', cls: 'btn-muted', value: false },
            { label: 'Yes', cls: 'btn-primary', value: true },
          ],
        });
        await window.electronAPI?.respondToQuitConfirmation?.(confirmed);
      }
    });

    return unsubscribe;
  }, [modal, navigate, setUpdateState, showUpdateModal]);

  return null;
}

function UpdateTechnicalDetails({ details }) {
  const text = String(details || '').trim();
  if (!text) return null;
  return (
    <details className="update-technical-details">
      <summary>Technical details</summary>
      <pre>{text}</pre>
    </details>
  );
}

function MtsUpdateModal({ updateInfo, updaterStatus, onClose }) {
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

  const handleAction = async () => {
    if (manualMode) {
      await handleManual();
      return;
    }
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
    if (manualOpening || manualOpenStatus) return;
    setManualOpening(true);
    try {
      const result = await window.electronAPI?.updaterManualDownload?.();
      if (result?.ok) {
        setManualOpenStatus('The update page opened in your browser. Download and run the installer to update.');
      } else {
        setManualOpenStatus(result?.error || 'Manual update link is invalid. Please check update-MTS.');
      }
    } finally {
      setManualOpening(false);
    }
  };

  const cleanNote = (value) => String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const notes = (Array.isArray(updateInfo.notes) ? updateInfo.notes : [updateInfo.notes])
    .flatMap(cleanNote)
    .filter(Boolean);

  return (
    <div className="cmodal-overlay open">
      <div className="cmodal" style={{ maxWidth: '600px', width: '90%' }}>
        <img className="cmodal-graphic" src={updateGraphic} alt="" style={{ height: '60px', objectFit: 'contain' }} />
        <div className="cmodal-title" style={{ fontSize: '1.4rem', marginBottom: '8px' }}>
          Update Available - {updateInfo.releaseTitle || `Version ${updateInfo.latestVersion}`}
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
          <UpdateTechnicalDetails details={technicalDetails} />

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
          {(manualMode || !required) && (
            <button className="btn btn-muted" onClick={onClose} disabled={isInstalling}>
              Close
            </button>
          )}
          <button className="btn btn-success" onClick={handleAction} disabled={buttonDisabled}>
            {manualOpening ? 'Opening...' : buttonText}
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
  const [quickStartOpen, setQuickStartOpen] = useState(false);
  const [appVersion, setAppVersion] = useState(() => window.electronAPI?.getVersion?.() || APP_VERSION_FALLBACK);
  const [updateState, setUpdateState] = useState({ currentVersion: APP_VERSION_FALLBACK, pendingUpdate: null, installedUpdate: null });
  const [mtsUpdateModal, setMtsUpdateModal] = useState(null);
  const [notificationGroups, setNotificationGroups] = useState(() => readTickerCache());
  const [dismissedBannerIds, setDismissedBannerIds] = useState(() => readStoredIds(DISMISSED_NOTIFICATION_BANNERS_KEY));
  const [discordOpen, setDiscordOpen] = useState(false);
  const [discordInitialTab, setDiscordInitialTab] = useState('templates');
  const [discordInitialPaletteOpen, setDiscordInitialPaletteOpen] = useState(false);
  const [discordInitialFilter, setDiscordInitialFilter] = useState('');
  const [discordInitialShortcutKey, setDiscordInitialShortcutKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState('Starting app...');
  const [loadingProgress, setLoadingProgress] = useState(10);
  const installedUpdateNoticeRef = useRef(null);
  const popupSessionIdsRef = useRef(new Set());
  const popupFlowActiveRef = useRef(false);
  const tutorialAutoStartRef = useRef(false);
  const discordAutoOpenRef = useRef(false);
  const modal = useModal();
  const [remoteContentVersion, setRemoteContentVersion] = useState(0);
  const discordProductivity = useMemo(
    () => normalizeDiscordProductivitySettings(settings?.discord_productivity),
    [settings?.discord_productivity]
  );
  const appDiscordTemplates = useMemo(() => {
    const source = (!settings?.discord_override && defaults?.discord_templates?.length > 0)
      ? defaults.discord_templates
      : (settings?.discord_templates || []);
    return normalizeDiscordTemplates(source);
  }, [defaults?.discord_templates, settings?.discord_override, settings?.discord_templates]);

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

  useEffect(() => {
    if (!discordProductivity.enableShortcuts) return undefined;
    const handleGlobalDiscordShortcuts = (event) => {
      if (discordOpen) return;
      if (shortcutMatchesEvent(discordProductivity.globalShortcuts.openPosts, event)) {
        event.preventDefault();
        setDiscordInitialTab('templates');
        setDiscordInitialPaletteOpen(false);
        setDiscordInitialFilter('');
        setDiscordInitialShortcutKey('');
        setDiscordOpen(true);
        return;
      }
      if (shortcutMatchesEvent(discordProductivity.globalShortcuts.openScreenshots, event)) {
        event.preventDefault();
        setDiscordInitialTab('screenshots');
        setDiscordInitialPaletteOpen(false);
        setDiscordInitialFilter('');
        setDiscordInitialShortcutKey('');
        setDiscordOpen(true);
        return;
      }
      if (discordProductivity.enableCommandPalette && shortcutMatchesEvent(discordProductivity.globalShortcuts.openCommandPalette, event)) {
        event.preventDefault();
        setDiscordInitialTab('templates');
        setDiscordInitialPaletteOpen(true);
        setDiscordInitialFilter('');
        setDiscordInitialShortcutKey('');
        setDiscordOpen(true);
        return;
      }
      if (shortcutMatchesEvent(discordProductivity.globalShortcuts.focusSearch, event)) {
        event.preventDefault();
        setDiscordInitialTab('templates');
        setDiscordInitialPaletteOpen(false);
        setDiscordInitialFilter('');
        setDiscordInitialShortcutKey('');
        setDiscordOpen(true);
        return;
      }
      if (shortcutMatchesEvent(discordProductivity.globalShortcuts.showFavorites, event)) {
        event.preventDefault();
        setDiscordInitialTab('templates');
        setDiscordInitialPaletteOpen(false);
        setDiscordInitialFilter('favorites');
        setDiscordInitialShortcutKey('');
        setDiscordOpen(true);
        return;
      }
      const shortcutMatch = appDiscordTemplates.find((template) => (
        shortcutMatchesEvent(discordProductivity.favoriteShortcuts[template.key] || getDefaultFavoriteShortcut(template), event)
      ));
      if (shortcutMatch) {
        event.preventDefault();
        setDiscordInitialTab('templates');
        setDiscordInitialPaletteOpen(false);
        setDiscordInitialFilter('');
        setDiscordInitialShortcutKey(shortcutMatch.key);
        setDiscordOpen(true);
      }
    };
    window.addEventListener('keydown', handleGlobalDiscordShortcuts);
    return () => window.removeEventListener('keydown', handleGlobalDiscordShortcuts);
  }, [appDiscordTemplates, discordOpen, discordProductivity]);

  useEffect(() => {
    if (loading || discordAutoOpenRef.current || !discordProductivity.openAutomatically) return;
    discordAutoOpenRef.current = true;
    setDiscordInitialTab('templates');
    setDiscordOpen(true);
  }, [discordProductivity.openAutomatically, loading]);

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

  const refreshHistoryData = useCallback(async (reason = 'manual') => {
    const startedAt = Date.now();
    const [historyResult, statsResult] = await Promise.allSettled([
      api.getHistory(8000),
      api.getHistoryStats(8000),
    ]);
    const nextHistory = historyResult.status === 'fulfilled' && Array.isArray(historyResult.value)
      ? historyResult.value
      : null;
    const nextStats = statsResult.status === 'fulfilled'
      ? (statsResult.value || {})
      : null;

    if (nextHistory) {
      setHistory(nextHistory);
    }
    if (nextStats) {
      setHistoryStats(nextStats);
    }

    console.log('[HISTORY REFRESH]', {
      reason,
      durationMs: Date.now() - startedAt,
      historyOk: historyResult.status === 'fulfilled',
      statsOk: statsResult.status === 'fulfilled',
      historyCount: nextHistory ? nextHistory.length : 0,
    });

    if (historyResult.status === 'rejected' && statsResult.status === 'rejected') {
      throw historyResult.reason || statsResult.reason;
    }

    return {
      history: nextHistory || [],
      stats: nextStats || {},
    };
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
        title: `Updated Successfully - Version ${updateState.installedUpdate.latestVersion}`,
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
            setSoundSettings(s || {});
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

            // Check if remote content is still loading in the background on uvicorn
            const sources = defs?._content_sources || {};
            const stillLoading = Object.values(sources).some(
              (src) => src.background_loading || src.background_status === 'loading'
            );
            if (stillLoading && !cancelled) {
              let attempts = 0;
              const maxAttempts = 15;
              const pollInterval = window.setInterval(async () => {
                if (cancelled) {
                  window.clearInterval(pollInterval);
                  return;
                }
                attempts++;
                try {
                  console.log(`[STARTUP] Polling remote content defaults... attempt ${attempts}`);
                  const nextDefs = await api.getDefaults(5000);
                  const nextSources = nextDefs?._content_sources || {};
                  const nextStillLoading = Object.values(nextSources).some(
                    (src) => src.background_loading || src.background_status === 'loading'
                  );
                  if (!nextStillLoading || attempts >= maxAttempts) {
                    window.clearInterval(pollInterval);
                    setDefaults(nextDefs || emptyDefaults());
                    setRemoteContentVersion(v => v + 1);
                    console.log(`[STARTUP] Remote content loading finished after ${attempts} polls. Version bumped.`);
                  }
                } catch (err) {
                  console.warn(`[STARTUP] Failed to poll defaults:`, err);
                  if (attempts >= maxAttempts) {
                    window.clearInterval(pollInterval);
                  }
                }
              }, 3000);
              recoveryTimeouts.push(pollInterval);
            }
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

        // Candidate-name/headset reconciliation is intentionally non-blocking.
        // The local History request above is allowed to render first.
        api.reconcileHistory(20000).then((result) => {
          if (cancelled) return;
          if (Array.isArray(result?.history)) setHistory(result.history);
          if (result?.stats) setHistoryStats(result.stats);
        }).catch(() => {
          // Local History remains authoritative for availability while remote sync is unavailable.
        });

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

    let cancelled = false;

    const requestGuard = createTickerRequestGuard();

    const refreshNotifications = async () => {
      const sequence = requestGuard.begin();
      const startedAt = Date.now();
      console.log('[STARTUP] ticker notifications started');
      try {
        const payload = await refreshTickerNotifications(() => api.getNotifications());
        const groups = normalizeTickerGroups(payload);
        if (!cancelled && requestGuard.isLatest(sequence) && groups) {
          setNotificationGroups(groups);
          writeTickerCache(payload);
          logTimedRequest('tickerNotifications', 'succeeded', startedAt, {
            shape: summarizePayload(payload),
            source: payload?.source || 'unknown',
          });
        }
      } catch (error) {
        // Preserve the cached/default ticker already on screen.
        console.warn('[NOTIFICATIONS] Failed to load notifications:', error?.message || error);
        logTimedRequest('tickerNotifications', 'failed', startedAt, {
          error: error?.message || String(error),
          fallbackUsed: true,
        });
      }
    };

    refreshNotifications();
    const interval = window.setInterval(refreshNotifications, TICKER_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      requestGuard.invalidate();
      window.clearInterval(interval);
    };
  }, [loading, remoteContentVersion]);

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
        setSoundSettings(s || {});
      }).catch(() => {});
    }
  }, [page]);

  const handleSetupCompleted = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setSettings(s);
      setSoundSettings(s || {});
    } catch (_error) {
      // Ignore settings refresh errors here; the user can still proceed to Home.
    }

    localStorage.removeItem(TUTORIAL_AFTER_SETUP_KEY);
    localStorage.setItem(MTS_QUICK_START_STATE_KEY, 'pending');
    setQuickStartOpen(true);
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

  const closeQuickStart = useCallback(() => {
    localStorage.setItem(MTS_QUICK_START_STATE_KEY, 'seen');
    setQuickStartOpen(false);
    navigate('home', null);
  }, [navigate]);

  const replayQuickStart = useCallback(() => {
    setTutorialRun(false);
    setQuickStartOpen(true);
  }, []);

  useEffect(() => {
    if (loading || tutorialRun) {
      return;
    }

    if (localStorage.getItem(MTS_QUICK_START_STATE_KEY) !== 'pending') {
      return;
    }

    if (page !== 'home') {
      navigate('home', null);
      return;
    }

    setQuickStartOpen(true);
  }, [loading, navigate, page, tutorialRun]);

  useEffect(() => {
    if (loading || tutorialRun || tutorialAutoStartRef.current) {
      return;
    }

    if (!settings?.setup_complete || settings?.tutorial_completed === true || localStorage.getItem(MTS_QUICK_START_STATE_KEY)) {
      return;
    }

    if (page !== 'home') {
      navigate('home', null);
      return;
    }

    tutorialAutoStartRef.current = true;
    localStorage.setItem(MTS_QUICK_START_STATE_KEY, 'pending');
    setQuickStartOpen(true);
  }, [loading, navigate, page, settings, tutorialRun]);

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
        { label: 'No', cls: 'btn-muted', value: false },
        { label: 'Yes', cls: 'btn-primary', value: true },
      ],
    });

    if (confirmed) {
      window.close();
    }
  }, [modal]);

  const visibleBanners = notificationGroups.banners.filter((notification) => (
    notification.persistent || !dismissedBannerIds.has(notification.id)
  ));

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
      {quickStartOpen ? (
        <PostSetupQuickStart
          app="mts"
          onWatch={() => {
            localStorage.setItem(MTS_QUICK_START_STATE_KEY, 'seen');
            setQuickStartOpen(false);
            startFullTutorial();
          }}
          onGuide={() => {
            localStorage.setItem(MTS_QUICK_START_STATE_KEY, 'seen');
            setQuickStartOpen(false);
            navigate('help', { section: 'getting-started' });
          }}
          onContinue={closeQuickStart}
        />
      ) : null}

      <div className="app-root" data-testid="app-root">
        <MtsTickerBar notificationGroups={notificationGroups} settings={settings} appVersion={appVersion} />
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
              <button className="action-btn action-discord" onClick={() => { setDiscordInitialTab('templates'); setDiscordInitialPaletteOpen(false); setDiscordOpen(true); }} data-testid="link-discord" data-tour="sidebar-discord" title={sidebarCollapsed ? 'Discord Post' : 'Open Discord message templates'}>
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
                  onReplayQuickStart={replayQuickStart}
                  onSetupCompleted={handleSetupCompleted}
                  startupStatuses={startupStatuses}
                  setMtsUpdateModal={setMtsUpdateModal}
                  onHistoryRefresh={refreshHistoryData}
                />
              )}
            </div>
            <div className="status-bar">
              <span id="status-text"></span>
              <span className="status-spacer" />
              <span>{`Mock Testing Suite v${appVersion} - By Shawn P. Bly`}</span>
            </div>
          </main>
        </div>

        {discordOpen && (
          <DiscordModal
            settings={settings}
            defaults={defaults}
            currentSession={currentSession}
            initialTab={discordInitialTab}
            initialPaletteOpen={discordInitialPaletteOpen}
            initialFilter={discordInitialFilter}
            initialShortcutKey={discordInitialShortcutKey}
            onPaletteHandled={() => setDiscordInitialPaletteOpen(false)}
            onShortcutHandled={() => setDiscordInitialShortcutKey('')}
            onClose={() => setDiscordOpen(false)}
          />
        )}
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

const DISCORD_FAVORITES_KEY = 'mts-discord-favorite-template-keys';
const DISCORD_FAVORITES_INITIALIZED_KEY = 'mts-discord-favorite-template-keys-initialized';
const DISCORD_RECENT_KEY = 'mts-discord-recent-template-keys';
const DEFAULT_DISCORD_FAVORITES = [
  'wrong headset',
  'vpn fail',
  'technical issue',
  'no script pop',
  'sup transfer failed',
  'failed 1st sup transfer',
];

function discordTemplateKey(item) {
  return `${String(item?.category || '').trim().toLowerCase()}::${String(item?.title || '').trim().toLowerCase()}`;
}

function normalizeDiscordTemplates(source, defaultCategory = 'Uncategorized') {
  return (Array.isArray(source) ? source : []).map(t => {
    if (!t) return null;
    if (Array.isArray(t)) {
      return { category: String(t[2] || defaultCategory), title: String(t[0] || ''), message: normalizeDiscordMessageWhitespace(t[1]) };
    }
    if (typeof t === 'object') {
      const category = t.category || t.Category || t.group || t.Group || '';
      const title = t.title || t.Title || t.name || t.Name || t.label || t.Label || '';
      const message = t.message || t.Message || t.text || t.Text || t.content || t.Content || t.body || t.Body || '';
      const normalized = { category: String(category || defaultCategory), title: String(title), message: normalizeDiscordMessageWhitespace(message) };
      const explicitSuggestedScreenshots = getDiscordPostSuggestedScreenshotPaths(t);
      if (explicitSuggestedScreenshots.length || Object.prototype.hasOwnProperty.call(t, 'suggestedScreenshots') || Object.prototype.hasOwnProperty.call(t, 'suggested_screenshots') || Object.prototype.hasOwnProperty.call(t, 'SuggestedScreenshots')) {
        normalized.suggestedScreenshots = explicitSuggestedScreenshots;
      }
      return normalized;
    }
    return null;
  }).filter(Boolean).map((item) => ({ ...item, key: discordTemplateKey(item) }));
}

function hasStoredDiscordKeys(storageKey) {
  try {
    return window.localStorage.getItem(storageKey) !== null;
  } catch (_error) {
    return false;
  }
}

function markStoredDiscordKeysInitialized(storageKey) {
  try {
    window.localStorage.setItem(storageKey, 'true');
  } catch (_error) {}
}

function readStoredDiscordKeys(storageKey) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || '[]');
    return normalizeDiscordKeyList(parsed);
  } catch (_error) {
    return [];
  }
}

function saveStoredDiscordKeys(storageKey, keys) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(normalizeDiscordKeyList(keys)));
  } catch (_error) {}
}

function titleMatchesAny(title, needles) {
  const normalized = String(title || '').toLowerCase();
  return needles.some((needle) => normalized.includes(needle));
}

function getDefaultFavoriteKeys(templates) {
  return templates
    .filter((item) => titleMatchesAny(item.title, DEFAULT_DISCORD_FAVORITES))
    .map(discordTemplateKey)
    .slice(0, 8);
}

function getSuggestedDiscordKeys(templates, currentSession) {
  const session = currentSession?.session || currentSession || {};
  const haystack = [
    session.auto_fail_reason,
    session.tech_issue,
    session.fail_summary,
    session.reason_for_fail_summary,
    session.headset_brand,
    session.sup_transfer_1?.result,
    session.sup_transfer_2?.result,
    session.sup_transfer_1_result,
    session.sup_transfer_2_result,
    session.vpn_on === true ? 'vpn' : '',
    session.vpn_off === false ? 'vpn fail' : '',
  ].join(' ').toLowerCase();
  const suggestions = [];
  const addMatch = (needles) => {
    const match = templates.find((item) => titleMatchesAny(item.title, needles));
    if (match) suggestions.push(discordTemplateKey(match));
  };
  if (/headset|noise|usb/.test(haystack)) addMatch(['wrong headset', 'headset']);
  if (/vpn|proxy/.test(haystack)) addMatch(['vpn fail', 'vpn failed', 'vpn']);
  if (/tech|technical|internet|speed|discord|script|route/.test(haystack)) addMatch(['technical issue', 'tech issue']);
  if (/no script/.test(haystack)) addMatch(['no script pop']);
  if (/sup|supervisor/.test(haystack) && /fail/.test(haystack)) addMatch(['sup transfer failed', 'failed 1st sup transfer', 'supervisor']);
  return Array.from(new Set(suggestions)).slice(0, 5);
}

function DiscordModal({ settings, defaults, currentSession, initialTab = 'templates', initialPaletteOpen = false, initialFilter = '', initialShortcutKey = '', onPaletteHandled, onShortcutHandled, onClose }) {
  const defaultCategory = 'Uncategorized';
  const [modalDefaults, setModalDefaults] = useState(defaults || emptyDefaults());
  const [defaultsLoadStatus, setDefaultsLoadStatus] = useState('idle');
  const defaultsFetchStartedRef = useRef(false);
  const searchRef = useRef(null);
  const paletteSearchRef = useRef(null);
  const [copiedKey, setCopiedKey] = useState('');
  const [copyToast, setCopyToast] = useState('');
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(Boolean(initialPaletteOpen));
  const [paletteSearch, setPaletteSearch] = useState('');
  const [paletteSelectedIndex, setPaletteSelectedIndex] = useState(0);
  const [favoriteKeys, setFavoriteKeys] = useState(() => readStoredDiscordKeys(DISCORD_FAVORITES_KEY));
  const [favoritesInitialized, setFavoritesInitialized] = useState(() => (
    hasStoredDiscordKeys(DISCORD_FAVORITES_KEY) || hasStoredDiscordKeys(DISCORD_FAVORITES_INITIALIZED_KEY)
  ));
  const [recentKeys, setRecentKeys] = useState(() => readStoredDiscordKeys(DISCORD_RECENT_KEY));
  const [selectedKey, setSelectedKey] = useState('');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState(initialTab === 'screenshots' ? 'screenshots' : 'templates');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [showRecentOnly, setShowRecentOnly] = useState(false);
  const productivity = useMemo(
    () => normalizeDiscordProductivitySettings(settings?.discord_productivity),
    [settings?.discord_productivity]
  );

  useEffect(() => {
    setModalDefaults(defaults || emptyDefaults());
  }, [defaults]);

  useEffect(() => {
    setTab(initialTab === 'screenshots' ? 'screenshots' : 'templates');
  }, [initialTab]);

  useEffect(() => {
    if (!initialPaletteOpen) return;
    setTab('templates');
    setCommandPaletteOpen(true);
    onPaletteHandled?.();
  }, [initialPaletteOpen, onPaletteHandled]);

  useEffect(() => {
    if (!initialFilter) return;
    setTab('templates');
    setShowFavoritesOnly(initialFilter === 'favorites');
    setShowRecentOnly(initialFilter === 'recent');
  }, [initialFilter]);

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

  const screenshotsSrc = useMemo(() => (
    (!settings?.discord_override && activeDefaults?.discord_screenshots?.length > 0)
      ? activeDefaults.discord_screenshots
      : (settings?.discord_screenshots || [])
  ), [activeDefaults?.discord_screenshots, settings?.discord_override, settings?.discord_screenshots]);

  const templates = useMemo(() => normalizeDiscordTemplates(templatesSrc, defaultCategory), [templatesSrc]);

  useEffect(() => {
    if (favoritesInitialized || favoriteKeys.length || !templates.length) return;
    const defaults = getDefaultFavoriteKeys(templates);
    if (!defaults.length) {
      markStoredDiscordKeysInitialized(DISCORD_FAVORITES_INITIALIZED_KEY);
      setFavoritesInitialized(true);
      return;
    }
    setFavoriteKeys(defaults);
    saveStoredDiscordKeys(DISCORD_FAVORITES_KEY, defaults);
    markStoredDiscordKeysInitialized(DISCORD_FAVORITES_INITIALIZED_KEY);
    setFavoritesInitialized(true);
  }, [favoriteKeys.length, favoritesInitialized, templates]);

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

  const screenshots = useMemo(() => screenshotsSrc.map(s => {
    if (!s) return null;
    if (typeof s === 'object') {
      const category = s.category || s.Category || s.group || s.Group || '';
      const title = s.title || s.name || 'Screenshot';
      const imageUrl = s.image_url || s.imageUrl || s.url || s.src || '';
      return { category: String(category || defaultCategory), title: String(title), imageUrl: String(imageUrl) };
    }
    return null;
  }).filter(Boolean), [screenshotsSrc]);

  const activeItems = useMemo(() => (tab === 'templates' ? templates : screenshots), [screenshots, tab, templates]);
  const categories = useMemo(() => {
    const seen = new Set();
    activeItems.forEach((item) => {
      const category = String(item.category || '').trim();
      if (category) seen.add(category);
    });
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [activeItems]);

  useEffect(() => {
    setCategoryFilter('all');
    setShowFavoritesOnly(false);
    setShowRecentOnly(false);
  }, [tab]);

  useEffect(() => {
    searchRef.current?.focus();
  }, [tab]);

  useEffect(() => {
    if (!commandPaletteOpen) return;
    setPaletteSearch('');
    setPaletteSelectedIndex(0);
    window.setTimeout(() => paletteSearchRef.current?.focus(), 0);
  }, [commandPaletteOpen]);

  useEffect(() => {
    if (categoryFilter !== 'all' && !categories.includes(categoryFilter)) {
      setCategoryFilter('all');
    }
  }, [categories, categoryFilter]);

  const favoriteKeySet = useMemo(() => new Set(favoriteKeys), [favoriteKeys]);
  const byKey = useMemo(() => new Map(templates.map((item) => [item.key, item])), [templates]);
  const filteredTemplates = useMemo(() => {
    const query = search.toLowerCase();
    const source = showRecentOnly
      ? recentKeys.map((key) => byKey.get(key)).filter(Boolean)
      : showFavoritesOnly
        ? favoriteKeys.map((key) => byKey.get(key)).filter(Boolean)
        : templates;
    return source.filter(({ category, title, message }) =>
      (categoryFilter === 'all' || category === categoryFilter) &&
      (
        category.toLowerCase().includes(query) ||
        title.toLowerCase().includes(query) ||
        message.toLowerCase().includes(query)
      )
    );
  }, [byKey, categoryFilter, favoriteKeys, recentKeys, search, showFavoritesOnly, showRecentOnly, templates]);
  const sectionTitle = useMemo(() => {
    if (showRecentOnly) return `Showing Recent (${filteredTemplates.length})`;
    if (showFavoritesOnly) return `Showing Favorites (${filteredTemplates.length})`;
    if (search || categoryFilter !== 'all') return `Matching Posts (${filteredTemplates.length})`;
    return `All Posts (${filteredTemplates.length})`;
  }, [categoryFilter, filteredTemplates.length, search, showFavoritesOnly, showRecentOnly]);
  const visibleTemplates = filteredTemplates;
  const suggestedKeys = useMemo(() => getSuggestedDiscordKeys(templates, currentSession), [templates, currentSession]);
  const paletteResults = useMemo(() => {
    const query = paletteSearch.trim().toLowerCase();
    if (!query) {
      const suggested = suggestedKeys.map((key) => byKey.get(key)).filter(Boolean);
      const suggestedSet = new Set(suggested.map((item) => item.key));
      return [...suggested, ...templates.filter((item) => !suggestedSet.has(item.key))].slice(0, 12);
    }
    return templates
      .filter((template) => getDiscordCommandSearchText(template).includes(query))
      .slice(0, 12);
  }, [byKey, paletteSearch, suggestedKeys, templates]);
  const selectedTemplate = useMemo(() => {
    if (!visibleTemplates.length) return null;
    return visibleTemplates.find((item) => item.key === selectedKey) || visibleTemplates[0];
  }, [selectedKey, visibleTemplates]);

  useEffect(() => {
    if (tab !== 'templates') return;
    if (!visibleTemplates.length) {
      setSelectedKey('');
      return;
    }
    if (!visibleTemplates.some((item) => item.key === selectedKey)) {
      setSelectedKey(visibleTemplates[0].key);
    }
  }, [selectedKey, tab, visibleTemplates]);

  useEffect(() => {
    setPaletteSelectedIndex((current) => Math.max(0, Math.min(current, Math.max(0, paletteResults.length - 1))));
  }, [paletteResults.length]);

  const filteredScreenshots = screenshots.filter(s =>
    (categoryFilter === 'all' || s.category === categoryFilter) &&
    (
      s.category.toLowerCase().includes(search.toLowerCase()) ||
      s.title.toLowerCase().includes(search.toLowerCase())
    )
  );

  const copyTemplate = useCallback(async (template) => {
    if (!template?.message) return;
    await navigator.clipboard.writeText(template.message);
    setCopiedKey(template.key);
    if (productivity.showCopyToast) {
      setCopyToast('✓ Copied to clipboard');
      window.setTimeout(() => setCopyToast(''), 2200);
    }
    window.setTimeout(() => setCopiedKey((current) => (current === template.key ? '' : current)), 3000);
    setRecentKeys((current) => {
      const next = [template.key, ...current.filter((key) => key !== template.key)].slice(0, 8);
      saveStoredDiscordKeys(DISCORD_RECENT_KEY, next);
      return next;
    });
  }, [productivity.showCopyToast]);

  useEffect(() => {
    if (!initialShortcutKey || !templates.length) return;
    const match = templates.find((template) => template.key === initialShortcutKey);
    if (match) {
      setTab('templates');
      setSelectedKey(match.key);
      if (productivity.automaticCopy) {
        copyTemplate(match);
      }
    }
    onShortcutHandled?.();
  }, [copyTemplate, initialShortcutKey, onShortcutHandled, productivity.automaticCopy, templates]);

  const toggleFavorite = useCallback((template) => {
    if (!template?.key) return;
    markStoredDiscordKeysInitialized(DISCORD_FAVORITES_INITIALIZED_KEY);
    setFavoritesInitialized(true);
    setFavoriteKeys((current) => {
      const next = nextDiscordFavoriteKeys(current, template.key);
      saveStoredDiscordKeys(DISCORD_FAVORITES_KEY, next);
      return next;
    });
  }, []);

  const moveSelection = useCallback((direction) => {
    if (!visibleTemplates.length) return;
    const index = Math.max(0, visibleTemplates.findIndex((item) => item.key === (selectedTemplate?.key || selectedKey)));
    const nextIndex = Math.max(0, Math.min(visibleTemplates.length - 1, index + direction));
    setSelectedKey(visibleTemplates[nextIndex].key);
  }, [selectedKey, selectedTemplate?.key, visibleTemplates]);

  const handleKeyDown = useCallback((event) => {
    if (commandPaletteOpen) return;
    if (shortcutMatchesEvent(productivity.globalShortcuts.openPosts, event)) {
      event.preventDefault();
      setTab('templates');
      return;
    }
    if (shortcutMatchesEvent(productivity.globalShortcuts.openScreenshots, event)) {
      event.preventDefault();
      setTab('screenshots');
      return;
    }
    if (productivity.enableShortcuts && productivity.enableCommandPalette && shortcutMatchesEvent(productivity.globalShortcuts.openCommandPalette, event)) {
      event.preventDefault();
      setTab('templates');
      setCommandPaletteOpen(true);
      return;
    }
    if (shortcutMatchesEvent(productivity.globalShortcuts.showFavorites, event)) {
      event.preventDefault();
      setTab('templates');
      setShowRecentOnly(false);
      setShowFavoritesOnly((current) => !current);
      return;
    }
    if (shortcutMatchesEvent(productivity.globalShortcuts.focusSearch, event)) {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    }
    if (shortcutMatchesEvent(productivity.globalShortcuts.close, event) || event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (productivity.enableShortcuts) {
      const categoryShortcut = DISCORD_CATEGORY_SHORTCUTS.find((item) => shortcutMatchesEvent(productivity.categoryShortcuts[item.key] || item.shortcut, event));
      if (categoryShortcut) {
        event.preventDefault();
        setTab('templates');
        if (categoryShortcut.key === 'favorites') {
          setShowFavoritesOnly(true);
          setShowRecentOnly(false);
          setCategoryFilter('all');
        } else {
          const matchingCategory = categories.find((category) => getDiscordCategoryMeta(category).key === categoryShortcut.key);
          setCategoryFilter(matchingCategory || 'all');
          setShowFavoritesOnly(false);
          setShowRecentOnly(false);
        }
        return;
      }
      const shortcutMatch = templates.find((template) => shortcutMatchesEvent(productivity.favoriteShortcuts[template.key] || getDefaultFavoriteShortcut(template), event));
      if (shortcutMatch) {
        event.preventDefault();
        setTab('templates');
        setSelectedKey(shortcutMatch.key);
        if (productivity.automaticCopy) {
          copyTemplate(shortcutMatch);
        }
        return;
      }
    }
    if (tab !== 'templates') return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (productivity.automaticCopy) {
        copyTemplate(selectedTemplate || visibleTemplates[0]);
      }
    }
  }, [categories, commandPaletteOpen, copyTemplate, moveSelection, onClose, productivity, selectedTemplate, tab, templates, visibleTemplates]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handlePaletteKeyDown = useCallback((event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      setCommandPaletteOpen(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setPaletteSelectedIndex((current) => Math.min(paletteResults.length - 1, current + 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setPaletteSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const template = paletteResults[paletteSelectedIndex] || paletteResults[0];
      if (template) {
        setSelectedKey(template.key);
        copyTemplate(template);
        setCommandPaletteOpen(false);
      }
    }
  }, [copyTemplate, paletteResults, paletteSelectedIndex]);

  const selectedScreenshots = useMemo(() => {
    if (!selectedTemplate) return [];
    return resolveDiscordSuggestedScreenshots(selectedTemplate, screenshots);
  }, [screenshots, selectedTemplate]);

  const handleTabChange = (nextTab) => {
    setTab(nextTab);
    setSearch('');
  };

  return (
    <div className="modal-overlay open" data-testid="discord-modal">
      <div className="modal discord-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Discord Posts</h2>
          <div className="discord-header-actions">
            {copyToast && <span className="discord-copy-toast" role="status">{copyToast}</span>}
            <button type="button" className="discord-help-btn" onClick={() => setShowShortcutHelp(true)} aria-label="Open Discord shortcut reference">⌨ Shortcuts</button>
          </div>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="discord-toolbar" data-testid="discord-productivity-toolbar">
          <label className="discord-search-field">
            <span className="discord-search-label">Search Discord posts</span>
            <span className="discord-search-input-wrap">
              <Search size={16} strokeWidth={2.3} aria-hidden="true" />
              <input ref={searchRef} className="discord-toolbar-search" type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder={tab === 'templates' ? 'Search title, category, keyword, or alias...' : 'Search screenshots...'} data-testid="discord-search" />
            </span>
          </label>
          <div className="discord-secondary-controls">
            <div className="discord-modal-tabs">
              <button className={`tab-btn ${tab === 'templates' ? 'active' : ''}`} onClick={() => handleTabChange('templates')}>Posts</button>
              <button className={`tab-btn ${tab === 'screenshots' ? 'active' : ''}`} onClick={() => handleTabChange('screenshots')}>Screenshots</button>
            </div>
            {categories.length > 0 && (
              <label className="discord-category-filter">
                <span>Category</span>
                <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} data-testid="discord-category-filter">
                  <option value="all">All</option>
                  {categories.map((category) => <option key={category} value={category}>{category}</option>)}
                </select>
              </label>
            )}
            <button type="button" className={`discord-toolbar-toggle ${showFavoritesOnly ? 'active' : ''}`} onClick={() => { setTab('templates'); setShowFavoritesOnly((current) => !current); setShowRecentOnly(false); }}>★ Favorites <span>{favoriteKeys.length}</span></button>
            <button type="button" className={`discord-toolbar-toggle ${showRecentOnly ? 'active' : ''}`} onClick={() => { setTab('templates'); setShowRecentOnly((current) => !current); setShowFavoritesOnly(false); }}>Recent <span>{recentKeys.length}</span></button>
          </div>
        </div>
        {tab === 'templates' && (
          <div className="discord-filter-status" data-testid="discord-filter-status">
            <strong>{sectionTitle}</strong>
            <span>{showRecentOnly ? 'Recent filter is active.' : showFavoritesOnly ? 'Favorites filter is active.' : 'Search is the fastest way to find a post.'}</span>
          </div>
        )}
        <div className="modal-body discord-modal-list">
          {tab === 'templates' ? (
            filteredTemplates.length === 0 ? (
              <p className="text-muted discord-empty-state">
                {defaultsLoadStatus === 'loading'
                  ? 'Loading templates...'
                  : defaultsLoadStatus === 'failed'
                    ? 'Discord templates could not be loaded.'
                    : showRecentOnly
                      ? 'No recent Discord posts yet.'
                      : showFavoritesOnly
                        ? 'No favorite Discord posts match this view.'
                        : 'No Discord posts match this search.'}
              </p>
            ) : (
              <div className="discord-template-workspace">
                <div className="discord-template-list" role="listbox" aria-label="Discord post templates">
                    <div className="discord-template-section" key={sectionTitle}>
                      <div className="discord-section-title">{sectionTitle}</div>
                      {visibleTemplates.map((template) => (
                        <DiscordTemplateListItem
                          key={template.key}
                          template={template}
                          selected={selectedTemplate?.key === template.key}
                          favorite={favoriteKeySet.has(template.key)}
                          copied={copiedKey === template.key}
                          shortcut={productivity.favoriteShortcuts[template.key] || getDefaultFavoriteShortcut(template) || productivity.categoryShortcuts[getDiscordCategoryMeta(template.category, template.title).key] || getDiscordCategoryMeta(template.category, template.title).shortcut}
                          categoryMeta={getDiscordCategoryMeta(template.category, template.title)}
                          onSelect={() => setSelectedKey(template.key)}
                          onCopy={() => copyTemplate(template)}
                          onDoubleClick={() => {
                            setSelectedKey(template.key);
                            if (productivity.automaticCopy) copyTemplate(template);
                          }}
                          onToggleFavorite={() => toggleFavorite(template)}
                        />
                      ))}
                    </div>
                </div>
                <DiscordTemplatePreview
                  template={selectedTemplate}
                  favorite={selectedTemplate ? favoriteKeySet.has(selectedTemplate.key) : false}
                  copied={selectedTemplate ? copiedKey === selectedTemplate.key : false}
                  shortcut={selectedTemplate ? productivity.favoriteShortcuts[selectedTemplate.key] || getDefaultFavoriteShortcut(selectedTemplate) : ''}
                  screenshots={selectedScreenshots}
                  onCopy={() => copyTemplate(selectedTemplate)}
                  onToggleFavorite={() => toggleFavorite(selectedTemplate)}
                />
              </div>
            )
          ) : (
            filteredScreenshots.length === 0 ? (
              <p className="text-muted discord-empty-state">
                {defaultsLoadStatus === 'loading'
                  ? 'Loading screenshots...'
                  : defaultsLoadStatus === 'failed'
                    ? 'Discord screenshots could not be loaded.'
                    : 'No screenshots match your search.'}
              </p>
            ) : filteredScreenshots.map((ss, i) => (
              <DiscordScreenshotRow key={i} category={ss.category} title={ss.title} imageUrl={ss.imageUrl} />
            ))
          )}
        </div>
        {showShortcutHelp && (
          <div className="discord-shortcut-help" role="dialog" aria-label="Discord Productivity Help">
            <div className="discord-shortcut-help-card">
              <div className="discord-shortcut-help-header">
                <h3>Discord Productivity Help</h3>
                <button type="button" className="modal-close" onClick={() => setShowShortcutHelp(false)} aria-label="Close shortcut reference">&times;</button>
              </div>
              <div className="discord-shortcut-grid">
                <ShortcutHelpGroup title="General" rows={DISCORD_GLOBAL_SHORTCUTS.map((item) => [productivity.globalShortcuts[item.key] || item.defaultShortcut, item.label])} />
                <ShortcutHelpGroup title="Searching" rows={[[productivity.globalShortcuts.focusSearch || 'Ctrl+F', 'Focus search'], ['Type keywords, categories, or aliases', 'Filter instantly']]} />
                <ShortcutHelpGroup title="Favorites" rows={[[productivity.globalShortcuts.showFavorites || 'Ctrl+Shift+F', 'Show Favorites'], ['★', 'Favorite or unfavorite a post']]} />
                <ShortcutHelpGroup title="Command Palette" rows={[[productivity.globalShortcuts.openCommandPalette || 'Ctrl+Shift+P', 'Open palette'], ['Enter', 'Copy selected result and close palette']]} />
                <ShortcutHelpGroup title="Navigation" rows={[['Arrow Up/Down', 'Move selection'], ['Double-click', 'Copy immediately']]} />
                <ShortcutHelpGroup title="Categories" rows={DISCORD_CATEGORY_SHORTCUTS.map((item) => [productivity.categoryShortcuts[item.key] || item.shortcut, item.label])} />
                <ShortcutHelpGroup title="Custom Shortcuts" rows={Object.entries(productivity.favoriteShortcuts).map(([key, shortcut]) => [shortcut, byKey.get(key)?.title || 'Favorite post'])} emptyText="Favorite shortcuts are assigned in Settings." />
                <ShortcutHelpGroup title="Mouse Shortcuts" rows={[['Double Click', 'Copy selected post'], ['Copy', 'Copy previewed post']]} />
                <ShortcutHelpGroup title="Double Click" rows={[['Double-click row', 'Copy immediately'], ['✓ Copied', 'Confirms clipboard update']]} />
                <ShortcutHelpGroup title="Copy" rows={[['Enter', 'Copy selected post'], ['Shortcut', 'Copies when automatic copy is enabled']]} />
                <ShortcutHelpGroup title="Screenshots" rows={[[productivity.globalShortcuts.openScreenshots || 'Ctrl+Shift+D', 'Open Screenshot Library'], ['Preview pane', 'Shows up to three configured screenshots'], ['Copy Screenshot', 'Copies each suggested image separately']]} />
              </div>
            </div>
          </div>
        )}
        {commandPaletteOpen && (
          <DiscordCommandPalette
            results={paletteResults}
            query={paletteSearch}
            selectedIndex={paletteSelectedIndex}
            searchRef={paletteSearchRef}
            onQueryChange={(value) => { setPaletteSearch(value); setPaletteSelectedIndex(0); }}
            onKeyDown={handlePaletteKeyDown}
            onClose={() => setCommandPaletteOpen(false)}
            onSelect={(template, index) => {
              setPaletteSelectedIndex(index);
              setSelectedKey(template.key);
            }}
            onChoose={(template) => {
              setSelectedKey(template.key);
              copyTemplate(template);
              setCommandPaletteOpen(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

function DiscordCommandPalette({ results, query, selectedIndex, searchRef, onQueryChange, onKeyDown, onClose, onSelect, onChoose }) {
  return (
    <div className="discord-command-palette-overlay" role="dialog" aria-label="Discord Command Palette">
      <div className="discord-command-palette">
        <div className="discord-command-palette-header">
          <h3>Discord Command Palette</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close Discord Command Palette">&times;</button>
        </div>
        <input
          ref={searchRef}
          className="discord-command-search"
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search Discord posts..."
          data-testid="discord-command-palette-search"
        />
        <div className="discord-command-results" role="listbox" aria-label="Discord command results">
          {results.length ? results.map((template, index) => {
            const categoryMeta = getDiscordCategoryMeta(template.category, template.title);
            return (
              <button
                key={template.key}
                type="button"
                className={`discord-command-result ${index === selectedIndex ? 'selected' : ''}`}
                onMouseEnter={() => onSelect(template, index)}
                onClick={() => onChoose(template)}
                role="option"
                aria-selected={index === selectedIndex}
              >
                <span className="discord-command-result-title">{template.title}</span>
                <span className={`discord-category-badge badge-${categoryMeta.key}`}>{categoryMeta.label}</span>
              </button>
            );
          }) : (
            <p className="text-muted discord-command-empty">No Discord posts match this search.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ShortcutHelpGroup({ title, rows, emptyText = 'No shortcuts configured.' }) {
  return (
    <div className="discord-shortcut-group">
      <h4>{title}</h4>
      {(rows || []).length ? rows.map(([keys, label]) => (
        <div className="discord-shortcut-row" key={`${title}-${keys}-${label}`}>
          <kbd>{keys}</kbd>
          <span>{label}</span>
        </div>
      )) : <p className="text-muted text-sm">{emptyText}</p>}
    </div>
  );
}

function DiscordTemplateListItem({ template, selected, favorite, copied, shortcut, categoryMeta, onSelect, onCopy, onDoubleClick, onToggleFavorite }) {
  return (
    <button
      type="button"
      className={`discord-template-list-item ${selected ? 'selected' : ''}`}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      role="option"
      aria-selected={selected}
    >
      <span className="discord-favorite-indicator" aria-label={favorite ? 'Favorite' : 'Not favorite'} onClick={(event) => { event.stopPropagation(); onToggleFavorite(); }}>{favorite ? '★' : '☆'}</span>
      <span className="discord-template-list-main">
        <span className="discord-title discord-template-title">{template.title}</span>
        <span className="discord-template-list-meta">
          {template.category && <span className={`discord-category-badge badge-${categoryMeta.key}`}>{categoryMeta.label}</span>}
          {shortcut && <span className="discord-shortcut-badge">{shortcut}</span>}
          {copied && <span className="discord-copied-inline">✓ Copied</span>}
        </span>
      </span>
      <div className="discord-template-quick-actions" onClick={(event) => event.stopPropagation()}>
        <button type="button" className={`discord-copy ${copied ? 'copied' : ''}`} onClick={onCopy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </button>
  );
}

function DiscordTemplatePreview({ template, favorite, copied, shortcut, screenshots = [], onCopy, onToggleFavorite }) {
  const [screenshotCopied, setScreenshotCopied] = useState({});
  if (!template) {
    return <div className="discord-template-preview-panel discord-template-preview-empty">Select a Discord post to preview it.</div>;
  }
  const categoryMeta = getDiscordCategoryMeta(template.category, template.title);
  const copyScreenshot = async (screenshot, index) => {
    const resolvedScreenshotUrl = screenshot?.imageUrl ? resolveScreenshotUrl(screenshot.imageUrl) : '';
    if (!resolvedScreenshotUrl) return;
    try {
      const resp = await fetch(resolvedScreenshotUrl);
      if (!resp.ok) throw new Error(`Image request failed with status ${resp.status}`);
      const blob = await resp.blob();
      if (!blob.type.startsWith('image/')) throw new Error('Referenced file is not an image.');
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    } catch (_error) {
      await navigator.clipboard.writeText(resolvedScreenshotUrl);
    }
    setScreenshotCopied((current) => ({ ...current, [index]: true }));
    window.setTimeout(() => setScreenshotCopied((current) => ({ ...current, [index]: false })), 2500);
  };
  return (
    <aside className="discord-template-preview-panel">
      <div className="discord-preview-top">
        <div>
          {template.category && <span className={`discord-category-badge badge-${categoryMeta.key}`}>{categoryMeta.label}</span>}
          <h3>{template.title}</h3>
          {shortcut && <span className="discord-shortcut-badge">{shortcut}</span>}
        </div>
        <button type="button" className="discord-mini-btn" onClick={onToggleFavorite}>{favorite ? '★ Favorite' : '☆ Favorite'}</button>
      </div>
      <div className="discord-preview-message">{template.message}</div>
      <div className="discord-preview-notes">
        <h4>Notes</h4>
        <p>Double-click the row or press Enter to copy the selected Discord post. Copy the post and screenshot separately if Discord does not paste both together.</p>
      </div>
      {screenshots.length ? (
        <div className="discord-preview-screenshot">
          <h4>Suggested Screenshots</h4>
          <div className="discord-suggested-screenshot-list">
            {screenshots.map((screenshot, index) => {
              const resolvedScreenshotUrl = screenshot?.imageUrl ? resolveScreenshotUrl(screenshot.imageUrl) : '';
              if (!resolvedScreenshotUrl) return null;
              return (
                <div className="discord-suggested-screenshot" key={`${screenshot.imageUrl || screenshot.title}-${index}`}>
                  <div className="discord-preview-screenshot-head">
                    <div>
                      <strong>Screenshot {index + 1}</strong>
                      <span>{screenshot.title || 'Suggested screenshot'}</span>
                    </div>
                    <button type="button" className={`discord-copy ${screenshotCopied[index] ? 'copied' : ''}`} onClick={() => copyScreenshot(screenshot, index)}>{screenshotCopied[index] ? 'Copied' : 'Copy Screenshot'}</button>
                  </div>
                  <img src={resolvedScreenshotUrl} alt={screenshot.title || `Discord screenshot ${index + 1}`} />
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="discord-preview-actions">
        <button type="button" className={`discord-copy discord-preview-copy ${copied ? 'copied' : ''}`} onClick={onCopy}>{copied ? 'Copied' : 'Copy Post'}</button>
      </div>
    </aside>
  );
}

function DiscordScreenshotRow({ category, title, imageUrl }) {
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
    <div className="discord-row discord-screenshot-row">
      <div className="discord-screenshot-header">
        <div className="discord-title-row">
          {category && <span className="discord-category-badge">{category}</span>}
          <div className="discord-title">{title}</div>
        </div>
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
          className="discord-screenshot-preview"
        />
      ) : (
        <div className="text-muted discord-screenshot-missing">
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
