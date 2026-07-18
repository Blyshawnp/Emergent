const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.resolve(__dirname, '..', 'docs', 'apps-script-api-web-app.gs');
const source = fs.readFileSync(sourcePath, 'utf8');

function createFakeSheet(name, headers = [], rows = []) {
  const values = headers.length ? [headers.slice(), ...rows.map((row) => row.slice())] : [];
  return {
    getName() {
      return name;
    },
    getSheetId() {
      return 1;
    },
    getMaxRows() {
      return Math.max(values.length, 1);
    },
    getMaxColumns() {
      return Math.max(...values.map((row) => row.length), 1);
    },
    getLastRow() {
      let last = values.length;
      while (last > 0 && !(values[last - 1] || []).some((value) => value !== '')) last -= 1;
      return last;
    },
    getLastColumn() {
      return values.reduce((maximum, row) => Math.max(maximum, row.length), 0);
    },
    getDataRange() {
      return {
        getValues() {
          return values.map((row) => row.slice());
        },
      };
    },
    getRange(startRow, startColumn, rowCount = 1, columnCount = 1) {
      return {
        getValues() {
          return Array.from({ length: rowCount }, (_, rowOffset) =>
            Array.from({ length: columnCount }, (_, columnOffset) =>
              (values[startRow - 1 + rowOffset] || [])[startColumn - 1 + columnOffset] || ''
            )
          );
        },
        setValues(nextRows) {
          nextRows.forEach((nextRow, rowOffset) => {
            const targetIndex = startRow - 1 + rowOffset;
            while (values.length <= targetIndex) values.push([]);
            const target = values[targetIndex];
            nextRow.forEach((value, columnOffset) => {
              target[startColumn - 1 + columnOffset] = value;
            });
          });
        },
        getNumRows() {
          return rowCount;
        },
        getNumColumns() {
          return columnCount;
        },
      };
    },
    deleteRow(rowNumber) {
      values.splice(rowNumber - 1, 1);
    },
    values,
  };
}

function createFakeWorkbook(sheets = []) {
  const byName = new Map(sheets.map((sheet) => [sheet.getName(), sheet]));
  return {
    getSheetByName(name) {
      return byName.get(name) || null;
    },
    getSheets() {
      return Array.from(byName.values());
    },
    insertSheet(name) {
      const sheet = createFakeSheet(name);
      byName.set(name, sheet);
      return sheet;
    },
  };
}

function createRuntime(overrides = {}) {
  const workbook = overrides.__workbook || null;
  const propertyOverrides = { ...overrides };
  delete propertyOverrides.__workbook;
  const properties = {
    MASTER_SPREADSHEET_ID: 'test-spreadsheet',
    MTS_API_TOKEN: 'mts-current',
    MTS_API_TOKEN_PREVIOUS: 'mts-previous',
    SAM_API_TOKEN: 'sam-current',
    SAM_API_TOKEN_PREVIOUS: 'sam-previous',
    API_TOKEN: 'legacy-mts',
    ...propertyOverrides,
  };

  const context = {
    Array,
    Boolean,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    RegExp,
    String,
    console,
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) {
        return {
          text,
          setMimeType() {
            return this;
          },
        };
      },
    },
    LockService: {
      getScriptLock() {
        return {
          tryLock() {
            return true;
          },
          releaseLock() {},
        };
      },
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(name) {
            return properties[name] || '';
          },
        };
      },
    },
    SpreadsheetApp: {
      openById() {
        return workbook || {
          getSheetByName() {
            return null;
          },
          getSheets() {
            return [];
          },
        };
      },
    },
  };

  vm.createContext(context);
  vm.runInContext(
    `${source}
globalThis.__appsScriptAuthorization = {
  authorizeAction_,
  credentialRole_,
  doGet,
  doPost,
  headsetReviewSchema_,
  safeError_,
  sanitizeMtsCandidateRow_,
  sanitizeMtsPendingRow_,
};`,
    context,
    { filename: sourcePath },
  );
  return { api: context.__appsScriptAuthorization, properties };
}

function responsePayload(response) {
  return JSON.parse(response.text);
}

function getEvent(action, token, params = {}) {
  return { parameter: { action, token, ...params } };
}

function postEvent(action, token, payload = {}) {
  return {
    postData: {
      contents: JSON.stringify({ action, token, ...payload }),
    },
  };
}

