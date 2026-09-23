/**
 * ContentManagementApp.jsx — SAM Content Management UI
 *
 * Provides administrator interface for managing Callers and Discord Posts
 * content domains, including per-item editing, optimistic concurrency,
 * publishing, version history, and restoration.
 *
 * Security: Uses SAM authenticated JWT for all operations.
 * Identity is derived from the JWT, never from request body.
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import api from '../api';

const CONTENT_DOMAINS = [
  { key: 'callers', label: 'Caller Roster' },
  { key: 'discord_posts', label: 'Discord Posts' },
];

const CALLER_FIELDS = [
  { key: 'category', label: 'Category', type: 'select', options: ['New', 'Existing', 'Increase'] },
  { key: 'first_name', label: 'First Name', type: 'text' },
  { key: 'last_name', label: 'Last Name', type: 'text' },
  { key: 'address', label: 'Address', type: 'text' },
  { key: 'city', label: 'City', type: 'text' },
  { key: 'state', label: 'State', type: 'text' },
  { key: 'zip', label: 'ZIP', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'email', label: 'Email', type: 'text' },
  { key: 'display_order', label: 'Display Order', type: 'number' },
];

const DISCORD_FIELDS = [
  { key: 'category', label: 'Category', type: 'text' },
  { key: 'title', label: 'Title', type: 'text' },
  { key: 'message', label: 'Message', type: 'textarea' },
  { key: 'display_order', label: 'Display Order', type: 'number' },
];

async function apiPost(path, payload, accessToken) {
  try {
    if (api) {
      if (path.includes('/content/state')) {
        return await api.getContentManagementState(payload.domain, accessToken);
      }
      if (path.includes('/content/save-item')) {
        return await api.saveContentManagementItem(payload.domain, payload.item_data, payload.item_id, payload.expected_updated_at, accessToken);
      }
      if (path.includes('/content/deactivate-item')) {
        return await api.deactivateContentManagementItem(payload.domain, payload.item_id, payload.expected_updated_at, accessToken);
      }
      if (path.includes('/content/publish')) {
        return await api.publishContentManagementDomain(payload.domain, payload.notes, payload.expected_current_version, accessToken);
      }
      if (path.includes('/content/restore')) {
        return await api.restoreContentManagementVersion(payload.domain, payload.version_id, payload.notes, payload.also_restore_draft, payload.expected_current_version, accessToken);
      }
    }
  } catch (err) {
    if (err?.response?.data) return err.response.data;
    // Fall through to fetch
  }
  const headers = { 'Content-Type': 'application/json' };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }
  const response = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  return response.json();
}

/**
 * ContentManagementApp component
 * @param {Object} props
 * @param {string} props.accessToken - SAM authenticated JWT
 * @param {Function} [props.onError] - Error handler callback
 */
