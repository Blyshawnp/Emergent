import axios from 'axios';

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

const BACKEND_URL = getBackendUrl();
const BASE = `${BACKEND_URL}/api`;

export function normalizeDiscordTemplate(template) {
  if (!template) return null;
  if (Array.isArray(template)) {
    return { title: String(template[0] || ''), message: String(template[1] || '') };
  }
  if (typeof template === 'object') {
    const title = template.title || template.Title || template.trigger || template.Trigger || template.name || template.Name || template.label || template.Label || '';
    const message = template.message || template.Message || template.text || template.Text || template.content || template.Content || template.body || template.Body || '';
    return { title: String(title), message: String(message) };
  }
  return null;
}

export function normalizeDiscordTemplates(templates) {
  return (Array.isArray(templates) ? templates : [])
    .map(normalizeDiscordTemplate)
    .filter((item) => item && item.title);
}

export function getActiveDiscordTemplates(settings = {}, defaults = {}) {
  if (settings?.discord_override && Array.isArray(settings.discord_templates) && settings.discord_templates.length) {
    return settings.discord_templates;
  }
  if (Array.isArray(defaults?.discord_templates) && defaults.discord_templates.length) {
    return defaults.discord_templates;
  }
  return Array.isArray(settings?.discord_templates) ? settings.discord_templates : [];
}

export function findDiscordTemplateMessage(settings = {}, defaults = {}, title = '') {
  const needle = String(title || '').trim().toLowerCase();
  if (!needle) return '';
  const templates = normalizeDiscordTemplates(getActiveDiscordTemplates(settings, defaults));
  const match = templates.find((item) => item.title.trim().toLowerCase() === needle);
  return match ? match.message : '';
}

function getAdminToken() {
  try {
    return window.electronAPI?.getAdminToken?.() || '';
  } catch (_error) {
    return '';
  }
}

function setUnsavedChanges(value) {
  if (window.electronAPI?.setUnsavedChanges) {
    window.electronAPI.setUnsavedChanges(value).catch(() => {});
  }
}

let _healthCacheOk = false;
let _healthCacheAt = 0;
let _healthCheckPromise = null;
const HEALTH_CACHE_MS = 5000;

async function getHealth() {
  if (_healthCacheOk && (Date.now() - _healthCacheAt) < HEALTH_CACHE_MS) {
    return { ok: true };
  }

  if (_healthCheckPromise) {
    return _healthCheckPromise;
  }

  _healthCheckPromise = request('GET', '/health', null, 2000)
    .then((data) => {
      _healthCacheOk = true;
      _healthCacheAt = Date.now();
      return data;
    })
    .catch((err) => {
      _healthCacheOk = false;
      throw err;
    })
    .finally(() => {
      _healthCheckPromise = null;
    });

  return _healthCheckPromise;
}

async function ensureBackendHealth() {
  if (_healthCacheOk && (Date.now() - _healthCacheAt) < HEALTH_CACHE_MS) {
    return;
  }
  await getHealth();
}

async function request(method, path, body = null, timeout = 15000) {
  const opts = {
    method,
    url: `${BASE}${path}`,
    headers: { 'Content-Type': 'application/json' },
    timeout,
  };
  const adminToken = getAdminToken();
  if (adminToken) {
    opts.headers['X-MTS-Admin-Token'] = adminToken;
  }
  if (body !== null) opts.data = body;
  const res = await axios(opts);
  return res.data;
}

async function savedRequest(method, path, body = null) {
  const data = await request(method, path, body);
  setUnsavedChanges(false);
  return data;
}

