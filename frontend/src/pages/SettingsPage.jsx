import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';
import geminiSettingsGraphic from '../assets/images/Gemini.png';

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
];

const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];
const APP_VERSION_FALLBACK = '1.0.1';

function resolveScreenshotUrl(imageUrl) {
  const value = String(imageUrl || '').trim();
  if (!value) return '';
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  return value.replace(/^\/+/, '');
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
        No preview
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

export default function SettingsPage({ onNavigate, updateState, refreshUpdateState, appVersion }) {
  const modal = useModal();
  const [tab, setTab] = useState('general');
  const [s, setS] = useState({});
  const [defaults, setDefaults] = useState({});
  const [loading, setLoading] = useState(true);
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const savedSnapshotRef = useRef('');

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

  const set = useCallback((key, val) => setS(prev => ({ ...prev, [key]: val })), []);

  const handleSave = useCallback(async () => {
    try {
      await api.saveSettings(s);
      savedSnapshotRef.current = JSON.stringify(s);
      setHasUnsavedChanges(false);
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

  const pendingUpdate = updateState?.pendingUpdate || null;

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

  const handleInstallPendingUpdate = useCallback(async () => {
    if (!window.electronAPI?.installPendingUpdate) {
      await modal.error('Update Failed', 'Update installs are only available in the desktop app.');
      return;
    }

    const result = await window.electronAPI.installPendingUpdate();
    if (!result?.ok) {
      await modal.error('Update Failed', result?.error || 'Unable to launch the update download.');
    }
  }, [modal]);

  if (loading) return <div className="page-loading">Loading settings...</div>;

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
        {TABS.map(t => (
          <button key={t.key} className={`tab-btn ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)} data-testid={`settings-tab-${t.key}`}>{t.label}</button>
        ))}
      </div>

      {tab === 'general' && <GeneralTab s={s} set={set} />}
      {tab === 'shows' && <ShowsTab s={s} set={set} defaults={defaults} />}
      {tab === 'calltypes' && <CallTypesTab s={s} set={set} defaults={defaults} />}
      {tab === 'callers' && <CallersTab s={s} set={set} defaults={defaults} />}
      {tab === 'supreasons' && <SupReasonsTab s={s} set={set} defaults={defaults} />}
      {tab === 'coaching' && <CoachingTab s={s} set={set} defaults={defaults} />}
      {tab === 'failreasons' && <FailReasonsTab s={s} set={set} defaults={defaults} />}
      {tab === 'discord' && <DiscordTab s={s} set={set} />}
      {tab === 'payment' && <PaymentTab s={s} set={set} />}
      {tab === 'gemini' && <GeminiTab s={s} set={set} />}
      {tab === 'calendar' && <CalendarTab s={s} set={set} />}

      <div className="settings-update-panel" data-testid="settings-update-panel">
        <div className="settings-update-copy">
          <div className="settings-update-title">
            {pendingUpdate ? `Mock Testing Suite v${pendingUpdate.latestVersion} is ready` : 'Check for updates'}
          </div>
          <div className="settings-update-subtitle">
            {pendingUpdate
              ? (pendingUpdate.downloadUrl
                ? 'Install the deferred update when you are ready.'
                : 'Update detected. The installer link has not been published yet.')
              : `Current version: v${appVersion || updateState?.currentVersion || APP_VERSION_FALLBACK}`}
          </div>
        </div>
        {pendingUpdate ? (
          <button
            className="btn btn-success btn-lg settings-update-btn"
            onClick={handleInstallPendingUpdate}
            data-testid="settings-update-now"
            title={`Install Mock Testing Suite v${pendingUpdate.latestVersion}`}
          >
            {`Install Update — v${pendingUpdate.latestVersion}`}
          </button>
        ) : (
          <button
            className="btn btn-primary btn-lg settings-update-btn"
            onClick={handleCheckForUpdates}
            disabled={checkingForUpdates}
            data-testid="settings-check-updates"
            title="Check the published update document for a newer installer"
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
      <SettingsRow label="Display Name"><input type="text" value={s.display_name || ''} onChange={e => set('display_name', e.target.value)} placeholder="Home screen greeting" style={{ maxWidth: 300 }} data-testid="settings-display" /></SettingsRow>
      <h3 style={{ margin: '24px 0 16px' }}>URLs</h3>
      <SettingsRow label="Cert Form URL"><input type="text" value={s.form_url || ''} onChange={e => set('form_url', e.target.value)} style={{ maxWidth: 500 }} data-testid="settings-form-url" /></SettingsRow>
      <SettingsRow label="Cert Spreadsheet URL"><input type="text" value={s.cert_sheet_url || ''} onChange={e => set('cert_sheet_url', e.target.value)} style={{ maxWidth: 500 }} data-testid="settings-cert-sheet-url" /></SettingsRow>
      <SettingsRow label="Form Fill Browser">
        <select value={s.form_fill_browser || 'auto'} onChange={e => set('form_fill_browser', e.target.value)} style={{ maxWidth: 220 }} data-testid="settings-form-browser">
          <option value="auto">Auto-detect fallback</option>
          <option value="chrome">Chrome</option>
          <option value="edge">Edge</option>
        </select>
      </SettingsRow>
      <SettingsRow label="Sounds Enabled">
        <label className="checkbox-label">
          <input type="checkbox" checked={s.enable_sounds !== false} onChange={e => set('enable_sounds', e.target.checked)} data-testid="settings-sounds-enabled" />
          <span>Play app sounds</span>
        </label>
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
        Ticker Speed is the only notification ticker setting exposed to normal users. The notification sheet URL is managed through admin configuration.
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
  renderLabel,
  emptyText = 'Select an item to edit.',
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
                className={`settings-admin-list-item ${index === selectedIndex ? 'active' : ''}`}
                onClick={() => onSelect(index)}
              >
                {renderLabel(item, index)}
              </button>
            ))}
            {!items.length && <div className="settings-admin-empty">No items yet.</div>}
          </div>
          <div className="settings-admin-list-actions">
            <button className="btn btn-primary btn-sm" onClick={onAdd}>Add</button>
            <button className="btn btn-danger btn-sm" onClick={onRemove} disabled={!items.length}>Remove</button>
            <button className="btn btn-ghost btn-sm" onClick={onMoveUp} disabled={selectedIndex <= 0}>Move Up</button>
            <button className="btn btn-ghost btn-sm" onClick={onMoveDown} disabled={!items.length || selectedIndex >= items.length - 1}>Move Down</button>
          </div>
        </div>
        <div className="settings-admin-detail-pane">
          {selectedItem ? children : <div className="settings-admin-empty">{emptyText}</div>}
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

function TextListEditor({ title, description, field, addLabel, s, set, defaults, testId }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const items = s[field] || defaults[field] || [];
  const selected = items[selectedIndex] || '';
  useClampedSelection(items, selectedIndex, setSelectedIndex);

  const updateSelected = (value) => set(field, items.map((item, index) => index === selectedIndex ? value : item));
  const add = () => {
    set(field, [...items, addLabel]);
    setSelectedIndex(items.length);
  };
  const remove = () => {
    const next = items.filter((_, index) => index !== selectedIndex);
    set(field, next);
    setSelectedIndex(Math.max(0, selectedIndex - 1));
  };
  const reorder = (direction) => {
    set(field, moveItem(items, selectedIndex, direction));
    setSelectedIndex(selectedIndex + direction);
  };

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
      onReset={() => { set(field, defaults[field] || []); setSelectedIndex(0); }}
      renderLabel={(item) => item || 'Untitled'}
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
function ShowsTab({ s, set, defaults }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const shows = s.shows || defaults.shows || [];
  const selected = shows[selectedIndex] || [];
  useClampedSelection(shows, selectedIndex, setSelectedIndex);

  const update = (fieldIndex, val) => {
    const next = shows.map((row, idx) => idx === selectedIndex ? row.map((c, ci) => ci === fieldIndex ? val : c) : row);
    set('shows', next);
  };
  const add = () => {
    set('shows', [...shows, ['New Show', '$0', '$0', 'Gift description']]);
    setSelectedIndex(shows.length);
  };
  const remove = () => {
    set('shows', shows.filter((_, idx) => idx !== selectedIndex));
    setSelectedIndex(Math.max(0, selectedIndex - 1));
  };
  const reorder = (direction) => {
    set('shows', moveItem(shows, selectedIndex, direction));
    setSelectedIndex(selectedIndex + direction);
  };

  return (
    <AdminEditorLayout
      title="Shows / Donation Packages"
      description="Each show has a name, one-time amount, monthly amount, and gift description."
      items={shows}
      selectedIndex={selectedIndex}
      onSelect={setSelectedIndex}
      onAdd={add}
      onRemove={remove}
      onMoveUp={() => reorder(-1)}
      onMoveDown={() => reorder(1)}
      onReset={() => { set('shows', defaults.shows || []); setSelectedIndex(0); }}
      renderLabel={(row) => row?.[0] || 'Untitled Show'}
      testId="settings-shows"
    >
      <div className="settings-admin-field-grid">
        <label className="settings-admin-field full"><span>Show Name</span><input type="text" value={selected[0] || ''} onChange={e => update(0, e.target.value)} /></label>
        <label className="settings-admin-field"><span>One-Time Amount</span><input type="text" value={selected[1] || ''} onChange={e => update(1, e.target.value)} /></label>
        <label className="settings-admin-field"><span>Monthly Amount</span><input type="text" value={selected[2] || ''} onChange={e => update(2, e.target.value)} /></label>
        <label className="settings-admin-field full"><span>Gift Description</span><textarea rows={4} value={selected[3] || ''} onChange={e => update(3, e.target.value)} /></label>
      </div>
    </AdminEditorLayout>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* CALL TYPES TAB                                                  */
/* ═══════════════════════════════════════════════════════════════ */
function CallTypesTab({ s, set, defaults }) {
  return (
    <TextListEditor
      title="Call Types"
      description="Define the call types used in Mock Call scenarios."
      field="call_types"
      addLabel="New Call Type"
      s={s}
      set={set}
      defaults={defaults}
      testId="settings-calltypes"
    />
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* SUP REASONS TAB                                                 */
/* ═══════════════════════════════════════════════════════════════ */
function SupReasonsTab({ s, set, defaults }) {
  return (
    <TextListEditor
      title="Supervisor Transfer Reasons"
      description="Reasons the caller gives for wanting a supervisor."
      field="sup_reasons"
      addLabel="New Reason"
      s={s}
      set={set}
      defaults={defaults}
      testId="settings-supreasons"
    />
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* CALLERS TAB (conditional per call type)                        */
/* ═══════════════════════════════════════════════════════════════ */
function CallersTab({ s, set, defaults }) {
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
  };
  const add = () => {
    set(field, [...callers, ['First', 'Last', 'Address', 'City', 'ST', '00000', '000-000-0000', 'email@test.com']]);
    setSelectedIndex(callers.length);
  };
  const remove = () => {
    set(field, callers.filter((_, idx) => idx !== selectedIndex));
    setSelectedIndex(Math.max(0, selectedIndex - 1));
  };
  const reorder = (direction) => {
    set(field, moveItem(callers, selectedIndex, direction));
    setSelectedIndex(selectedIndex + direction);
  };

  const headers = ['First', 'Last', 'Address', 'City', 'State', 'Zip', 'Phone', 'Email'];

  return (
    <div className="card" data-testid="settings-callers">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3>Callers & Demographics</h3>
        <button className="btn btn-ghost btn-sm" onClick={() => { set(field, defaults[field] || []); setSelectedIndex(0); }} title="Reset this category to defaults">Reset Defaults</button>
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
          <div className="settings-admin-list-actions">
            <button className="btn btn-primary btn-sm" onClick={add}>Add</button>
            <button className="btn btn-danger btn-sm" onClick={remove} disabled={!callers.length}>Remove</button>
            <button className="btn btn-ghost btn-sm" onClick={() => reorder(-1)} disabled={selectedIndex <= 0}>Move Up</button>
            <button className="btn btn-ghost btn-sm" onClick={() => reorder(1)} disabled={!callers.length || selectedIndex >= callers.length - 1}>Move Down</button>
          </div>
        </div>
        <div className="settings-admin-detail-pane">
          {callers.length ? (
            <div className="settings-admin-field-grid">
              {headers.map((label, fieldIndex) => (
                <label key={label} className={`settings-admin-field ${fieldIndex === 2 || fieldIndex === 7 ? 'full' : ''}`}>
                  <span>{label}</span>
                  {fieldIndex === 4 ? (
                    <select value={selected[fieldIndex] || ''} onChange={e => update(fieldIndex, e.target.value)}>
                      <option value="">--</option>
                      {US_STATES.map(st => <option key={st}>{st}</option>)}
                    </select>
                  ) : (
                    <input type="text" value={selected[fieldIndex] || ''} onChange={e => update(fieldIndex, e.target.value)} />
                  )}
                </label>
              ))}
            </div>
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
function CoachingTab({ s, set, defaults }) {
  const [scope, setScope] = useState('call_coaching');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const items = s[scope] || defaults[scope] || [];
  const selected = normalizeCoachingItem(items[selectedIndex]);
  useClampedSelection(items, selectedIndex, setSelectedIndex);

  const updateSelected = (patch) => {
    set(scope, items.map((item, index) => index === selectedIndex ? { ...item, ...patch } : item));
  };
  const add = () => {
    set(scope, [...items, { id: `custom-${Date.now()}`, label: 'New Coaching Item', helper: '', children: [] }]);
    setSelectedIndex(items.length);
  };
  const remove = () => {
    set(scope, items.filter((_, index) => index !== selectedIndex));
    setSelectedIndex(Math.max(0, selectedIndex - 1));
  };
  const reorder = (direction) => {
    set(scope, moveItem(items, selectedIndex, direction));
    setSelectedIndex(selectedIndex + direction);
  };

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
        onReset={() => { set(scope, defaults[scope] || []); setSelectedIndex(0); }}
        renderLabel={(item) => item?.label || 'Untitled Coaching Item'}
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
function FailReasonsTab({ s, set, defaults }) {
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
        testId={`settings-${scope}`}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* DISCORD TAB                                                     */
/* ═══════════════════════════════════════════════════════════════ */
function DiscordTab({ s, set }) {
  const modal = useModal();
  const [section, setSection] = useState('posts');
  const discord = s.discord_templates || [];
  const screenshots = s.discord_screenshots || [];
  const update = (i, field, val) => {
    const next = discord.map((item, idx) => idx === i ? (field === 0 ? [val, item[1]] : [item[0], val]) : item);
    set('discord_templates', next);
  };
  const remove = (i) => set('discord_templates', discord.filter((_, idx) => idx !== i));
  const add = () => set('discord_templates', [...discord, ['New Trigger', 'Message text here']]);
  const updateSS = (i, key, val) => set('discord_screenshots', screenshots.map((ss, idx) => idx === i ? { ...ss, [key]: val } : ss));
  const removeSS = (i) => set('discord_screenshots', screenshots.filter((_, idx) => idx !== i));
  const addSS = () => set('discord_screenshots', [...screenshots, { title: 'New Screenshot', image_url: '' }]);
  const uploadSS = async (i, file) => {
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      updateSS(i, 'image_url', dataUrl);
    } catch (error) {
      await modal.error('Image Upload Failed', error.message || 'Unable to load the selected image.');
    }
  };

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
            Trigger / Message pairs. The tester can copy these from the Discord panel during a session.
          </p>
          {discord.map(([trigger, msg], i) => (
            <div key={i} className="discord-edit-row">
              <div className="discord-edit-trigger">
                <label className="text-xs text-muted" style={{ display: 'block', marginBottom: 2 }}>Trigger</label>
                <input type="text" value={trigger} onChange={e => update(i, 0, e.target.value)} style={{ width: '100%' }} />
              </div>
              <div className="discord-edit-msg">
                <label className="text-xs text-muted" style={{ display: 'block', marginBottom: 2 }}>Message</label>
                <textarea value={msg} onChange={e => update(i, 1, e.target.value)} rows={3} style={{ width: '100%' }} />
              </div>
              <button className="btn btn-danger btn-sm" onClick={() => remove(i)} style={{ alignSelf: 'flex-start', marginTop: 18, flexShrink: 0 }} title="Remove template">X</button>
            </div>
          ))}
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
  const setP = (key, val) => set('payment', { ...pay, [key]: val });
  return (
    <div className="card" data-testid="settings-payment">
      <h3 style={{ marginBottom: 16 }}>Credit Card</h3>
      <SettingsRow label="Type"><input type="text" value={pay.cc_type || ''} onChange={e => setP('cc_type', e.target.value)} style={{ maxWidth: 200 }} /></SettingsRow>
      <SettingsRow label="Number"><input type="text" value={pay.cc_number || ''} onChange={e => setP('cc_number', e.target.value)} style={{ maxWidth: 250 }} /></SettingsRow>
      <SettingsRow label="Exp"><input type="text" value={pay.cc_exp || ''} onChange={e => setP('cc_exp', e.target.value)} style={{ maxWidth: 120 }} /></SettingsRow>
      <SettingsRow label="CVV"><input type="text" value={pay.cc_cvv || ''} onChange={e => setP('cc_cvv', e.target.value)} style={{ maxWidth: 100 }} /></SettingsRow>
      <h3 style={{ margin: '24px 0 16px' }}>EFT</h3>
      <SettingsRow label="Routing"><input type="text" value={pay.eft_routing || ''} onChange={e => setP('eft_routing', e.target.value)} style={{ maxWidth: 200 }} /></SettingsRow>
      <SettingsRow label="Account"><input type="text" value={pay.eft_account || ''} onChange={e => setP('eft_account', e.target.value)} style={{ maxWidth: 200 }} /></SettingsRow>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* GEMINI TAB                                                      */
/* ═══════════════════════════════════════════════════════════════ */
function GeminiTab({ s, set }) {
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
              value={s.gemini_key || ''}
              onChange={e => set('gemini_key', e.target.value)}
              placeholder="Paste your Gemini API key"
              autoComplete="off"
              style={{ maxWidth: 420 }}
              data-testid="settings-gemini-key"
            />
          </SettingsRow>
        </div>
        <img className="settings-gemini-image" src={geminiSettingsGraphic} alt="Gemini" />
      </div>
      <p className="text-muted text-sm" style={{ marginTop: 8, lineHeight: 1.7 }}>
        Gemini is optional. When enabled and a valid API key is saved, the app uses Gemini to generate management-facing coaching and fail summaries from the selected checkboxes.
      </p>
      {s.enable_gemini && !String(s.gemini_key || '').trim() && (
        <p className="text-sm" style={{ marginTop: 12, color: 'var(--color-warning)' }}>
          Gemini is enabled, but no API key is saved. The app will fall back to generic summaries until a valid key is entered.
        </p>
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
      <p className="text-muted text-sm" style={{ marginTop: 16 }}>The "Add to Google Calendar" button on the Newbie Shift screen creates a calendar event with the title "Supervisor Test Call - [Candidate Name]". No additional setup needed.</p>
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