test('MTS current, previous, and legacy credentials keep intended read-only operations', () => {
  const { api } = createRuntime();

  for (const token of ['mts-current', 'mts-previous', 'legacy-mts']) {
    assert.deepEqual(responsePayload(api.doGet(getEvent('ping', token))), {
      ok: true,
      result: { status: 'ready' },
    });
    assert.deepEqual(responsePayload(api.doGet(getEvent('getMtsTutorialVideos', token))), {
      ok: true,
      result: { rows: [] },
    });
  }
});

test('update metadata reads are bound to the authenticated MTS or SAM role', () => {
  const headers = ['Version', 'RequiredVersion', 'Release Date', 'Release Title', 'URL', 'Notes'];
  const mtsSheet = createFakeSheet('update-MTS', headers, [[
    '1.0.1', '', '2026-07-18', 'MTS release', '', 'MTS notes',
  ]]);
  const samSheet = createFakeSheet('update-SAM', headers, [[
    '1.0.2', '1.0.1', '2026-07-18', 'SAM release', '', 'SAM notes',
  ]]);
  const { api } = createRuntime({ __workbook: createFakeWorkbook([mtsSheet, samSheet]) });

  const mts = responsePayload(api.doGet(getEvent('getUpdateMetadata', 'mts-current', { app: 'sam' })));
  assert.equal(mts.ok, true);
  assert.equal(mts.result.app, 'mts');
  assert.equal(mts.result.tab, 'update-MTS');
  assert.equal(mts.result.row.Version, '1.0.1');
  assert.equal(mts.result.row['Release Title'], 'MTS release');

  const sam = responsePayload(api.doGet(getEvent('getUpdateMetadata', 'sam-current', { app: 'mts' })));
  assert.equal(sam.ok, true);
  assert.equal(sam.result.app, 'sam');
  assert.equal(sam.result.tab, 'update-SAM');
  assert.equal(sam.result.row.Version, '1.0.2');
  assert.equal(sam.result.row['Release Title'], 'SAM release');
});

test('MTS credentials cannot invoke SAM-only decisions or generic sheet administration', () => {
  const { api } = createRuntime();

  for (const action of ['approveHeadset', 'decidePendingRequest', 'deleteNotification', 'batchUpdateSpreadsheet', 'ensureTutorialVideoTabs']) {
    const result = responsePayload(api.doPost(postEvent(action, 'mts-current', {
      requests: [],
      request_id: 'request-test',
      request_type: 'initial_newbie_shift',
      decision: 'approve',
      expected_status: 'pending',
      review_id: 'review-test',
      brand: 'Example',
      model: 'Model',
      id: 'notification-test',
    })));
    assert.deepEqual(result, { ok: false, error: 'Forbidden' });
  }

  assert.deepEqual(
    responsePayload(api.doPost(postEvent('updateCandidateTracking', 'mts-current', {
      operation: 'delete_candidate_history',
      session_id: 'session-test',
    }))),
    { ok: false, error: 'Forbidden' },
  );
});

test('SAM current and previous credentials can invoke authorized admin operations', () => {
  const { api } = createRuntime();

  for (const token of ['sam-current', 'sam-previous']) {
    assert.deepEqual(
      responsePayload(api.doPost(postEvent('batchUpdateSpreadsheet', token, { requests: [] }))),
      { ok: true, result: { replies: [] } },
    );
    assert.equal(
      api.authorizeAction_(token, 'POST', 'decidePendingRequest', {
        request_id: 'request-test',
        request_type: 'initial_newbie_shift',
        decision: 'approve',
        expected_status: 'pending',
      }),
      'sam',
    );
  }
});

test('MTS candidate synchronization is allowed only for non-admin payloads', () => {
  const { api } = createRuntime();

  assert.equal(
    api.authorizeAction_('mts-current', 'POST', 'updateCandidateTracking', {
      candidateRow: { session_id: 'session-test', status: 'INCOMPLETE' },
    }),
    'mts',
  );
  assert.throws(
    () => api.authorizeAction_('mts-current', 'POST', 'updateCandidateTracking', {
      operation: 'archive_candidate',
      session_id: 'session-test',
    }),
    /Forbidden/,
  );
});

