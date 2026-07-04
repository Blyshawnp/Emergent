import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';
import geminiSettingsGraphic from '../assets/images/Gemini.png';
import { getPaymentOptionsFromSettings, syncLegacyPaymentFields } from '../utils/paymentOptions';
import { VPN_PROXY_CHECK_MODES, normalizeVpnProxyCheckMode } from '../components/CandidateIpIntelligence';

const TABS = [
  { key: 'general', label: 'General' },
  { key: 'gemini', label: 'Gemini AI' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'payment', label: 'Payment' },
  { key: 'calltypes', label: 'Call Types' },
  { key: 'shows', label: 'Shows' },
  { key: 'callers', label: 'Callers' },
  { key: 'supreasons', label: 'Sup Reasons' },
  { key: 'coaching', label: 'Coaching' },
  { key: 'failreasons', label: 'Fail Reasons' },
  { key: 'discord', label: 'Discord' },
  { key: 'admin', label: 'Admin' },
];

const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];
const APP_VERSION_FALLBACK = '1.0.1';

function adminDiagnosticsEnabled() {
  try {
    return Boolean(window.electronAPI?.getRuntimeFlags?.().adminDiagnosticsEnabled);
  } catch (_error) {
    return false;
  }
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

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Unable to read the selected image.'));
    reader.readAsDataURL(file);
  });
}

