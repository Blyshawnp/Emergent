import React, { useState, useEffect, useCallback, useRef } from 'react';
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
import mtsLogo from './assets/images/MTSLogonew.png';
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

const NAV_ITEMS = [
  { key: 'home', label: 'Home', emoji: '\uD83C\uDFE0' },
  { key: 'basics', label: 'The Basics', emoji: '\uD83D\uDCCB' },
  { key: 'calls', label: 'Calls', emoji: '\u260F' },
  { key: 'suptransfer', label: 'Sup Transfer', emoji: '\uD83D\uDD04' },
  { key: 'review', label: 'Review', emoji: '\uD83D\uDCC4' },
  { key: 'history', label: 'History', emoji: '\uD83D\uDCCA' },
  { key: 'settings', label: 'Settings', emoji: '\u2699\uFE0F' },
  { key: 'help', label: 'Help', emoji: '\u2139' },
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
  const title = notification.title
    ? `<div style="font-weight:700; margin-bottom:8px;">${notification.title}</div>`
    : '';
  const action = notification.actionURL
    ? `<div style="margin-top:14px;">Action available: <strong>${notification.actionText || 'Open'}</strong></div>`
    : '';

  return `${title}<div>${notification.message}</div>${action}`;
}

function resolveScreenshotUrl(imageUrl) {
  const value = String(imageUrl || '').trim();
  if (!value) return '';
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  return value.replace(/^\/+/, '');
}

function PageRouter({ page, navigate, navigationState, updateState, refreshUpdateState, appVersion, settings, onReplayTutorial, onSetupCompleted }) {
  const props = { onNavigate: navigate, navigationState, updateState, refreshUpdateState, appVersion, settings, onReplayTutorial, onSetupCompleted };
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
  const notes = updateInfo.notes || [];
  const notesContent = notesAsBullets
    ? notes.map((note) => `<li>${note}</li>`).join('')
    : notes.map((note) => `<div>${note}</div>`).join('');

  const detailLines = [
    updateInfo.releaseTitle ? `<strong>${updateInfo.releaseTitle}</strong>` : '',
    updateInfo.releaseDate ? `<div class="text-muted">Released ${updateInfo.releaseDate}</div>` : '',
    `<div style="margin-top:12px;"><strong>Current:</strong> v${updateInfo.currentVersion}</div>`,
    `<div><strong>New:</strong> v${updateInfo.latestVersion}</div>`,
    notesContent
      ? `<div style="margin-top:12px;"><strong>Notes:</strong>${notesAsBullets ? `<ul style="margin:8px 0 0 18px;">${notesContent}</ul>` : `<div style="margin-top:8px;">${notesContent}</div>`}</div>`
      : '',
    updateInfo.downloadUrl ? '' : '<div style="margin-top:12px;"><strong>Installer link:</strong> Not published in the update document yet.</div>',
    includeDeferredNote ? '<div style="margin-top:12px;">This update can be installed later from Settings by clicking <strong>Install Update</strong>.</div>' : '',
  ].filter(Boolean);

  return detailLines.join('');
}

