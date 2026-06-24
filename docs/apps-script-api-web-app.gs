/**
 * MTS/SAM Apps Script web-app backend.
 *
 * Required Script Properties:
 *   API_TOKEN              shared API token (never put it in source)
 *   MASTER_SPREADSHEET_ID  ID of the configured MTS/SAM master spreadsheet
 *
 * Deploy as a Web app that executes as the owner. Update the existing deployment
 * after changing this file so the /exec URL remains stable.
 */

const ALLOWED_TABS = Object.freeze([
  'callers',
  'callers-new',
  'callers-existing',
  'callers-increase',
  'shows',
  'call-types',
  'sup-reasons',
  'call-coaching',
  'sup-coaching',
  'call-fail-reasons',
  'sup-fail-reasons',
  'discord-posts',
  'screenshots',
  'headsets',
  'gemini-coaching-prompt',
  'gemini-fail-prompt',
  'Candidate Sessions',
  'Pending Sup Transfers',
  'headset-review-log',
  'sam-authorized-users',
  'sam-notifications',
  'update-MTS',
  'update-SAM',
  'settings',
  'notification-recipients',
]);

function doGet(event) {
  try {
    const params = (event && event.parameter) || {};
    authorize_(params.token);
    return jsonResponse_({ ok: true, result: dispatchGet_(String(params.action || ''), params) });
  } catch (error) {
    return jsonResponse_({ ok: false, error: safeError_(error) });
  }
}

function doPost(event) {
  try {
    const body = JSON.parse((event && event.postData && event.postData.contents) || '{}');
    authorize_(body.token);
    return jsonResponse_({ ok: true, result: dispatchPost_(String(body.action || ''), body) });
  } catch (error) {
    return jsonResponse_({ ok: false, error: safeError_(error) });
  }
}

function dispatchGet_(action, params) {
  switch (action) {
    case 'ping':
      return { status: 'ready' };
    case 'getHeadsets':
      return { rows: readTableRows_('headsets') };
    case 'getScreenshots':
      return { rows: readTableRows_('screenshots') };
    case 'getDiscordPosts':
      return { rows: readTableRows_('discord-posts') };
    case 'getHeadsetReviewLog':
      return { rows: readTableRows_('headset-review-log') };
    case 'getCandidateTracking':
    case 'getSharedCandidates':
      return {
        rows: readTableRows_('Candidate Sessions'),
        pendingRows: readTableRows_('Pending Sup Transfers'),
      };
    case 'getSamAdmins':
    case 'getAdminPins':
      return { rows: readTableRows_('sam-authorized-users') };
    case 'getTickerMessages':
    case 'getAlerts':
      return { rows: readTableRows_('sam-notifications') };
    case 'getSheetMetadata':
      return getSheetMetadata_();
    case 'getSheetRange':
      return { values: readRange_(required_(params.range, 'range')) };
    case 'batchGetSheetRanges':
      return batchGetRanges_(parseJsonArray_(params.ranges, 'ranges'));
    case 'getSettings':
      try {
        return { rows: readTableRows_('settings') };
      } catch (error) {
        if (error.message.indexOf('Missing sheet') !== -1 || error.message.indexOf('Table is not allowed') !== -1) {
          return { ok: true, rows: [], source: 'missing' };
        }
        throw error;
      }
    case 'getNotificationRecipients':
      try {
        return { rows: readTableRows_('notification-recipients') };
      } catch (error) {
        if (error.message.indexOf('Missing sheet') !== -1 || error.message.indexOf('Table is not allowed') !== -1) {
          return { ok: true, rows: [], source: 'missing' };
        }
        throw error;
      }
    default:
      throw new Error('Unknown action: ' + action);
  }
}

function dispatchPost_(action, body) {
  switch (action) {
    case 'submitHeadsetReview':
      return submitHeadsetReview_(body);
    case 'approveHeadset':
      return decideHeadset_(body, 'approved');
    case 'denyHeadset':
      return decideHeadset_(body, 'denied');
    case 'updateCandidateTracking':
      return updateCandidateTracking_(body);
    case 'updateSheetRange':
      return updateRange_(body);
    case 'appendSheetRows':
      return appendRange_(body);
    case 'batchUpdateSheetRanges':
      return batchUpdateRanges_(body);
    case 'batchUpdateSpreadsheet':
      return batchUpdateSpreadsheet_(body.requests || []);
    default:
      throw new Error('Unknown action: ' + action);
  }
}

function authorize_(providedToken) {
  const expected = PropertiesService.getScriptProperties().getProperty('API_TOKEN') || '';
  if (!expected || !providedToken || !constantTimeEqual_(expected, String(providedToken))) {
    throw new Error('Unauthorized');
  }
}