export default function ContentManagementApp({ accessToken, onError }) {
  const [activeDomain, setActiveDomain] = useState('callers');
  const [draftItems, setDraftItems] = useState([]);
  const [currentPublication, setCurrentPublication] = useState(null);
  const [versionHistory, setVersionHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingItem, setEditingItem] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [showPublishConfirm, setShowPublishConfirm] = useState(false);
  const [publishNotes, setPublishNotes] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [restoreConfirm, setRestoreConfirm] = useState(null);
  const [restoreNotes, setRestoreNotes] = useState('');
  const [restoreDraft, setRestoreDraft] = useState(false);
  const [showNewItem, setShowNewItem] = useState(false);
  const [newItemForm, setNewItemForm] = useState({});
  const [operationMessage, setOperationMessage] = useState(null);
  const messageTimer = useRef(null);

  const showMessage = useCallback((text, type = 'info') => {
    if (messageTimer.current) clearTimeout(messageTimer.current);
    setOperationMessage({ text, type });
    messageTimer.current = setTimeout(() => setOperationMessage(null), 5000);
  }, []);

  // Load content management state for the active domain
  const loadState = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await apiPost('/sam/admin/content/state', { domain: activeDomain }, accessToken);
      if (result?.ok) {
        setDraftItems(result.draft_items || []);
        setCurrentPublication(result.current_publication && result.current_publication !== null ? result.current_publication : null);
        setVersionHistory(result.version_history || []);
      } else {
        const msg = result?.error || 'Failed to load content state.';
        setError(msg);
        if (onError) onError(msg);
      }
    } catch (err) {
      setError('Network error loading content state.');
    } finally {
      setLoading(false);
    }
  }, [accessToken, activeDomain, onError]);

  useEffect(() => {
    loadState();
  }, [loadState]);

  // Filtered items based on search
  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return draftItems;
    const q = searchQuery.trim().toLowerCase();
    return draftItems.filter((item) => {
      if (activeDomain === 'callers') {
        return (
          (item.first_name || '').toLowerCase().includes(q) ||
          (item.last_name || '').toLowerCase().includes(q) ||
          (item.category || '').toLowerCase().includes(q) ||
          (item.city || '').toLowerCase().includes(q) ||
          (item.zip || '').toLowerCase().includes(q)
        );
      }
      return (
        (item.title || '').toLowerCase().includes(q) ||
        (item.category || '').toLowerCase().includes(q) ||
        (item.message || '').toLowerCase().includes(q)
      );
    });
  }, [draftItems, searchQuery, activeDomain]);

  const activeItems = useMemo(() => filteredItems.filter((item) => item.is_active !== false), [filteredItems]);
  const inactiveItems = useMemo(() => filteredItems.filter((item) => item.is_active === false), [filteredItems]);

  // Edit handlers
  const startEdit = useCallback((item) => {
    setEditingItem(item.id);
    setEditForm({ ...item });
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingItem(null);
    setEditForm({});
  }, []);

  const saveItem = useCallback(async () => {
    if (!editingItem) return;
    setSaving(true);
    try {
      const result = await apiPost('/sam/admin/content/save-item', {
        domain: activeDomain,
        item_id: editingItem,
        item_data: editForm,
        expected_updated_at: editForm.updated_at,
      }, accessToken);

      if (result?.ok) {
        showMessage('Item saved successfully.', 'success');
        setEditingItem(null);
        setEditForm({});
        await loadState();
      } else if (result?.error_code === 'CONCURRENT_EDIT') {
        showMessage('Another administrator modified this item. Please refresh and try again.', 'warning');
      } else {
        showMessage(result?.error || 'Failed to save item.', 'error');
      }
    } catch (err) {
      showMessage('Network error saving item.', 'error');
    } finally {
      setSaving(false);
    }
  }, [editingItem, editForm, activeDomain, accessToken, loadState, showMessage]);

  const addNewItem = useCallback(async () => {
    setSaving(true);
    try {
      const result = await apiPost('/sam/admin/content/save-item', {
        domain: activeDomain,
        item_data: newItemForm,
      }, accessToken);

      if (result?.ok) {
        showMessage('New item added.', 'success');
        setShowNewItem(false);
        setNewItemForm({});
        await loadState();
      } else {
        showMessage(result?.error || 'Failed to add item.', 'error');
      }
    } catch (err) {
      showMessage('Network error adding item.', 'error');
    } finally {
      setSaving(false);
    }
  }, [activeDomain, newItemForm, accessToken, loadState, showMessage]);

  const deactivateItem = useCallback(async (item) => {
    if (!window.confirm(`Deactivate "${activeDomain === 'callers' ? `${item.first_name} ${item.last_name}` : item.title}"?`)) return;
    try {
      const result = await apiPost('/sam/admin/content/deactivate-item', {
        domain: activeDomain,
        item_id: item.id,
        expected_updated_at: item.updated_at,
      }, accessToken);

      if (result?.ok) {
        showMessage('Item deactivated.', 'success');
        await loadState();
      } else if (result?.error_code === 'CONCURRENT_EDIT') {
        showMessage('This item was modified by another editor. Refresh and try again.', 'warning');
      } else {
        showMessage(result?.error || 'Failed to deactivate item.', 'error');
      }
    } catch (err) {
      showMessage('Network error.', 'error');
    }
  }, [activeDomain, accessToken, loadState, showMessage]);

  // Publish
  const publishDomain = useCallback(async () => {
    setPublishing(true);
    try {
      const result = await apiPost('/sam/admin/content/publish', {
        domain: activeDomain,
        notes: publishNotes,
        expected_current_version: currentPublication?.version_id || null,
      }, accessToken);

      if (result?.ok) {
        showMessage(`Published ${activeDomain} ${result.version_id} (${result.item_count} items).`, 'success');
        setShowPublishConfirm(false);
        setPublishNotes('');
        await loadState();
      } else if (result?.error_code === 'STALE_PUBLISH') {
        showMessage('Another administrator published a newer version. Refresh before publishing.', 'warning');
      } else if (result?.error_code === 'CONTENT_UNCHANGED') {
        showMessage('No changes to publish — content is identical to current publication.', 'info');
        setShowPublishConfirm(false);
      } else if (result?.error_code === 'EMPTY_CONTENT') {
        showMessage('Cannot publish an empty roster. Add items first.', 'error');
        setShowPublishConfirm(false);
      } else {
        showMessage(result?.error || 'Failed to publish.', 'error');
      }
    } catch (err) {
      showMessage('Network error publishing.', 'error');
    } finally {
      setPublishing(false);
    }
  }, [activeDomain, publishNotes, currentPublication, accessToken, loadState, showMessage]);

  // Restore
  const restoreVersion = useCallback(async () => {
    if (!restoreConfirm) return;
    setPublishing(true);
    try {
      const result = await apiPost('/sam/admin/content/restore', {
        domain: activeDomain,
        version_id: restoreConfirm.version_id,
        notes: restoreNotes || `Restored from ${restoreConfirm.version_id}`,
        also_restore_draft: restoreDraft,
        expected_current_version: currentPublication?.version_id || null,
      }, accessToken);

      if (result?.ok) {
        showMessage(`Restored ${result.version_id} from ${result.restored_from}${restoreDraft ? ' (draft also restored)' : ''}.`, 'success');
        setRestoreConfirm(null);
        setRestoreNotes('');
        setRestoreDraft(false);
        await loadState();
      } else if (result?.error_code === 'STALE_RESTORE') {
        showMessage('Another administrator published since. Refresh before restoring.', 'warning');
      } else {
        showMessage(result?.error || 'Failed to restore.', 'error');
      }
    } catch (err) {
      showMessage('Network error restoring.', 'error');
    } finally {
      setPublishing(false);
    }
  }, [activeDomain, restoreConfirm, restoreNotes, restoreDraft, currentPublication, accessToken, loadState, showMessage]);

  const fields = activeDomain === 'callers' ? CALLER_FIELDS : DISCORD_FIELDS;

  const renderField = (field, value, onChange) => {
    if (field.type === 'select') {
      return (
        <select value={value || ''} onChange={(e) => onChange(field.key, e.target.value)} className="cm-input">
          {(field.options || []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
        </select>
      );
    }
    if (field.type === 'textarea') {
      return (
        <textarea
          value={value || ''} onChange={(e) => onChange(field.key, e.target.value)}
          className="cm-input cm-textarea" rows={6}
        />
      );
    }
    if (field.type === 'number') {
      return (
        <input type="number" value={value ?? ''} onChange={(e) => onChange(field.key, parseInt(e.target.value, 10) || 0)} className="cm-input" />
      );
    }
    return <input type="text" value={value || ''} onChange={(e) => onChange(field.key, e.target.value)} className="cm-input" />;
  };

  const itemLabel = (item) => {
    if (activeDomain === 'callers') return `${item.first_name || ''} ${item.last_name || ''}`.trim() || '(unnamed)';
    return item.title || '(untitled)';
  };

  return (
    <div className="cm-container">
      <style>{`
        .cm-container { padding: 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
        .cm-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
        .cm-tabs { display: flex; gap: 8px; margin-bottom: 16px; }
        .cm-tab { padding: 8px 16px; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; background: #f5f5f5; font-size: 14px; }
        .cm-tab.active { background: #0066cc; color: white; border-color: #0066cc; }
        .cm-search { padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; width: 300px; font-size: 14px; }
        .cm-actions { display: flex; gap: 8px; }
        .cm-btn { padding: 8px 16px; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; font-size: 13px; background: white; }
        .cm-btn:hover { background: #f0f0f0; }
        .cm-btn.primary { background: #0066cc; color: white; border-color: #0066cc; }
        .cm-btn.primary:hover { background: #0055aa; }
        .cm-btn.danger { background: #cc3333; color: white; border-color: #cc3333; }
        .cm-btn.danger:hover { background: #aa2222; }
        .cm-btn.success { background: #228833; color: white; border-color: #228833; }
        .cm-btn.success:hover { background: #117722; }
        .cm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .cm-table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
        .cm-table th, .cm-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #eee; font-size: 13px; }
        .cm-table th { background: #f8f8f8; font-weight: 600; position: sticky; top: 0; }
        .cm-table tr:hover { background: #f5f9ff; }
        .cm-table tr.inactive { opacity: 0.5; background: #fafafa; }
        .cm-input { padding: 6px 8px; border: 1px solid #ccc; border-radius: 3px; font-size: 13px; width: 100%; box-sizing: border-box; }
        .cm-textarea { resize: vertical; font-family: inherit; }
        .cm-message { padding: 10px 16px; border-radius: 4px; margin-bottom: 12px; font-size: 13px; }
        .cm-message.success { background: #e6f4ea; color: #137333; border: 1px solid #a8dab5; }
        .cm-message.error { background: #fce8e6; color: #c5221f; border: 1px solid #f5c6cb; }
        .cm-message.warning { background: #fef7cd; color: #8a6d3b; border: 1px solid #f0e0a1; }
        .cm-message.info { background: #e8f0fe; color: #1967d2; border: 1px solid #aecbfa; }
        .cm-pub-info { padding: 12px; background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 4px; margin-bottom: 16px; font-size: 13px; }
        .cm-pub-info strong { font-weight: 600; }
        .cm-modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.4); display: flex; justify-content: center; align-items: center; z-index: 1000; }
        .cm-modal { background: white; border-radius: 8px; padding: 24px; max-width: 500px; width: 90%; box-shadow: 0 4px 16px rgba(0,0,0,0.2); }
        .cm-modal h3 { margin-top: 0; }
        .cm-history { max-height: 300px; overflow-y: auto; }
        .cm-history-item { padding: 8px 12px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
        .cm-history-item.current { background: #e8f0fe; }
        .cm-edit-form { padding: 16px; background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 4px; margin-bottom: 8px; }
        .cm-edit-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
        .cm-edit-row label { min-width: 120px; font-size: 13px; font-weight: 500; }
        .cm-section-label { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin: 16px 0 8px; font-weight: 600; }
        .cm-empty { text-align: center; padding: 40px; color: #999; font-size: 14px; }
        .cm-count { font-size: 12px; color: #666; margin-left: 8px; }
      `}</style>

      <div className="cm-header">
        <h2 style={{ margin: 0 }}>Content Management</h2>
      </div>

      {/* Domain tabs */}
      <div className="cm-tabs">
        {CONTENT_DOMAINS.map((d) => (
          <button
            key={d.key}
            className={`cm-tab ${activeDomain === d.key ? 'active' : ''}`}
            onClick={() => { setActiveDomain(d.key); setSearchQuery(''); setEditingItem(null); setShowNewItem(false); }}
          >
            {d.label}
          </button>
        ))}
      </div>

      {/* Operation message */}
      {operationMessage && (
        <div className={`cm-message ${operationMessage.type}`}>{operationMessage.text}</div>
      )}

      {/* Publication info */}
      {currentPublication && currentPublication.version_id && (
        <div className="cm-pub-info">
          <strong>Current Publication:</strong> {currentPublication.version_id} &middot;{' '}
          {currentPublication.item_count} items &middot; Published{' '}
          {currentPublication.published_at ? new Date(currentPublication.published_at).toLocaleString() : 'unknown'} by{' '}
          {currentPublication.published_by || 'unknown'}
          {currentPublication.content_hash && <span style={{ color: '#888', marginLeft: 8 }}>#{currentPublication.content_hash.substring(0, 8)}</span>}
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="text" placeholder="Search..." value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)} className="cm-search"
          />
          <span className="cm-count">
            {activeItems.length} active{inactiveItems.length > 0 ? `, ${inactiveItems.length} inactive` : ''}
          </span>
        </div>
        <div className="cm-actions">
          <button className="cm-btn" onClick={() => setShowNewItem(true)} disabled={loading}>+ Add Item</button>
          <button className="cm-btn" onClick={() => setShowHistory(!showHistory)} disabled={loading}>
            {showHistory ? 'Hide History' : 'Version History'}
          </button>
          <button className="cm-btn primary" onClick={() => setShowPublishConfirm(true)} disabled={loading || activeItems.length === 0}>
            Publish
          </button>
          <button className="cm-btn" onClick={loadState} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      {/* Loading / Error */}
      {loading && <div className="cm-empty">Loading...</div>}
      {error && <div className="cm-message error">{error}</div>}

      {/* New item form */}
      {showNewItem && (
        <div className="cm-edit-form">
          <h4 style={{ margin: '0 0 12px' }}>New {activeDomain === 'callers' ? 'Caller' : 'Discord Post'}</h4>
          {fields.map((field) => (
            <div key={field.key} className="cm-edit-row">
              <label>{field.label}</label>
              {renderField(field, newItemForm[field.key], (k, v) => setNewItemForm((prev) => ({ ...prev, [k]: v })))}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="cm-btn success" onClick={addNewItem} disabled={saving}>{saving ? 'Saving...' : 'Add'}</button>
            <button className="cm-btn" onClick={() => { setShowNewItem(false); setNewItemForm({}); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Items table */}
      {!loading && activeItems.length === 0 && !error && (
        <div className="cm-empty">
          No {activeDomain === 'callers' ? 'callers' : 'discord posts'} found.
          {searchQuery && ' Try adjusting your search.'}
        </div>
      )}

      {activeItems.length > 0 && (
        <>
          <div className="cm-section-label">Active Items ({activeItems.length})</div>
          <table className="cm-table">
            <thead>
              <tr>
                {(activeDomain === 'callers'
                  ? ['Category', 'First Name', 'Last Name', 'City', 'ZIP', 'Phone']
                  : ['Category', 'Title', 'Message (preview)', 'Order']
                ).map((h) => <th key={h}>{h}</th>)}
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {activeItems.map((item) => (
                <React.Fragment key={item.id}>
                  <tr>
                    {activeDomain === 'callers' ? (
                      <>
                        <td>{item.category}</td>
                        <td>{item.first_name}</td>
                        <td>{item.last_name}</td>
                        <td>{item.city}</td>
                        <td>{item.zip}</td>
                        <td>{item.phone}</td>
                      </>
                    ) : (
                      <>
                        <td>{item.category}</td>
                        <td>{item.title}</td>
                        <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {(item.message || '').substring(0, 80)}
                        </td>
                        <td>{item.display_order}</td>
                      </>
                    )}
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="cm-btn" onClick={() => startEdit(item)} disabled={editingItem === item.id}>Edit</button>
                        <button className="cm-btn danger" onClick={() => deactivateItem(item)}>Deactivate</button>
                      </div>
                    </td>
                  </tr>
                  {editingItem === item.id && (
                    <tr>
                      <td colSpan={activeDomain === 'callers' ? 7 : 5}>
                        <div className="cm-edit-form">
                          {fields.map((field) => (
                            <div key={field.key} className="cm-edit-row">
                              <label>{field.label}</label>
                              {renderField(field, editForm[field.key], (k, v) => setEditForm((prev) => ({ ...prev, [k]: v })))}
                            </div>
                          ))}
                          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                            <button className="cm-btn success" onClick={saveItem} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
                            <button className="cm-btn" onClick={cancelEdit}>Cancel</button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* Inactive items */}
      {inactiveItems.length > 0 && (
        <>
          <div className="cm-section-label">Inactive Items ({inactiveItems.length})</div>
          <table className="cm-table">
            <thead>
              <tr>
                {(activeDomain === 'callers'
                  ? ['Category', 'Name', 'City']
                  : ['Category', 'Title']
                ).map((h) => <th key={h}>{h}</th>)}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {inactiveItems.map((item) => (
                <tr key={item.id} className="inactive">
                  {activeDomain === 'callers' ? (
                    <>
                      <td>{item.category}</td>
                      <td>{item.first_name} {item.last_name}</td>
                      <td>{item.city}</td>
                    </>
                  ) : (
                    <>
                      <td>{item.category}</td>
                      <td>{item.title}</td>
                    </>
                  )}
                  <td style={{ color: '#888' }}>Deactivated</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* Version History Panel */}
      {showHistory && (
        <div style={{ marginTop: 16 }}>
          <div className="cm-section-label">Version History</div>
          {versionHistory.length === 0 ? (
            <div className="cm-empty">No publication history available.</div>
          ) : (
            <div className="cm-history">
              {versionHistory.map((v) => (
                <div key={v.version_id} className={`cm-history-item ${v.is_current ? 'current' : ''}`}>
                  <div>
                    <strong>{v.version_id}</strong>
                    {v.is_current && <span style={{ color: '#0066cc', marginLeft: 8 }}>● Current</span>}
                    <br />
                    <span style={{ color: '#666' }}>
                      {v.item_count} items &middot; {v.published_at ? new Date(v.published_at).toLocaleString() : ''} &middot; {v.published_by}
                    </span>
                    {v.notes && <div style={{ color: '#444', fontStyle: 'italic', marginTop: 2 }}>{v.notes}</div>}
                  </div>
                  {!v.is_current && (
                    <button className="cm-btn" onClick={() => { setRestoreConfirm(v); setRestoreNotes(''); setRestoreDraft(false); }}>
                      Restore
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Publish Confirmation Modal */}
      {showPublishConfirm && (
        <div className="cm-modal-overlay">
          <div className="cm-modal">
            <h3>Publish {activeDomain === 'callers' ? 'Caller Roster' : 'Discord Posts'}?</h3>
            <p>This will publish {activeItems.length} active item(s) as the new current version.</p>
            {currentPublication?.version_id && (
              <p style={{ color: '#666' }}>Current version: {currentPublication.version_id}</p>
            )}
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Notes (optional):</label>
              <input type="text" value={publishNotes} onChange={(e) => setPublishNotes(e.target.value)} className="cm-input" placeholder="Publication notes..." />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="cm-btn" onClick={() => setShowPublishConfirm(false)}>Cancel</button>
              <button className="cm-btn primary" onClick={publishDomain} disabled={publishing}>
                {publishing ? 'Publishing...' : 'Confirm Publish'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Restore Confirmation Modal */}
      {restoreConfirm && (
        <div className="cm-modal-overlay">
          <div className="cm-modal">
            <h3>Restore Publication?</h3>
            <p>Restore <strong>{restoreConfirm.version_id}</strong> ({restoreConfirm.item_count} items) as the new current publication.</p>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Notes (optional):</label>
              <input type="text" value={restoreNotes} onChange={(e) => setRestoreNotes(e.target.value)} className="cm-input" />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={restoreDraft} onChange={(e) => setRestoreDraft(e.target.checked)} />
                <span>Also replace working draft with this version's content</span>
              </label>
              {restoreDraft && (
                <div className="cm-message warning" style={{ marginTop: 8 }}>
                  ⚠ This will replace your current unpublished draft edits with the content from {restoreConfirm.version_id}.
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="cm-btn" onClick={() => setRestoreConfirm(null)}>Cancel</button>
              <button className="cm-btn primary" onClick={restoreVersion} disabled={publishing}>
                {publishing ? 'Restoring...' : 'Confirm Restore'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
