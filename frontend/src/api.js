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

async function request(method, path, body = null) {
  const opts = {
    method,
    url: `${BASE}${path}`,
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  };
  if (body !== null) opts.data = body;
  const res = await axios(opts);
  return res.data;
}

const api = {
  getSettings: () => request('GET', '/settings'),
  saveSettings: (data) => request('PUT', '/settings', data),
  getDefaults: () => request('GET', '/settings/defaults'),
  completeSetup: (data) => request('POST', '/settings/complete-setup', data),
  getCurrentSession: () => request('GET', '/session/current'),
  startSession: (data) => request('POST', '/session/start', data),
  updateSession: (data) => request('PUT', '/session/update', data),
  saveCall: (data) => request('POST', '/session/call', data),
  saveSupTransfer: (data) => request('POST', '/session/sup', data),
  finishSessionSimple: () => request('POST', '/session/finish'),
  discardSession: () => request('POST', '/session/discard'),
  getHistory: () => request('GET', '/history'),
  getHistoryStats: () => request('GET', '/history/stats'),
  clearHistory: () => request('DELETE', '/history'),
  getTicker: () => request('GET', '/ticker'),
  generateSummaries: () => request('POST', '/gemini/summaries'),
  regenerateSummary: (type) => request('POST', '/gemini/regenerate', { type }),
  fillForm: (coaching, fail) => request('POST', '/form/fill', { coaching, fail_reason: fail }),
  finishSession: (coaching, fail) => request('POST', '/finish-session', { coaching_summary: coaching, fail_summary: fail }),
  checkForUpdate: () => request('GET', '/update'),
};

export default api;
