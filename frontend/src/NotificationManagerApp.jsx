import React, { useEffect, useMemo, useRef, useState } from 'react';
import './notification-manager.css';
import {
  NOTIFICATION_CSV_COLUMNS,
  NOTIFICATION_MANAGER_STORAGE_KEY,
  NOTIFICATION_TYPES,
  createEmptyNotification,
  downloadCsv,
  ensureNotificationId,
  getEasternNowDefaults,
  normalizeManagerNotification,
  parseManagerCsv,
  serializeNotificationsToCsv,
  toTwelveHour,
  validateNotification,
} from './utils/notificationManager';

function PreviewBanner({ item }) {
  return (
    <div className={`nm-preview-banner ${item.Type === 'warning' ? 'is-warning' : ''} ${item.Type === 'urgent' ? 'is-urgent' : ''}`}>
      <h4>{item.Title || 'Notification banner'}</h4>
      <p>{item.Message || 'Banner preview updates as you edit the notification.'}</p>
    </div>
  );
}

function PreviewPopup({ item }) {
  return (
    <div className="nm-preview-popup">
      <h4>{item.Title || 'Popup preview'}</h4>
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
    item.ShowPopup ? 'Popup' : null,
    item.ShowBanner ? 'Banner' : null,
    item.Persistent ? 'Persistent' : 'Dismissible',
  ].filter(Boolean).join(' · ');
}

