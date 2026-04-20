import axios from 'axios';

function getBackendUrl() {
  const configuredUrl = (process.env.REACT_APP_BACKEND_URL || '').trim();
  if (configuredUrl) {
    return configuredUrl.replace(/\/+$/, '');
  }

  return 'http://127.0.0.1:8600';
}

const BACKEND_URL = getBackendUrl();
const BASE = `${BACKEND_URL}/api`;

function setUnsavedChanges(value) {
  if (window.electronAPI?.setUnsavedChanges) {
    window.electronAPI.setUnsavedChanges(value).catch(() => {});
  }
}

async function request(method, path, body = null, timeout = 15000) {
  const opts = {
    method,
    url: `${BASE}${path}`,
    headers: { 'Content-Type': 'application/json' },
    timeout,
  };
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
  getSettings: () => request('GET', '/settings'),
  saveSettings: (data) => savedRequest('PUT', '/settings', data),
  getDefaults: () => request('GET', '/settings/defaults'),
  restoreSettingsDefaults: () => savedRequest('POST', '/settings/restore-defaults'),
  completeSetup: (data) => savedRequest('POST', '/settings/complete-setup', data),
  getCurrentSession: () => request('GET', '/session/current'),
  startSession: (data) => savedRequest('POST', '/session/start', data),
  updateSession: (data) => savedRequest('PUT', '/session/update', data),
  saveCall: (data) => savedRequest('POST', '/session/call', data),
  saveSupTransfer: (data) => savedRequest('POST', '/session/sup', data),
  finishSessionSimple: () => savedRequest('POST', '/session/finish'),
  discardSession: () => savedRequest('POST', '/session/discard'),
  getHistory: () => request('GET', '/history'),
  getHistoryStats: () => request('GET', '/history/stats'),
  clearHistory: () => request('DELETE', '/history'),
  getTicker: () => request('GET', '/ticker'),
  generateSummaries: () => request('POST', '/gemini/summaries'),
  regenerateSummary: (type) => request('POST', '/gemini/regenerate', { type }),
  fillForm: (coaching, fail) => request('POST', '/form/fill', { coaching, fail_reason: fail }, 120000),
  finishSession: (coaching, fail) => savedRequest('POST', '/finish-session', { coaching_summary: coaching, fail_summary: fail }),
  checkForUpdate: () => request('GET', '/update'),
};

export default api;
