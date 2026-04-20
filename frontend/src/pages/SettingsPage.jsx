import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';

const TABS = [
  { key: 'general', label: 'General' },
  { key: 'gemini', label: 'Gemini AI' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'payment', label: 'Payment' },
  { key: 'calltypes', label: 'Call Types' },
  { key: 'shows', label: 'Shows' },
  { key: 'callers', label: 'Callers' },
  { key: 'supreasons', label: 'Sup Reasons' },
  { key: 'discord', label: 'Discord' },
];

const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];

function resolveScreenshotUrl(imageUrl) {
  const value = String(imageUrl || '').trim();
  if (!value) return '';
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  return value.replace(/^\/+/, '');
}

export default function SettingsPage({ onNavigate }) {
  const modal = useModal();
  const [tab, setTab] = useState('general');
  const [s, setS] = useState({});
  const [defaults, setDefaults] = useState({});
  const [loading, setLoading] = useState(true);
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
    window.electronAPI.setUnsavedChanges(hasChanges).catch(() => {});
  }, [s, loading]);

  const set = useCallback((key, val) => setS(prev => ({ ...prev, [key]: val })), []);

  const handleSave = useCallback(async () => {
    try {
      await api.saveSettings(s);
      savedSnapshotRef.current = JSON.stringify(s);
      await modal.alert('Settings Saved', 'Your settings have been saved successfully.');
    } catch (e) { await modal.error('Save Failed', e.message); }
  }, [s, modal]);

  const handleRestoreDefaults = useCallback(async () => {
    const confirmed = await modal.confirmDanger(
      'Restore Defaults',
      'Are you sure you want to restore the app settings to their default values?<br><br>This will overwrite your current saved settings.'
    );
    if (!confirmed) return;

    try {
      const result = await api.restoreSettingsDefaults();
      const nextSettings = result.settings || {};
      setS(nextSettings);
      savedSnapshotRef.current = JSON.stringify(nextSettings);
      await modal.alert('Defaults Restored', 'Settings have been restored to their default values.');
    } catch (e) {
      await modal.error('Restore Failed', e.message);
    }
  }, [modal]);

  if (loading) return <div className="page-loading">Loading settings...</div>;

  return (
    <div data-testid="settings-page">
      <h1 style={{ marginBottom: 24 }}>Settings</h1>
      <div className="tabs-header" style={{ overflowX: 'auto' }}>
        {TABS.map(t => (
          <button key={t.key} className={`tab-btn ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)} data-testid={`settings-tab-${t.key}`}>{t.label}</button>
        ))}
      </div>

      {tab === 'general' && <GeneralTab s={s} set={set} />}
      {tab === 'shows' && <ShowsTab s={s} set={set} defaults={defaults} />}
      {tab === 'calltypes' && <CallTypesTab s={s} set={set} defaults={defaults} />}
      {tab === 'callers' && <CallersTab s={s} set={set} defaults={defaults} />}
      {tab === 'supreasons' && <SupReasonsTab s={s} set={set} defaults={defaults} />}
      {tab === 'discord' && <DiscordTab s={s} set={set} />}
      {tab === 'payment' && <PaymentTab s={s} set={set} />}
      {tab === 'gemini' && <GeminiTab s={s} set={set} />}
      {tab === 'calendar' && <CalendarTab s={s} set={set} />}

      <div className="footer-bar" data-testid="settings-footer">
        <button className="btn btn-danger" onClick={handleRestoreDefaults} data-testid="settings-restore-defaults">Restore Defaults</button>
        <span className="spacer" />
        <button className="btn btn-primary btn-lg" onClick={handleSave} data-testid="settings-save">Save Settings</button>
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
/* SHOWS TAB                                                       */
/* ═══════════════════════════════════════════════════════════════ */
function ShowsTab({ s, set, defaults }) {
  const shows = s.shows || defaults.shows || [];
  const update = (i, fi, val) => {
    const next = shows.map((row, idx) => idx === i ? row.map((c, ci) => ci === fi ? val : c) : row);
    set('shows', next);
  };
  const remove = (i) => set('shows', shows.filter((_, idx) => idx !== i));
  const add = () => set('shows', [...shows, ['New Show', '$0', '$0', 'Gift description']]);
  const reset = () => set('shows', defaults.shows || []);

  return (
    <div className="card" data-testid="settings-shows">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3>Shows / Donation Packages</h3>
        <button className="btn btn-ghost btn-sm" onClick={reset} title="Reset to default shows">Reset Defaults</button>
      </div>
      <p className="text-muted text-sm" style={{ marginBottom: 16 }}>Each show has a name, one-time amount, monthly amount, and gift description. A "Use Own/Custom" option is always available.</p>
      <div className="settings-table-wrap">
        <table className="settings-table">
          <thead><tr><th>Show Name</th><th style={{ width: 90 }}>One-Time</th><th style={{ width: 90 }}>Monthly</th><th>Gift Description</th><th style={{ width: 60 }}></th></tr></thead>
          <tbody>
            {shows.map((row, i) => (
              <tr key={i}>
                <td><input type="text" value={row[0] || ''} onChange={e => update(i, 0, e.target.value)} /></td>
                <td><input type="text" value={row[1] || ''} onChange={e => update(i, 1, e.target.value)} style={{ width: 80 }} /></td>
                <td><input type="text" value={row[2] || ''} onChange={e => update(i, 2, e.target.value)} style={{ width: 80 }} /></td>
                <td><input type="text" value={row[3] || ''} onChange={e => update(i, 3, e.target.value)} /></td>
                <td><button className="btn btn-danger btn-sm" onClick={() => remove(i)} title="Remove this show">X</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn btn-primary btn-sm" onClick={add} style={{ marginTop: 12 }} data-testid="settings-shows-add">+ Add Show</button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* CALL TYPES TAB                                                  */
/* ═══════════════════════════════════════════════════════════════ */
function CallTypesTab({ s, set, defaults }) {
  const types = s.call_types || defaults.call_types || [];
  const update = (i, val) => set('call_types', types.map((t, idx) => idx === i ? val : t));
  const remove = (i) => set('call_types', types.filter((_, idx) => idx !== i));
  const add = () => set('call_types', [...types, 'New Call Type']);
  const reset = () => set('call_types', defaults.call_types || []);

  return (
    <div className="card" data-testid="settings-calltypes">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3>Call Types</h3>
        <button className="btn btn-ghost btn-sm" onClick={reset} title="Reset to default call types">Reset Defaults</button>
      </div>
      <p className="text-muted text-sm" style={{ marginBottom: 16 }}>Define the call types used in Mock Call scenarios. "Use Own/Custom" is always appended.</p>
      {types.map((t, i) => (
        <div key={i} className="editable-row">
          <input type="text" value={t} onChange={e => update(i, e.target.value)} />
          <button className="btn btn-danger btn-sm" onClick={() => remove(i)} title="Remove">X</button>
        </div>
      ))}
      <div className="editable-row" style={{ opacity: 0.5, pointerEvents: 'none' }}>
        <input type="text" value="Use Own / Custom" readOnly style={{ fontStyle: 'italic' }} />
        <span className="text-xs text-muted" style={{ marginLeft: 8 }}>Always included</span>
      </div>
      <button className="btn btn-primary btn-sm" onClick={add} style={{ marginTop: 12 }} data-testid="settings-calltypes-add">+ Add Call Type</button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* SUP REASONS TAB                                                 */
/* ═══════════════════════════════════════════════════════════════ */
function SupReasonsTab({ s, set, defaults }) {
  const reasons = s.sup_reasons || defaults.sup_reasons || [];
  const update = (i, val) => set('sup_reasons', reasons.map((r, idx) => idx === i ? val : r));
  const remove = (i) => set('sup_reasons', reasons.filter((_, idx) => idx !== i));
  const add = () => set('sup_reasons', [...reasons, 'New Reason']);
  const reset = () => set('sup_reasons', defaults.sup_reasons || []);

  return (
    <div className="card" data-testid="settings-supreasons">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3>Supervisor Transfer Reasons</h3>
        <button className="btn btn-ghost btn-sm" onClick={reset} title="Reset to defaults">Reset Defaults</button>
      </div>
      <p className="text-muted text-sm" style={{ marginBottom: 16 }}>Reasons the caller gives for wanting a supervisor. "Use Own/Other" is always appended.</p>
      {reasons.filter(r => r !== 'Use Own/Other').map((r, i) => (
        <div key={i} className="editable-row">
          <input type="text" value={r} onChange={e => update(i, e.target.value)} />
          <button className="btn btn-danger btn-sm" onClick={() => remove(i)} title="Remove">X</button>
        </div>
      ))}
      <div className="editable-row" style={{ opacity: 0.5, pointerEvents: 'none' }}>
        <input type="text" value="Use Own / Other" readOnly style={{ fontStyle: 'italic' }} />
        <span className="text-xs text-muted" style={{ marginLeft: 8 }}>Always included</span>
      </div>
      <button className="btn btn-primary btn-sm" onClick={add} style={{ marginTop: 12 }} data-testid="settings-supreasons-add">+ Add Reason</button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* CALLERS TAB (conditional per call type)                        */
/* ═══════════════════════════════════════════════════════════════ */
function CallersTab({ s, set, defaults }) {
  const [category, setCategory] = useState('new');
  const categories = [
    { key: 'new', label: 'New Donors', field: 'donors_new' },
    { key: 'existing', label: 'Existing Members', field: 'donors_existing' },
    { key: 'increase', label: 'Increase Sustaining', field: 'donors_increase' },
  ];
  const cat = categories.find(c => c.key === category);
  const field = cat.field;
  const callers = s[field] || defaults[field] || [];

  const update = (i, fi, val) => {
    const next = callers.map((row, idx) => idx === i ? row.map((c, ci) => ci === fi ? val : c) : row);
    set(field, next);
  };
  const remove = (i) => set(field, callers.filter((_, idx) => idx !== i));
  const add = () => set(field, [...callers, ['First', 'Last', 'Address', 'City', 'ST', '00000', '000-000-0000', 'email@test.com']]);
  const reset = () => set(field, defaults[field] || []);

  const headers = ['First', 'Last', 'Address', 'City', 'State', 'Zip', 'Phone', 'Email'];

  return (
    <div className="card" data-testid="settings-callers">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3>Callers & Demographics</h3>
        <button className="btn btn-ghost btn-sm" onClick={reset} title="Reset this category to defaults">Reset Defaults</button>
      </div>
      <p className="text-muted text-sm" style={{ marginBottom: 16 }}>
        Each category maps to call types. <b>New Donors</b> appear when the tester picks a "New Donor" call type.
        <b> Existing Members</b> for "Existing Member" types. <b>Increase Sustaining</b> for increase calls.
      </p>
      <div className="tabs-header" style={{ marginBottom: 16 }}>
        {categories.map(c => (
          <button key={c.key} className={`tab-btn ${category === c.key ? 'active' : ''}`} onClick={() => setCategory(c.key)} data-testid={`callers-cat-${c.key}`}>{c.label} ({(s[c.field] || defaults[c.field] || []).length})</button>
        ))}
      </div>
      <div className="settings-table-wrap">
        <table className="settings-table">
          <thead><tr>{headers.map(h => <th key={h}>{h}</th>)}<th style={{ width: 50 }}></th></tr></thead>
          <tbody>
            {callers.map((row, i) => (
              <tr key={i}>
                {headers.map((_, fi) => (
                  <td key={fi}>
                    {fi === 4 ? (
                      <select value={row[fi] || ''} onChange={e => update(i, fi, e.target.value)} style={{ width: 60 }}>
                        <option value="">--</option>
                        {US_STATES.map(st => <option key={st}>{st}</option>)}
                      </select>
                    ) : (
                      <input type="text" value={row[fi] || ''} onChange={e => update(i, fi, e.target.value)} style={fi < 2 ? { width: 90 } : fi === 2 ? { minWidth: 140 } : fi >= 6 ? { width: 110 } : {}} />
                    )}
                  </td>
                ))}
                <td><button className="btn btn-danger btn-sm" onClick={() => remove(i)} title="Remove caller">X</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn btn-primary btn-sm" onClick={add} style={{ marginTop: 12 }} data-testid="settings-callers-add">+ Add Caller</button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/* DISCORD TAB                                                     */
/* ═══════════════════════════════════════════════════════════════ */
function DiscordTab({ s, set }) {
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
  const addSS = () => set('discord_screenshots', [...screenshots, { title: 'New Screenshot', image_url: 'placeholder.png' }]);

  return (
    <div className="card" data-testid="settings-discord">
      <h3 style={{ marginBottom: 16 }}>Discord Message Templates</h3>
      <p className="text-muted text-sm" style={{ marginBottom: 16 }}>Trigger / Message pairs. The tester can copy these from the Discord panel during a session.</p>
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

      <h3 style={{ margin: '32px 0 16px' }}>Discord Screenshots</h3>
      <p className="text-muted text-sm" style={{ marginBottom: 16 }}>Screenshots with titles that can be copied to clipboard from the Discord panel.</p>
      {screenshots.map((ss, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ flex: 1 }}>
            <div className="form-row" style={{ marginBottom: 8 }}><label style={{ minWidth: 80 }}>Title</label><input type="text" value={ss.title} onChange={e => updateSS(i, 'title', e.target.value)} /></div>
            <div className="form-row" style={{ marginBottom: 0 }}><label style={{ minWidth: 80 }}>Image URL</label><input type="text" value={ss.image_url} onChange={e => updateSS(i, 'image_url', e.target.value)} /></div>
          </div>
          {ss.image_url && <img src={resolveScreenshotUrl(ss.image_url)} alt={ss.title} style={{ width: 80, height: 60, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border-subtle)' }} />}
          <button className="btn btn-danger btn-sm" onClick={() => removeSS(i)} title="Remove screenshot">X</button>
        </div>
      ))}
      <button className="btn btn-primary btn-sm" onClick={addSS} style={{ marginTop: 8 }} data-testid="settings-discord-ss-add">+ Add Screenshot</button>
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
      <label className="checkbox-label" style={{ marginBottom: 16 }}>
        <input type="checkbox" checked={s.enable_gemini || false} onChange={e => set('enable_gemini', e.target.checked)} data-testid="settings-gemini-on" />
        <span>Enable Gemini AI Summaries</span>
      </label>
      <p className="text-muted text-sm" style={{ marginTop: 8, lineHeight: 1.7 }}>
        When enabled, Gemini generates clearer coaching and fail summaries from the checkboxes selected during the session review.
      </p>
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