export default function NotificationManagerApp() {
  const fileInputRef = useRef(null);
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

  useEffect(() => {
    document.body.classList.add('notification-manager-body');
    return () => document.body.classList.remove('notification-manager-body');
  }, []);

  useEffect(() => {
    localStorage.setItem(NOTIFICATION_MANAGER_STORAGE_KEY, JSON.stringify(items));
  }, [items]);

  const selectedItem = items[selectedIndex] || items[0];
  const validation = useMemo(
    () => (selectedItem ? validateNotification(selectedItem, items) : { errors: [], id: '' }),
    [items, selectedItem],
  );

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
    setItems((current) => [...current, next]);
    setSelectedIndex(items.length);
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
    setItems((current) => [...current, duplicate]);
    setSelectedIndex(items.length);
  };

  const handleDelete = () => {
    if (items.length === 1) {
      setItems([createEmptyNotification()]);
      setSelectedIndex(0);
      return;
    }
    setItems((current) => current.filter((_, index) => index !== selectedIndex));
    setSelectedIndex((current) => Math.max(0, current - 1));
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
      setItems(parsed);
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
    'All times interpreted as Eastern',
    `${NOTIFICATION_CSV_COLUMNS.length} export columns`,
  ];

  return (
    <div className="nm-app">
      <div className="nm-shell">
        <section className="nm-hero">
          <div>
            <div className="nm-overline">Mock Testing Suite Tooling</div>
            <h1 className="nm-title">Notification Manager</h1>
            <p className="nm-subtitle">
              Create, edit, preview, import, and export structured notifications for Mock Testing Suite without touching the raw sheet by hand.
              Starts At defaults to the current Eastern time, Expires At stays blank unless you set it, and the exported CSV matches the live app schema.
            </p>
            <div className="nm-actions">
              <button type="button" className="nm-btn nm-btn-primary" onClick={handleAdd}>Add Notification</button>
              <button type="button" className="nm-btn nm-btn-secondary" onClick={handleDuplicate} disabled={!selectedItem}>Duplicate Selected</button>
              <button type="button" className="nm-btn nm-btn-secondary" onClick={handleExport}>Export CSV</button>
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
            </div>
          </div>
          <div className="nm-pill-row">
            {infoTiles.map((tile) => <div key={tile} className="nm-pill">{tile}</div>)}
          </div>
        </section>

        <div className="nm-grid">
          <section className="nm-panel">
            <div className="nm-section-title">
              <div>
                <h2>Notifications</h2>
                <div className="nm-kicker">Table view for quick scanning and selection</div>
              </div>
            </div>
            <table className="nm-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Schedule</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => {
                  const normalized = normalizeManagerNotification(item);
                  return (
                    <tr key={`${normalized.ID || 'new'}-${index}`} className={index === selectedIndex ? 'is-selected' : ''}>
                      <td>
                        <button type="button" onClick={() => setSelectedIndex(index)}>
                          <span className={getBadgeClass(normalized.Type)}>{normalized.Type}</span>
                        </button>
                      </td>
                      <td>
                        <button type="button" onClick={() => setSelectedIndex(index)}>
                          <div style={{ fontWeight: 800 }}>{normalized.Title || '(Untitled notification)'}</div>
                          <div className="nm-meta">{normalized.Message || 'No message yet.'}</div>
                        </button>
                      </td>
                      <td>
                        <div style={{ fontWeight: 700 }}>{normalized.Enabled ? 'Enabled' : 'Disabled'}</div>
                        <div className="nm-meta">{formatFlags(normalized)}</div>
                      </td>
                      <td className="nm-meta">
                        <div>{normalized.StartDate || 'Starts immediately'} {normalized.StartTime || ''}</div>
                        <div>{normalized.EndDate ? `Expires ${normalized.EndDate} ${normalized.EndTime || '12:00 AM'}` : 'No auto-expiration'}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="nm-panel" style={{ display: 'grid', gap: 20 }}>
            <div className="nm-form-card">
              <div className="nm-section-title">
                <div>
                  <h3>Edit Notification</h3>
                  <div className="nm-kicker">The export keeps the final Mock Testing Suite sheet schema</div>
                </div>
                <button type="button" className="nm-btn nm-btn-danger" onClick={handleDelete}>Delete</button>
              </div>

              {selectedItem ? (
                <div className="nm-form-layout">
                  <div className="nm-fields">
                    <div className="nm-field-grid">
                      <div className="nm-field">
                        <label htmlFor="nm-type">Type</label>
                        <select id="nm-type" value={selectedItem.Type} onChange={(event) => updateSelected({ Type: event.target.value })}>
                          {NOTIFICATION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                        </select>
                      </div>
                      <div className="nm-field">
                        <label htmlFor="nm-id">ID</label>
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

                    <div className="nm-inline">
                      <label className="nm-checkbox"><input type="checkbox" checked={selectedItem.Enabled} onChange={(event) => updateSelected({ Enabled: event.target.checked })} /> Enabled</label>
                      <label className="nm-checkbox"><input type="checkbox" checked={selectedItem.ShowPopup} onChange={(event) => updateSelected({ ShowPopup: event.target.checked })} /> Show Popup</label>
                      <label className="nm-checkbox"><input type="checkbox" checked={selectedItem.ShowBanner} onChange={(event) => updateSelected({ ShowBanner: event.target.checked })} /> Show Banner</label>
                      <label className="nm-checkbox"><input type="checkbox" checked={selectedItem.Persistent} onChange={(event) => updateSelected({ Persistent: event.target.checked })} /> Persistent</label>
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
                        <label htmlFor="nm-end-date">Expires At Date</label>
                        <input id="nm-end-date" type="date" value={selectedItem.EndDate} onChange={(event) => updateSelected({ EndDate: event.target.value })} />
                      </div>
                      <div className="nm-field">
                        <label htmlFor="nm-end-time">Expires At Time</label>
                        <input id="nm-end-time" type="text" value={selectedItem.EndTime} onChange={(event) => updateSelected({ EndTime: event.target.value })} placeholder="12:00 AM" />
                      </div>
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
                  </div>

                  <div className="nm-sidecard">
                    <h4>Export Rules</h4>
                    <ul>
                      <li>`StartDate` defaults to today in Eastern Time.</li>
                      <li>`StartTime` defaults to the current Eastern time.</li>
                      <li>`Expires At` stays blank until you choose an end date.</li>
                      <li>When `EndDate` is set and `EndTime` is blank, export uses `12:00 AM`.</li>
                      <li>Ticker speed is controlled in Mock Testing Suite Settings, not in this file.</li>
                    </ul>
                    <h4 style={{ marginTop: 18 }}>Current ID</h4>
                    <p style={{ margin: 0, fontFamily: '"IBM Plex Mono", monospace' }}>{validation.id}</p>
                  </div>
                </div>
              ) : (
                <div className="nm-empty">Select a notification to edit.</div>
              )}
            </div>

            <div className="nm-preview-card">
              <div className="nm-section-title">
                <div>
                  <h3>Live Preview</h3>
                  <div className="nm-kicker">Ticker, banner, and popup rendering from the selected row</div>
                </div>
              </div>
              {selectedItem ? (
                <div className="nm-preview-stack">
                  <div className="nm-preview-box">
                    <div className="nm-preview-label">Ticker Preview</div>
                    <div className="nm-preview-ticker">
                      {selectedItem.Type === 'ticker'
                        ? `${selectedItem.Title ? `${selectedItem.Title}: ` : ''}${selectedItem.Message || 'Ticker preview text'}`
                        : 'Only Type=ticker rows appear in the ticker bar.'}
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
        </div>
      </div>
    </div>
  );
}