test('ordinary MTS synchronization fields remain available while admin decision fields are removed', () => {
  const { api } = createRuntime();
  const candidate = api.sanitizeMtsCandidateRow_({
    session_id: 'session-test',
    status: 'WITHDREW FROM CERTIFICATION',
    withdrawn: 'TRUE',
    withdrawn_at: '2026-07-16T12:00:00Z',
    retention_until: '2026-08-16T12:00:00Z',
    extra_attempt_granted: 'TRUE',
    archived: 'TRUE',
    newbie_shift_admin_decision_by: 'private-admin',
  });
  const pending = api.sanitizeMtsPendingRow_({
    pending_id: 'pending-test',
    status: 'completed',
    completed_by: 'Trainer Example',
    completed_at: '2026-07-16T12:00:00Z',
    completed_status: 'PASS',
  });

  assert.equal(candidate.withdrawn, 'TRUE');
  assert.equal(candidate.withdrawn_at, '2026-07-16T12:00:00Z');
  assert.equal(candidate.retention_until, '2026-08-16T12:00:00Z');
  assert.equal(candidate.extra_attempt_granted, undefined);
  assert.equal(candidate.archived, undefined);
  assert.equal(candidate.newbie_shift_admin_decision_by, undefined);
  assert.equal(pending.status, 'completed');
  assert.equal(pending.completed_by, 'Trainer Example');
  assert.equal(pending.completed_status, 'PASS');
});

test('read-only optional request tabs return an empty snapshot instead of failing', () => {
  const { api } = createRuntime();
  assert.deepEqual(responsePayload(api.doGet(getEvent('getPendingRequests', 'mts-current'))), {
    ok: true,
    result: {
      requests: [],
      counts: {
        total: 0,
        newbie_shift: 0,
        reschedule: 0,
        candidate_deletion: 0,
      },
    },
  });
});

test('headset review compatibility recognizes V2, basic, and legacy headers', () => {
  const { api } = createRuntime();
  assert.equal(api.headsetReviewSchema_([
    'review_id', 'source_session_id', 'candidate_name', 'tester_name',
    'Brand', 'Model', 'Status', 'Note', 'created_at', 'updated_at',
    'decision_at', 'decision_by', 'denial_reason',
  ]), 'v2');
  assert.equal(api.headsetReviewSchema_(['Brand', 'Model', 'Status', 'Note']), 'basic');
  assert.equal(api.headsetReviewSchema_([
    'headset_model', 'candidate_name', 'tester_name', 'entered_at', 'review_status', 'notes',
  ]), 'legacy');
});

test('legacy headset review submission and SAM decision preserve the existing schema', () => {
  const legacySheet = createFakeSheet('headset-review-log', [
    'headset_model', 'candidate_name', 'tester_name', 'entered_at', 'review_status', 'notes',
  ]);
  const headsetsSheet = createFakeSheet('headsets', ['Brand', 'Model', 'Status', 'Note']);
  const workbook = createFakeWorkbook([legacySheet, headsetsSheet]);
  const { api } = createRuntime({ __workbook: workbook });

  const submitted = responsePayload(api.doPost(postEvent('submitHeadsetReview', 'mts-current', {
    review_id: 'review-test',
    source_session_id: 'session-test',
    candidate_name: 'Candidate Example',
    tester_name: 'Tester Example',
    brand: 'ExampleBrand',
    model: 'Model 9000',
    note: 'Trainer note',
  })));
  assert.equal(submitted.ok, true);
  assert.equal(legacySheet.values[1][0], 'ExampleBrand Model 9000');
  assert.equal(legacySheet.values[1][4], 'pending');

  const decided = responsePayload(api.doPost(postEvent('approveHeadset', 'sam-current', {
    review_id: 'legacy-2',
    brand: 'ExampleBrand',
    model: 'Model 9000',
    actor: 'SAM Admin',
  })));
  assert.equal(decided.ok, true);
  assert.equal(legacySheet.values[1][4], 'approved');
  assert.equal(headsetsSheet.values[1][2], 'approved');
});