function constantTimeEqual_(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function spreadsheet_() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty('MASTER_SPREADSHEET_ID') || '';
  if (!spreadsheetId) throw new Error('MASTER_SPREADSHEET_ID is not configured.');
  return SpreadsheetApp.openById(spreadsheetId);
}

function allowedSheet_(title) {
  if (ALLOWED_TABS.indexOf(String(title || '')) === -1) {
    throw new Error('Table is not allowed: ' + String(title || ''));
  }
  const sheet = spreadsheet_().getSheetByName(String(title));
  if (!sheet) throw new Error('Missing sheet: ' + String(title));
  return sheet;
}

function getSheetMetadata_() {
  const sheets = spreadsheet_().getSheets()
    .filter((sheet) => ALLOWED_TABS.indexOf(sheet.getName()) !== -1)
    .map((sheet) => ({
      properties: {
        title: sheet.getName(),
        sheetId: sheet.getSheetId(),
        rowCount: sheet.getMaxRows(),
        columnCount: sheet.getMaxColumns(),
      },
    }));
  return { sheets: sheets };
}

function parseA1_(a1) {
  const text = String(a1 || '').trim();
  const match = text.match(/^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/);
  if (!match) throw new Error('A sheet-qualified range is required.');
  const title = String(match[1] || match[2] || '').replace(/''/g, "'").trim();
  if (ALLOWED_TABS.indexOf(title) === -1) throw new Error('Table is not allowed: ' + title);
  return { title: title, localRange: String(match[3] || '').trim() };
}

function readRange_(a1) {
  const parsed = parseA1_(a1);
  const values = allowedSheet_(parsed.title).getRange(parsed.localRange).getValues();
  return trimTrailingEmpty_(values);
}

function readTableRows_(title) {
  const sheet = allowedSheet_(title);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 1 || lastColumn < 1) return [];
  const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headers = values[0].map((value) => String(value || '').trim());
  return values.slice(1).filter((row) => row.some(nonBlank_)).map((row) => {
    const item = {};
    headers.forEach((header, index) => {
      if (header) item[header] = serializeCell_(row[index]);
    });
    return item;
  });
}

function batchGetRanges_(ranges) {
  return {
    valueRanges: ranges.map((range) => ({ range: String(range), values: readRange_(range) })),
  };
}

function updateRange_(body) {
  const parsed = parseA1_(required_(body.range, 'range'));
  const values = requireRows_(body.values);
  const range = allowedSheet_(parsed.title).getRange(parsed.localRange);
  if (range.getNumRows() !== values.length || range.getNumColumns() !== maxColumns_(values)) {
    throw new Error('Values do not match the target range dimensions.');
  }
  range.setValues(padRows_(values, range.getNumColumns()));
  return { updated: true, updatedRows: values.length };
}

function appendRange_(body) {
  const parsed = parseA1_(required_(body.range, 'range'));
  const values = requireRows_(body.values);
  const sheet = allowedSheet_(parsed.title);
  const startRow = Math.max(sheet.getLastRow() + 1, 2);
  const width = maxColumns_(values);
  sheet.getRange(startRow, 1, values.length, width).setValues(padRows_(values, width));
  return { updated: true, appendedRows: values.length };
}

function batchUpdateRanges_(body) {
  const data = Array.isArray(body.data) ? body.data : [];
  return { responses: data.map((entry) => updateRange_(entry)) };
}

function batchUpdateSpreadsheet_(requests) {
  if (!Array.isArray(requests)) throw new Error('requests must be an array.');
  const replies = requests.map((request) => {
    if (request && request.addSheet) {
      const title = String(((request.addSheet || {}).properties || {}).title || '').trim();
      if (ALLOWED_TABS.indexOf(title) === -1) throw new Error('Table is not allowed: ' + title);
      const existing = spreadsheet_().getSheetByName(title);
      const sheet = existing || spreadsheet_().insertSheet(title);
      return { addSheet: { properties: { title: sheet.getName(), sheetId: sheet.getSheetId() } } };
    }
    if (request && request.deleteDimension) {
      const definition = request.deleteDimension.range || {};
      const sheet = allowedSheetById_(definition.sheetId);
      if (definition.dimension !== 'ROWS') throw new Error('Only row deletion is allowed.');
      const start = Number(definition.startIndex || 0) + 1;
      const count = Number(definition.endIndex || 0) - Number(definition.startIndex || 0);
      if (start <= 1 || count < 1) throw new Error('Header-row deletion is not allowed.');
      sheet.deleteRows(start, count);
      return { deleteDimension: { deletedRows: count } };
    }
    throw new Error('Unsupported batch spreadsheet request.');
  });
  return { replies: replies };
}

