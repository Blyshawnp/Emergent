import React, { useEffect, useMemo, useRef, useState } from 'react';
import './notification-manager.css';
import api from './api';
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
const NOTIFICATION_VIEWS = [
  { key: 'active', label: 'Current' },
  { key: 'disabled', label: 'Disabled / Expired' },
  { key: 'all', label: 'All Notifications' },
];

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

export default function NotificationManagerApp() {
  const fileInputRef = useRef(null);
  const editorRef = useRef(null);
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
    statusMessage: '',
    writeReady: false,
    writeError: '',
    readError: '',
    sheetId: '',
  });
  const [notificationView, setNotificationView] = useState('active');

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
    localStorage.setItem(NOTIFICATION_MANAGER_STORAGE_KEY, JSON.stringify(items));
  }, [items]);

  const selectedItem = items[selectedIndex] || items[0];
  const validation = useMemo(
    () => (selectedItem ? validateNotification(selectedItem, items) : { errors: [], id: '' }),
    [items, selectedItem],
  );

  const loadSheetItems = async ({ silent = false } = {}) => {
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
        writeReady: Boolean(response?.write?.ready),
        writeError: response?.write?.error || '',
        readError: response?.ok === false ? (response?.error || 'Unable to read the configured notification sheet.') : '',
        sheetId: response?.sheet?.sheetId || '',
        statusKind: response?.ok === false ? 'warning' : current.statusKind,
        statusMessage: response?.ok === false ? (response?.error || 'Unable to read the configured notification sheet.') : current.statusMessage,
      }));
    } catch (error) {
      setSheetState((current) => ({
        ...current,
        isLoading: false,
        readError: error instanceof Error ? error.message : 'Unable to read the configured notification sheet.',
        statusKind: 'error',
        statusMessage: error instanceof Error ? error.message : 'Unable to read the configured notification sheet.',
      }));
    }
  };

  useEffect(() => {
    loadSheetItems();
  }, []);

  const focusEditor = () => {
    window.requestAnimationFrame(() => {
      editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const selectNotification = (index) => {
    setSelectedIndex(index);
    focusEditor();
  };

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
    focusEditor();
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
    focusEditor();
  };

  const handleDeleteIndex = (index) => {
    const target = items[index];
    const confirmed = window.confirm(`Delete "${target?.Title || target?.Message || 'this notification'}"?`);
    if (!confirmed) return;

    if (items.length === 1) {
      setItems([createEmptyNotification()]);
      setSelectedIndex(0);
      focusEditor();
      return;
    }

    setItems((current) => current.filter((_, rowIndex) => rowIndex !== index));
    setSelectedIndex((current) => {
      if (current > index) return current - 1;
      if (current === index) return Math.max(0, current - 1);
      return current;
    });
    focusEditor();
  };

  const handleDelete = () => {
    handleDeleteIndex(selectedIndex);
  };

  const handleToggleEnabled = (index) => {
    const nextItems = sortManagerItems(items.map((entry, rowIndex) => (
      rowIndex === index
        ? normalizeManagerNotification({
            ...entry,
            Enabled: !entry.Enabled,
            UpdatedAt: new Date().toISOString(),
          })
        : entry
    )));
    const targetId = items[index]?.ID;
    setItems(nextItems);
    const nextIndex = nextItems.findIndex((entry) => entry.ID === targetId);
    setSelectedIndex(nextIndex >= 0 ? nextIndex : 0);
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

    if (window.confirm('Are you sure you want to exit the Notification Manager?')) {
      window.close();
    }
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

    const outgoing = normalizeManagerNotification({
      ...selectedItem,
      ID: validation.id,
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
        return;
      }

      const savedItem = normalizeManagerNotification(result.item || outgoing);
      setItems((current) => {
        const nextItems = sortManagerItems(current.map((entry, index) => (
          index === selectedIndex ? savedItem : entry
        )));
        const nextIndex = nextItems.findIndex((entry) => entry.ID === savedItem.ID);
        setSelectedIndex(nextIndex >= 0 ? nextIndex : 0);
        return nextItems;
      });
      setSheetState((current) => ({
        ...current,
        isSaving: false,
        writeReady: true,
        statusKind: 'success',
        statusMessage: `Notification ${result.action === 'updated' ? 'updated' : 'appended'} in Google Sheet${result.sheetTitle ? ` (${result.sheetTitle})` : ''}. The main app will pick it up on its next refresh.`,
      }));
    } catch (error) {
      setSheetState((current) => ({
        ...current,
        isSaving: false,
        statusKind: 'error',
        statusMessage: error instanceof Error ? error.message : 'Unable to submit the notification to Google Sheets.',
      }));
    }
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
            <div className="nm-overline">Mock Testing Suite Tooling</div>
            <h1 className="nm-title">Notification Manager</h1>
            <p className="nm-subtitle">
              Create, edit, preview, and push structured notifications directly into the configured Google Sheet.
              Starts At defaults to the current Eastern time, Expires At uses 12:00 AM Eastern when you leave the time blank, and the saved row matches the live app schema the main app already reads.
            </p>
            <div className="nm-hero-toolbar">
            <div className="nm-actions-panel">
                <div className="nm-toolbar-label">Actions</div>
                <div className="nm-actions">
                  <button type="button" className="nm-btn nm-btn-primary" onClick={handleAdd}>Add Notification</button>
                  <button type="button" className="nm-btn nm-btn-secondary" onClick={handleDuplicate} disabled={!selectedItem}>Duplicate Selected</button>
                  <button type="button" className="nm-btn nm-btn-secondary" onClick={loadSheetItems} disabled={sheetState.isLoading || sheetState.isSaving}>Refresh from Sheet</button>
                  <button type="button" className="nm-btn nm-btn-success" onClick={handleSubmit} disabled={!selectedItem || sheetState.isSaving || sheetState.isLoading}>
                    {sheetState.isSaving ? 'Submitting…' : 'Submit to Sheet'}
                  </button>
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
                  <button type="button" className="nm-btn nm-btn-danger" onClick={handleExitApp}>Exit App</button>
                </div>
              </div>
            </div>
          </div>
          <div className="nm-status-panel">
            <div className="nm-toolbar-label">Status</div>
            <div className="nm-pill-row">
              {infoTiles.map((tile) => <div key={tile} className="nm-pill">{tile}</div>)}
            </div>
          </div>
        </section>

        {sheetState.statusMessage ? (
          <section className={`nm-status-card is-${sheetState.statusKind || 'info'}`}>
            <strong>{sheetState.statusKind === 'success' ? 'Success' : sheetState.statusKind === 'warning' ? 'Warning' : 'Status'}</strong>
            <span>{sheetState.statusMessage}</span>
          </section>
        ) : null}

        <div className="nm-grid">
          <section className="nm-panel" style={{ display: 'grid', gap: 20 }}>
            <div className="nm-form-card" ref={editorRef}>
              <div className="nm-section-title">
                <div>
                  <h3>Edit Notification</h3>
                  <div className="nm-kicker">Use the checkboxes to choose ticker, popup, banner, and persistent behavior. Warning and urgent rows are prefixed automatically in the ticker.</div>
                </div>
                <button type="button" className="nm-btn nm-btn-danger" onClick={handleDelete}>Delete</button>
              </div>

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

                    <div className="nm-inline">
                      <label className="nm-checkbox"><input type="checkbox" checked={selectedItem.Enabled} onChange={(event) => updateSelected({ Enabled: event.target.checked })} /> Enabled</label>
                      <label className="nm-checkbox"><input type="checkbox" checked={selectedItem.ShowTicker} onChange={(event) => updateSelected({ ShowTicker: event.target.checked })} /> Ticker</label>
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

                    <div className="nm-submit-bar">
                      <div className="nm-submit-copy">
                        <strong>Save this notification</strong>
                        <span>{selectedItem.Title || selectedItem.Message || 'Selected draft notification'}</span>
                      </div>
                      <button
                        type="button"
                        className="nm-btn nm-btn-success"
                        onClick={handleSubmit}
                        disabled={!selectedItem || sheetState.isSaving || sheetState.isLoading}
                      >
                        {sheetState.isSaving ? 'Submitting…' : 'Submit Selected Notification'}
                      </button>
                    </div>
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

          <section className="nm-panel">
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
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map(({ item: normalized, index }) => {
                    return (
                      <tr key={`${normalized.ID || 'new'}-${index}`} className={index === selectedIndex ? 'is-selected' : ''}>
                        <td>
                          <button type="button" className="nm-row-select" onClick={() => selectNotification(index)}>
                            <span className={getBadgeClass(normalized.Type)}>{normalized.Type}</span>
                          </button>
                        </td>
                        <td>
                          <button type="button" className="nm-row-select nm-row-title-button" onClick={() => selectNotification(index)}>
                            <div style={{ fontWeight: 800 }}>{normalized.Title || '(Untitled notification)'}</div>
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
                            <button type="button" className="nm-btn nm-btn-secondary nm-btn-table" onClick={() => selectNotification(index)}>Edit</button>
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
      </div>
    </div>
  );
}