test('first MTS pending-request write creates only the missing workflow tab contract', () => {
  const workbook = createFakeWorkbook();
  const { api } = createRuntime({ __workbook: workbook });
  const result = responsePayload(api.doPost(postEvent('upsertPendingRequest', 'mts-current', {
    request: {
      request_id: 'request-test',
      request_type: 'initial_newbie_shift',
      source_session_id: 'session-test',
      candidate: 'Candidate Example',
      tester: 'Tester Example',
    },
  })));

  assert.equal(result.ok, true);
  const sheet = workbook.getSheetByName('newbie-shift-requests');
  assert.ok(sheet);
  assert.equal(sheet.values[0][0], 'request_id');
  assert.equal(sheet.values[0][1], 'session_id');
  assert.equal(sheet.values[1][0], 'request-test');
  assert.equal(sheet.values[1][1], 'session-test');
  assert.equal(sheet.values[1][7], 'pending');
  assert.equal(workbook.getSheetByName('candidate-deletion-requests'), null);
});

test('SAM tutorial setup creates only missing tabs with the exact headers and is idempotent', () => {
  const headers = [
    'Category', 'VideoKey', 'Title', 'Description', 'YouTubeURL', 'Duration',
    'HelpTopicKey', 'SortOrder', 'Active', 'Audience', 'Notes',
  ];
  const existing = createFakeSheet('mts-tutorial-videos', headers, [[
    'Quick Start', 'existing', 'Existing video', '', 'https://youtu.be/dQw4w9WgXcQ', '', '', '1', 'TRUE', 'MTS', '',
  ]]);
  const workbook = createFakeWorkbook([existing]);
  const { api } = createRuntime({ __workbook: workbook });

  const first = responsePayload(api.doPost(postEvent('ensureTutorialVideoTabs', 'sam-current')));
  assert.equal(first.ok, true);
  assert.equal(first.result.createdCount, 1);
  assert.equal(first.result.existingCount, 1);
  assert.deepEqual(workbook.getSheetByName('sam-tutorial-videos').values[0], headers);
  assert.equal(existing.values[1][2], 'Existing video');

  const second = responsePayload(api.doPost(postEvent('ensureTutorialVideoTabs', 'sam-current')));
  assert.equal(second.ok, true);
  assert.equal(second.result.createdCount, 0);
  assert.equal(second.result.existingCount, 2);
  assert.equal(existing.values.length, 2);
});

test('tutorial setup rejects incompatible existing headers with a sanitized actionable error', () => {
  const workbook = createFakeWorkbook([createFakeSheet('mts-tutorial-videos', ['Wrong', 'Headers'])]);
  const { api } = createRuntime({ __workbook: workbook });
  const result = responsePayload(api.doPost(postEvent('ensureTutorialVideoTabs', 'sam-current')));
  assert.equal(result.ok, false);
  assert.match(result.error, /incompatible headers: mts-tutorial-videos/i);
  assert.equal(result.error.includes('test-spreadsheet'), false);
  assert.equal(workbook.getSheetByName('sam-tutorial-videos'), null);
});

test('unknown, blank, and cross-role ambiguous credentials fail closed', () => {
  const { api } = createRuntime();

  for (const token of ['', 'unknown-token']) {
    assert.deepEqual(responsePayload(api.doGet(getEvent('ping', token))), {
      ok: false,
      error: 'Unauthorized',
    });
  }

  const ambiguous = createRuntime({ SAM_API_TOKEN: 'mts-current' }).api;
  assert.deepEqual(responsePayload(ambiguous.doGet(getEvent('ping', 'mts-current'))), {
    ok: false,
    error: 'Unauthorized',
  });
});

test('authorization failures reveal no credential or deployment details', () => {
  const { api } = createRuntime();
  const invalidToken = 'invalid-secret-token';
  const deploymentMarker = 'private-deployment-marker';

  const unauthorized = JSON.stringify(responsePayload(api.doGet(getEvent('ping', invalidToken, {
    deployment: deploymentMarker,
  }))));
  const forbidden = JSON.stringify(responsePayload(api.doPost(postEvent(
    'deleteNotification',
    'mts-current',
    { id: deploymentMarker },
  ))));

  for (const response of [unauthorized, forbidden]) {
    assert.equal(response.includes(invalidToken), false);
    assert.equal(response.includes('mts-current'), false);
    assert.equal(response.includes(deploymentMarker), false);
  }

  assert.equal(
    api.safeError_(new Error('Deployment https://script.google.com/macros/s/private-marker/exec rejected token')),
    'Request failed.',
  );
});