function submitHeadsetReview_(body) {
  const brand = String(body.brand || '').trim();
  const model = String(body.model || body.headset_model || '').trim();
  if (!brand || !model) return { skipped: true, reason: 'blank_headset' };
  const sheet = allowedSheet_('headset-review-log');
  const headers = headerMap_(sheet);
  const rows = readTableRows_('headset-review-log');
  const duplicate = rows.some((row) =>
    normalize_(row.Brand) === normalize_(brand) &&
    normalize_(row.Model) === normalize_(model) &&
    normalize_(row.Status || 'pending') === 'pending');
  if (duplicate) return { skipped: true, reason: 'duplicate_pending' };
  appendObject_(sheet, headers, { Brand: brand, Model: model, Status: 'pending', Note: String(body.note || '') });
  return { updated: true };
}

function decideHeadset_(body, status) {
  const brand = required_(body.brand, 'brand');
  const model = required_(body.model, 'model');
  const note = String(body.note || body.reason || '').trim();
  upsertObject_('headsets', ['Brand', 'Model'], { Brand: brand, Model: model, Status: status, Note: note });
  upsertObject_('headset-review-log', ['Brand', 'Model'], { Brand: brand, Model: model, Status: status, Note: note });
  return { updated: true, status: status };
}

function updateCandidateTracking_(body) {
  if (body.candidateRow && typeof body.candidateRow === 'object') {
    const candidateAction = upsertObject_('Candidate Sessions', ['session_id'], body.candidateRow);
    let pendingAction = '';
    if (body.pendingRow && typeof body.pendingRow === 'object') {
      pendingAction = upsertObject_('Pending Sup Transfers', ['pending_id'], body.pendingRow);
    }
    return { updated: true, candidateAction: candidateAction, pendingAction: pendingAction };
  }
  if (body.operation) return applyCandidateOperation_(body);
  throw new Error('candidateRow or operation is required.');
}

function applyCandidateOperation_(body) {
  const operation = String(body.operation || '').trim();
  const candidateName = String(body.candidate_name || '').trim();
  const sessionId = String(body.session_id || body.latest_session_id || '').trim();
  const pendingId = String(body.pending_id || '').trim();
  if (operation === 'delete_candidate_history') {
    const targets = Array.isArray(body.targets) ? body.targets : [body];
    const candidateDeleted = deleteMatchingRows_('Candidate Sessions', (row) => targets.some((target) =>
      (target.session_id && String(row.session_id || '') === String(target.session_id)) ||
      (target.candidate_name && normalize_(row.candidate_name) === normalize_(target.candidate_name))));
    const pendingDeleted = deleteMatchingRows_('Pending Sup Transfers', (row) => targets.some((target) =>
      (target.pending_id && String(row.pending_id || '') === String(target.pending_id)) ||
      (target.candidate_name && normalize_(row.candidate_name) === normalize_(target.candidate_name))));
    return { updated: true, deletedCandidates: candidateDeleted, deletedPending: pendingDeleted };
  }
  if (operation === 'move_pending_sup_transfer') {
    const nextPendingId = pendingId || ('pending-' + (sessionId || new Date().getTime()));
    const pendingAction = upsertObject_('Pending Sup Transfers', ['pending_id'], {
      pending_id: nextPendingId,
      candidate_name: candidateName,
      original_session_id: sessionId,
      created_at: new Date().toISOString(),
      status: 'pending',
      notes: String(body.reason || ''),
    });
    return { updated: true, pendingAction: pendingAction, pending_id: nextPendingId };
  }
  if (operation === 'cancel_pending' || operation === 'remove_pending_sup_transfer') {
    return updateMatchingRows_('Pending Sup Transfers', (row) =>
      (pendingId && String(row.pending_id || '') === pendingId) ||
      (candidateName && normalize_(row.candidate_name) === normalize_(candidateName)),
      { status: operation === 'cancel_pending' ? 'cancelled' : 'incomplete' });
  }
  const changes = {};
  if (operation === 'withdraw') Object.assign(changes, { withdrawn: 'TRUE', status: 'WITHDREW FROM CERTIFICATION', withdrawn_at: new Date().toISOString() });
  else if (operation === 'restore_withdrawal') Object.assign(changes, { withdrawn: 'FALSE', withdrawn_at: '', status: 'INCOMPLETE' });
  else if (operation === 'grant_extra_attempt') Object.assign(changes, { extra_attempt_granted: 'TRUE', extra_attempt_reason: String(body.reason || '') });
  else if (operation === 'archive_candidate') Object.assign(changes, { archived: 'TRUE' });
  else if (operation === 'mark_passed') Object.assign(changes, { status: 'PASS' });
  else if (operation === 'mark_failed') Object.assign(changes, { status: 'FAIL' });
  else if (operation === 'mark_incomplete') Object.assign(changes, { status: 'INCOMPLETE' });
  else throw new Error('Unsupported candidate operation: ' + operation);
  return updateMatchingRows_('Candidate Sessions', (row) =>
    (sessionId && String(row.session_id || '') === sessionId) ||
    (candidateName && normalize_(row.candidate_name) === normalize_(candidateName)), changes);
}