function ElectronEventBridge({ navigate, setUpdateState }) {
  const modal = useModal();

  const showUpdateModal = useCallback(async (updateInfo) => {
    const confirmed = await modal.showModal({
      type: 'confirm',
      title: `Update Available — Version ${updateInfo.latestVersion}`,
      body: formatUpdateBody(updateInfo),
      graphic: 'update',
      buttons: [
        { label: 'Install Update', cls: 'btn-success', value: true },
        { label: 'Later', cls: 'btn-muted', value: false },
      ],
    });

    if (confirmed) {
      const result = await window.electronAPI?.installPendingUpdate?.();
      if (!result?.ok) {
        await modal.error('Update Failed', result?.error || 'Unable to launch the update download.');
      }
      return;
    }

    await modal.showModal({
      type: 'alert',
      title: 'Update Deferred',
      body: formatUpdateBody(updateInfo, true),
      graphic: 'update',
      buttons: [{ label: 'OK', cls: 'btn-primary', value: true }],
    });
  }, [modal]);

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

function AppShell() {
  const [page, setPage] = useState('home');
  const [pageState, setPageState] = useState(null);
  const [settings, setSettings] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.sessionStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
  const [tutorialRun, setTutorialRun] = useState(false);
  const [tutorialStepIndex, setTutorialStepIndex] = useState(0);
  const [appVersion, setAppVersion] = useState(() => window.electronAPI?.getVersion?.() || APP_VERSION_FALLBACK);
  const [updateState, setUpdateState] = useState({ currentVersion: APP_VERSION_FALLBACK, pendingUpdate: null, installedUpdate: null });
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

    return () => {
      active = false;
    };
  }, [modal, refreshUpdateState, updateState]);

  useEffect(() => {
    let cancelled = false;
    let retryTimeout = null;

    const loadInitialSettings = async (attempt = 0) => {
      try {
        if (attempt === 0) {
          setLoadingStatus('Connecting to backend...');
          setLoadingProgress(42);
        } else {
          setLoadingStatus(attempt >= 5 ? 'Finalizing backend connection...' : 'Connecting to backend...');
          setLoadingProgress(Math.min(84, 42 + attempt * 4));
        }

        const s = await api.getSettings();
        if (cancelled) return;
        setLoadingStatus('Loading settings...');
        setLoadingProgress(88);
        setSettings(s);
        setSoundsEnabled(s.enable_sounds !== false);
        setLoadingStatus('Preparing workspace...');
        setLoadingProgress(98);
        if (!s.setup_complete) setPage('setup');
        setLoading(false);
      } catch (_err) {
        if (cancelled) return;
        if (attempt < INITIAL_SETTINGS_MAX_RETRIES) {
          setLoadingStatus('Connecting to backend...');
          retryTimeout = window.setTimeout(() => {
            loadInitialSettings(attempt + 1);
          }, INITIAL_SETTINGS_RETRY_DELAY_MS);
          return;
        }
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
      try {
        const data = await api.getTicker();
        if (data.messages?.length > 0) setTickerMessages(data.messages);
      } catch (_err) {
        // Non-critical
      }
    };
    fetchTicker();
    const interval = setInterval(fetchTicker, 60000);
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
    const interval = window.setInterval(refreshNotifications, 60000);

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
          title: notification.title || 'Notification',
          body: formatNotificationModalBody(notification),
          graphic: notification.type === 'warning' || notification.type === 'urgent' ? 'warning' : 'update',
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

  const stopTutorial = useCallback(async (status = 'dismissed') => {
    setTutorialRun(false);
    setTutorialStepIndex(0);
    localStorage.setItem(TUTORIAL_STATUS_KEY, status);

    if (status === 'completed' || status === 'dismissed') {
      try {
        await api.saveSettings({ tutorial_completed: true });
        setSettings((current) => current ? { ...current, tutorial_completed: true } : current);
      } catch (_error) {
        // Ignore tutorial completion persistence errors; the walkthrough still closes.
      }
    }
  }, []);

  const startFullTutorial = useCallback(() => {
    setSidebarCollapsed(false);
    setTutorialStepIndex(0);
    setTutorialRun(true);
    navigate('home', null);
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
    .map((notification) => (
      notification.title
        ? `${notification.title}: ${notification.message}`
        : notification.message
    ))
    .filter(Boolean);

  const fallbackTickerMessages = tickerMessages
    .map(message => String(message || '').replace(/^\d+[\.\)]\s+/, '').trim())
    .filter(Boolean);

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
    ? displayTickerMessages.join('  \u25C6  ')
    : `Welcome to Mock Testing Suite v${appVersion}`;

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
            <span className="ticker-content">{tickerContent}</span>
            <span className="ticker-content" aria-hidden="true">{tickerContent}</span>
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
                {sidebarCollapsed ? '\u25B6' : '\u25C0'}
              </button>
              <img src={LOGO_SRC} alt="Mock Testing Suite" className="sidebar-logo-img" />
              <div className="sidebar-version">{`v${appVersion}`}</div>
            </div>
            <nav className="sidebar-nav">
              {NAV_ITEMS.map(item => (
                <button
                  key={item.key}
                  className={`nav-btn ${page === item.key ? 'active' : ''}`}
                  onClick={() => navigate(item.key, null)}
                  data-testid={`nav-${item.key}`}
                  title={sidebarCollapsed ? item.label : `Open ${item.label}`}
                >
                  <span className="nav-emoji">{item.emoji}</span>
                  <span className="nav-label">{item.label}</span>
                </button>
              ))}
            </nav>
            <div className="sidebar-divider" />
            <div className="sidebar-actions">
              <button className="action-btn action-discord" onClick={() => setDiscordOpen(true)} data-testid="link-discord" data-tour="sidebar-discord" title={sidebarCollapsed ? 'Discord Post' : 'Open Discord message templates'}>
                <span className="action-emoji">{'\uD83D\uDCAC'}</span><span className="action-label">Discord Post</span>
              </button>
              <button className="action-btn action-cert" onClick={() => { if (settings?.cert_sheet_url) window.open(settings.cert_sheet_url, '_blank'); }} data-testid="link-cert" data-tour="sidebar-cert-sheet" title={sidebarCollapsed ? 'Cert Spreadsheet' : 'Open Cert Spreadsheet'}>
                <span className="action-emoji">{'\uD83D\uDCCA'}</span><span className="action-label">Cert Spreadsheet</span>
              </button>
            </div>
            <div className="sidebar-footer">
              <button className="exit-btn" onClick={handleExit} data-testid="exit-btn" data-tour="sidebar-exit" title={sidebarCollapsed ? 'Exit App' : 'Close the desktop app'}>
                <span className="exit-btn-icon">{'\u23FB'}</span>
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
                  onReplayTutorial={startFullTutorial}
                  onSetupCompleted={handleSetupCompleted}
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

        {discordOpen && <DiscordModal settings={settings} onClose={() => setDiscordOpen(false)} />}
        <ElectronEventBridge navigate={navigate} setUpdateState={setUpdateState} />
      </div>
     </>  
  );
}

function DiscordModal({ settings, onClose }) {
  const templates = settings?.discord_templates || [];
  const screenshots = settings?.discord_screenshots || [];
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('templates');
  const filteredTemplates = templates.filter(([trigger, msg]) =>
    trigger.toLowerCase().includes(search.toLowerCase()) || msg.toLowerCase().includes(search.toLowerCase())
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
              <p className="text-muted" style={{ padding: 20 }}>No templates match your search.</p>
            ) : filteredTemplates.map(([title, message], i) => (
              <DiscordRow key={i} title={title} message={message} />
            ))
          ) : (
            filteredScreenshots.length === 0 ? (
              <p className="text-muted" style={{ padding: 20 }}>No screenshots match your search.</p>
            ) : filteredScreenshots.map((ss, i) => (
              <DiscordScreenshotRow key={i} title={ss.title} imageUrl={ss.image_url} />
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
        setTimeout(() => setCopied(false), 1500);
      }}>{copied ? 'Copied!' : 'Copy'}</button>
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

  const handleCopy = async () => {
    if (!resolvedImageUrl) return;
    try {
      const resp = await fetch(resolvedImageUrl);
      const blob = await resp.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_e) {
      // Fallback: open image in new tab
      window.open(resolvedImageUrl, '_blank');
    }
  };
  return (
    <div className="discord-row" style={{ flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="discord-title">{title}</div>
        <button className={`discord-copy ${copied ? 'copied' : ''}`} onClick={handleCopy} disabled={!resolvedImageUrl || previewError}>{copied ? 'Copied!' : 'Copy Image'}</button>
      </div>
      {resolvedImageUrl && !previewError ? (
        <img
          src={resolvedImageUrl}
          alt={title}
          onError={() => setPreviewError(true)}
          style={{ width: '100%', maxHeight: 300, objectFit: 'contain', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}
        />
      ) : (
        <div className="text-muted" style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: 16 }}>
          No image preview is available for this screenshot.
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