const api = {
  getSettings: (timeout) => request('GET', '/settings', null, timeout),
  saveSettings: (data) => savedRequest('PUT', '/settings', data),
  getAdminSettings: (timeout) => request('GET', '/admin/settings', null, timeout),
  saveAdminSettings: (data) => savedRequest('PUT', '/admin/settings', data),
  getHealth: () => getHealth(),
  getDefaults: async (timeout, refresh = false) => {
    await ensureBackendHealth();
    return request('GET', `/settings/defaults${refresh ? '?refresh=true' : ''}`, null, timeout);
  },
  restoreSettingsDefaults: () => savedRequest('POST', '/settings/restore-defaults'),
  resetSettingsSection: (section) => savedRequest('POST', '/settings/reset-section', { section }),
  completeSetup: (data) => savedRequest('POST', '/settings/complete-setup', data),
  getCurrentSession: (timeout) => request('GET', '/session/current', null, timeout),
  getAttemptState: () => request('GET', '/session/attempt-state'),
  startSession: (data) => savedRequest('POST', '/session/start', data),
  updateSession: (data) => savedRequest('PUT', '/session/update', data),
  saveCall: (data) => savedRequest('POST', '/session/call', data),
  saveSupTransfer: (data) => savedRequest('POST', '/session/sup', data),
  finishSessionSimple: () => savedRequest('POST', '/session/finish'),
  discardSession: () => savedRequest('POST', '/session/discard'),
  getHistory: (timeout) => request('GET', '/history', null, timeout),
  getHistoryStats: (timeout) => request('GET', '/history/stats', null, timeout),
  reconcileHistory: (timeout) => request('POST', '/history/reconcile', null, timeout),
  clearHistory: () => request('DELETE', '/history'),
  deleteHistorySession: (historyId) => request('DELETE', `/history/session/${encodeURIComponent(historyId)}`),
  requestHistorySessionDeletion: (historyId, reason) => request('POST', `/history/session/${encodeURIComponent(historyId)}/deletion-request`, { reason }),
  requestHistorySessionCorrection: (historyId, changes, reason) => request('POST', `/history/session/${encodeURIComponent(historyId)}/correction-request`, { changes, reason }),
  updateHistorySessionFormStatus: (historyId, formFillStatus) => request('POST', `/history/session/${encodeURIComponent(historyId)}/form-status`, { form_fill_status: formFillStatus }),
  lookupSharedCandidate: (name) => request('GET', `/shared/candidates/lookup?name=${encodeURIComponent(name || '')}`),
  getSharedPendingSupTransfers: () => request('GET', '/shared/pending-sup-transfers'),
  getSharedAdminCandidates: () => request('GET', '/shared/admin/candidates'),
  getSharedAdminSnapshot: () => request('GET', '/shared/admin/snapshot'),
  updateSharedAdminCandidate: (payload) => request('POST', '/shared/admin/candidates/action', payload),
  getSharedAdminPendingRequests: () => request('GET', '/shared/admin/pending-requests'),
  updateSharedAdminPendingRequest: (payload) => request('POST', '/shared/admin/pending-requests/action', payload),
  getTicker: () => request('GET', '/ticker', null, 5000),
  getRuntimeStatus: () => request('GET', '/runtime/verify-token', null, 3000),
  getSamSetupStatus: () => request('GET', '/sam/setup/status', null, 60000),
  completeSamSetup: (data) => savedRequest('POST', '/sam/setup/complete', data),
  resetSamSetup: () => savedRequest('POST', '/sam/setup/reset'),
  getSamAuthConfig: () => request('GET', '/sam/auth/config', null, 10000),
  verifySamAuth: (authUid) => request('POST', '/sam/auth/verify', { auth_uid: authUid }, 15000),
  completeSamAuthSetup: (data) => savedRequest('POST', '/sam/auth/complete', data),
  getSamUserManagementList: (callerAuthUid) => request('POST', '/sam/admin/users/list', { caller_auth_uid: callerAuthUid }, 15000),
  setSamUserActive: (callerAuthUid, targetUserId, active) => request('POST', '/sam/admin/users/set-active', { caller_auth_uid: callerAuthUid, target_user_id: targetUserId, active }, 15000),
  getNotifications: () => request('GET', '/notifications', null, 8000),
  getConfigStatus: () => request('GET', '/config-status', null, 5000),
  getRuntimeDiagnostics: () => request('GET', '/admin/runtime-diagnostics', null, 10000),
  runGoogleSheetDiagnostics: () => request('GET', '/admin/google-sheet-permission-check', null, 60000),
  getManagedNotifications: () => request('GET', '/notifications/manage'),
  saveManagedNotification: (item) => request('POST', '/notifications/manage', { item }),
  deleteManagedNotification: (id) => request('DELETE', `/notifications/manage/${encodeURIComponent(id)}`),
  getApprovedHeadsets: (force = false) => request('GET', `/headsets${force ? '?force=true' : ''}`, null, 10000),
  logHeadsetReview: (payload) => request('POST', '/headsets/review-log', payload, 10000),
  getHeadsetReviews: () => request('GET', '/headsets/reviews', null, 15000),
  updateHeadsetReview: (payload) => request('POST', '/headsets/reviews/action', payload, 15000),
  getHelpContent: () => request('GET', '/help/content', null, 8000),
  generateSummaries: (session = null) => request('POST', '/gemini/summaries', session ? { session } : {}, 90000),
  regenerateSummary: (type, instructions = '', current_summary = '') => request('POST', '/gemini/regenerate', { type, instructions, current_summary }, 90000),
  testGeminiConnection: () => request('POST', '/test-gemini', {}, 15000),
  fillForm: (coaching, fail, session = null) => request('POST', '/form/fill', { coaching, fail_reason: fail, session }, 120000),
  finishSession: (coaching, fail) => savedRequest('POST', '/finish-session', { coaching_summary: coaching, fail_summary: fail }),
  checkForUpdate: (app = 'mts') => request('GET', `/update?app=${encodeURIComponent(app)}`, null, 5000),
};

export default api;