function deleteMatchingRows_(title, predicate) {
  const sheet = allowedSheet_(title);
  const headers = headerMap_(sheet);
  const values = sheet.getDataRange().getValues();
  const rowsToDelete = [];
  values.slice(1).forEach((row, offset) => {
    if (predicate(rowObject_(headers.names, row))) rowsToDelete.push(offset + 2);
  });
  rowsToDelete.sort((left, right) => right - left).forEach((rowNumber) => sheet.deleteRow(rowNumber));
  return rowsToDelete.length;
}

function updateMatchingRows_(title, predicate, changes) {
  const sheet = allowedSheet_(title);
  const headers = headerMap_(sheet);
  const values = sheet.getDataRange().getValues();
  let updated = 0;
  values.slice(1).forEach((row, offset) => {
    const object = rowObject_(headers.names, row);
    if (!predicate(object)) return;
    Object.keys(changes).forEach((key) => {
      if (headers.index[key] !== undefined) row[headers.index[key]] = changes[key];
    });
    sheet.getRange(offset + 2, 1, 1, headers.names.length).setValues([row.slice(0, headers.names.length)]);
    updated += 1;
  });
  return { updated: true, updatedRows: updated };
}

function upsertObject_(title, keyNames, object) {
  const sheet = allowedSheet_(title);
  const headers = headerMap_(sheet);
  const values = sheet.getDataRange().getValues();
  const target = values.slice(1).findIndex((row) => keyNames.every((key) =>
    normalize_(row[headers.index[key]]) === normalize_(object[key])));
  const rowValues = headers.names.map((header) => object[header] === undefined ? '' : object[header]);
  if (target >= 0) {
    const existing = values[target + 1].slice(0, headers.names.length);
    headers.names.forEach((header, index) => {
      if (object[header] !== undefined) existing[index] = object[header];
    });
    sheet.getRange(target + 2, 1, 1, headers.names.length).setValues([existing]);
    return 'updated';
  }
  sheet.getRange(Math.max(sheet.getLastRow() + 1, 2), 1, 1, headers.names.length).setValues([rowValues]);
  return 'appended';
}

function appendObject_(sheet, headers, object) {
  const values = headers.names.map((header) => object[header] === undefined ? '' : object[header]);
  sheet.getRange(Math.max(sheet.getLastRow() + 1, 2), 1, 1, values.length).setValues([values]);
}

function headerMap_(sheet) {
  const lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) throw new Error('Missing headers: ' + sheet.getName());
  const names = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map((value) => String(value || '').trim());
  const index = {};
  names.forEach((name, position) => { if (name) index[name] = position; });
  return { names: names, index: index };
}

function allowedSheetById_(sheetId) {
  const sheet = spreadsheet_().getSheets().find((candidate) => candidate.getSheetId() === Number(sheetId));
  if (!sheet || ALLOWED_TABS.indexOf(sheet.getName()) === -1) throw new Error('Sheet ID is not allowed.');
  return sheet;
}

function parseJsonArray_(value, label) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]'));
    if (Array.isArray(parsed)) return parsed;
  } catch (_error) {}
  throw new Error(label + ' must be a JSON array.');
}

function requireRows_(values) {
  if (!Array.isArray(values) || !values.length || !values.every(Array.isArray)) {
    throw new Error('values must be a non-empty two-dimensional array.');
  }
  return values;
}

function required_(value, label) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) throw new Error(label + ' is required.');
  return text;
}

function maxColumns_(rows) {
  return rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
}

function padRows_(rows, width) {
  return rows.map((row) => {
    const copy = row.slice(0, width);
    while (copy.length < width) copy.push('');
    return copy;
  });
}

function trimTrailingEmpty_(values) {
  const rows = values.map((row) => row.slice());
  while (rows.length && !rows[rows.length - 1].some(nonBlank_)) rows.pop();
  let width = rows.reduce((maximum, row) => {
    let last = row.length;
    while (last > 0 && !nonBlank_(row[last - 1])) last -= 1;
    return Math.max(maximum, last);
  }, 0);
  return rows.map((row) => row.slice(0, width).map(serializeCell_));
}

function rowObject_(headers, row) {
  const object = {};
  headers.forEach((header, index) => { if (header) object[header] = serializeCell_(row[index]); });
  return object;
}

function serializeCell_(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function nonBlank_(value) {
  return value !== '' && value !== null && value !== undefined;
}

function normalize_(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function safeError_(error) {
  const message = String(error && error.message || error || 'Request failed.');
  return message.indexOf('Unauthorized') !== -1 ? 'Unauthorized' : message;
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
