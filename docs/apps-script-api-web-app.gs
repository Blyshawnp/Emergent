/**
 * MTS/SAM Apps Script web-app backend.
 *
 * Required Script Properties:
 *   MTS_API_TOKEN           current MTS token (never put it in source)
 *   SAM_API_TOKEN           current SAM/admin token (never put it in source)
 *   MASTER_SPREADSHEET_ID   ID of the configured MTS/SAM master spreadsheet
 *
 * Optional rotation/migration properties:
 *   MTS_API_TOKEN_PREVIOUS  previous MTS token during a bounded rollout
 *   SAM_API_TOKEN_PREVIOUS  previous SAM token during a bounded rollout
 *   API_TOKEN               legacy token accepted as MTS-only during migration
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
  'mts-tutorial-videos',
  'sam-tutorial-videos',
  'Candidate Sessions',
  'Pending Sup Transfers',
  'newbie-shift-requests',
  'candidate-deletion-requests',
  'candidate-information-correction-requests',
  'headset-review-log',
  'sam-authorized-users',
  'sam-notifications',
  'update-MTS',
  'update-SAM',
  'settings',
  'notification-recipients',
]);

const MTS_GET_ACTIONS = Object.freeze([
  'ping',
  'getHeadsets',
  'getScreenshots',
  'getDiscordPosts',
  'getTutorialVideos',
  'getMtsTutorialVideos',
  'getSamTutorialVideos',
  'getCandidateTracking',
  'getSharedCandidates',
  'getPendingRequests',
  'getTickerMessages',
  'getAlerts',
  'getSettings',
  'getNotificationRecipients',
  'getUpdateMetadata',
]);

const SAM_ONLY_GET_ACTIONS = Object.freeze([
  'getHeadsetReviewLog',
  'getHeadsetReviewMigrationPlan',
  'getSamSetupStatus',
  'getSamAdmins',
  'getAdminPins',
  'getSheetMetadata',
  'getSheetRange',
  'batchGetSheetRanges',
]);

const MTS_POST_ACTIONS = Object.freeze([
  'submitHeadsetReview',
  'updateCandidateTracking',
  'upsertPendingRequest',
]);

const SAM_ONLY_POST_ACTIONS = Object.freeze([
  'completeSamSetup',
  'approveHeadset',
  'denyHeadset',
  'editHeadsetReview',
  'migrateHeadsetReviewSchema',
  'archiveHeadsetReview',
  'deleteHeadsetReview',
  'decidePendingRequest',
  'addNotification',
  'updateNotification',
  'disableNotification',
  'deleteNotification',
  'updateSheetRange',
  'appendSheetRows',
  'batchUpdateSheetRanges',
  'batchUpdateSpreadsheet',
  'ensureTutorialVideoTabs',
]);

const MTS_PROTECTED_CANDIDATE_FIELDS = Object.freeze([
  'extra_attempt_granted',
  'extra_attempt_reason',
  'extra_attempts_granted',
  'allowed_attempt_count',
  'extra_attempt_last_action_id',
  'extra_attempt_granted_by',
  'extra_attempt_granted_at',
  'readiness_override_by',
  'readiness_override_at',
  'archived',
  'newbie_shift_admin_decision_at',
  'newbie_shift_admin_decision_by',
  'newbie_shift_denial_reason',
]);

const SAM_AUTHORIZED_USER_HEADERS = Object.freeze([
  'name', 'pin', 'role', 'enabled', 'installed', 'install_date', 'device_name', 'notes',
]);

const HEADSET_REVIEW_V2_HEADERS = Object.freeze([
  'review_id',
  'source_session_id',
  'candidate_name',
  'tester_name',
  'Brand',
  'Model',
  'Status',
  'Note',
  'created_at',
  'updated_at',
  'decision_at',
  'decision_by',
  'denial_reason',
]);

const HEADSET_REVIEW_BASIC_HEADERS = Object.freeze([
  'Brand',
  'Model',
  'Status',
  'Note',
]);

const HEADSET_REVIEW_LEGACY_HEADERS = Object.freeze([
  'headset_model',
  'candidate_name',
  'tester_name',
  'entered_at',
  'review_status',
  'notes',
]);

const NEWBIE_SHIFT_REQUEST_HEADERS = Object.freeze([
  'request_id',
  'session_id',
  'candidate_name',
  'candidate_first_name',
  'candidate_last_initial',
  'tester_name',
  'request_type',
  'request_status',
  'requested_by',
  'request_reason',
  'request_details',
  'request_created_at',
  'original_scheduled_at',
  'rescheduled_at',
  'scheduled_at',
  'timezone',
  'within_24_hours',
  'counts_as_attempt',
  'final_attempt',
  'admin_decision_at',
  'admin_decision_by',
  'denial_reason',
  'updated_at',
  'lead_time_seconds',
  'lead_time_category',
  'current_attempt',
  'resulting_attempt',
  'becomes_final_attempt',
  'attempt_rule',
  'terminal_outcome',
  'newbie_shift_number',
]);

const CANDIDATE_SESSION_WORKFLOW_HEADERS = Object.freeze([
  'extra_attempts_granted', 'allowed_attempt_count', 'current_attempt_number',
  'extra_attempt_last_action_id', 'extra_attempt_granted_by', 'extra_attempt_granted_at',
  'readiness_override_by', 'readiness_override_at', 'newbie_shift_number',
]);

const CANDIDATE_DELETION_REQUEST_HEADERS = Object.freeze([
  'request_id',
  'session_id',
  'candidate_name',
  'candidate_first_name',
  'candidate_last_initial',
  'tester_name',
  'created_at',
  'status',
  'local_history_deleted',
  'reason',
  'session_status',
  'completed_at',
  'audit_summary',
  'admin_decision_at',
  'admin_decision_by',
  'denial_reason',
  'updated_at',
]);

const CANDIDATE_CORRECTION_REQUEST_HEADERS = Object.freeze([
  'request_id', 'request_type', 'source_session_id', 'candidate_id', 'candidate_name',
  'tester_name', 'reason', 'changes_json', 'created_at', 'status',
  'admin_decision_at', 'admin_decision_by', 'denial_reason', 'updated_at',
]);

const TUTORIAL_VIDEO_HEADERS = Object.freeze([
  'Category', 'VideoKey', 'Title', 'Description', 'YouTubeURL', 'Duration',
  'HelpTopicKey', 'SortOrder', 'Active', 'Audience', 'Notes',
]);

function doGet(event) {
  try {
    const params = (event && event.parameter) || {};
    const action = String(params.action || '');
    const role = authorizeAction_(params.token, 'GET', action, params);
    return jsonResponse_({ ok: true, result: dispatchGet_(action, params, role) });
  } catch (error) {
    return jsonResponse_({ ok: false, error: safeError_(error) });
  }
}

function doPost(event) {
  try {
    const body = JSON.parse((event && event.postData && event.postData.contents) || '{}');
    const action = String(body.action || '');
    const role = authorizeAction_(body.token, 'POST', action, body);
    return jsonResponse_({ ok: true, result: dispatchPost_(action, body, role) });
  } catch (error) {
    return jsonResponse_({ ok: false, error: safeError_(error) });
  }
}

function dispatchGet_(action, params, role) {
  switch (action) {
    case 'ping':
      return { status: 'ready' };
    case 'getHeadsets':
      return { rows: readTableRows_('headsets') };
    case 'getScreenshots':
      return { rows: readTableRows_('screenshots') };
    case 'getDiscordPosts':
      return { rows: readTableRows_('discord-posts') };
    case 'getTutorialVideos':
      return {
        mtsRows: readOptionalTableRows_('mts-tutorial-videos'),
        samRows: readOptionalTableRows_('sam-tutorial-videos'),
      };
    case 'getMtsTutorialVideos':
      return { rows: readOptionalTableRows_('mts-tutorial-videos') };
    case 'getSamTutorialVideos':
      return { rows: readOptionalTableRows_('sam-tutorial-videos') };
    case 'getHeadsetReviewLog':
      return { rows: readOptionalTableRows_('headset-review-log') };
    case 'getHeadsetReviewMigrationPlan':
      return headsetReviewMigrationPlan_();
    case 'getSamSetupStatus':
      return getSamSetupStatus_();
    case 'getCandidateTracking':
    case 'getSharedCandidates':
      return {
        rows: readTableRows_('Candidate Sessions'),
        pendingRows: readTableRows_('Pending Sup Transfers'),
      };
    case 'getPendingRequests':
      return getPendingRequests_(params);
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
    case 'getUpdateMetadata':
      return getUpdateMetadata_(role);
    default:
      throw new Error('Unknown action: ' + action);
  }
}

function dispatchPost_(action, body, role) {
  switch (action) {
    case 'completeSamSetup':
      return completeSamSetup_(body);
    case 'submitHeadsetReview':
      return submitHeadsetReview_(body);
    case 'approveHeadset':
      return decideHeadset_(body, 'approved');
    case 'denyHeadset':
      return decideHeadset_(body, 'denied');
    case 'editHeadsetReview':
      return editHeadsetReview_(body);
    case 'migrateHeadsetReviewSchema':
      return migrateHeadsetReviewSchema_(body);
    case 'archiveHeadsetReview':
      return archiveHeadsetReview_(body);
    case 'deleteHeadsetReview':
      return deleteHeadsetReview_(body);
    case 'updateCandidateTracking':
      return updateCandidateTracking_(body, role);
    case 'upsertPendingRequest':
      return upsertPendingRequest_(body, role);
    case 'decidePendingRequest':
      return decidePendingRequest_(body);
    case 'addNotification':
      return upsertNotification_(body);
    case 'updateNotification':
      return upsertNotification_(body);
    case 'disableNotification':
      return disableNotification_(body);
    case 'deleteNotification':
      return deleteNotification_(body);
    case 'updateSheetRange':
      return updateRange_(body);
    case 'appendSheetRows':
      return appendRange_(body);
    case 'batchUpdateSheetRanges':
      return batchUpdateRanges_(body);
    case 'batchUpdateSpreadsheet':
      return batchUpdateSpreadsheet_(body.requests || []);
    case 'ensureTutorialVideoTabs':
      return ensureTutorialVideoTabs_();
    default:
      throw new Error('Unknown action: ' + action);
  }
}

function getSamSetupStatus_() {
  try {
    const sheet = allowedSheet_('sam-authorized-users');
    const headers = headerMap_(sheet);
    const configured = SAM_AUTHORIZED_USER_HEADERS.every((header) => headers.index[header] !== undefined);
    return { ok: true, configured: configured };
  } catch (_error) {
    return { ok: true, configured: false };
  }
}

function completeSamSetup_(body) {
  const enteredName = String(body.name || '').trim().replace(/\s+/g, ' ');
  const enteredPin = String(body.pin || '').trim();
  const deviceName = String(body.device_name || '').trim().slice(0, 120);
  if (!enteredName) return { ok: false, errorCode: 'setup_invalid_admin' };
  if (!enteredPin) return { ok: false, errorCode: 'setup_invalid_pin' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: false, errorCode: 'setup_transport_unavailable' };
  try {
    const sheet = allowedSheet_('sam-authorized-users');
    const headers = headerMap_(sheet);
    if (!SAM_AUTHORIZED_USER_HEADERS.every((header) => headers.index[header] !== undefined)) {
      return { ok: false, errorCode: 'setup_configuration_unavailable' };
    }
    const values = sheet.getDataRange().getValues();
    const nameKey = enteredName.toLowerCase();
    const rowOffset = values.slice(1).findIndex((row) => String(row[headers.index.name] || '').trim().toLowerCase() === nameKey);
    if (rowOffset < 0) return { ok: false, errorCode: 'setup_admin_not_found' };

    const row = values[rowOffset + 1].slice(0, headers.names.length);
    const storedPin = String(row[headers.index.pin] || '').trim();
    if (!constantTimeEqual_(storedPin, enteredPin)) return { ok: false, errorCode: 'setup_invalid_pin' };
    if (!pendingRequestBoolean_(row[headers.index.enabled])) {
      return { ok: false, errorCode: 'setup_authorization_failed' };
    }

    const alreadyInstalled = pendingRequestBoolean_(row[headers.index.installed]);
    row[headers.index.installed] = 'TRUE';
    if (!String(row[headers.index.install_date] || '').trim()) {
      row[headers.index.install_date] = new Date().toISOString();
    }
    if (deviceName) row[headers.index.device_name] = deviceName;
    sheet.getRange(rowOffset + 2, 1, 1, headers.names.length).setValues([row]);
    return {
      ok: true,
      name: String(row[headers.index.name] || enteredName).trim(),
      role: String(row[headers.index.role] || 'user').trim() || 'user',
      alreadyInstalled: alreadyInstalled,
    };
  } catch (error) {
    const message = String(error && error.message || error || '').toLowerCase();
    const configurationFailure = message.indexOf('missing sheet') !== -1 ||
      message.indexOf('missing headers') !== -1 ||
      message.indexOf('not configured') !== -1;
    return {
      ok: false,
      errorCode: configurationFailure ? 'setup_configuration_unavailable' : 'setup_transport_unavailable',
    };
  } finally {
    lock.releaseLock();
  }
}

function authorizeAction_(providedToken, method, action, payload) {
  const role = credentialRole_(providedToken);
  if (!role) {
    throw new Error('Unauthorized');
  }
  if (!actionAllowedForRole_(role, method, action, payload || {})) {
    throw new Error('Forbidden');
  }
  return role;
}

function credentialRole_(providedToken) {
  const token = String(providedToken || '');
  if (!token) return '';
  const properties = PropertiesService.getScriptProperties();
  const mtsTokens = [
    properties.getProperty('MTS_API_TOKEN'),
    properties.getProperty('MTS_API_TOKEN_PREVIOUS'),
    properties.getProperty('API_TOKEN'),
  ];
  const samTokens = [
    properties.getProperty('SAM_API_TOKEN'),
    properties.getProperty('SAM_API_TOKEN_PREVIOUS'),
  ];
  const matchesMts = matchesCredential_(token, mtsTokens);
  const matchesSam = matchesCredential_(token, samTokens);
  if (matchesMts === matchesSam) return '';
  return matchesSam ? 'sam' : 'mts';
}

function matchesCredential_(providedToken, configuredTokens) {
  let matched = false;
  (configuredTokens || []).forEach((configuredToken) => {
    const expected = String(configuredToken || '');
    if (expected && constantTimeEqual_(expected, providedToken)) matched = true;
  });
  return matched;
}

function actionAllowedForRole_(role, method, action, payload) {
  const normalizedMethod = String(method || '').trim().toUpperCase();
  const normalizedAction = String(action || '').trim();
  if (normalizedMethod === 'GET') {
    if (MTS_GET_ACTIONS.indexOf(normalizedAction) !== -1) return role === 'mts' || role === 'sam';
    return role === 'sam' && SAM_ONLY_GET_ACTIONS.indexOf(normalizedAction) !== -1;
  }
  if (normalizedMethod !== 'POST') return false;
  if (MTS_POST_ACTIONS.indexOf(normalizedAction) !== -1) {
    if (role === 'sam') return true;
    if (role !== 'mts') return false;
    if (normalizedAction === 'updateCandidateTracking') {
      return Boolean(payload && payload.candidateRow && typeof payload.candidateRow === 'object' && !payload.operation);
    }
    return true;
  }
  return role === 'sam' && SAM_ONLY_POST_ACTIONS.indexOf(normalizedAction) !== -1;
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

function ensureSheetWithHeaders_(title, expectedHeaders) {
  if (ALLOWED_TABS.indexOf(String(title || '')) === -1) {
    throw new Error('Table is not allowed: ' + String(title || ''));
  }
  const workbook = spreadsheet_();
  const sheet = workbook.getSheetByName(String(title)) || workbook.insertSheet(String(title));
  const width = Math.max(sheet.getLastColumn(), expectedHeaders.length);
  const current = sheet.getRange(1, 1, 1, width).getValues()[0]
    .map((value) => String(value || '').trim());
  if (!current.some(nonBlank_)) {
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([Array.prototype.slice.call(expectedHeaders)]);
  } else {
    let existingWidth = current.length;
    while (existingWidth > 0 && !current[existingWidth - 1]) existingWidth -= 1;
    const compatiblePrefix = current.slice(0, existingWidth).every((header, index) => header === expectedHeaders[index]);
    if (compatiblePrefix && existingWidth < expectedHeaders.length) {
      sheet.getRange(1, existingWidth + 1, 1, expectedHeaders.length - existingWidth)
        .setValues([Array.prototype.slice.call(expectedHeaders, existingWidth)]);
    } else if (String(title) === 'newbie-shift-requests') {
      const existingHeaders = current.slice(0, existingWidth);
      const missingHeaders = expectedHeaders.filter((header) => existingHeaders.indexOf(header) === -1);
      if (missingHeaders.length) {
        sheet.getRange(1, existingWidth + 1, 1, missingHeaders.length)
          .setValues([missingHeaders]);
      }
    }
  }
  return sheet;
}

function ensureHeadersPresent_(title, requiredHeaders) {
  const sheet = allowedSheet_(title);
  const headers = headerMap_(sheet);
  const missing = requiredHeaders.filter((header) => headers.index[header] === undefined);
  if (missing.length) {
    sheet.getRange(1, headers.names.length + 1, 1, missing.length).setValues([missing]);
  }
  return sheet;
}

function ensureTutorialVideoTabs_() {
  const workbook = spreadsheet_();
  const created = [];
  const existing = [];
  ['mts-tutorial-videos', 'sam-tutorial-videos'].forEach((title) => {
    let sheet = workbook.getSheetByName(title);
    if (!sheet) {
      sheet = workbook.insertSheet(title);
      sheet.getRange(1, 1, 1, TUTORIAL_VIDEO_HEADERS.length).setValues([Array.prototype.slice.call(TUTORIAL_VIDEO_HEADERS)]);
      created.push(title);
      return;
    }
    const width = sheet.getLastColumn();
    const headers = width > 0
      ? sheet.getRange(1, 1, 1, width).getValues()[0].map((value) => String(value || '').trim())
      : [];
    if (headers.length !== TUTORIAL_VIDEO_HEADERS.length || headers.some((header, index) => header !== TUTORIAL_VIDEO_HEADERS[index])) {
      throw new Error('Tutorial video tab has incompatible headers: ' + title + '. Correct the header row and try again.');
    }
    existing.push(title);
  });
  return { createdCount: created.length, existingCount: existing.length, created: created, existing: existing };
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

function readOptionalTableRows_(title) {
  try {
    return readTableRows_(title);
  } catch (error) {
    if (String(error && error.message || error).indexOf('Missing sheet') !== -1) return [];
    throw error;
  }
}

function getUpdateMetadata_(role) {
  const normalizedRole = String(role || '').trim().toLowerCase();
  const title = normalizedRole === 'sam' ? 'update-SAM' : 'update-MTS';
  const rows = readOptionalTableRows_(title);
  const row = rows.find((candidate) => String(candidate.Version || '').trim()) || {};
  return {
    app: normalizedRole === 'sam' ? 'sam' : 'mts',
    tab: title,
    row: row,
  };
}

function getPendingRequests_(params) {
  const requestedStatus = String(params.status || 'pending').trim().toLowerCase();
  const hasStatusFilter = Boolean(String(params.status || '').trim());
  const requestedType = String(params.request_type || '').trim().toLowerCase();
  const includeResolved = String(params.include_resolved || '').trim().toLowerCase() === 'true';
  const normalize = (row, sourceTab) => ({
    request_id: String(row.request_id || '').trim(),
    request_type: String(row.request_type || (sourceTab === 'candidate-deletion-requests' ? 'candidate_deletion' : sourceTab === 'candidate-information-correction-requests' ? 'candidate_information_correction' : 'initial_newbie_shift')).trim().toLowerCase(),
    source_session_id: String(row.session_id || row.source_session_id || '').trim(),
    candidate_id: String(row.candidate_id || '').trim(),
    candidate: String(row.candidate_name || row.candidate || '').trim(),
    tester: String(row.tester_name || row.tester || '').trim(),
    requester: String(row.requested_by || row.requester || '').trim(),
    reason: String(row.request_reason || row.reason || '').trim(),
    details: String(row.request_details || row.audit_summary || '').trim(),
    changes_json: String(row.changes_json || '').trim(),
    original_scheduled_at: String(row.original_scheduled_at || row.original_schedule || row.newbie_shift_original_scheduled_at || '').trim(),
    requested_scheduled_at: String(row.scheduled_at || row.rescheduled_at || row.requested_scheduled_at || '').trim(),
    timezone: String(row.timezone || '').trim(), newbie_shift_number: String(row.newbie_shift_number || '').trim(), within_24_hours: pendingRequestBoolean_(row.within_24_hours),
    counts_as_attempt: pendingRequestBoolean_(row.counts_as_attempt), final_attempt: pendingRequestBoolean_(row.final_attempt),
    lead_time_seconds: row.lead_time_seconds === '' ? '' : Number(row.lead_time_seconds),
    lead_time_category: String(row.lead_time_category || '').trim(), current_attempt: Number(row.current_attempt || 1),
    resulting_attempt: Number(row.resulting_attempt || row.current_attempt || 1), becomes_final_attempt: pendingRequestBoolean_(row.becomes_final_attempt),
    attempt_rule: String(row.attempt_rule || '').trim(), terminal_outcome: String(row.terminal_outcome || '').trim(),
    status: String(row.request_status || row.status || 'pending').trim().toLowerCase(),
    created_at: String(row.request_created_at || row.created_at || '').trim(), updated_at: String(row.updated_at || '').trim(),
    decision_at: String(row.admin_decision_at || '').trim(), decision_by: String(row.admin_decision_by || '').trim(),
    denial_reason: String(row.denial_reason || '').trim(), source_tab: sourceTab,
  });
  const rows = readOptionalTableRows_('newbie-shift-requests').map((row) => normalize(row, 'newbie-shift-requests'))
    .concat(readOptionalTableRows_('candidate-deletion-requests').map((row) => normalize(row, 'candidate-deletion-requests')))
    .concat(readOptionalTableRows_('candidate-information-correction-requests')
      .filter((row) => String(row.request_type || 'candidate_information_correction').trim().toLowerCase() === 'candidate_information_correction')
      .map((row) => normalize(row, 'candidate-information-correction-requests')))
    .filter((row) => row.request_id);
  const requests = rows.filter((row) => (hasStatusFilter ? row.status === requestedStatus : (includeResolved || row.status === 'pending')) && (!requestedType || row.request_type === requestedType)).sort((left, right) => right.created_at.localeCompare(left.created_at));
  return { requests: requests, counts: { total: requests.length, newbie_shift: requests.filter((row) => row.source_tab === 'newbie-shift-requests' && row.request_type !== 'newbie_shift_reschedule').length, reschedule: requests.filter((row) => row.request_type === 'newbie_shift_reschedule' || row.request_type === 'reschedule').length, candidate_deletion: requests.filter((row) => row.source_tab === 'candidate-deletion-requests').length, candidate_correction: requests.filter((row) => row.source_tab === 'candidate-information-correction-requests').length } };
}

function pendingRequestBoolean_(value) {
  return value === true || ['true', 'yes', '1', 'y'].indexOf(String(value || '').trim().toLowerCase()) !== -1;
}

function correctionChanges_(value) {
  let changes = value;
  if (typeof changes === 'string') {
    try { changes = JSON.parse(changes || '[]'); } catch (_error) { throw new Error('Correction request changes are invalid.'); }
  }
  if (!Array.isArray(changes) || !changes.length) throw new Error('Correction request has no changes.');
  const allowed = { candidate_name: 'Candidate Name', headset_brand: 'Headset Brand', headset_model: 'Headset Model' };
  const seen = {};
  return changes.map((change) => {
    const field = String(change && (change.field || change.field_key) || '').trim().toLowerCase();
    const previousValue = String(change && change.previous_value || '').trim();
    const requestedValue = String(change && change.requested_value || '').trim();
    if (!allowed[field] || seen[field] || !requestedValue || previousValue === requestedValue) throw new Error('Correction request changes are invalid.');
    seen[field] = true;
    return { field: field, field_key: field, label: allowed[field], previous_value: previousValue, requested_value: requestedValue };
  });
}

function applyCandidateCorrection_(sourceSessionId, changesValue, candidateId) {
  const changes = correctionChanges_(changesValue);
  const sheet = allowedSheet_('Candidate Sessions');
  const headers = headerMap_(sheet);
  const values = sheet.getDataRange().getValues();
  const target = values.slice(1).findIndex((row) => String(row[headers.index.session_id] || '').trim() === sourceSessionId);
  if (target < 0) throw new Error('Correction target was not found.');
  const row = values[target + 1].slice(0, headers.names.length);
  const expectedCandidateId = String(candidateId || '').trim();
  const actualCandidateId = headers.index.candidate_id === undefined ? '' : String(row[headers.index.candidate_id] || '').trim();
  if (expectedCandidateId && actualCandidateId && expectedCandidateId !== actualCandidateId) throw new Error('Correction target identity has changed.');
  let updated = false;
  let correctedHeadset = null;
  changes.filter((change) => change.field === 'candidate_name').forEach((change) => {
    const current = String(row[headers.index.candidate_name] || '').trim();
    if (current === change.requested_value) return;
    if (change.previous_value && current !== change.previous_value) throw new Error('Correction target identity has changed.');
    row[headers.index.candidate_name] = change.requested_value;
    updated = true;
  });
  const headsetChanges = changes.filter((change) => change.field === 'headset_brand' || change.field === 'headset_model');
  if (headsetChanges.length) {
    const currentLabel = String(row[headers.index.headset_brand] || '').trim().replace(/\s+/g, ' ');
    const brandChange = headsetChanges.find((change) => change.field === 'headset_brand');
    const modelChange = headsetChanges.find((change) => change.field === 'headset_model');
    const brandPrevious = String(brandChange && brandChange.previous_value || '').trim();
    const modelPrevious = String(modelChange && modelChange.previous_value || '').trim();
    const brandRequested = String(brandChange && brandChange.requested_value || '').trim();
    const modelRequested = String(modelChange && modelChange.requested_value || '').trim();
    const labelKey = currentLabel.toLowerCase();
    let brand = '';
    let model = '';
    let split = false;
    const alreadyApplied = Boolean(
      brandChange && !modelChange && (currentLabel === brandRequested || currentLabel.indexOf(brandRequested + ' ') === 0)
      || modelChange && !brandChange && (currentLabel === modelRequested || currentLabel.slice(-(modelRequested.length + 1)) === ' ' + modelRequested)
    );
    const legacyFullReplacement = Boolean(modelChange && !brandChange && modelPrevious === currentLabel);
    if (!alreadyApplied && !legacyFullReplacement && brandPrevious && (labelKey === brandPrevious.toLowerCase() || labelKey.indexOf(brandPrevious.toLowerCase() + ' ') === 0)) {
      brand = currentLabel.slice(0, brandPrevious.length);
      model = currentLabel.slice(brandPrevious.length).trim();
      split = true;
    } else if (!alreadyApplied && !legacyFullReplacement && modelPrevious && (labelKey === modelPrevious.toLowerCase() || labelKey.slice(-(modelPrevious.length + 1)) === ' ' + modelPrevious.toLowerCase())) {
      model = currentLabel.slice(-modelPrevious.length);
      brand = currentLabel.slice(0, -modelPrevious.length).trim();
      split = true;
    }
    let nextLabel = currentLabel;
    if (alreadyApplied) {
      nextLabel = currentLabel;
    } else if (legacyFullReplacement) {
      nextLabel = modelChange.requested_value;
    } else {
      headsetChanges.forEach((change) => {
        const currentPart = change.field === 'headset_brand' ? brand : model;
        if (change.previous_value && currentPart !== change.previous_value) throw new Error('Correction target identity has changed.');
        if (change.field === 'headset_brand') brand = change.requested_value;
        else model = change.requested_value;
      });
      const brandKey = brand.toLowerCase();
      const modelKey = model.toLowerCase();
      nextLabel = !brand ? model : !model ? brand : (modelKey === brandKey || modelKey.indexOf(brandKey + ' ') === 0 ? model : brand + ' ' + model);
      correctedHeadset = brand && model ? { brand: brand, model: model } : null;
    }
    if (nextLabel !== currentLabel) {
      row[headers.index.headset_brand] = nextLabel;
      updated = true;
    }
  }
  if (updated) sheet.getRange(target + 2, 1, 1, headers.names.length).setValues([row]);
  if (correctedHeadset) {
    try {
      updateMatchingRows_('headset-review-log', (review) => String(review.source_session_id || '').trim() === sourceSessionId, {
        Brand: correctedHeadset.brand,
        Model: correctedHeadset.model,
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      if (String(error && error.message || error).indexOf('Missing sheet') === -1) throw error;
    }
  }
  const nameChange = changes.find((change) => change.field === 'candidate_name');
  if (nameChange) {
    try {
      updateMatchingRows_('Pending Sup Transfers', (pending) => String(pending.original_session_id || '').trim() === sourceSessionId, { candidate_name: nameChange.requested_value });
    } catch (error) {
      if (String(error && error.message || error).indexOf('Missing sheet') === -1) throw error;
    }
  }
  return { updated: updated, changes: changes };
}

function applyCandidateDeletionTerminal_(sourceSessionId, requestId) {
  const candidate = updateMatchingRows_('Candidate Sessions', (row) => String(row.session_id || '').trim() === sourceSessionId, {
    archived: 'TRUE', status: 'REMOVED', needs_sup_transfer: 'FALSE', pending_sup_transfer_id: '',
    newbie_shift_scheduled_at: '', newbie_shift_timezone: '', newbie_shift_request_status: '',
    deletion_request_id: requestId, deletion_request_status: 'approved',
  });
  const pending = updateMatchingRows_('Pending Sup Transfers', (row) => {
    const status = normalize_(row.status || '');
    return String(row.original_session_id || '').trim() === sourceSessionId && ['pending', 'in progress', 'in_progress'].indexOf(status) !== -1;
  }, { status: 'cancelled', notes: 'Obsolete after approved candidate deletion.' });
  const now = new Date().toISOString();
  const newbie = updateMatchingRows_('newbie-shift-requests', (row) => String(row.session_id || '').trim() === sourceSessionId && normalize_(row.request_status || 'pending') === 'pending', {
    request_status: 'denied', admin_decision_at: now, admin_decision_by: 'SAM deletion reconciliation', denial_reason: 'Request became obsolete after approved candidate deletion.', updated_at: now,
  });
  let corrections = { updatedRows: 0 };
  try {
    corrections = updateMatchingRows_('candidate-information-correction-requests', (row) => String(row.source_session_id || '').trim() === sourceSessionId && normalize_(row.status || 'pending') === 'pending', {
      status: 'denied', admin_decision_at: now, admin_decision_by: 'SAM deletion reconciliation', denial_reason: 'Request became obsolete after approved candidate deletion.', updated_at: now,
    });
  } catch (error) {
    if (String(error && error.message || error).indexOf('Missing sheet') === -1) throw error;
  }
  return { candidateUpdates: candidate.updatedRows || 0, pendingUpdates: pending.updatedRows || 0, obsoleteRequests: (newbie.updatedRows || 0) + (corrections.updatedRows || 0) };
}
function upsertPendingRequest_(body, role) {
  const request = Object.assign({}, body.request && typeof body.request === 'object' ? body.request : body);
  if (role === 'mts') {
    request.status = 'pending';
    request.request_status = 'pending';
    request.admin_decision_at = '';
    request.admin_decision_by = '';
    request.denial_reason = '';
    request.decision_at = '';
    request.decision_by = '';
  }
  const requestId = String(request.request_id || '').trim();
  const requestType = String(request.request_type || '').trim().toLowerCase();
  const tabByType = { initial_newbie_shift: 'newbie-shift-requests', newbie_shift_reschedule: 'newbie-shift-requests', candidate_deletion: 'candidate-deletion-requests', candidate_information_correction: 'candidate-information-correction-requests' };
  const sourceTab = tabByType[requestType];
  if (!requestId || !requestType || !sourceTab || !String(request.source_session_id || request.session_id || '').trim()) throw new Error('Pending request data is incomplete.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Pending request is busy. Please try again.');
  try {
    const sheet = ensureSheetWithHeaders_(
      sourceTab,
      sourceTab === 'newbie-shift-requests'
        ? NEWBIE_SHIFT_REQUEST_HEADERS
        : sourceTab === 'candidate-deletion-requests'
          ? CANDIDATE_DELETION_REQUEST_HEADERS
          : CANDIDATE_CORRECTION_REQUEST_HEADERS
    );
    const headers = headerMap_(sheet);
    const values = sheet.getDataRange().getValues();
    const now = new Date().toISOString();
    const existingIndex = values.slice(1).findIndex((row) => String(row[headers.index.request_id] || '').trim() === requestId);
    const status = String(request.status || 'pending').trim().toLowerCase() || 'pending';
    if (existingIndex >= 0) {
      const row = values[existingIndex + 1].slice(0, headers.names.length);
      const currentStatus = String(row[headers.index.request_status !== undefined ? headers.index.request_status : headers.index.status] || 'pending').trim().toLowerCase();
      if (currentStatus === 'approved' || currentStatus === 'denied') throw new Error('Pending request has already been resolved.');
      headers.names.forEach((header, index) => { const value = request[header] === undefined ? request[{ session_id: 'source_session_id', request_status: 'status', requested_by: 'requester', request_reason: 'reason', request_details: 'details', original_scheduled_at: 'original_schedule', scheduled_at: 'requested_scheduled_at', admin_decision_at: 'decision_at', admin_decision_by: 'decision_by' }[header]] : request[header]; if (value !== undefined && header !== 'created_at' && header !== 'request_created_at') row[index] = value; });
      if (headers.index.updated_at !== undefined) row[headers.index.updated_at] = now;
      sheet.getRange(existingIndex + 2, 1, 1, headers.names.length).setValues([row]);
      return { request_id: requestId, request_type: requestType, source_tab: sourceTab, action: 'updated', status: currentStatus, created_at: String(row[headers.index.created_at] || row[headers.index.request_created_at] || ''), updated_at: now };
    }
    const row = headers.names.map((header) => { const aliases = { session_id: 'source_session_id', request_status: 'status', requested_by: 'requester', request_reason: 'reason', request_details: 'details', original_scheduled_at: 'original_schedule', scheduled_at: 'requested_scheduled_at' }; if (header === 'request_id') return requestId; if (header === 'request_type') return requestType; if (header === 'status' || header === 'request_status') return status; if (header === 'created_at' || header === 'request_created_at') return request[header] || now; if (header === 'updated_at') return now; return request[header] === undefined ? (request[aliases[header]] || '') : request[header]; });
    sheet.getRange(Math.max(sheet.getLastRow() + 1, 2), 1, 1, headers.names.length).setValues([row]);
    return { request_id: requestId, request_type: requestType, source_tab: sourceTab, action: 'created', status: status, created_at: now, updated_at: now };
  } finally { lock.releaseLock(); }
}

function decidePendingRequest_(body) {
  const requestId = String(body.request_id || '').trim();
  const requestType = String(body.request_type || '').trim().toLowerCase();
  const decision = String(body.decision || '').trim().toLowerCase();
  const expectedStatus = String(body.expected_status || '').trim().toLowerCase();
  const denialReason = String(body.denial_reason || '').trim();
  const newbieShiftNumber = String(body.newbie_shift_number || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64);
  const tabByType = { initial_newbie_shift: 'newbie-shift-requests', newbie_shift_reschedule: 'newbie-shift-requests', candidate_deletion: 'candidate-deletion-requests', candidate_information_correction: 'candidate-information-correction-requests' };
  const sourceTab = tabByType[requestType];
  if (!requestId || !sourceTab || expectedStatus !== 'pending' || ['approve', 'deny'].indexOf(decision) === -1) throw new Error('Pending request decision is invalid.');
  if (decision === 'deny' && !denialReason) throw new Error('A denial reason is required.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Pending request is busy. Please try again.');
  try {
    const sheet = allowedSheet_(sourceTab); const headers = headerMap_(sheet); const values = sheet.getDataRange().getValues();
    const rowIndex = values.slice(1).findIndex((row) => String(row[headers.index.request_id] || '').trim() === requestId);
    if (rowIndex < 0) throw new Error('Pending request was not found.');
    const row = values[rowIndex + 1].slice(0, headers.names.length); const statusHeader = headers.index.request_status === undefined ? 'status' : 'request_status';
    const currentStatus = String(row[headers.index[statusHeader]] || 'pending').trim().toLowerCase();
    if (currentStatus !== expectedStatus) throw new Error('Pending request status has changed.');
    const now = new Date().toISOString(); const nextStatus = decision === 'approve' ? 'approved' : 'denied';
    const sourceSessionId = String(row[headers.index.session_id] || row[headers.index.source_session_id] || '').trim();
    let correctionResult = { updated: false, changes: [] };
    if (requestType === 'candidate_information_correction' && decision === 'approve') {
      correctionResult = applyCandidateCorrection_(sourceSessionId, row[headers.index.changes_json]);
    }
    row[headers.index[statusHeader]] = nextStatus;
    if (headers.index.admin_decision_at !== undefined) row[headers.index.admin_decision_at] = now;
    if (headers.index.admin_decision_by !== undefined) row[headers.index.admin_decision_by] = String(body.decision_by || '').trim();
    if (headers.index.denial_reason !== undefined) row[headers.index.denial_reason] = decision === 'deny' ? denialReason : '';
    if (decision === 'approve' && headers.index.newbie_shift_number !== undefined) row[headers.index.newbie_shift_number] = newbieShiftNumber;
    if (headers.index.updated_at !== undefined) row[headers.index.updated_at] = now;
    sheet.getRange(rowIndex + 2, 1, 1, headers.names.length).setValues([row]);
    let candidateSessionSynced = requestType === 'candidate_information_correction' && correctionResult.updated; let warning = '';
    if (requestType === 'initial_newbie_shift' || requestType === 'newbie_shift_reschedule') {
      if (!sourceSessionId) warning = 'Candidate session synchronization requires a source session id.';
      else {
        const candidateSheet = ensureHeadersPresent_('Candidate Sessions', CANDIDATE_SESSION_WORKFLOW_HEADERS); const candidateHeaders = headerMap_(candidateSheet); const candidateValues = candidateSheet.getDataRange().getValues();
        const candidateIndex = candidateValues.slice(1).findIndex((candidateRow) => String(candidateRow[candidateHeaders.index.session_id] || '').trim() === sourceSessionId);
        if (candidateIndex < 0) warning = 'The matching Candidate Sessions record was not found.';
        else {
          const candidateRow = candidateValues[candidateIndex + 1].slice(0, candidateHeaders.names.length);
          const changes = { newbie_shift_request_id: requestId, newbie_shift_request_status: nextStatus, newbie_shift_admin_decision_at: now, newbie_shift_admin_decision_by: String(body.decision_by || '').trim(), newbie_shift_denial_reason: decision === 'deny' ? denialReason : '' };
          const resultingAttempt = Number(row[headers.index.resulting_attempt] || row[headers.index.current_attempt] || 1);
          if (Number.isFinite(resultingAttempt) && resultingAttempt > 0) changes.attempt_number = resultingAttempt;
          if (headers.index.final_attempt !== undefined) changes.final_attempt = pendingRequestBoolean_(row[headers.index.final_attempt]);
          const terminalOutcome = headers.index.terminal_outcome === undefined ? '' : String(row[headers.index.terminal_outcome] || '').trim();
          if (terminalOutcome) { changes.status = terminalOutcome; changes.final_result = terminalOutcome; }
          if (decision === 'approve') { changes.newbie_shift_scheduled_at = String(row[headers.index.scheduled_at] || row[headers.index.rescheduled_at] || '').trim(); changes.newbie_shift_timezone = String(row[headers.index.timezone] || '').trim(); }
          if (decision === 'approve') changes.newbie_shift_number = newbieShiftNumber;
          Object.keys(changes).forEach((key) => { if (candidateHeaders.index[key] !== undefined && (key !== 'newbie_shift_scheduled_at' || changes[key])) candidateRow[candidateHeaders.index[key]] = changes[key]; });
          candidateSheet.getRange(candidateIndex + 2, 1, 1, candidateHeaders.names.length).setValues([candidateRow]); candidateSessionSynced = true;
        }
      }
    }
    let deletionResult = { candidateUpdates: 0, pendingUpdates: 0 };
    if (requestType === 'candidate_deletion' && decision === 'approve') deletionResult = applyCandidateDeletionTerminal_(sourceSessionId, requestId);
    return { request_id: requestId, request_type: requestType, status: nextStatus, decision: decision, decision_at: now, decision_by: String(body.decision_by || '').trim(), denial_reason: decision === 'deny' ? denialReason : '', candidate_session_synced: candidateSessionSynced, candidate_session_updated: requestType === 'candidate_information_correction' && correctionResult.updated, applied_changes: correctionResult.changes, candidate_deletion_applied: requestType === 'candidate_deletion' && decision === 'approve', candidate_updates: deletionResult.candidateUpdates, pending_updates: deletionResult.pendingUpdates, deletion_action_required: false, warning: warning };
  } finally { lock.releaseLock(); }
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

function headsetReviewSchema_(headers) {
  if (headersStartWith_(headers, HEADSET_REVIEW_V2_HEADERS)) return 'v2';
  if (headersStartWith_(headers, HEADSET_REVIEW_BASIC_HEADERS)) return 'basic';
  if (headersStartWith_(headers, HEADSET_REVIEW_LEGACY_HEADERS)) return 'legacy';
  throw new Error('Headset review log has unsupported headers.');
}

function headersStartWith_(headers, expected) {
  if (!Array.isArray(headers) || headers.length < expected.length) return false;
  return expected.every((header, index) => String(headers[index] || '').trim() === header);
}

function headsetReviewChecksum_(values) {
  const serialized = JSON.stringify(values.map((row) => row.map(serializeCell_)));
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, serialized)
    .map((value) => ('0' + ((value + 256) % 256).toString(16)).slice(-2))
    .join('');
}

function legacyMigrationReviewId_(rowNumber, headers, row) {
  const fingerprint = headsetReviewChecksum_([[rowNumber].concat(headers), row]);
  return 'legacy-migrated-' + fingerprint.slice(0, 32);
}

function distinctNonBlank_(values) {
  const seen = {};
  return values.map((value) => String(serializeCell_(value) || '').trim())
    .filter((value) => {
      const key = normalize_(value);
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
}

function headsetReviewMigrationAnalysis_() {
  const sheet = allowedSheet_('headset-review-log');
  const headers = headerMap_(sheet);
  const values = sheet.getDataRange().getValues();
  const schema = headsetReviewSchema_(headers.names);
  const rows = values.slice(1);
  const counts = {
    total_legacy_rows: schema === 'legacy' ? rows.length : 0,
    exact_session_linkage: 0,
    deterministic_legacy_only_linkage: 0,
    ambiguous_rows: 0,
    rows_already_current_schema: schema === 'v2' ? rows.length : 0,
    duplicate_review_ids: 0,
    duplicate_source_session_links: 0,
    blank_brand: 0,
    blank_model: 0,
    unknown_status: 0,
    rows_remaining_unlinked: 0,
  };
  if (schema === 'basic') throw new Error('Basic headset review rows need an explicit mapping before migration.');

  const migratedRows = [];
  const reviewIds = {};
  const sourceSessionIds = {};
  rows.forEach((row, offset) => {
    const object = rowObject_(headers.names, row);
    if (schema === 'v2') {
      const reviewId = String(object.review_id || '').trim();
      const sourceSessionId = String(object.source_session_id || '').trim();
      if (reviewId) reviewIds[reviewId] = (reviewIds[reviewId] || 0) + 1;
      if (sourceSessionId) sourceSessionIds[sourceSessionId] = (sourceSessionIds[sourceSessionId] || 0) + 1;
      if (!String(object.Brand || '').trim()) counts.blank_brand += 1;
      if (!String(object.Model || '').trim()) counts.blank_model += 1;
      return;
    }

    const directBrand = String(object.Brand || '').trim();
    const directModel = String(object.Model || '').trim();
    const combinedLegacyModel = String(object.headset_model || '').trim();
    const brand = directBrand;
    const model = directModel || combinedLegacyModel;
    const combinedDirect = (directBrand + ' ' + directModel).trim();
    const timestampValues = distinctNonBlank_([object.entered_at, object.Timestamp]);
    const testerValues = distinctNonBlank_([object.tester_name, object.SubmittedBy]);
    const status = normalize_(object.review_status) || 'pending';
    const noteParts = distinctNonBlank_([object.notes, object.Notes, object.ReviewNotes]);
    const ambiguous = Boolean(
      directModel && combinedLegacyModel && normalize_(combinedDirect) !== normalize_(combinedLegacyModel)
      || timestampValues.length > 1
      || testerValues.length > 1
    );
    if (ambiguous) counts.ambiguous_rows += 1;
    if (!brand) counts.blank_brand += 1;
    if (!model) counts.blank_model += 1;
    if (['pending', 'approved', 'denied', 'archived'].indexOf(status) === -1) counts.unknown_status += 1;

    const reviewId = legacyMigrationReviewId_(offset + 2, headers.names, row);
    const sourceSessionId = String(object.source_session_id || '').trim();
    reviewIds[reviewId] = (reviewIds[reviewId] || 0) + 1;
    if (sourceSessionId) {
      counts.exact_session_linkage += 1;
      sourceSessionIds[sourceSessionId] = (sourceSessionIds[sourceSessionId] || 0) + 1;
    } else {
      counts.deterministic_legacy_only_linkage += 1;
      counts.rows_remaining_unlinked += 1;
    }
    const createdAt = timestampValues[0] || '';
    migratedRows.push([
      reviewId,
      sourceSessionId,
      String(object.candidate_name || '').trim(),
      testerValues[0] || '',
      brand,
      model,
      status,
      noteParts.join(' | '),
      createdAt,
      createdAt,
      status === 'pending' ? '' : createdAt,
      '',
      status === 'denied' ? noteParts.join(' | ') : '',
    ]);
  });
  counts.duplicate_review_ids = Object.keys(reviewIds).filter((key) => reviewIds[key] > 1).length;
  counts.duplicate_source_session_links = Object.keys(sourceSessionIds).filter((key) => sourceSessionIds[key] > 1).length;
  return {
    schema: schema,
    current_headers: headers.names,
    expected_headers: HEADSET_REVIEW_V2_HEADERS.slice(),
    source_row_count: rows.length,
    source_checksum: headsetReviewChecksum_(values),
    counts: counts,
    safe_to_migrate: schema === 'legacy'
      && counts.ambiguous_rows === 0
      && counts.duplicate_review_ids === 0
      && counts.duplicate_source_session_links === 0,
    already_current: schema === 'v2',
    migratedRows: migratedRows,
    sourceValues: values,
  };
}

function publicHeadsetReviewMigrationPlan_(analysis) {
  return {
    schema: analysis.schema,
    current_headers: analysis.current_headers,
    expected_headers: analysis.expected_headers,
    source_row_count: analysis.source_row_count,
    source_checksum: analysis.source_checksum,
    counts: analysis.counts,
    safe_to_migrate: analysis.safe_to_migrate,
    already_current: analysis.already_current,
  };
}

function headsetReviewMigrationPlan_() {
  return publicHeadsetReviewMigrationPlan_(headsetReviewMigrationAnalysis_());
}

function migrateHeadsetReviewSchema_(body) {
  if (String(body.confirm || '') !== 'MIGRATE_HEADSET_REVIEW_V2') {
    throw new Error('Explicit migration confirmation is required.');
  }
  const expectedChecksum = required_(body.expected_checksum, 'expected_checksum');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Headset review migration is busy. Please try again.');
  try {
    const analysis = headsetReviewMigrationAnalysis_();
    if (analysis.source_checksum !== expectedChecksum) throw new Error('Headset review data changed after the dry run.');
    if (analysis.counts.duplicate_review_ids || analysis.counts.duplicate_source_session_links) {
      throw new Error('Headset review migration dry run found duplicate identity.');
    }
    if (analysis.already_current) {
      return Object.assign(publicHeadsetReviewMigrationPlan_(analysis), {
        migrated: false,
        final_row_count: analysis.source_row_count,
        changed_rows: 0,
        backup_created: false,
      });
    }
    if (!analysis.safe_to_migrate) throw new Error('Headset review migration dry run found blocking ambiguity or duplicate identity.');

    const workbook = spreadsheet_();
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    let backupTitle = 'headset-review-log-migration-backup-' + timestamp;
    let suffix = 1;
    while (workbook.getSheetByName(backupTitle)) {
      backupTitle = 'headset-review-log-migration-backup-' + timestamp + '-' + suffix;
      suffix += 1;
    }
    const backup = workbook.insertSheet(backupTitle);
    const sourceWidth = Math.max(analysis.current_headers.length, 1);
    if (analysis.sourceValues.length) {
      backup.getRange(1, 1, analysis.sourceValues.length, sourceWidth)
        .setValues(padRows_(analysis.sourceValues, sourceWidth));
    }
    const backupValues = backup.getDataRange().getValues();
    const backupChecksum = headsetReviewChecksum_(backupValues);
    if (backupValues.length !== analysis.sourceValues.length || backupChecksum !== analysis.source_checksum) {
      throw new Error('Headset review migration backup verification failed.');
    }

    const target = allowedSheet_('headset-review-log');
    const output = [HEADSET_REVIEW_V2_HEADERS.slice()].concat(analysis.migratedRows);
    target.getRange(1, 1, output.length, HEADSET_REVIEW_V2_HEADERS.length).setValues(output);
    const verified = headsetReviewMigrationAnalysis_();
    if (!verified.already_current || verified.source_row_count !== analysis.source_row_count || verified.counts.duplicate_review_ids) {
      throw new Error('Headset review migration verification failed. Restore from the retained backup.');
    }
    return Object.assign(publicHeadsetReviewMigrationPlan_(verified), {
      migrated: true,
      backup_title: backupTitle,
      backup_verified: true,
      backup_row_count: backupValues.length - 1,
      backup_checksum: backupChecksum,
    });
  } finally {
    lock.releaseLock();
  }
}

function headsetReviewStatus_(row, schema) {
  return normalize_(schema === 'legacy' ? row.review_status : row.Status) || 'pending';
}

function headsetReviewMatches_(row, schema, identity) {
  const reviewId = String(identity.review_id || '').trim();
  const brand = String(identity.brand || '').trim();
  const model = String(identity.model || '').trim();
  if (schema === 'v2') {
    if (reviewId) return String(row.review_id || '').trim() === reviewId;
    const sourceSessionId = String(identity.source_session_id || '').trim();
    return Boolean(
      sourceSessionId &&
      String(row.source_session_id || '').trim() === sourceSessionId &&
      normalize_(row.Brand) === normalize_(brand) &&
      normalize_(row.Model) === normalize_(model)
    );
  }
  if (schema === 'legacy') {
    return normalize_(row.headset_model) === normalize_((brand + ' ' + model).trim());
  }
  return normalize_(row.Brand) === normalize_(brand) && normalize_(row.Model) === normalize_(model);
}

function headsetReviewValues_(schema, values) {
  const output = {};
  if (schema === 'legacy') {
    if (values.brand !== undefined || values.model !== undefined) {
      output.headset_model = (String(values.brand || '') + ' ' + String(values.model || '')).trim();
    }
    if (values.candidate_name !== undefined) output.candidate_name = values.candidate_name;
    if (values.tester_name !== undefined) output.tester_name = values.tester_name;
    if (values.created_at !== undefined) output.entered_at = values.created_at;
    if (values.status !== undefined) output.review_status = values.status;
    if (values.note !== undefined) output.notes = values.note;
    return output;
  }
  if (values.brand !== undefined) output.Brand = values.brand;
  if (values.model !== undefined) output.Model = values.model;
  if (values.status !== undefined) output.Status = values.status;
  if (values.note !== undefined) output.Note = values.note;
  if (schema === 'basic') return output;
  if (values.review_id !== undefined) output.review_id = values.review_id;
  if (values.source_session_id !== undefined) output.source_session_id = values.source_session_id;
  if (values.candidate_name !== undefined) output.candidate_name = values.candidate_name;
  if (values.tester_name !== undefined) output.tester_name = values.tester_name;
  if (values.created_at !== undefined) output.created_at = values.created_at;
  if (values.updated_at !== undefined) output.updated_at = values.updated_at;
  if (values.decision_at !== undefined) output.decision_at = values.decision_at;
  if (values.decision_by !== undefined) output.decision_by = values.decision_by;
  if (values.denial_reason !== undefined) output.denial_reason = values.denial_reason;
  return output;
}

function updateHeadsetReviewRows_(body, changes) {
  const sheet = allowedSheet_('headset-review-log');
  const headers = headerMap_(sheet);
  const schema = headsetReviewSchema_(headers.names);
  const identity = {
    review_id: String(body.review_id || '').trim(),
    brand: String(body.brand || '').trim(),
    model: String(body.model || '').trim(),
  };
  const values = sheet.getDataRange().getValues();
  let updated = 0;
  values.slice(1).forEach((row, offset) => {
    const object = rowObject_(headers.names, row);
    if (!headsetReviewMatches_(object, schema, identity)) return;
    const mappedChanges = headsetReviewValues_(schema, changes);
    Object.keys(mappedChanges).forEach((key) => {
      if (headers.index[key] !== undefined) row[headers.index[key]] = mappedChanges[key];
    });
    sheet.getRange(offset + 2, 1, 1, headers.names.length).setValues([row.slice(0, headers.names.length)]);
    updated += 1;
  });
  return { updated: true, updatedRows: updated };
}

function submitHeadsetReview_(body) {
  const reviewId = String(body.review_id || '').trim();
  const sourceSessionId = String(body.source_session_id || '').trim();
  const candidateName = String(body.candidate_name || '').trim();
  const testerName = String(body.tester_name || '').trim();
  const brand = String(body.brand || '').trim();
  const model = String(body.model || body.headset_model || '').trim();
  if (!reviewId || !sourceSessionId || !candidateName || !testerName || !brand || !model) throw new Error('Headset review request data is incomplete.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Headset review request is busy. Please try again.');
  try {
    const parentSessions = readTableRows_('Candidate Sessions').filter((row) => String(row.session_id || '').trim() === sourceSessionId);
    if (parentSessions.length !== 1) throw new Error('Headset review parent session could not be verified.');
    const sheet = ensureSheetWithHeaders_('headset-review-log', HEADSET_REVIEW_V2_HEADERS);
    const headers = headerMap_(sheet);
    const schema = headsetReviewSchema_(headers.names);
    const values = sheet.getDataRange().getValues();
    const target = values.slice(1).findIndex((row) => {
      const object = rowObject_(headers.names, row);
      if (schema === 'v2') {
        return String(object.review_id || '').trim() === reviewId
          || String(object.source_session_id || '').trim() === sourceSessionId;
      }
      return headsetReviewMatches_(object, schema, { brand: brand, model: model });
    });
    const now = new Date().toISOString();
    if (target >= 0) {
      const row = values[target + 1].slice(0, headers.names.length);
      const currentStatus = headsetReviewStatus_(rowObject_(headers.names, row), schema);
      if (currentStatus !== 'pending') return { updated: false, skipped: true, reason: 'already_resolved', review_id: reviewId, status: currentStatus };
      const current = rowObject_(headers.names, row);
      return {
        updated: false,
        skipped: true,
        reason: 'duplicate_pending',
        review_id: String(current.review_id || reviewId),
        source_session_id: String(current.source_session_id || sourceSessionId),
        brand: String(current.Brand || brand),
        model: String(current.Model || model),
        status: 'pending',
      };
    }
    appendObject_(sheet, headers, headsetReviewValues_(schema, {
      review_id: reviewId,
      source_session_id: sourceSessionId,
      candidate_name: candidateName,
      tester_name: testerName,
      brand: brand,
      model: model,
      status: 'pending',
      note: String(body.note || ''),
      created_at: now,
      updated_at: now,
      decision_at: '',
      decision_by: '',
      denial_reason: '',
    }));
    return { updated: true, action: 'appended', review_id: reviewId, status: 'pending' };
  } finally {
    lock.releaseLock();
  }
}

function editHeadsetReview_(body) {
  const reviewId = required_(body.review_id, 'review_id');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Headset review edit is busy. Please try again.');
  try {
    const sheet = allowedSheet_('headset-review-log');
    const headers = headerMap_(sheet);
    const schema = headsetReviewSchema_(headers.names);
    if (schema !== 'v2') throw new Error('Pending headset editing requires the stable review schema.');
    const values = sheet.getDataRange().getValues();
    const target = values.slice(1).findIndex((row) => String(rowObject_(headers.names, row).review_id || '').trim() === reviewId);
    if (target < 0) throw new Error('Headset review was not found.');
    const row = values[target + 1].slice(0, headers.names.length);
    const current = rowObject_(headers.names, row);
    if (headsetReviewStatus_(current, schema) !== 'pending') throw new Error('Only pending headset reviews can be edited.');
    const brand = String(body.brand === undefined ? current.Brand : body.brand).trim().replace(/\s+/g, ' ');
    const model = String(body.model === undefined ? current.Model : body.model).trim().replace(/\s+/g, ' ');
    if (!brand && !model) throw new Error('Enter a headset brand or model.');
    const note = String(body.note === undefined ? current.Note : body.note).trim();
    const now = new Date().toISOString();
    const changes = headsetReviewValues_(schema, {
      brand: brand,
      model: model,
      note: note,
      updated_at: now,
      decision_by: String(body.actor || 'SAM'),
    });
    headers.names.forEach((header, index) => { if (changes[header] !== undefined) row[index] = changes[header]; });
    sheet.getRange(target + 2, 1, 1, headers.names.length).setValues([row]);
    const sourceSessionId = String(current.source_session_id || '').trim();
    if (sourceSessionId) {
      updateMatchingRows_('Candidate Sessions', (candidate) => String(candidate.session_id || '').trim() === sourceSessionId, {
        headset_brand: (brand + ' ' + model).trim().replace(/\s+/g, ' '),
      });
    }
    const approvedMatch = readTableRows_('headsets').some((headset) =>
      normalize_(headset.Brand) === normalize_(brand)
      && normalize_(headset.Model) === normalize_(model)
      && (!headset.Status || normalize_(headset.Status) === 'approved'));
    return {
      updated: true,
      review_id: reviewId,
      source_session_id: sourceSessionId,
      brand: brand,
      model: model,
      note: note,
      status: 'pending',
      approved_match: approvedMatch,
      updated_at: now,
      audit: {
        actor: String(body.actor || 'SAM'),
        before: { brand: String(current.Brand || ''), model: String(current.Model || ''), note: String(current.Note || '') },
        after: { brand: brand, model: model, note: note },
      },
    };
  } finally {
    lock.releaseLock();
  }
}

function decideHeadset_(body, status) {
  let reviewId = String(body.review_id || '').trim();
  const brand = required_(body.brand, 'brand');
  const model = required_(body.model, 'model');
  let authoritativeBrand = brand;
  let authoritativeModel = model;
  const note = String(body.note || body.reason || '').trim();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Headset review decision is busy. Please try again.');
  try {
    const sheet = allowedSheet_('headset-review-log');
    const headers = headerMap_(sheet);
    const schema = headsetReviewSchema_(headers.names);
    const values = sheet.getDataRange().getValues();
    const target = values.slice(1).findIndex((row) => headsetReviewMatches_(rowObject_(headers.names, row), schema, {
      review_id: reviewId,
      source_session_id: String(body.session_id || ''),
      brand: brand,
      model: model,
    }));

    const now = new Date().toISOString();
    let row;
    if (target < 0) {
      if (schema === 'legacy') throw new Error('Headset review was not found.');
      reviewId = reviewId || ('review-' + Math.random().toString(36).substring(2, 10));
      appendObject_(sheet, headers, headsetReviewValues_(schema, {
        review_id: reviewId,
        source_session_id: String(body.session_id || ''),
        candidate_name: String(body.candidate_name || body.admin_name || 'SAM'),
        tester_name: String(body.tester_name || body.actor || 'SAM'),
        brand: brand,
        model: model,
        status: status,
        note: note,
        created_at: now,
        updated_at: now,
        decision_at: now,
        decision_by: String(body.actor || 'SAM'),
        denial_reason: status === 'denied' ? String(body.reason || '') : '',
      }));
    } else {
      if (schema === 'v2' && !reviewId) throw new Error('review_id is required.');
      row = values[target + 1].slice(0, headers.names.length);
      const authoritative = rowObject_(headers.names, row);
      authoritativeBrand = String(authoritative.Brand || brand).trim().replace(/\s+/g, ' ');
      authoritativeModel = String(authoritative.Model || model).trim().replace(/\s+/g, ' ');
      const currentStatus = headsetReviewStatus_(authoritative, schema);
      if (currentStatus !== 'pending' && currentStatus !== status) throw new Error('Headset review status has changed.');
      const changes = headsetReviewValues_(schema, {
        status: status,
        note: note,
        updated_at: now,
        decision_at: now,
        decision_by: String(body.actor || 'SAM'),
        denial_reason: status === 'denied' ? String(body.reason || '') : '',
      });
      headers.names.forEach((header, index) => { if (changes[header] !== undefined) row[index] = changes[header]; });
      sheet.getRange(target + 2, 1, 1, headers.names.length).setValues([row]);
    }
    upsertObject_('headsets', ['Brand', 'Model'], {
      Brand: authoritativeBrand,
      Model: authoritativeModel,
      Status: status,
      Note: note,
    });
    return {
      updated: true,
      review_id: reviewId,
      brand: authoritativeBrand,
      model: authoritativeModel,
      status: status,
    };
  } finally {
    lock.releaseLock();
  }
}

function archiveHeadsetReview_(body) {
  const brand = required_(body.brand, 'brand');
  const model = required_(body.model, 'model');
  const note = String(body.note || body.reason || 'Archived from SAM').trim();
  return updateHeadsetReviewRows_(body, { status: 'archived', note: note });
}

function deleteHeadsetReview_(body) {
  const brand = required_(body.brand, 'brand');
  const model = required_(body.model, 'model');
  const sheet = allowedSheet_('headset-review-log');
  const headers = headerMap_(sheet);
  const schema = headsetReviewSchema_(headers.names);
  const reviewId = String(body.review_id || '').trim();
  const deletedRows = deleteMatchingRows_('headset-review-log', (row) => headsetReviewMatches_(row, schema, {
    review_id: reviewId,
    brand: brand,
    model: model,
  }));
  return { updated: true, deletedRows: deletedRows };
}

function upsertNotification_(body) {
  const item = normalizeNotification_(body.item && typeof body.item === 'object' ? body.item : body);
  const action = upsertObject_('sam-notifications', ['ID'], item);
  return { updated: true, action: action, item: item };
}

function disableNotification_(body) {
  const id = required_(body.id || (body.item || {}).ID, 'id');
  return updateMatchingRows_('sam-notifications', (row) => String(row.ID || '') === String(id), { Enabled: 'FALSE' });
}

function deleteNotification_(body) {
  const id = required_(body.id || (body.item || {}).ID, 'id');
  const deletedRows = deleteMatchingRows_('sam-notifications', (row) => String(row.ID || '') === String(id));
  return { updated: true, deletedRows: deletedRows, id: id };
}

function normalizeNotification_(item) {
  const now = new Date().toISOString();
  const id = String(item.ID || item.id || '').trim() || ('notification-' + now.replace(/[^0-9A-Za-z]+/g, '-'));
  const type = String(item.Type || item.type || 'info').trim().toLowerCase();
  return {
    Enabled: boolText_(item.Enabled),
    ID: id,
    Type: ['info', 'warning', 'urgent'].indexOf(type) === -1 ? 'info' : type,
    Title: String(item.Title || item.title || '').trim(),
    Message: String(item.Message || item.message || '').trim(),
    ShowTicker: boolText_(item.ShowTicker),
    ShowPopup: boolText_(item.ShowPopup),
    ShowBanner: boolText_(item.ShowBanner),
    Persistent: boolText_(item.Persistent),
    StartDate: String(item.StartDate || '').trim(),
    StartTime: String(item.StartTime || '').trim(),
    EndDate: String(item.EndDate || '').trim(),
    EndTime: String(item.EndTime || '').trim(),
    ActionText: String(item.ActionText || '').trim(),
    ActionURL: String(item.ActionURL || '').trim(),
    CreatedAt: String(item.CreatedAt || now).trim(),
    UpdatedAt: now,
  };
}

function boolText_(value) {
  if (value === true) return 'TRUE';
  if (value === false) return 'FALSE';
  const text = String(value || '').trim().toLowerCase();
  return ['true', 'yes', '1', 'y', 'enabled'].indexOf(text) !== -1 ? 'TRUE' : 'FALSE';
}

function updateCandidateTracking_(body, role) {
  if (body.candidateRow && typeof body.candidateRow === 'object') {
    const candidateRow = role === 'mts' ? sanitizeMtsCandidateRow_(body.candidateRow) : body.candidateRow;
    const candidateAction = upsertObject_('Candidate Sessions', ['session_id'], candidateRow);
    let pendingAction = '';
    if (body.pendingRow && typeof body.pendingRow === 'object') {
      const pendingRow = role === 'mts' ? sanitizeMtsPendingRow_(body.pendingRow) : body.pendingRow;
      pendingAction = upsertObject_('Pending Sup Transfers', ['pending_id'], pendingRow);
    }
    return { updated: true, candidateAction: candidateAction, pendingAction: pendingAction };
  }
  if (body.operation) {
    if (role !== 'sam') throw new Error('Forbidden');
    return applyCandidateOperation_(body);
  }
  throw new Error('candidateRow or operation is required.');
}

function sanitizeMtsCandidateRow_(candidateRow) {
  const sanitized = Object.assign({}, candidateRow || {});
  MTS_PROTECTED_CANDIDATE_FIELDS.forEach((field) => { delete sanitized[field]; });
  if (sanitized.newbie_shift_request_id) sanitized.newbie_shift_request_status = 'pending';
  if (sanitized.deletion_request_id) sanitized.deletion_request_status = 'pending';
  return sanitized;
}

function sanitizeMtsPendingRow_(pendingRow) {
  const sanitized = Object.assign({}, pendingRow || {});
  const allowedStatuses = ['pending', 'resumed', 'completed', 'failed_final', 'withdrawn'];
  const status = normalize_(sanitized.status || 'pending');
  sanitized.status = allowedStatuses.indexOf(status) === -1 ? 'pending' : status;
  return sanitized;
}

function applyCandidateOperation_(body) {
  const operation = String(body.operation || '').trim();
  const candidateName = String(body.candidate_name || '').trim();
  const sessionId = String(body.session_id || body.latest_session_id || '').trim();
  const pendingId = String(body.pending_id || '').trim();
  const exactSessionOperations = ['mark_passed', 'mark_failed', 'grant_extra_attempt', 'mark_incomplete', 'move_pending_sup_transfer', 'remove_pending_sup_transfer'];
  if (exactSessionOperations.indexOf(operation) !== -1 && !sessionId) throw new Error('session_id is required.');
  if (operation === 'edit_candidate_information') {
    if (!sessionId) throw new Error('session_id is required.');
    const reason = String(body.reason || '').trim();
    if (!reason) throw new Error('A correction reason is required.');
    const changes = correctionChanges_(body.changes || []);
    try {
      ensureSheetWithHeaders_('candidate-information-correction-requests', CANDIDATE_CORRECTION_REQUEST_HEADERS);
    } catch (_auditSetupError) {
      return { updated: false, error_code: 'candidate_update_action_unavailable', error: 'Candidate edit audit storage is unavailable.', candidateUpdated: false };
    }
    const result = applyCandidateCorrection_(sessionId, changes, body.candidate_id);
    const now = new Date().toISOString();
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify({ session_id: sessionId, changes: changes }))
      .slice(0, 6).map((value) => ('0' + ((value + 256) % 256).toString(16)).slice(-2)).join('');
    const requestId = String(body.request_id || ('admin-correction-' + sessionId + '-' + digest)).trim();
    try {
      upsertObject_('candidate-information-correction-requests', ['request_id'], {
        request_id: requestId, request_type: 'candidate_information_admin_edit', source_session_id: sessionId,
        candidate_id: String(body.candidate_id || sessionId).trim(), candidate_name: candidateName, tester_name: String(body.actor || 'SAM').trim(),
        reason: reason, changes_json: JSON.stringify(changes), created_at: now,
        status: 'approved', admin_decision_at: now, admin_decision_by: String(body.actor || 'SAM').trim(),
        denial_reason: '', updated_at: now,
      });
    } catch (_auditError) {
      return { updated: false, error_code: 'candidate_update_audit_failed', error: 'The candidate was updated, but the audit record could not be saved.', candidateUpdated: Boolean(result.updated) };
    }
    return { updated: true, action: 'edit_candidate_information', candidateUpdated: result.updated, request_id: requestId, changes: changes };
  }
  if (operation === 'delete_candidate_history') {
    const targets = Array.isArray(body.targets) ? body.targets : [body];
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) throw new Error('Candidate deletion is busy. Please try again.');
    try {
      const candidateTargets = readTableRows_('Candidate Sessions').filter((row) => targets.some((target) =>
        (target.session_id && String(row.session_id || '') === String(target.session_id)) ||
        (target.candidate_name && normalize_(row.candidate_name) === normalize_(target.candidate_name))));
      const targetSessionIds = candidateTargets.map((row) => String(row.session_id || '').trim()).filter(Boolean);
      const linkedReviews = readOptionalTableRows_('headset-review-log').filter((row) =>
        targetSessionIds.indexOf(String(row.source_session_id || '').trim()) !== -1);
      if (linkedReviews.length) throw new Error('Candidate session has a linked headset review. Resolve the review relationship before deleting the session.');
      const candidateDeleted = deleteMatchingRows_('Candidate Sessions', (row) => targets.some((target) =>
        (target.session_id && String(row.session_id || '') === String(target.session_id)) ||
        (target.candidate_name && normalize_(row.candidate_name) === normalize_(target.candidate_name))));
      const pendingDeleted = deleteMatchingRows_('Pending Sup Transfers', (row) => targets.some((target) =>
        (target.pending_id && String(row.pending_id || '') === String(target.pending_id)) ||
        (target.candidate_name && normalize_(row.candidate_name) === normalize_(target.candidate_name))));
      return { updated: true, deletedCandidates: candidateDeleted, deletedPending: pendingDeleted };
    } finally {
      lock.releaseLock();
    }
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
  ensureHeadersPresent_('Candidate Sessions', CANDIDATE_SESSION_WORKFLOW_HEADERS);
  const changes = {};
  if (operation === 'withdraw') Object.assign(changes, { withdrawn: 'TRUE', status: 'WITHDREW FROM CERTIFICATION', withdrawn_at: new Date().toISOString() });
  else if (operation === 'restore_active') Object.assign(changes, { archived: 'FALSE', status: 'INCOMPLETE' });
  else if (operation === 'restore_withdrawal') Object.assign(changes, { withdrawn: 'FALSE', withdrawn_at: '', status: 'INCOMPLETE' });
  else if (operation === 'grant_extra_attempt') {
    const candidates = readTableRows_('Candidate Sessions').filter((row) => String(row.session_id || '').trim() === sessionId);
    if (candidates.length !== 1) throw new Error('Candidate session could not be found.');
    const candidate = candidates[0];
    const currentExtra = Math.max(Number(candidate.extra_attempts_granted || 0) || 0, pendingRequestBoolean_(candidate.extra_attempt_granted) ? 1 : 0);
    if (body.expected_extra_attempts_granted !== undefined && Number(body.expected_extra_attempts_granted) !== currentExtra) {
      return { updated: true, already_applied: true, extra_attempts_granted: currentExtra, allowed_attempt_count: Math.max(3 + currentExtra, Number(candidate.allowed_attempt_count || 0) || 0) };
    }
    const nextExtra = currentExtra + 1;
    Object.assign(changes, {
      extra_attempt_granted: 'TRUE', extra_attempt_reason: String(body.reason || ''),
      extra_attempts_granted: nextExtra, allowed_attempt_count: Math.max(3 + nextExtra, Number(candidate.allowed_attempt_count || 0) || 0),
      extra_attempt_last_action_id: String(body.action_id || ('extra-' + sessionId + '-' + nextExtra)),
      extra_attempt_granted_by: String(body.actor || 'SAM'), extra_attempt_granted_at: new Date().toISOString(),
    });
  }
  else if (operation === 'archive_candidate') Object.assign(changes, { archived: 'TRUE' });
  else if (operation === 'mark_passed') Object.assign(changes, { status: 'PASS', final_result: 'PASS', readiness_override_applied: 'TRUE', readiness_override_result: 'PASS', readiness_override_reason: String(body.reason || ''), readiness_override_explanation: 'Manual SAM status override.', readiness_override_by: String(body.actor || 'SAM'), readiness_override_at: new Date().toISOString() });
  else if (operation === 'mark_failed') Object.assign(changes, { status: 'FAIL', final_result: 'FAIL', readiness_override_applied: 'TRUE', readiness_override_result: 'FAIL', readiness_override_reason: String(body.reason || ''), readiness_override_explanation: 'Manual SAM status override.', readiness_override_by: String(body.actor || 'SAM'), readiness_override_at: new Date().toISOString() });
  else if (operation === 'mark_incomplete') Object.assign(changes, { status: 'INCOMPLETE' });
  else throw new Error('Unsupported candidate operation: ' + operation);
  return updateMatchingRows_('Candidate Sessions', (row) => exactSessionOperations.indexOf(operation) !== -1
    ? String(row.session_id || '') === sessionId
    : ((sessionId && String(row.session_id || '') === sessionId) ||
      (candidateName && normalize_(row.candidate_name) === normalize_(candidateName))), changes);
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
  if (message.indexOf('Unauthorized') !== -1) return 'Unauthorized';
  if (message.indexOf('Forbidden') !== -1) return 'Forbidden';
  if (/token|deployment|script\.google|macros\/s\/|MASTER_SPREADSHEET_ID|https?:\/\//i.test(message)) {
    return 'Request failed.';
  }
  return message;
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