function ScreenshotPreview({ title, imageUrl }) {
  const [failed, setFailed] = useState(false);
  const resolved = resolveScreenshotUrl(imageUrl);

  useEffect(() => {
    setFailed(false);
  }, [resolved]);

  if (!resolved || failed) {
    return (
      <div style={{ width: 96, height: 72, borderRadius: 4, border: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--font-size-xs)', textAlign: 'center', padding: 8 }}>
        Image not found
      </div>
    );
  }

  return (
    <img
      src={resolved}
      alt={title}
      onError={() => setFailed(true)}
      style={{ width: 96, height: 72, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border-subtle)' }}
    />
  );
}

export default function SettingsPage({ onNavigate, updateState, refreshUpdateState, appVersion, setMtsUpdateModal }) {
  const modal = useModal();
  const [tab, setTab] = useState('general');
  const [s, setS] = useState({});
  const [defaults, setDefaults] = useState({});
  const [loading, setLoading] = useState(true);
  const [showAdminDiagnostics] = useState(() => adminDiagnosticsEnabled());
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [sectionFeedback, setSectionFeedback] = useState({});
  const savedSnapshotRef = useRef('');
  const feedbackTimersRef = useRef({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settings, defs] = await Promise.all([api.getSettings(), api.getDefaults()]);
        if (cancelled) return;
        setS(settings);
        setDefaults(defs);
        savedSnapshotRef.current = JSON.stringify(settings);
      } catch (_err) {
        // Settings load failed
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (loading || !window.electronAPI?.setUnsavedChanges) {
      return;
    }

    const hasChanges = JSON.stringify(s) !== savedSnapshotRef.current;
    setHasUnsavedChanges(hasChanges);
    window.electronAPI.setUnsavedChanges(hasChanges).catch(() => {});
  }, [s, loading]);

  useEffect(() => () => {
    Object.values(feedbackTimersRef.current).forEach((timerId) => window.clearTimeout(timerId));
  }, []);

  useEffect(() => {
    if (tab === 'admin' && !showAdminDiagnostics) {
      setTab('general');
    }
  }, [showAdminDiagnostics, tab]);

  const set = useCallback((key, val) => setS(prev => ({ ...prev, [key]: val })), []);

  const markSectionFeedback = useCallback((sectionKey, message) => {
    if (!sectionKey) return;

    setSectionFeedback((prev) => ({
      ...prev,
      [sectionKey]: message,
    }));

    if (feedbackTimersRef.current[sectionKey]) {
      window.clearTimeout(feedbackTimersRef.current[sectionKey]);
    }

    feedbackTimersRef.current[sectionKey] = window.setTimeout(() => {
      setSectionFeedback((prev) => {
        const next = { ...prev };
        delete next[sectionKey];
        return next;
      });
      delete feedbackTimersRef.current[sectionKey];
    }, 3200);
  }, []);

  const handleSave = useCallback(async () => {
    try {
      await api.saveSettings(s);
      savedSnapshotRef.current = JSON.stringify(s);
      setHasUnsavedChanges(false);
      setSectionFeedback({});
      await modal.showModal({
        type: 'alert',
        title: 'Settings Saved',
        body: 'Your settings have been saved successfully.',
        graphic: 'save',
        buttons: [{ label: 'OK', cls: 'btn-primary', value: true }],
      });
    } catch (e) { await modal.error('Save Failed', e.message); }
  }, [s, modal]);

  const handleRestoreDefaults = useCallback(async () => {
    const confirmed = await modal.showModal({
      type: 'danger',
      title: 'Restore Defaults',
      body: 'Are you sure you want to restore the app settings to their default values?<br><br>This will overwrite your current saved settings.',
      graphic: 'warning',
      buttons: [
        { label: "Yes, I'm sure", cls: 'btn-danger', value: true },
        { label: 'Cancel', cls: 'btn-muted', value: false },
      ],
    });
    if (!confirmed) return;

    try {
      const result = await api.restoreSettingsDefaults();
      const nextSettings = result.settings || {};
      setS(nextSettings);
      savedSnapshotRef.current = JSON.stringify(nextSettings);
      setHasUnsavedChanges(false);
      await modal.showModal({
        type: 'alert',
        title: 'Defaults Restored',
        body: 'Settings have been restored to their default values.',
        graphic: 'warning',
        buttons: [{ label: 'OK', cls: 'btn-primary', value: true }],
      });
    } catch (e) {
      await modal.error('Restore Failed', e.message);
    }
  }, [modal]);

  const handleResetSection = useCallback(async (section, label) => {
    const confirmed = await modal.showModal({
      type: 'confirm',
      title: `Reset ${label}`,
      body: `Replace your saved ${label.toLowerCase()} with the current app defaults?`,
      graphic: 'warning',
      buttons: [
        { label: 'Reset', cls: 'btn-primary', value: true },
        { label: 'Cancel', cls: 'btn-muted', value: false },
      ],
    });
    if (!confirmed) return;

    try {
      const result = await api.resetSettingsSection(section);
      const nextSettings = result.settings || {};
      setS(nextSettings);
      savedSnapshotRef.current = JSON.stringify(nextSettings);
      setHasUnsavedChanges(false);
      markSectionFeedback('discord', `${label} reset to current defaults.`);
    } catch (e) {
      await modal.error('Reset Failed', e.message);
    }
  }, [markSectionFeedback, modal]);

  const pendingUpdate = updateState?.pendingUpdate || null;
  const updaterStatus = updateState?.updaterStatus || null;
  const manualUpdateMode = updateState?.signedAutoUpdatesEnabled !== true;

  const handleCheckForUpdates = useCallback(async () => {
    if (!window.electronAPI?.checkForUpdates) {
      await modal.error('Update Check Failed', 'Update checks are only available in the desktop app.');
      return;
    }

    setCheckingForUpdates(true);
    try {
      const result = await window.electronAPI.checkForUpdates();
      await refreshUpdateState?.();

      if (!result?.ok) {
        await modal.error('Update Check Failed', result?.error || 'Unable to check for updates right now.');
        return;
      }

      if (!result.updateAvailable) {
        await modal.showModal({
          type: 'alert',
          title: 'No Update Available',
          body: `Mock Testing Suite v${appVersion || updateState?.currentVersion || APP_VERSION_FALLBACK} is already up to date.`,
          graphic: 'update',
          buttons: [{ label: 'OK', cls: 'btn-primary', value: true }],
        });
      }
    } finally {
      setCheckingForUpdates(false);
    }
  }, [appVersion, modal, refreshUpdateState, updateState]);

  const handlePendingUpdateAction = useCallback(async () => {
    if (!pendingUpdate) return;
    if (manualUpdateMode) {
      const result = await window.electronAPI?.updaterManualDownload?.();
      if (!result?.ok) {
        await modal.error('Manual Update Link Invalid', result?.error || 'Manual update link is invalid. Please check update-MTS.');
      } else {
        await modal.alert('Update Page Opened', 'The update page opened in your browser. Download and run the installer to update.');
      }
      await refreshUpdateState?.();
      return;
    }
    if (setMtsUpdateModal) {
      setMtsUpdateModal(pendingUpdate);
    }
  }, [manualUpdateMode, modal, pendingUpdate, refreshUpdateState, setMtsUpdateModal]);

  if (loading) return <div className="page-loading">Loading settings...</div>;

  const visibleTabs = showAdminDiagnostics ? TABS : TABS.filter(t => t.key !== 'admin');

  return (
    <div data-testid="settings-page">
      <div className="page-header-row">
        <button
          className="btn btn-ghost btn-sm page-back-btn"
          onClick={() => onNavigate?.('home', null)}
          data-testid="settings-back"
          title="Return to Home"
        >
          ← Back
        </button>
        <h1 style={{ marginBottom: 0 }}>Settings</h1>
      </div>
      <div className="tabs-header" style={{ overflowX: 'auto' }} data-tour="settings-tabs">
        {visibleTabs.map(t => (
          <button key={t.key} className={`tab-btn ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)} data-testid={`settings-tab-${t.key}`}>{t.label}</button>
        ))}
      </div>

      {hasUnsavedChanges && (
        <div className="settings-unsaved-banner" data-testid="settings-unsaved-banner">
          <strong>Unsaved Changes</strong>
          <span>List edits are only pending until you click Save Settings.</span>
        </div>
      )}

      {tab === 'general' && <GeneralTab s={s} set={set} />}
      {tab === 'shows' && <ShowsTab s={s} set={set} defaults={defaults} feedback={sectionFeedback.shows} onFeedback={markSectionFeedback} />}
      {tab === 'calltypes' && <CallTypesTab s={s} set={set} defaults={defaults} feedback={sectionFeedback.call_types} onFeedback={markSectionFeedback} />}
      {tab === 'callers' && <CallersTab s={s} set={set} defaults={defaults} feedback={sectionFeedback.callers} onFeedback={markSectionFeedback} />}
      {tab === 'supreasons' && <SupReasonsTab s={s} set={set} defaults={defaults} feedback={sectionFeedback.sup_reasons} onFeedback={markSectionFeedback} />}
      {tab === 'coaching' && <CoachingTab s={s} set={set} defaults={defaults} feedback={sectionFeedback.coaching} onFeedback={markSectionFeedback} />}
      {tab === 'failreasons' && <FailReasonsTab s={s} set={set} defaults={defaults} feedback={sectionFeedback.failreasons} onFeedback={markSectionFeedback} />}
      {tab === 'discord' && <DiscordTab s={s} set={set} feedback={sectionFeedback.discord} onFeedback={markSectionFeedback} onResetSection={handleResetSection} />}
      {tab === 'payment' && <PaymentTab s={s} set={set} />}
      {tab === 'gemini' && <GeminiTab s={s} set={set} />}
      {tab === 'admin' && showAdminDiagnostics && <AdminTab />}
      {tab === 'calendar' && <CalendarTab s={s} set={set} />}

      <div className="settings-update-panel" data-testid="settings-update-panel">
        <div className="settings-update-copy">
          <div className="settings-update-title">
            {pendingUpdate ? `Mock Testing Suite v${pendingUpdate.latestVersion} is ready` : 'Check for updates'}
          </div>
          <div className="settings-update-subtitle">
            {manualUpdateMode
              ? (pendingUpdate
                ? 'Updates are currently installed manually. Use Download Update to open the GitHub release page.'
                : `Current version: v${appVersion || updateState?.currentVersion || APP_VERSION_FALLBACK}`)
              : updaterStatus?.message
              ? updaterStatus.message
              : pendingUpdate
              ? (pendingUpdate.downloadUrl
                ? (pendingUpdate.source === 'github-releases'
                  ? 'Download and install this update from GitHub Releases.'
                  : 'Open the manual fallback release link when you are ready.')
                : 'Update detected. The installer link has not been published yet.')
              : `Current version: v${appVersion || updateState?.currentVersion || APP_VERSION_FALLBACK}`}
          </div>
        </div>
        {pendingUpdate ? (
          <button
            className="btn btn-success btn-lg settings-update-btn"
            onClick={handlePendingUpdateAction}
            data-testid="settings-update-now"
            title={manualUpdateMode ? `Download Mock Testing Suite v${pendingUpdate.latestVersion}` : `Install Mock Testing Suite v${pendingUpdate.latestVersion}`}
          >
            {manualUpdateMode ? `Download Update - v${pendingUpdate.latestVersion}` : `Install Update - v${pendingUpdate.latestVersion}`}
          </button>
        ) : (
          <button
            className="btn btn-primary btn-lg settings-update-btn"
            onClick={handleCheckForUpdates}
            disabled={checkingForUpdates}
            data-testid="settings-check-updates"
            title="Check GitHub Releases first, then the Google Sheet fallback"
          >
            {checkingForUpdates ? 'Checking…' : 'Check for Updates'}
          </button>
        )}
      </div>

      <div className="footer-bar" data-testid="settings-footer">
        <button className="btn btn-danger" onClick={handleRestoreDefaults} data-testid="settings-restore-defaults" title="Restore default settings while preserving protected setup values">Restore Defaults</button>
        <span className="spacer" />
        {hasUnsavedChanges && (
          <span className="settings-unsaved-indicator" data-testid="settings-unsaved-indicator">
            Unsaved Changes
          </span>
        )}
        <button className="btn btn-primary btn-lg" onClick={handleSave} data-testid="settings-save" title="Save all settings changes">Save Settings</button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* GENERAL TAB                                                    */
/* ═══════════════════════════════════════════════════════════════ */
function GeneralTab({ s, set }) {
  return (
    <div className="card" data-testid="settings-general">
      <h3 style={{ marginBottom: 16 }}>Profile</h3>
      <SettingsRow label="Tester Name"><input type="text" value={s.tester_name || ''} onChange={e => set('tester_name', e.target.value)} style={{ maxWidth: 300 }} data-testid="settings-name" /></SettingsRow>
      <SettingsRow label="Display Name">
        <div>
          <input type="text" value={s.display_name || ''} onChange={e => set('display_name', e.target.value)} placeholder="Optional nickname" style={{ maxWidth: 320, width: '100%' }} data-testid="settings-display" />
          <div className="text-muted text-xs" style={{ marginTop: 6 }}>Optional. Leave blank to automatically use your first name.</div>
        </div>
      </SettingsRow>
      <h3 style={{ margin: '24px 0 16px' }}>URLs</h3>
      <SettingsRow label="Cert Form URL"><input type="text" value={s.form_url || ''} onChange={e => set('form_url', e.target.value)} style={{ maxWidth: 500 }} data-testid="settings-form-url" /></SettingsRow>
      <SettingsRow label="Cert Spreadsheet URL"><input type="text" value={s.cert_sheet_url || ''} onChange={e => set('cert_sheet_url', e.target.value)} style={{ maxWidth: 500 }} data-testid="settings-cert-sheet-url" /></SettingsRow>
      <SettingsRow label="Form Fill Browser">
        <select value={s.form_fill_browser || 'auto'} onChange={e => set('form_fill_browser', e.target.value)} style={{ maxWidth: 220 }} data-testid="settings-form-browser">
          <option value="auto">System Default</option>
          <option value="chrome">Chrome</option>
          <option value="edge">Edge</option>
        </select>
      </SettingsRow>
      <SettingsRow label="VPN / Proxy Check">
        <div>
          <select
            value={normalizeVpnProxyCheckMode(s.vpnProxyCheckMode)}
            onChange={e => set('vpnProxyCheckMode', e.target.value)}
            style={{ maxWidth: 260 }}
            data-testid="settings-vpn-proxy-mode"
          >
            <option value={VPN_PROXY_CHECK_MODES.LINKS}>Manual lookup links</option>
            <option value={VPN_PROXY_CHECK_MODES.CHECKER}>Integrated provider check</option>
            <option value={VPN_PROXY_CHECK_MODES.DISABLED}>Disabled message only</option>
          </select>
          <div className="text-muted text-xs" style={{ marginTop: 6, maxWidth: 620 }}>
            Manual lookup links are the release-safe default. Integrated checks require configured VPN/proxy reputation providers and show manual links when coverage is limited.
          </div>
        </div>
      </SettingsRow>
      <SettingsRow label="Welcome voice">
        <select
          value={s.welcome_voice || 'male'}
          onChange={e => set('welcome_voice', e.target.value)}
          style={{ maxWidth: 220 }}
          data-testid="settings-welcome-voice"
        >
          <option value="male">Male</option>
          <option value="female">Female</option>
        </select>
      </SettingsRow>
      <SettingsRow label="Sound volume">
        <select
          value={s.sound_volume || (s.enable_sounds === false ? 'off' : 'medium')}
          onChange={e => {
            const level = e.target.value;
            set('sound_volume', level);
            set('enable_sounds', level !== 'off');
          }}
          style={{ maxWidth: 220 }}
          data-testid="settings-sound-volume"
        >
          <option value="off">Off</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
        <div className="text-muted text-xs" style={{ marginTop: 6 }}>Controls welcome audio and app sound effects.</div>
      </SettingsRow>
      <h3 style={{ margin: '24px 0 16px' }}>Notifications</h3>
      <SettingsRow label="Ticker Speed">
        <select
          value={s.ticker_speed || 'normal'}
          onChange={e => set('ticker_speed', e.target.value)}
          style={{ maxWidth: 220 }}
          data-testid="settings-ticker-speed"
        >
          <option value="slow">Slow</option>
          <option value="normal">Normal</option>
          <option value="fast">Fast</option>
        </select>
      </SettingsRow>
      <p className="text-muted text-sm" style={{ marginTop: 12, lineHeight: 1.7 }}>
        Ticker Speed is the only notification ticker setting exposed to normal users. SAM notification rows are managed by admins in the master Google Sheet sam-notifications tab.
      </p>
      <h3 style={{ margin: '24px 0 16px' }}>Theme</h3>
      <button className="btn btn-ghost btn-sm" onClick={() => {
        const c = document.documentElement.getAttribute('data-theme') || 'dark';
        const n = c === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', n);
        localStorage.setItem('mts-theme', n);
        set('theme', n);
      }} data-testid="settings-theme-toggle">Toggle Light/Dark</button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* ADMIN EDITOR HELPERS                                           */
/* ═══════════════════════════════════════════════════════════════ */
function moveItem(items, index, direction) {
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= items.length) return items;
  const next = [...items];
  [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  return next;
}

function normalizeCoachingItem(item = {}) {
  return {
    id: item.id || '',
    label: item.label || '',
    helper: item.helper || '',
    children: Array.isArray(item.children) ? item.children : [],
  };
}

function PendingListFeedback({ message }) {
  if (!message) return null;

  return (
    <div className="settings-pending-feedback" data-testid="settings-pending-feedback">
      {message}
    </div>
  );
}

function AdminEditorLayout({
  title,
  description,
  items,
  selectedIndex,
  onSelect,
  onAdd,
  onRemove,
  onMoveUp,
  onMoveDown,
  onReset,
  onApply,
  renderLabel,
  emptyText = 'Select an item to edit.',
  feedback,
  children,
  testId,
}) {
  const selectedItem = items[selectedIndex];

  return (
    <div className="card" data-testid={testId}>
      <div className="settings-admin-header">
        <div>
          <h3>{title}</h3>
          {description && <p className="text-muted text-sm">{description}</p>}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onReset}>Reset Defaults</button>
      </div>
      <div className="settings-admin-editor">
        <div className="settings-admin-list-pane">
          <div className="settings-admin-list">
            {items.map((item, index) => (
              <button
                key={`${renderLabel(item, index)}-${index}`}
                type="button"
                className={`settings-admin-list-item ${index === selectedIndex ? 'active' : ''} ${index === selectedIndex && feedback ? 'pending-highlight' : ''}`}
                onClick={() => onSelect(index)}
              >
                {renderLabel(item, index)}
              </button>
            ))}
            {!items.length && <div className="settings-admin-empty">No items yet.</div>}
          </div>
          <PendingListFeedback message={feedback} />
          <div className="settings-admin-list-actions">
            <button className="btn btn-primary btn-sm" onClick={onAdd}>Add</button>
            <button className="btn btn-danger btn-sm" onClick={onRemove} disabled={!items.length}>Remove</button>
            <button className="btn btn-ghost btn-sm" onClick={onMoveUp} disabled={selectedIndex <= 0}>Move Up</button>
            <button className="btn btn-ghost btn-sm" onClick={onMoveDown} disabled={!items.length || selectedIndex >= items.length - 1}>Move Down</button>
          </div>
        </div>
        <div className="settings-admin-detail-pane">
          {selectedItem ? (
            <>
              <div className="settings-admin-detail-actions">
                <button className="btn btn-ghost btn-sm" onClick={onApply}>Apply to List</button>
              </div>
              {children}
            </>
          ) : <div className="settings-admin-empty">{emptyText}</div>}
        </div>
      </div>
    </div>
  );
}

function useClampedSelection(items, selectedIndex, setSelectedIndex) {
  useEffect(() => {
    if (!items.length && selectedIndex !== 0) {
      setSelectedIndex(0);
      return;
    }
    if (items.length && selectedIndex > items.length - 1) {
      setSelectedIndex(items.length - 1);
    }
  }, [items.length, selectedIndex, setSelectedIndex]);
}

function TextListEditor({ title, description, field, addLabel, s, set, defaults, testId, feedback, onFeedback }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const items = s[field] || defaults[field] || [];
  const selected = items[selectedIndex] || '';
  useClampedSelection(items, selectedIndex, setSelectedIndex);

  const updateSelected = (value) => {
    set(field, items.map((item, index) => index === selectedIndex ? value : item));
    onFeedback?.(field, 'Updated. Click Save Settings to keep changes.');
  };
  const add = () => {
    set(field, [...items, addLabel]);
    setSelectedIndex(items.length);
    onFeedback?.(field, 'Added. Click Save Settings to keep changes.');
  };
  const remove = () => {
    const next = items.filter((_, index) => index !== selectedIndex);
    set(field, next);
    setSelectedIndex(Math.max(0, selectedIndex - 1));
    onFeedback?.(field, 'Removed. Click Save Settings to keep changes.');
  };
  const reorder = (direction) => {
    set(field, moveItem(items, selectedIndex, direction));
    setSelectedIndex(selectedIndex + direction);
    onFeedback?.(field, 'List order updated. Click Save Settings to keep changes.');
  };
  const apply = () => onFeedback?.(field, 'Applied to pending list. Click Save Settings to keep changes.');

  return (
    <AdminEditorLayout
      title={title}
      description={description}
      items={items}
      selectedIndex={selectedIndex}
      onSelect={setSelectedIndex}
      onAdd={add}
      onRemove={remove}
      onMoveUp={() => reorder(-1)}
      onMoveDown={() => reorder(1)}
      onApply={apply}
      onReset={() => {
        set(field, defaults[field] || []);
        setSelectedIndex(0);
        onFeedback?.(field, 'Defaults restored. Click Save Settings to keep changes.');
      }}
      renderLabel={(item) => item || 'Untitled'}
      feedback={feedback}
      testId={testId}
    >
      <div className="settings-admin-field-grid">
        <label className="settings-admin-field full">
          <span>Name</span>
          <input type="text" value={selected} onChange={e => updateSelected(e.target.value)} />
        </label>
      </div>
    </AdminEditorLayout>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* SHOWS TAB                                                       */
/* ═══════════════════════════════════════════════════════════════ */
function ShowsTab({ s, set, defaults, feedback, onFeedback }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const shows = s.shows || defaults.shows || [];
  const selected = shows[selectedIndex] || [];
  useClampedSelection(shows, selectedIndex, setSelectedIndex);

  const update = (fieldIndex, val) => {
    const next = shows.map((row, idx) => idx === selectedIndex ? row.map((c, ci) => ci === fieldIndex ? val : c) : row);
    set('shows', next);
    onFeedback?.('shows', 'Updated. Click Save Settings to keep changes.');
  };
  const add = () => {
    set('shows', [...shows, ['New Show', '$0', '$0', 'Gift description', '']]);
    setSelectedIndex(shows.length);
    onFeedback?.('shows', 'Added. Click Save Settings to keep changes.');
  };
  const remove = () => {
    set('shows', shows.filter((_, idx) => idx !== selectedIndex));
    setSelectedIndex(Math.max(0, selectedIndex - 1));
    onFeedback?.('shows', 'Removed. Click Save Settings to keep changes.');
  };
  const reorder = (direction) => {
    set('shows', moveItem(shows, selectedIndex, direction));
    setSelectedIndex(selectedIndex + direction);
    onFeedback?.('shows', 'List order updated. Click Save Settings to keep changes.');
  };
  const apply = () => onFeedback?.('shows', 'Applied to pending list. Click Save Settings to keep changes.');

  return (
    <AdminEditorLayout
      title="Shows / Donation Packages"
      description="Each show has a name, one-time amount, monthly amount, gift description, and optional scenario note."
      items={shows}
      selectedIndex={selectedIndex}
      onSelect={setSelectedIndex}
      onAdd={add}
      onRemove={remove}
      onMoveUp={() => reorder(-1)}
      onMoveDown={() => reorder(1)}
      onApply={apply}
      onReset={() => {
        set('shows', defaults.shows || []);
        setSelectedIndex(0);
        onFeedback?.('shows', 'Defaults restored. Click Save Settings to keep changes.');
      }}
      renderLabel={(row) => row?.[0] || 'Untitled Show'}
      feedback={feedback}
      testId="settings-shows"
    >
      <div className="settings-admin-field-grid">
        <label className="settings-admin-field full"><span>Show Name</span><input type="text" value={selected[0] || ''} onChange={e => update(0, e.target.value)} /></label>
        <label className="settings-admin-field"><span>One-Time Amount</span><input type="text" value={selected[1] || ''} onChange={e => update(1, e.target.value)} /></label>
        <label className="settings-admin-field"><span>Monthly Amount</span><input type="text" value={selected[2] || ''} onChange={e => update(2, e.target.value)} /></label>
        <label className="settings-admin-field full"><span>Gift Description</span><textarea rows={4} value={selected[3] || ''} onChange={e => update(3, e.target.value)} /></label>
        <label className="settings-admin-field full"><span>Notes</span><textarea rows={3} value={selected[4] || ''} onChange={e => update(4, e.target.value)} /></label>
      </div>
    </AdminEditorLayout>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* CALL TYPES TAB                                                  */
/* ═══════════════════════════════════════════════════════════════ */
function CallTypesTab({ s, set, defaults, feedback, onFeedback }) {
  return (
    <TextListEditor
      title="Call Types"
      description="Define the call types used in Mock Call scenarios."
      field="call_types"
      addLabel="New Call Type"
      s={s}
      set={set}
      defaults={defaults}
      feedback={feedback}
      onFeedback={onFeedback}
      testId="settings-calltypes"
    />
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* SUP REASONS TAB                                                 */
/* ═══════════════════════════════════════════════════════════════ */
function SupReasonsTab({ s, set, defaults, feedback, onFeedback }) {
  return (
    <TextListEditor
      title="Supervisor Transfer Reasons"
      description="Reasons the caller gives for wanting a supervisor."
      field="sup_reasons"
      addLabel="New Reason"
      s={s}
      set={set}
      defaults={defaults}
      feedback={feedback}
      onFeedback={onFeedback}
      testId="settings-supreasons"
    />
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* CALLERS TAB (conditional per call type)                        */
/* ═══════════════════════════════════════════════════════════════ */
function CallersTab({ s, set, defaults, feedback, onFeedback }) {
  const [category, setCategory] = useState('new');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const categories = [
    { key: 'new', label: 'New Donors', field: 'donors_new' },
    { key: 'existing', label: 'Existing Members', field: 'donors_existing' },
    { key: 'increase', label: 'Increase Sustaining', field: 'donors_increase' },
  ];
  const cat = categories.find(c => c.key === category);
  const field = cat.field;
  const callers = s[field] || defaults[field] || [];
  const selected = callers[selectedIndex] || [];
  useClampedSelection(callers, selectedIndex, setSelectedIndex);

  const update = (fieldIndex, val) => {
    const next = callers.map((row, idx) => idx === selectedIndex ? row.map((c, ci) => ci === fieldIndex ? val : c) : row);
    set(field, next);
    onFeedback?.('callers', 'Updated. Click Save Settings to keep changes.');
  };
  const add = () => {
    set(field, [...callers, ['First', 'Last', 'Address', 'City', 'ST', '00000', '000-000-0000', 'email@test.com', '']]);
    setSelectedIndex(callers.length);
    onFeedback?.('callers', 'Added. Click Save Settings to keep changes.');
  };
  const remove = () => {
    set(field, callers.filter((_, idx) => idx !== selectedIndex));
    setSelectedIndex(Math.max(0, selectedIndex - 1));
    onFeedback?.('callers', 'Removed. Click Save Settings to keep changes.');
  };
  const reorder = (direction) => {
    set(field, moveItem(callers, selectedIndex, direction));
    setSelectedIndex(selectedIndex + direction);
    onFeedback?.('callers', 'List order updated. Click Save Settings to keep changes.');
  };
  const apply = () => onFeedback?.('callers', 'Applied to pending list. Click Save Settings to keep changes.');

  const headers = ['First', 'Last', 'Address', 'City', 'State', 'Zip', 'Phone', 'Email', 'Notes'];

  return (
    <div className="card" data-testid="settings-callers">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3>Callers & Demographics</h3>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            set(field, defaults[field] || []);
            setSelectedIndex(0);
            onFeedback?.('callers', 'Defaults restored. Click Save Settings to keep changes.');
          }}
          title="Reset this category to defaults"
        >
          Reset Defaults
        </button>
      </div>
      <p className="text-muted text-sm" style={{ marginBottom: 16 }}>
        Each category maps to call types. <b>New Donors</b> appear when the tester picks a "New Donor" call type.
        <b> Existing Members</b> for "Existing Member" types. <b>Increase Sustaining</b> for increase calls.
      </p>
      <div className="tabs-header" style={{ marginBottom: 16 }}>
        {categories.map(c => (
          <button key={c.key} className={`tab-btn ${category === c.key ? 'active' : ''}`} onClick={() => { setCategory(c.key); setSelectedIndex(0); }} data-testid={`callers-cat-${c.key}`}>{c.label} ({(s[c.field] || defaults[c.field] || []).length})</button>
        ))}
      </div>
      <div className="settings-admin-editor">
        <div className="settings-admin-list-pane">
          <div className="settings-admin-list">
            {callers.map((row, index) => (
              <button
                key={`${row[0]}-${row[1]}-${index}`}
                type="button"
                className={`settings-admin-list-item ${index === selectedIndex ? 'active' : ''}`}
                onClick={() => setSelectedIndex(index)}
              >
                {`${row[0] || 'First'} ${row[1] || 'Last'}`}
              </button>
            ))}
            {!callers.length && <div className="settings-admin-empty">No callers yet.</div>}
          </div>
          <PendingListFeedback message={feedback} />
          <div className="settings-admin-list-actions">
            <button className="btn btn-primary btn-sm" onClick={add}>Add</button>
            <button className="btn btn-danger btn-sm" onClick={remove} disabled={!callers.length}>Remove</button>
            <button className="btn btn-ghost btn-sm" onClick={() => reorder(-1)} disabled={selectedIndex <= 0}>Move Up</button>
            <button className="btn btn-ghost btn-sm" onClick={() => reorder(1)} disabled={!callers.length || selectedIndex >= callers.length - 1}>Move Down</button>
          </div>
        </div>
        <div className="settings-admin-detail-pane">
          {callers.length ? (
            <>
              <div className="settings-admin-detail-actions">
                <button className="btn btn-ghost btn-sm" onClick={apply}>Apply to List</button>
              </div>
              <div className="settings-admin-field-grid">
                {headers.map((label, fieldIndex) => (
                  <label key={label} className={`settings-admin-field ${fieldIndex === 2 || fieldIndex >= 7 ? 'full' : ''}`}>
                    <span>{label}</span>
                    {fieldIndex === 4 ? (
                      <select value={selected[fieldIndex] || ''} onChange={e => update(fieldIndex, e.target.value)}>
                        <option value="">--</option>
                        {US_STATES.map(st => <option key={st}>{st}</option>)}
                      </select>
                    ) : fieldIndex === 8 ? (
                      <textarea rows={3} value={selected[fieldIndex] || ''} onChange={e => update(fieldIndex, e.target.value)} />
                    ) : (
                      <input type="text" value={selected[fieldIndex] || ''} onChange={e => update(fieldIndex, e.target.value)} />
                    )}
                  </label>
                ))}
              </div>
            </>
          ) : (
            <div className="settings-admin-empty">Select a caller to edit.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* COACHING TAB                                                    */
/* ═══════════════════════════════════════════════════════════════ */
function CoachingTab({ s, set, defaults, feedback, onFeedback }) {
  const [scope, setScope] = useState('call_coaching');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const items = s[scope] || defaults[scope] || [];
  const selected = normalizeCoachingItem(items[selectedIndex]);
  useClampedSelection(items, selectedIndex, setSelectedIndex);

  const updateSelected = (patch) => {
    set(scope, items.map((item, index) => index === selectedIndex ? { ...item, ...patch } : item));
    onFeedback?.('coaching', 'Updated. Click Save Settings to keep changes.');
  };
  const add = () => {
    set(scope, [...items, { id: `custom-${Date.now()}`, label: 'New Coaching Item', helper: '', children: [] }]);
    setSelectedIndex(items.length);
    onFeedback?.('coaching', 'Added. Click Save Settings to keep changes.');
  };
  const remove = () => {
    set(scope, items.filter((_, index) => index !== selectedIndex));
    setSelectedIndex(Math.max(0, selectedIndex - 1));
    onFeedback?.('coaching', 'Removed. Click Save Settings to keep changes.');
  };
  const reorder = (direction) => {
    set(scope, moveItem(items, selectedIndex, direction));
    setSelectedIndex(selectedIndex + direction);
    onFeedback?.('coaching', 'List order updated. Click Save Settings to keep changes.');
  };
  const apply = () => onFeedback?.('coaching', 'Applied to pending list. Click Save Settings to keep changes.');

  return (
    <div data-testid="settings-coaching">
      <div className="tabs-header" style={{ marginBottom: 16 }}>
        <button className={`tab-btn ${scope === 'call_coaching' ? 'active' : ''}`} onClick={() => { setScope('call_coaching'); setSelectedIndex(0); }}>Call Coaching</button>
        <button className={`tab-btn ${scope === 'sup_coaching' ? 'active' : ''}`} onClick={() => { setScope('sup_coaching'); setSelectedIndex(0); }}>Supervisor Coaching</button>
      </div>
      <AdminEditorLayout
        title={scope === 'call_coaching' ? 'Call Coaching' : 'Supervisor Coaching'}
        description="Edit coaching checkbox labels, optional helper text, and optional child checkbox lines."
        items={items}
        selectedIndex={selectedIndex}
        onSelect={setSelectedIndex}
        onAdd={add}
        onRemove={remove}
        onMoveUp={() => reorder(-1)}
        onMoveDown={() => reorder(1)}
        onApply={apply}
        onReset={() => {
          set(scope, defaults[scope] || []);
          setSelectedIndex(0);
          onFeedback?.('coaching', 'Defaults restored. Click Save Settings to keep changes.');
        }}
        renderLabel={(item) => item?.label || 'Untitled Coaching Item'}
        feedback={feedback}
        testId={`settings-${scope}`}
      >
        <div className="settings-admin-field-grid">
          <label className="settings-admin-field full"><span>Label</span><input type="text" value={selected.label} onChange={e => updateSelected({ label: e.target.value })} /></label>
          <label className="settings-admin-field full"><span>ID</span><input type="text" value={selected.id} onChange={e => updateSelected({ id: e.target.value })} /></label>
          <label className="settings-admin-field full"><span>Helper Text</span><textarea rows={3} value={selected.helper} onChange={e => updateSelected({ helper: e.target.value })} /></label>
          <label className="settings-admin-field full">
            <span>Child Items (one per line)</span>
            <textarea
              rows={5}
              value={selected.children.join('\n')}
              onChange={e => updateSelected({ children: e.target.value.split('\n').map(line => line.trim()).filter(Boolean) })}
            />
          </label>
        </div>
      </AdminEditorLayout>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* FAIL REASONS TAB                                                */
/* ═══════════════════════════════════════════════════════════════ */
function FailReasonsTab({ s, set, defaults, feedback, onFeedback }) {
  const [scope, setScope] = useState('call_fails');

  return (
    <div data-testid="settings-failreasons">
      <div className="tabs-header" style={{ marginBottom: 16 }}>
        <button className={`tab-btn ${scope === 'call_fails' ? 'active' : ''}`} onClick={() => setScope('call_fails')}>Call Fail Reasons</button>
        <button className={`tab-btn ${scope === 'sup_fails' ? 'active' : ''}`} onClick={() => setScope('sup_fails')}>Supervisor Fail Reasons</button>
      </div>
      <TextListEditor
        key={scope}
        title={scope === 'call_fails' ? 'Call Fail Reasons' : 'Supervisor Fail Reasons'}
        description="Edit the fail reason options used when marking a section as failed."
        field={scope}
        addLabel="New Fail Reason"
        s={s}
        set={set}
        defaults={defaults}
        feedback={feedback}
        onFeedback={(_, message) => onFeedback?.('failreasons', message)}
        testId={`settings-${scope}`}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* DISCORD TAB                                                     */
/* ═══════════════════════════════════════════════════════════════ */
function normalizeDiscordPost(item) {
  if (Array.isArray(item)) {
    return { title: String(item[0] || ''), message: String(item[1] || ''), category: String(item[2] || 'Uncategorized') };
  }
  if (item && typeof item === 'object') {
    return {
      title: String(item.title || item.Title || item.trigger || item.Trigger || item.name || item.Name || item.label || item.Label || ''),
      message: String(item.message || item.Message || item.text || item.Text || item.content || item.Content || item.body || item.Body || ''),
      category: String(item.category || item.Category || item.group || item.Group || 'Uncategorized'),
    };
  }
  return { title: '', message: '', category: 'Uncategorized' };
}

function normalizeScreenshotItem(item) {
  if (item && typeof item === 'object') {
    return {
      title: String(item.title || item.Title || item.name || item.Name || ''),
      image_url: String(item.image_url || item.ImagePath || item.imagePath || item.url || ''),
      category: String(item.category || item.Category || item.group || item.Group || 'Uncategorized'),
    };
  }
  return { title: '', image_url: '', category: 'Uncategorized' };
}

function DiscordTab({ s, set, feedback, onFeedback, onResetSection }) {
  const modal = useModal();
  const [section, setSection] = useState('posts');
  const discord = (s.discord_templates || []).map(normalizeDiscordPost);
  const screenshots = (s.discord_screenshots || []).map(normalizeScreenshotItem);
  const update = (i, field, val) => {
    const next = discord.map((item, idx) => idx === i ? { ...item, [field]: val } : item);
    set('discord_templates', next);
    onFeedback?.('discord', 'Updated. Click Save Settings to keep changes.');
  };
  const remove = (i) => {
    set('discord_templates', discord.filter((_, idx) => idx !== i));
    onFeedback?.('discord', 'Removed. Click Save Settings to keep changes.');
  };
  const add = () => {
    set('discord_templates', [...discord, { category: 'Uncategorized', title: 'New Trigger', message: 'Message text here' }]);
    onFeedback?.('discord', 'Added. Click Save Settings to keep changes.');
  };
  const updateSS = (i, key, val) => {
    set('discord_screenshots', screenshots.map((ss, idx) => idx === i ? { ...ss, [key]: val } : ss));
    onFeedback?.('discord', 'Updated. Click Save Settings to keep changes.');
  };
  const removeSS = (i) => {
    set('discord_screenshots', screenshots.filter((_, idx) => idx !== i));
    onFeedback?.('discord', 'Removed. Click Save Settings to keep changes.');
  };
  const addSS = () => {
    set('discord_screenshots', [...screenshots, { category: 'Uncategorized', title: 'New Screenshot', image_url: '' }]);
    onFeedback?.('discord', 'Added. Click Save Settings to keep changes.');
  };
  const uploadSS = async (i, file) => {
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      updateSS(i, 'image_url', dataUrl);
    } catch (error) {
      await modal.error('Image Upload Failed', error.message || 'Unable to load the selected image.');
    }
  };
  const applyPosts = () => onFeedback?.('discord', 'Applied to pending list. Click Save Settings to keep changes.');
  const applyScreenshots = () => onFeedback?.('discord', 'Applied to pending list. Click Save Settings to keep changes.');

  return (
    <div className="card" data-testid="settings-discord">
      <div className="tabs-header" style={{ marginBottom: 16 }}>
        <button
          className={`tab-btn ${section === 'posts' ? 'active' : ''}`}
          onClick={() => setSection('posts')}
          data-testid="settings-discord-tab-posts"
        >
          Posts
        </button>
        <button
          className={`tab-btn ${section === 'screenshots' ? 'active' : ''}`}
          onClick={() => setSection('screenshots')}
          data-testid="settings-discord-tab-screenshots"
        >
          Screenshots
        </button>
      </div>

      {section === 'posts' && (
        <>
          <h3 style={{ marginBottom: 16 }}>Discord Message Templates</h3>
          <p className="text-muted text-sm" style={{ marginBottom: 16 }}>
            Category, trigger, and message entries. The tester can copy these from the Discord panel during a session. Basics, Sup Transfer, and Newbie Shift copy buttons use these same template triggers when available.
          </p>
          {discord.map((item, i) => (
            <div key={i} className="discord-edit-row">
              <div className="discord-edit-category">
                <label className="text-xs text-muted" style={{ display: 'block', marginBottom: 2 }}>Category</label>
                <input type="text" value={item.category} onChange={e => update(i, 'category', e.target.value)} style={{ width: '100%' }} />
              </div>
              <div className="discord-edit-trigger">
                <label className="text-xs text-muted" style={{ display: 'block', marginBottom: 2 }}>Trigger</label>
                <input type="text" value={item.title} onChange={e => update(i, 'title', e.target.value)} style={{ width: '100%' }} />
              </div>
              <div className="discord-edit-msg">
                <label className="text-xs text-muted" style={{ display: 'block', marginBottom: 2 }}>Message</label>
                <textarea value={item.message} onChange={e => update(i, 'message', e.target.value)} rows={3} style={{ width: '100%' }} />
              </div>
              <button className="btn btn-danger btn-sm" onClick={() => remove(i)} style={{ alignSelf: 'flex-start', marginTop: 18, flexShrink: 0 }} title="Remove template">X</button>
            </div>
          ))}
          <div className="settings-admin-detail-actions">
            <button className="btn btn-ghost btn-sm" onClick={applyPosts}>Apply to List</button>
            <button className="btn btn-muted btn-sm" onClick={() => onResetSection?.('discord_templates', 'Discord Posts')}>Reset Posts to Defaults</button>
          </div>
          <PendingListFeedback message={feedback} />
          <button className="btn btn-primary btn-sm" onClick={add} style={{ marginTop: 16 }} data-testid="settings-discord-add">+ Add Template</button>
        </>
      )}

      {section === 'screenshots' && (
        <>
          <h3 style={{ marginBottom: 16 }}>Discord Screenshots</h3>
          <p className="text-muted text-sm" style={{ marginBottom: 16 }}>
            Screenshots with titles that can be copied to clipboard from the Discord panel. Upload an image file to store it with your settings and preview it here.
          </p>
          {screenshots.map((ss, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ flex: 1 }}>
                <div className="form-row" style={{ marginBottom: 8 }}><label style={{ minWidth: 80 }}>Category</label><input type="text" value={ss.category} onChange={e => updateSS(i, 'category', e.target.value)} /></div>
                <div className="form-row" style={{ marginBottom: 8 }}><label style={{ minWidth: 80 }}>Title</label><input type="text" value={ss.title} onChange={e => updateSS(i, 'title', e.target.value)} /></div>
                <div className="form-row" style={{ marginBottom: 8 }}>
                  <label style={{ minWidth: 80 }}>Image File</label>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={e => uploadSS(i, e.target.files?.[0])}
                    data-testid={`settings-discord-ss-file-${i}`}
                  />
                </div>
                <div className="form-row" style={{ marginBottom: 0 }}>
                  <label style={{ minWidth: 80 }}>Stored Image</label>
                  <input type="text" value={ss.image_url || ''} readOnly placeholder="Select an image file to save it with settings" />
                </div>
              </div>
              <ScreenshotPreview title={ss.title} imageUrl={ss.image_url} />
              <button className="btn btn-danger btn-sm" onClick={() => removeSS(i)} title="Remove screenshot">X</button>
            </div>
          ))}
          <div className="settings-admin-detail-actions">
            <button className="btn btn-ghost btn-sm" onClick={applyScreenshots}>Apply to List</button>
            <button className="btn btn-muted btn-sm" onClick={() => onResetSection?.('discord_screenshots', 'Discord Screenshots')}>Reset Screenshots to Defaults</button>
          </div>
          <PendingListFeedback message={feedback} />
          <button className="btn btn-primary btn-sm" onClick={addSS} style={{ marginTop: 8 }} data-testid="settings-discord-ss-add">+ Add Screenshot</button>
        </>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* PAYMENT TAB                                                     */
/* ═══════════════════════════════════════════════════════════════ */
function PaymentTab({ s, set }) {
  const pay = s.payment || {};
  const options = getPaymentOptionsFromSettings(pay);
  const updatePayment = (nextPayment) => set('payment', syncLegacyPaymentFields(nextPayment));

  const updateCard = (index, field, value) => {
    const nextCards = options.card.map((item, idx) => idx === index ? { ...item, [field]: value } : item);
    updatePayment({ ...pay, card_options: nextCards, eft_options: options.eft });
  };

  const addCard = () => {
    const nextIndex = options.card.length + 1;
    updatePayment({
      ...pay,
      card_options: [
        ...options.card,
        {
          id: `card_${Date.now()}`,
          label: `Card ${nextIndex}`,
          type: '',
          number: '',
          exp: '',
          cvv: '',
        },
      ],
      eft_options: options.eft,
    });
  };

  const removeCard = (index) => {
    if (index === 0 || options.card.length <= 1) return;
    updatePayment({
      ...pay,
      card_options: options.card.filter((_, idx) => idx !== index),
      eft_options: options.eft,
    });
  };

  const updateEft = (index, field, value) => {
    const nextEft = options.eft.map((item, idx) => idx === index ? { ...item, [field]: value } : item);
    updatePayment({ ...pay, card_options: options.card, eft_options: nextEft });
  };

  const addEft = () => {
    const nextIndex = options.eft.length + 1;
    updatePayment({
      ...pay,
      card_options: options.card,
      eft_options: [
        ...options.eft,
        {
          id: `eft_${Date.now()}`,
          label: `EFT ${nextIndex}`,
          routing: '',
          account: '',
        },
      ],
    });
  };

  const removeEft = (index) => {
    if (index === 0 || options.eft.length <= 1) return;
    updatePayment({
      ...pay,
      card_options: options.card,
      eft_options: options.eft.filter((_, idx) => idx !== index),
    });
  };

  return (
    <div className="card" data-testid="settings-payment">
      <h3 style={{ marginBottom: 16 }}>Credit Card</h3>
      <p className="text-muted text-sm" style={{ marginBottom: 16 }}>
        These options appear in the Call and Sup Transfer payment dropdowns. Each new call starts on Default.
      </p>
      <PaymentOptionEditor
        type="card"
        items={options.card}
        onUpdate={updateCard}
        onRemove={removeCard}
      />
      <button type="button" className="btn btn-primary btn-sm" onClick={addCard} data-testid="settings-payment-add-card">+ Add Credit Card Option</button>
      <h3 style={{ margin: '24px 0 16px' }}>EFT</h3>
      <p className="text-muted text-sm" style={{ marginBottom: 16 }}>
        EFT options use the same reset behavior and return to Default for each new call or Sup Transfer.
      </p>
      <PaymentOptionEditor
        type="eft"
        items={options.eft}
        onUpdate={updateEft}
        onRemove={removeEft}
      />
      <button type="button" className="btn btn-primary btn-sm" onClick={addEft} data-testid="settings-payment-add-eft">+ Add EFT Option</button>
    </div>
  );
}

function PaymentOptionEditor({ type, items, onUpdate, onRemove }) {
  const isCard = type === 'card';
  return (
    <div className="payment-settings-list" data-testid={`settings-payment-${type}-list`}>
      {items.map((item, index) => (
        <div className="payment-settings-row" key={`${item.id}-${index}`} data-testid={`settings-payment-${type}-${index}`}>
          <div className="payment-settings-row-header">
            <strong>{index === 0 ? 'Default' : item.label || `${isCard ? 'Card' : 'EFT'} ${index + 1}`}</strong>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => onRemove(index)}
              disabled={index === 0 || items.length <= 1}
              data-testid={`settings-payment-remove-${type}-${index}`}
            >
              Remove
            </button>
          </div>
          <div className="settings-admin-field-grid">
            <label className="settings-admin-field">
              <span>Label</span>
              <input type="text" value={item.label || ''} onChange={e => onUpdate(index, 'label', e.target.value)} data-testid={`settings-payment-${type}-${index}-label`} />
            </label>
            {isCard ? (
              <>
                <label className="settings-admin-field">
                  <span>Type</span>
                  <input type="text" value={item.type || ''} onChange={e => onUpdate(index, 'type', e.target.value)} data-testid={`settings-payment-card-${index}-type`} />
                </label>
                <label className="settings-admin-field">
                  <span>Number</span>
                  <input type="text" value={item.number || ''} onChange={e => onUpdate(index, 'number', e.target.value)} data-testid={`settings-payment-card-${index}-number`} />
                </label>
                <label className="settings-admin-field">
                  <span>Exp</span>
                  <input type="text" value={item.exp || ''} onChange={e => onUpdate(index, 'exp', e.target.value)} data-testid={`settings-payment-card-${index}-exp`} />
                </label>
                <label className="settings-admin-field">
                  <span>CVV</span>
                  <input type="text" value={item.cvv || ''} onChange={e => onUpdate(index, 'cvv', e.target.value)} data-testid={`settings-payment-card-${index}-cvv`} />
                </label>
              </>
            ) : (
              <>
                <label className="settings-admin-field">
                  <span>Routing</span>
                  <input type="text" value={item.routing || ''} onChange={e => onUpdate(index, 'routing', e.target.value)} data-testid={`settings-payment-eft-${index}-routing`} />
                </label>
                <label className="settings-admin-field">
                  <span>Account</span>
                  <input type="text" value={item.account || ''} onChange={e => onUpdate(index, 'account', e.target.value)} data-testid={`settings-payment-eft-${index}-account`} />
                </label>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* GEMINI TAB                                                      */
/* ═══════════════════════════════════════════════════════════════ */
function GeminiTab({ s, set }) {
  const [testStatus, setTestStatus] = useState(null);
  const [testing, setTesting] = useState(false);
  const pendingKey = Boolean(String(s.gemini_api_key || '').trim());
  const configured = Boolean(s.gemini_api_key_configured || pendingKey);

  const handleTestConnection = async () => {
    if (testing) return;
    setTesting(true);
    setTestStatus(null);
    try {
      const result = await api.testGeminiConnection();
      const detail = result?.detail && !result?.ok && result?.code !== 'blocked_or_empty' ? `: ${result.detail}` : '';
      setTestStatus({
        ok: Boolean(result?.ok),
        message: `${result?.message || (result?.ok ? 'Gemini connection successful' : 'Unable to connect to Gemini')}${detail}`,
      });
    } catch (error) {
      const backendMessage = error?.response?.data?.message || error?.response?.data?.error;
      setTestStatus({
        ok: false,
        message: backendMessage || 'Unable to connect to Gemini',
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="card" data-testid="settings-gemini">
      <div className="settings-gemini-layout">
        <div className="settings-gemini-fields">
          <label className="checkbox-label" style={{ marginBottom: 16 }}>
            <input type="checkbox" checked={s.enable_gemini || false} onChange={e => set('enable_gemini', e.target.checked)} data-testid="settings-gemini-on" />
            <span>Enable Gemini AI Summaries</span>
          </label>
          <SettingsRow label="Gemini API Key">
            <input
              type="password"
              value={s.gemini_api_key || ''}
              onChange={e => set('gemini_api_key', e.target.value)}
              placeholder={s.gemini_api_key_configured ? 'Gemini API key saved. Enter a new key to replace it.' : 'Paste your Gemini API key'}
              autoComplete="off"
              style={{ maxWidth: 420 }}
              data-testid="settings-gemini-key"
            />
          </SettingsRow>
          <div className="gemini-config-status" data-testid="settings-gemini-config-status">
            {configured ? (
              <span className="gemini-status-badge gemini-status-success">✓ Gemini API key configured</span>
            ) : (
              <span className="gemini-status-badge gemini-status-neutral">No Gemini API key configured</span>
            )}
          </div>
          <div className="gemini-test-row">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleTestConnection}
              disabled={testing}
              data-testid="settings-gemini-test"
            >
              {testing && <span className="btn-spinner" aria-hidden="true" />}
              {testing ? 'Testing...' : 'Test Gemini Connection'}
            </button>
            {testStatus && (
              <span
                className={`gemini-status-badge ${testStatus.ok ? 'gemini-status-success' : 'gemini-status-error'}`}
                data-testid="settings-gemini-test-status"
              >
                {testStatus.ok ? '✓ ' : ''}{testStatus.message}
              </span>
            )}
          </div>
          {pendingKey && (
            <p className="text-muted text-sm" style={{ marginTop: 8 }}>
              Save settings before testing a newly entered key.
            </p>
          )}
        </div>
        <img className="settings-gemini-image" src={geminiSettingsGraphic} alt="Gemini" />
      </div>
      <p className="text-muted text-sm" style={{ marginTop: 8, lineHeight: 1.7 }}>
        Gemini is optional. When enabled and a valid API key is saved, the app uses Gemini to generate management-facing coaching and fail summaries from the selected checkboxes.
      </p>
      {s.enable_gemini && !s.gemini_api_key_configured && !String(s.gemini_api_key || '').trim() && (
        <p className="text-sm" style={{ marginTop: 12, color: 'var(--color-warning)' }}>
          Gemini is enabled, but no API key is saved. The app will fall back to generic summaries until a valid key is entered.
        </p>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* ADMIN TAB                                                       */
/* ═══════════════════════════════════════════════════════════════ */
function AdminTab() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const handleRunDiagnostics = async () => {
    if (running) return;
    setRunning(true);
    setResult(null);
    try {
      const data = await api.runGoogleSheetDiagnostics();
      setResult(data);
    } catch (error) {
      const data = error?.response?.data;
      setResult(data || {
        ok: false,
        failedOperation: 'request_google_sheet_diagnostics',
        errorType: error?.name || 'RequestError',
        errorMessage: error?.message || 'Unable to run Google Sheet diagnostics.',
        spreadsheetId: '',
        appsScriptApi: {},
        appAdminAuth: {
          ok: false,
          errorMessage: data?.errorMessage || data?.error || error?.message || '',
        },
        googleSheetsPermission: {
          checked: false,
          ok: false,
          errorMessage: 'Google Sheets diagnostics did not run because the request failed.',
        },
      });
    } finally {
      setRunning(false);
    }
  };

  const failedOperation = result?.failedOperation || '';
  const appAuth = result?.appAdminAuth || {};
  const sheetAuth = result?.googleSheetsPermission || {};
  const summary = result
    ? (result.ok ? 'Google Sheets diagnostics passed' : (result.errorMessage || result.error || 'Google Sheets diagnostics failed'))
    : '';

  return (
    <div className="card" data-testid="settings-admin">
      <div className="settings-admin-header">
        <div>
          <h3>Google Sheet Diagnostics</h3>
          <p className="text-muted text-sm">Run a local permission check against the master MTS Google Sheet.</p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={handleRunDiagnostics}
          disabled={running}
          data-testid="settings-run-google-sheet-diagnostics"
        >
          {running && <span className="btn-spinner" aria-hidden="true" />}
          {running ? 'Running...' : 'Run Google Sheet Diagnostics'}
        </button>
      </div>

      {result && (
        <div className="settings-diagnostics-result" data-testid="settings-google-sheet-diagnostics-result">
          <div className={`gemini-status-badge ${result.ok ? 'gemini-status-success' : 'gemini-status-error'}`}>
            {result.ok ? '✓ ' : ''}{summary}
          </div>
          <div className="settings-diagnostics-grid">
            <div>
              <span>App Admin Auth</span>
              <strong>{appAuth.ok ? (appAuth.usedLocalDevelopmentFallback ? 'Local dev fallback' : 'Authenticated') : 'Failed'}</strong>
            </div>
            <div>
              <span>Google Sheets</span>
              <strong>{sheetAuth.checked ? (sheetAuth.ok ? 'Passed' : 'Failed') : 'Not run'}</strong>
            </div>
            <div>
              <span>Failed Operation</span>
              <strong>{failedOperation || 'None'}</strong>
            </div>
            <div>
              <span>Spreadsheet ID</span>
              <strong>{result.spreadsheetId || result.activeSpreadsheetId || 'Unknown'}</strong>
            </div>
            <div className="full">
              <span>Apps Script API</span>
              <strong>{result.appsScriptApi?.status || (result.ok ? 'ready' : 'unavailable')}</strong>
            </div>
          </div>
          <pre className="settings-diagnostics-json">{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* CALENDAR TAB                                                    */
/* ═══════════════════════════════════════════════════════════════ */
function CalendarTab({ s, set }) {
  return (
    <div className="card" data-testid="settings-calendar">
      <label className="checkbox-label">
        <input type="checkbox" checked={s.enable_calendar || false} onChange={e => set('enable_calendar', e.target.checked)} data-testid="settings-cal-on" />
        <span>Enable Google Calendar for Newbie Shifts</span>
      </label>
      <p className="text-muted text-sm" style={{ marginTop: 16 }}>The "Add to Google Calendar" button on the Newbie Shift screen creates a calendar event with the title "Supervisor Test Call - [Candidate Name]". The Discord copy button beside it uses the Out of Time (Needs Sup) template from Discord Posts. No additional setup needed.</p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* SHARED                                                          */
/* ═══════════════════════════════════════════════════════════════ */
function SettingsRow({ label, children }) {
  return (
    <div className="form-row">
      <label>{label}</label>
      {children}
    </div>
  );
}
