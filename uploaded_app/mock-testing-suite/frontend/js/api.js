/**
 * api.js — Centralized fetch wrapper for the FastAPI backend.
 */

const BASE = 'http://127.0.0.1:8600';

async function request(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== null) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${path}: ${res.status} — ${text}`);
  }
  return res.json();
}

export const api = {
  // Settings
  getSettings:     ()     => request('GET',  '/api/settings'),
  saveSettings:    (data) => request('PUT',  '/api/settings', data),
  getDefaults:     ()     => request('GET',  '/api/settings/defaults'),
  completeSetup:   (data) => request('POST', '/api/settings/complete-setup', data),

  // Session
  getCurrentSession: ()   => request('GET',  '/api/session/current'),
  startSession:    (data) => request('POST', '/api/session/start', data),
  updateSession:   (data) => request('PUT',  '/api/session/update', data),
  saveCall:        (data) => request('POST', '/api/session/call', data),
  saveSupTransfer: (data) => request('POST', '/api/session/sup', data),
  finishSession:   ()     => request('POST', '/api/session/finish'),
  discardSession:  ()     => request('POST', '/api/session/discard'),

  // History
  getHistory:      ()     => request('GET',    '/api/history'),
  getHistoryStats: ()     => request('GET',    '/api/history/stats'),
  clearHistory:    ()     => request('DELETE', '/api/history'),

  // Ticker
  getTicker:       ()     => request('GET',  '/api/ticker'),

  // Integrations — Gemini
  generateSummaries: ()     => request('POST', '/api/gemini/summaries'),
  regenerateSummary: (type) => request('POST', '/api/gemini/regenerate', { type }),

  // Integrations — Sheets
  saveToSheets: (coaching, fail) => request('POST', '/api/sheets/save', {
    coaching_summary: coaching, fail_summary: fail,
  }),

  // Integrations — Form Filler
  fillForm: (coaching, fail) => request('POST', '/api/form/fill', {
    coaching, fail_reason: fail,
  }),

  // Integrations — Finish All (orchestrates sheets + form + history)
  finishSession: (coaching, fail, doFillForm = false) => request('POST', '/api/finish-session', {
    coaching_summary: coaching, fail_summary: fail, fill_form: doFillForm,
  }),

  // Update Check
  checkForUpdate: () => request('GET', '/api/update'),
  getUpdateStatus: () => request('GET', '/api/update/status'),
};
