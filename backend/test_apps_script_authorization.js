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
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest(_algorithm, value) {
        return Array.from(String(value)).slice(0, 32).map((character) => character.charCodeAt(0) - 128);
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

test('MTS credentials cannot invoke SAM-only setup, decisions, migration, or generic sheet administration', () => {
  const { api } = createRuntime();

  for (const action of ['completeSamSetup', 'approveHeadset', 'editHeadsetReview', 'migrateHeadsetReviewSchema', 'decidePendingRequest', 'deleteNotification', 'batchUpdateSpreadsheet', 'ensureTutorialVideoTabs']) {
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

test('SAM setup status exposes readiness without returning administrator rows', () => {
  const headers = ['name', 'pin', 'role', 'enabled', 'installed', 'install_date', 'device_name', 'notes'];
  const sheet = createFakeSheet('sam-authorized-users', headers, [[
    'Admin Example', '1234', 'owner', 'TRUE', '', '', '', '',
  ]]);
  const { api } = createRuntime({ __workbook: createFakeWorkbook([sheet]) });

  assert.deepEqual(responsePayload(api.doGet(getEvent('getSamSetupStatus', 'sam-current'))), {
    ok: true,
    result: { ok: true, configured: true },
  });
  assert.deepEqual(responsePayload(api.doGet(getEvent('getSamSetupStatus', 'mts-current'))), {
    ok: false,
    error: 'Forbidden',
  });
});

test('SAM setup validates, registers, and preserves the original install timestamp on retry', () => {
  const headers = ['name', 'pin', 'role', 'enabled', 'installed', 'install_date', 'device_name', 'notes'];
  const sheet = createFakeSheet('sam-authorized-users', headers, [[
    'Admin Example', '1234', 'owner', 'TRUE', '', '', '', 'keep',
  ]]);
  const { api } = createRuntime({ __workbook: createFakeWorkbook([sheet]) });

  const first = responsePayload(api.doPost(postEvent('completeSamSetup', 'sam-current', {
    name: 'Admin Example', pin: '1234', device_name: 'Desk PC',
  })));
  assert.equal(first.ok, true);
  assert.equal(first.result.ok, true);
  assert.equal(first.result.name, 'Admin Example');
  assert.equal(first.result.role, 'owner');
  assert.equal(first.result.alreadyInstalled, false);
  assert.equal(sheet.values[1][4], 'TRUE');
  assert.equal(sheet.values[1][6], 'Desk PC');
  assert.equal(sheet.values[1][7], 'keep');
  const installDate = sheet.values[1][5];
  assert.ok(installDate);

  const repeated = responsePayload(api.doPost(postEvent('completeSamSetup', 'sam-current', {
    name: 'Admin Example', pin: '1234', device_name: 'Desk PC',
  })));
  assert.equal(repeated.result.ok, true);
  assert.equal(repeated.result.alreadyInstalled, true);
  assert.equal(sheet.values[1][5], installDate);
});

test('SAM setup returns stable errors for unknown, invalid, and disabled administrators', () => {
  const headers = ['name', 'pin', 'role', 'enabled', 'installed', 'install_date', 'device_name', 'notes'];
  const sheet = createFakeSheet('sam-authorized-users', headers, [
    ['Admin Example', '1234', 'owner', 'TRUE', '', '', '', ''],
    ['Disabled Admin', '9999', 'admin', 'FALSE', '', '', '', ''],
  ]);
  const { api } = createRuntime({ __workbook: createFakeWorkbook([sheet]) });
  const setup = (name, pin) => responsePayload(api.doPost(postEvent('completeSamSetup', 'sam-current', { name, pin })));

  assert.equal(setup('Missing Admin', '1234').result.errorCode, 'setup_admin_not_found');
  assert.equal(setup('Admin Example', '0000').result.errorCode, 'setup_invalid_pin');
  assert.equal(setup('Disabled Admin', '9999').result.errorCode, 'setup_authorization_failed');
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
        candidate_correction: 0,
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

test('headset review migration dry run is aggregate-only and apply retains an exact verified backup', () => {
  const headers = [
    'headset_model', 'candidate_name', 'tester_name', 'entered_at', 'review_status', 'notes',
    'Timestamp', 'Brand', 'Model', 'SubmittedBy', 'Notes', 'ReviewNotes',
  ];
  const legacySheet = createFakeSheet('headset-review-log', headers, [
    ['USB Training One', 'Candidate One', 'Tester One', '2026-07-01T12:00:00Z', 'pending', 'First note', '', '', '', '', '', ''],
    ['USB Training Two', 'Candidate Two', 'Tester Two', '2026-07-02T12:00:00Z', 'approved', '', '', 'USB', 'Training Two', '', 'Second note', ''],
  ]);
  const workbook = createFakeWorkbook([legacySheet]);
  const { api } = createRuntime({ __workbook: workbook });

  const dryRun = responsePayload(api.doGet(getEvent('getHeadsetReviewMigrationPlan', 'sam-current')));
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.result.schema, 'legacy');
  assert.equal(dryRun.result.source_row_count, 2);
  assert.equal(dryRun.result.counts.deterministic_legacy_only_linkage, 2);
  assert.equal(dryRun.result.counts.rows_remaining_unlinked, 2);
  assert.equal(dryRun.result.safe_to_migrate, true);
  assert.equal(Object.hasOwn(dryRun.result, 'migratedRows'), false);
  assert.equal(JSON.stringify(dryRun).includes('Candidate One'), false);

  const migrated = responsePayload(api.doPost(postEvent('migrateHeadsetReviewSchema', 'sam-current', {
    confirm: 'MIGRATE_HEADSET_REVIEW_V2', expected_checksum: dryRun.result.source_checksum,
  })));
  assert.equal(migrated.ok, true, JSON.stringify(migrated));
  assert.equal(migrated.result.migrated, true);
  assert.equal(migrated.result.backup_verified, true);
  assert.equal(migrated.result.backup_row_count, 2);
  assert.deepEqual(legacySheet.values[0].slice(0, 13), [
    'review_id', 'source_session_id', 'candidate_name', 'tester_name', 'Brand', 'Model',
    'Status', 'Note', 'created_at', 'updated_at', 'decision_at', 'decision_by', 'denial_reason',
  ]);
  assert.match(legacySheet.values[1][0], /^legacy-migrated-/);
  assert.equal(legacySheet.values[1][1], '');
  assert.equal(legacySheet.values[1][5], 'USB Training One');
  const backup = workbook.getSheetByName(migrated.result.backup_title);
  assert.ok(backup);
  assert.deepEqual(backup.values, [headers, ...[
    ['USB Training One', 'Candidate One', 'Tester One', '2026-07-01T12:00:00Z', 'pending', 'First note', '', '', '', '', '', ''],
    ['USB Training Two', 'Candidate Two', 'Tester Two', '2026-07-02T12:00:00Z', 'approved', '', '', 'USB', 'Training Two', '', 'Second note', ''],
  ]]);
});

test('headset review migration refuses conflicting legacy mappings before creating a backup', () => {
  const headers = [
    'headset_model', 'candidate_name', 'tester_name', 'entered_at', 'review_status', 'notes',
    'Timestamp', 'Brand', 'Model', 'SubmittedBy', 'Notes', 'ReviewNotes',
  ];
  const legacySheet = createFakeSheet('headset-review-log', headers, [[
    'USB Old Model', 'Candidate', 'Tester', '2026-07-01T12:00:00Z', 'pending', '',
    '2026-07-03T12:00:00Z', 'USB', 'Different Model', '', '', '',
  ]]);
  const workbook = createFakeWorkbook([legacySheet]);
  const { api } = createRuntime({ __workbook: workbook });
  const dryRun = responsePayload(api.doGet(getEvent('getHeadsetReviewMigrationPlan', 'sam-current')));
  assert.equal(dryRun.result.safe_to_migrate, false);
  assert.equal(dryRun.result.counts.ambiguous_rows, 1);

  const migrated = responsePayload(api.doPost(postEvent('migrateHeadsetReviewSchema', 'sam-current', {
    confirm: 'MIGRATE_HEADSET_REVIEW_V2', expected_checksum: dryRun.result.source_checksum,
  })));
  assert.equal(migrated.ok, false);
  assert.equal(workbook.getSheets().length, 1);
  assert.deepEqual(legacySheet.values[0], headers);
});

test('current V2 headset review migration is a deterministic write-free no-op', () => {
  const headers = [
    'review_id', 'source_session_id', 'candidate_name', 'tester_name', 'Brand', 'Model',
    'Status', 'Note', 'created_at', 'updated_at', 'decision_at', 'decision_by', 'denial_reason',
  ];
  const currentRows = [[
    'review-current', 'session-current', 'Candidate', 'Tester', 'USB', 'Training One',
    'approved', '', '2026-07-01T12:00:00Z', '2026-07-01T12:00:00Z', '', '', '',
  ]];
  const currentSheet = createFakeSheet('headset-review-log', headers, currentRows);
  const workbook = createFakeWorkbook([currentSheet]);
  const { api } = createRuntime({ __workbook: workbook });
  const before = JSON.stringify(currentSheet.values);
  const plan = responsePayload(api.doGet(getEvent('getHeadsetReviewMigrationPlan', 'sam-current')));

  const first = responsePayload(api.doPost(postEvent('migrateHeadsetReviewSchema', 'sam-current', {
    confirm: 'MIGRATE_HEADSET_REVIEW_V2', expected_checksum: plan.result.source_checksum,
  })));
  const second = responsePayload(api.doPost(postEvent('migrateHeadsetReviewSchema', 'sam-current', {
    confirm: 'MIGRATE_HEADSET_REVIEW_V2', expected_checksum: plan.result.source_checksum,
  })));

  for (const response of [first, second]) {
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.result.schema, 'v2');
    assert.equal(response.result.already_current, true);
    assert.equal(response.result.migrated, false);
    assert.equal(response.result.source_row_count, 1);
    assert.equal(response.result.final_row_count, 1);
    assert.equal(response.result.changed_rows, 0);
    assert.equal(response.result.backup_created, false);
    assert.doesNotThrow(() => JSON.stringify(response.result));
  }
  assert.deepEqual(first.result, second.result);
  assert.equal(JSON.stringify(currentSheet.values), before);
  assert.equal(workbook.getSheets().length, 1);

  const stale = responsePayload(api.doPost(postEvent('migrateHeadsetReviewSchema', 'sam-current', {
    confirm: 'MIGRATE_HEADSET_REVIEW_V2', expected_checksum: 'stale-checksum',
  })));
  assert.equal(stale.ok, false);
  assert.match(stale.error, /changed after the dry run/i);
  assert.equal(JSON.stringify(currentSheet.values), before);
  assert.equal(workbook.getSheets().length, 1);
});

test('current V2 headset review migration fails closed on duplicate identities', () => {
  const headers = [
    'review_id', 'source_session_id', 'candidate_name', 'tester_name', 'Brand', 'Model',
    'Status', 'Note', 'created_at', 'updated_at', 'decision_at', 'decision_by', 'denial_reason',
  ];
  for (const rows of [
    [
      ['duplicate-review', 'session-one'],
      ['duplicate-review', 'session-two'],
    ],
    [
      ['review-one', 'duplicate-session'],
      ['review-two', 'duplicate-session'],
    ],
  ]) {
    const sheetRows = rows.map(([reviewId, sessionId]) => [
      reviewId, sessionId, 'Candidate', 'Tester', 'USB', 'Training', 'pending', '', '', '', '', '', '',
    ]);
    const sheet = createFakeSheet('headset-review-log', headers, sheetRows);
    const workbook = createFakeWorkbook([sheet]);
    const { api } = createRuntime({ __workbook: workbook });
    const plan = responsePayload(api.doGet(getEvent('getHeadsetReviewMigrationPlan', 'sam-current')));
    const result = responsePayload(api.doPost(postEvent('migrateHeadsetReviewSchema', 'sam-current', {
      confirm: 'MIGRATE_HEADSET_REVIEW_V2', expected_checksum: plan.result.source_checksum,
    })));
    assert.equal(result.ok, false);
    assert.match(result.error, /duplicate identity/i);
    assert.equal(workbook.getSheets().length, 1);
  }
});

test('legacy headset review submission and SAM decision preserve the existing schema', () => {
  const legacySheet = createFakeSheet('headset-review-log', [
    'headset_model', 'candidate_name', 'tester_name', 'entered_at', 'review_status', 'notes',
  ]);
  const headsetsSheet = createFakeSheet('headsets', ['Brand', 'Model', 'Status', 'Note']);
  const candidateSheet = createFakeSheet('Candidate Sessions', ['session_id', 'candidate_name'], [
    ['session-test', 'Candidate Example'],
  ]);
  const workbook = createFakeWorkbook([legacySheet, headsetsSheet, candidateSheet]);
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

test('headset review submission fails closed when the exact parent session is unavailable', () => {
  const reviewSheet = createFakeSheet('headset-review-log', [
    'review_id', 'source_session_id', 'candidate_name', 'tester_name', 'Brand', 'Model',
    'Status', 'Note', 'created_at', 'updated_at', 'decision_at', 'decision_by', 'denial_reason',
  ]);
  const candidateSheet = createFakeSheet('Candidate Sessions', ['session_id', 'candidate_name'], [
    ['different-session', 'Candidate Example'],
  ]);
  const workbook = createFakeWorkbook([reviewSheet, candidateSheet]);
  const { api } = createRuntime({ __workbook: workbook });
  const result = responsePayload(api.doPost(postEvent('submitHeadsetReview', 'mts-current', {
    review_id: 'review-test', source_session_id: 'missing-session',
    candidate_name: 'Candidate Example', tester_name: 'Tester Example',
    brand: 'ExampleBrand', model: 'Model 9000',
  })));
  assert.equal(result.ok, false);
  assert.match(result.error, /parent session could not be verified/i);
  assert.equal(reviewSheet.values.length, 1);
});

test('headset review submission fails closed when the parent session identity is duplicated', () => {
  const reviewSheet = createFakeSheet('headset-review-log', [
    'review_id', 'source_session_id', 'candidate_name', 'tester_name', 'Brand', 'Model',
    'Status', 'Note', 'created_at', 'updated_at', 'decision_at', 'decision_by', 'denial_reason',
  ]);
  const candidateSheet = createFakeSheet('Candidate Sessions', ['session_id', 'candidate_name'], [
    ['duplicate-session', 'Candidate One'],
    ['duplicate-session', 'Candidate Two'],
  ]);
  const workbook = createFakeWorkbook([reviewSheet, candidateSheet]);
  const { api } = createRuntime({ __workbook: workbook });
  const result = responsePayload(api.doPost(postEvent('submitHeadsetReview', 'mts-current', {
    review_id: 'review-test', source_session_id: 'duplicate-session',
    candidate_name: 'Candidate Example', tester_name: 'Tester Example',
    brand: 'ExampleBrand', model: 'Model 9000',
  })));
  assert.equal(result.ok, false);
  assert.match(result.error, /parent session could not be verified/i);
  assert.equal(reviewSheet.values.length, 1);
});

test('candidate deletion cannot silently orphan a linked headset review', () => {
  const candidateSheet = createFakeSheet('Candidate Sessions', ['session_id', 'candidate_name'], [
    ['session-1', 'Candidate Example'],
  ]);
  const reviewSheet = createFakeSheet('headset-review-log', [
    'review_id', 'source_session_id', 'candidate_name', 'tester_name', 'Brand', 'Model',
    'Status', 'Note', 'created_at', 'updated_at', 'decision_at', 'decision_by', 'denial_reason',
  ], [[
    'review-1', 'session-1', 'Candidate Example', 'Tester Example', 'USB', 'MODEL',
    'pending', '', 'created', 'updated', '', '', '',
  ]]);
  const workbook = createFakeWorkbook([candidateSheet, reviewSheet]);
  const { api } = createRuntime({ __workbook: workbook });
  const result = responsePayload(api.doPost(postEvent('updateCandidateTracking', 'sam-current', {
    operation: 'delete_candidate_history', targets: [{ session_id: 'session-1' }],
  })));
  assert.equal(result.ok, false);
  assert.match(result.error, /linked headset review/i);
  assert.equal(candidateSheet.values.length, 2);
  assert.equal(reviewSheet.values.length, 2);
});

test('pending headset edit updates the exact review and approval uses corrected authoritative values', () => {
  const headers = [
    'review_id', 'source_session_id', 'candidate_name', 'tester_name', 'Brand', 'Model',
    'Status', 'Note', 'created_at', 'updated_at', 'decision_at', 'decision_by', 'denial_reason',
  ];
  const reviewSheet = createFakeSheet('headset-review-log', headers, [[
    'review-1', 'session-1', 'Candidate Example', 'Tester Example', 'SYNTHETIC USB', 'MIGRATION HEDSET',
    'pending', '', 'created', 'created', '', '', '',
  ]]);
  const headsetsSheet = createFakeSheet('headsets', ['Brand', 'Model', 'Status', 'Note']);
  const candidateSheet = createFakeSheet('Candidate Sessions', ['session_id', 'candidate_name', 'headset_brand'], [
    ['session-1', 'Candidate Example', 'SYNTHETIC USB MIGRATION HEDSET'],
  ]);
  const workbook = createFakeWorkbook([reviewSheet, headsetsSheet, candidateSheet]);
  const { api } = createRuntime({ __workbook: workbook });

  const edited = responsePayload(api.doPost(postEvent('editHeadsetReview', 'sam-current', {
    review_id: 'review-1', brand: 'SYNTHETIC USB', model: '  MIGRATION   HEADSET ', actor: 'SAM Admin',
  })));
  assert.equal(edited.ok, true);
  assert.equal(edited.result.status, 'pending');
  assert.equal(reviewSheet.values[1][5], 'MIGRATION HEADSET');
  assert.equal(candidateSheet.values[1][2], 'SYNTHETIC USB MIGRATION HEADSET');

  const approved = responsePayload(api.doPost(postEvent('approveHeadset', 'sam-current', {
    review_id: 'review-1', brand: 'SYNTHETIC USB', model: 'MIGRATION HEDSET', actor: 'SAM Admin',
  })));
  assert.equal(approved.ok, true);
  assert.deepEqual(headsetsSheet.values[1].slice(0, 3), ['SYNTHETIC USB', 'MIGRATION HEADSET', 'approved']);
  assert.equal(headsetsSheet.values.length, 2);
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

test('Newbie Shift approval stores optional number as text on exact request and session', () => {
  const candidateSheet = createFakeSheet('Candidate Sessions', ['session_id', 'candidate_name', 'status'], [
    ['session-1', 'Candidate Example', 'INCOMPLETE'],
  ]);
  const workbook = createFakeWorkbook([candidateSheet]);
  const { api } = createRuntime({ __workbook: workbook });
  const submitted = responsePayload(api.doPost(postEvent('upsertPendingRequest', 'mts-current', {
    request: {
      request_id: 'newbie-1', request_type: 'initial_newbie_shift', source_session_id: 'session-1',
      candidate_name: 'Candidate Example', scheduled_at: '2026-08-01T10:00:00-04:00', status: 'pending',
    },
  })));
  assert.equal(submitted.ok, true);

  const decided = responsePayload(api.doPost(postEvent('decidePendingRequest', 'sam-current', {
    request_id: 'newbie-1', request_type: 'initial_newbie_shift', decision: 'approve',
    expected_status: 'pending', decision_by: 'SAM Admin', newbie_shift_number: '001842',
  })));
  assert.equal(decided.ok, true);
  const requestSheet = workbook.getSheetByName('newbie-shift-requests');
  const requestHeaders = requestSheet.values[0];
  assert.equal(requestSheet.values[1][requestHeaders.indexOf('newbie_shift_number')], '001842');
  const candidateHeaders = candidateSheet.values[0];
  assert.equal(candidateSheet.values[1][candidateHeaders.indexOf('newbie_shift_number')], '001842');
});

test('candidate overrides are audited and extra-attempt count is idempotent by expected count', () => {
  const candidateSheet = createFakeSheet('Candidate Sessions', [
    'session_id', 'candidate_name', 'status', 'calculated_result', 'final_result',
    'extra_attempt_granted', 'extra_attempt_reason', 'readiness_override_applied',
    'readiness_override_result', 'readiness_override_reason', 'readiness_override_explanation',
  ], [['session-1', 'Candidate Example', 'FAIL', 'Pass', 'FAIL', '', '', '', '', '', '']]);
  const workbook = createFakeWorkbook([candidateSheet]);
  const { api } = createRuntime({ __workbook: workbook });

  const marked = responsePayload(api.doPost(postEvent('updateCandidateTracking', 'sam-current', {
    operation: 'mark_passed', session_id: 'session-1', candidate_name: 'Candidate Example',
    actor: 'SAM Admin', reason: 'Authorized review completed.',
  })));
  assert.equal(marked.ok, true);
  let headers = candidateSheet.values[0];
  assert.equal(candidateSheet.values[1][headers.indexOf('calculated_result')], 'Pass');
  assert.equal(candidateSheet.values[1][headers.indexOf('readiness_override_result')], 'PASS');
  assert.equal(candidateSheet.values[1][headers.indexOf('readiness_override_by')], 'SAM Admin');
  assert.ok(candidateSheet.values[1][headers.indexOf('readiness_override_at')]);

  const granted = responsePayload(api.doPost(postEvent('updateCandidateTracking', 'sam-current', {
    operation: 'grant_extra_attempt', session_id: 'session-1', candidate_name: 'Candidate Example',
    actor: 'SAM Admin', expected_extra_attempts_granted: 0,
  })));
  assert.equal(granted.ok, true);
  headers = candidateSheet.values[0];
  assert.equal(Number(candidateSheet.values[1][headers.indexOf('extra_attempts_granted')]), 1);
  assert.equal(Number(candidateSheet.values[1][headers.indexOf('allowed_attempt_count')]), 4);

  const duplicate = responsePayload(api.doPost(postEvent('updateCandidateTracking', 'sam-current', {
    operation: 'grant_extra_attempt', session_id: 'session-1', candidate_name: 'Candidate Example',
    actor: 'SAM Admin', expected_extra_attempts_granted: 0,
  })));
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.result.already_applied, true);
  assert.equal(Number(candidateSheet.values[1][headers.indexOf('extra_attempts_granted')]), 1);
});

test('candidate information correction is bounded, MTS-submittable, and SAM-decidable by stable session id', () => {
  const candidateHeaders = ['session_id', 'candidate_name', 'headset_brand', 'status', 'archived'];
  const candidateSheet = createFakeSheet('Candidate Sessions', candidateHeaders, [
    ['session-1', 'Taylr Example', 'Jabra Evolve 40', 'PASS', 'FALSE'],
  ]);
  const pendingSheet = createFakeSheet('Pending Sup Transfers', ['pending_id', 'candidate_name', 'original_session_id', 'status'], [
    ['pending-1', 'Taylr Example', 'session-1', 'pending'],
  ]);
  const workbook = createFakeWorkbook([candidateSheet, pendingSheet]);
  const { api } = createRuntime({ __workbook: workbook });
  const changes = [{ field: 'candidate_name', label: 'Candidate Name', previous_value: 'Taylr Example', requested_value: 'Taylor Example' }];

  const submitted = responsePayload(api.doPost(postEvent('upsertPendingRequest', 'mts-current', {
    request: {
      request_id: 'correction-1', request_type: 'candidate_information_correction', source_session_id: 'session-1',
      candidate_id: 'session-1', candidate_name: 'Taylr Example', tester_name: 'Tester Example',
      reason: 'Candidate name was entered incorrectly.', changes_json: JSON.stringify(changes), status: 'pending',
    },
  })));
  assert.equal(submitted.ok, true);
  assert.equal(workbook.getSheetByName('candidate-information-correction-requests').values[1][9], 'pending');

  const decided = responsePayload(api.doPost(postEvent('decidePendingRequest', 'sam-current', {
    request_id: 'correction-1', request_type: 'candidate_information_correction', decision: 'approve',
    expected_status: 'pending', decision_by: 'SAM Admin',
  })));
  assert.equal(decided.ok, true);
  assert.equal(decided.result.status, 'approved');
  assert.equal(candidateSheet.values[1][1], 'Taylor Example');
  assert.equal(pendingSheet.values[1][1], 'Taylor Example');
  assert.equal(workbook.getSheetByName('candidate-information-correction-requests').values[1][9], 'approved');
});

test('headset typo correction remains a correction and never creates a headset review', () => {
  const candidateSheet = createFakeSheet('Candidate Sessions', ['session_id', 'candidate_name', 'headset_brand', 'status', 'archived'], [
    ['session-1', 'Taylor Example', 'Logitec Zone 300', 'PASS', 'FALSE'],
  ]);
  const workbook = createFakeWorkbook([candidateSheet]);
  const { api } = createRuntime({ __workbook: workbook });
  const changes = [{ field: 'headset_model', previous_value: 'Logitec Zone 300', requested_value: 'Logitech Zone 300' }];

  responsePayload(api.doPost(postEvent('upsertPendingRequest', 'mts-current', {
    request: {
      request_id: 'correction-headset-1', request_type: 'candidate_information_correction', source_session_id: 'session-1',
      candidate_name: 'Taylor Example', tester_name: 'Tester Example', reason: 'Correct the headset spelling.',
      changes_json: JSON.stringify(changes), status: 'pending',
    },
  })));
  const decided = responsePayload(api.doPost(postEvent('decidePendingRequest', 'sam-current', {
    request_id: 'correction-headset-1', request_type: 'candidate_information_correction', decision: 'approve',
    expected_status: 'pending', decision_by: 'SAM Admin',
  })));

  assert.equal(decided.ok, true);
  assert.equal(candidateSheet.values[1][2], 'Logitech Zone 300');
  assert.equal(workbook.getSheetByName('headset-review-log'), null);
  assert.equal(Object.hasOwn(decided.result, 'headset_review_required'), false);
});

test('headset correction updates the existing linked pending review instead of creating another identity', () => {
  const candidateSheet = createFakeSheet('Candidate Sessions', ['session_id', 'candidate_name', 'headset_brand'], [
    ['session-1', 'Taylor Example', 'SYNTHETIC USB MIGRATION HEDSET'],
  ]);
  const reviewHeaders = [
    'review_id', 'source_session_id', 'candidate_name', 'tester_name', 'Brand', 'Model',
    'Status', 'Note', 'created_at', 'updated_at', 'decision_at', 'decision_by', 'denial_reason',
  ];
  const reviewSheet = createFakeSheet('headset-review-log', reviewHeaders, [[
    'review-1', 'session-1', 'Taylor Example', 'Tester Example', 'SYNTHETIC USB', 'MIGRATION HEDSET',
    'pending', '', 'created', 'created', '', '', '',
  ]]);
  const workbook = createFakeWorkbook([candidateSheet, reviewSheet]);
  const { api } = createRuntime({ __workbook: workbook });
  const response = responsePayload(api.doPost(postEvent('updateCandidateTracking', 'sam-current', {
    operation: 'edit_candidate_information', session_id: 'session-1', reason: 'Correct the model spelling.', actor: 'SAM Admin',
    changes: [{ field: 'headset_model', previous_value: 'MIGRATION HEDSET', requested_value: 'MIGRATION HEADSET' }],
  })));
  assert.equal(response.ok, true);
  assert.equal(candidateSheet.values[1][2], 'SYNTHETIC USB MIGRATION HEADSET');
  assert.equal(reviewSheet.values[1][5], 'MIGRATION HEADSET');
  assert.equal(reviewSheet.values[1][6], 'pending');
  assert.equal(reviewSheet.values.length, 2);
});

test('SAM direct candidate edit requires an audit reason before applying changes', () => {
  const candidateSheet = createFakeSheet('Candidate Sessions', ['session_id', 'candidate_name', 'headset_brand'], [
    ['session-1', 'Taylr Example', 'Jabra Evolve 40'],
  ]);
  const workbook = createFakeWorkbook([candidateSheet]);
  const { api } = createRuntime({ __workbook: workbook });
  const response = responsePayload(api.doPost(postEvent('updateCandidateTracking', 'sam-current', {
    operation: 'edit_candidate_information', session_id: 'session-1', candidate_name: 'Taylr Example', reason: '',
    changes: [{ field: 'candidate_name', previous_value: 'Taylr Example', requested_value: 'Taylor Example' }],
  })));

  assert.equal(response.ok, false);
  assert.equal(candidateSheet.values[1][1], 'Taylr Example');
  assert.equal(workbook.getSheetByName('candidate-information-correction-requests'), null);
});

test('first SAM direct candidate edit safely creates its audit contract before updating the exact session', () => {
  const candidateSheet = createFakeSheet('Candidate Sessions', ['session_id', 'candidate_id', 'candidate_name', 'headset_brand', 'status', 'attempt_number'], [
    ['session-1', 'candidate-1', 'Taylr Example', 'Jabra Evolve 40', 'PASS', 2],
    ['session-2', 'candidate-2', 'Taylr Example', 'Jabra Evolve 40', 'FAIL', 1],
  ]);
  const workbook = createFakeWorkbook([candidateSheet]);
  const { api } = createRuntime({ __workbook: workbook });
  const response = responsePayload(api.doPost(postEvent('updateCandidateTracking', 'sam-current', {
    operation: 'edit_candidate_information', session_id: 'session-1', candidate_id: 'candidate-1',
    candidate_name: 'Taylr Example', reason: 'Correct the candidate name spelling.', actor: 'SAM Admin',
    changes: [{ field_key: 'candidate_name', previous_value: 'Taylr Example', requested_value: 'Taylor Example' }],
  })));

  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result.updated, true);
  assert.equal(candidateSheet.values[1][2], 'Taylor Example');
  assert.equal(candidateSheet.values[1][4], 'PASS');
  assert.equal(candidateSheet.values[1][5], 2);
  assert.equal(candidateSheet.values[2][2], 'Taylr Example');
  const auditSheet = workbook.getSheetByName('candidate-information-correction-requests');
  assert.ok(auditSheet);
  assert.equal(auditSheet.values[1][1], 'candidate_information_admin_edit');
  assert.equal(auditSheet.values[1][2], 'session-1');
  assert.equal(auditSheet.values[1][6], 'Correct the candidate name spelling.');
  assert.equal(auditSheet.values[1][9], 'approved');
});

test('legacy Newbie Shift request tabs gain and return the missing previous schedule column', () => {
  const legacyHeaders = [
    'request_id', 'session_id', 'candidate_name', 'candidate_first_name', 'candidate_last_initial',
    'tester_name', 'request_type', 'request_status', 'requested_by', 'request_reason',
    'request_details', 'request_created_at', 'rescheduled_at', 'scheduled_at', 'timezone',
    'within_24_hours', 'counts_as_attempt', 'final_attempt', 'admin_decision_at',
    'admin_decision_by', 'denial_reason', 'updated_at',
  ];
  const sheet = createFakeSheet('newbie-shift-requests', legacyHeaders);
  const workbook = createFakeWorkbook([sheet]);
  const { api } = createRuntime({ __workbook: workbook });

  const written = responsePayload(api.doPost(postEvent('upsertPendingRequest', 'mts-current', {
    request: {
      request_id: 'reschedule-test',
      request_type: 'newbie_shift_reschedule',
      source_session_id: 'session-test',
      candidate: 'Candidate Example',
      tester: 'Tester Example',
      original_scheduled_at: '2026-07-20T10:00:00-05:00',
      requested_scheduled_at: '2026-07-22T11:30:00-05:00',
      timezone: 'EST (Eastern)',
    },
  })));

  assert.equal(written.ok, true);
  const originalColumn = sheet.values[0].indexOf('original_scheduled_at');
  assert.notEqual(originalColumn, -1);
  assert.equal(sheet.values[1][originalColumn], '2026-07-20T10:00:00-05:00');

  const listed = responsePayload(api.doGet(getEvent('getPendingRequests', 'sam-current')));
  assert.equal(listed.ok, true);
  assert.equal(listed.result.requests[0].original_scheduled_at, '2026-07-20T10:00:00-05:00');
  assert.equal(listed.result.requests[0].requested_scheduled_at, '2026-07-22T11:30:00-05:00');
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



test('explicit decision for live USB pair remains distinct and does not merge', () => {
  const headers = [
    'review_id', 'source_session_id', 'candidate_name', 'tester_name', 'Brand', 'Model',
    'Status', 'Note', 'created_at', 'updated_at', 'decision_at', 'decision_by', 'denial_reason',
  ];
  const reviewSheet = createFakeSheet('headset-review-log', headers, [[
    'review-1', 'session-1', 'Candidate Example', 'Tester Example', 'USB', 'TEST HEADSET',
    'pending', '', 'created', 'updated', '', '', '',
  ], [
    'review-2', 'session-2', 'Candidate Example 2', 'Tester Example 2', 'USB', 'TESTER HEADSET',
    'pending', '', 'created', 'updated', '', '', '',
  ]]);
  const headsetsSheet = createFakeSheet('headsets', ['Brand', 'Model', 'Status', 'Note']);
  const workbook = createFakeWorkbook([reviewSheet, headsetsSheet]);
  const { api } = createRuntime({ __workbook: workbook });

  const approved = responsePayload(api.doPost(postEvent('approveHeadset', 'sam-current', {
    review_id: 'review-1', brand: 'USB', model: 'TEST HEADSET', actor: 'SAM Admin',
  })));
  assert.equal(approved.ok, true);

  const denied = responsePayload(api.doPost(postEvent('denyHeadset', 'sam-current', {
    review_id: 'review-2', brand: 'USB', model: 'TESTER HEADSET', note: 'Headset does not connect via USB', actor: 'SAM Admin',
  })));
  assert.equal(denied.ok, true);

  assert.equal(headsetsSheet.values.length, 3);
  assert.deepEqual(headsetsSheet.values[1].slice(0, 4), ['USB', 'TEST HEADSET', 'approved', '']);
  assert.deepEqual(headsetsSheet.values[2].slice(0, 4), ['USB', 'TESTER HEADSET', 'denied', 'Headset does not connect via USB']);
});

test('approval and denial use current authoritative row and stale requests are ignored', () => {
  const headers = [
    'review_id', 'source_session_id', 'candidate_name', 'tester_name', 'Brand', 'Model',
    'Status', 'Note', 'created_at', 'updated_at', 'decision_at', 'decision_by', 'denial_reason',
  ];
  const reviewSheet = createFakeSheet('headset-review-log', headers, [[
    'review-1', 'session-1', 'Candidate Example', 'Tester Example', 'USB', 'NEW MODEL',
    'pending', 'New note', 'created', 'updated', '', '', '',
  ]]);
  const headsetsSheet = createFakeSheet('headsets', ['Brand', 'Model', 'Status', 'Note']);
  const workbook = createFakeWorkbook([reviewSheet, headsetsSheet]);
  const { api } = createRuntime({ __workbook: workbook });

  const approved = responsePayload(api.doPost(postEvent('approveHeadset', 'sam-current', {
    review_id: 'review-1', brand: 'USB', model: 'OLD MODEL', actor: 'SAM Admin',
  })));
  assert.equal(approved.ok, true);
  assert.deepEqual(headsetsSheet.values[1].slice(0, 4), ['USB', 'NEW MODEL', 'approved', '']);
});

test('denial uses current authoritative row and preserves note', () => {
  const headers = [
    'review_id', 'source_session_id', 'candidate_name', 'tester_name', 'Brand', 'Model',
    'Status', 'Note', 'created_at', 'updated_at', 'decision_at', 'decision_by', 'denial_reason',
  ];
  const reviewSheet = createFakeSheet('headset-review-log', headers, [[
    'review-1', 'session-1', 'Candidate Example', 'Tester Example', 'USB', 'NEW MODEL',
    'pending', 'New note', 'created', 'updated', '', '', '',
  ]]);
  const headsetsSheet = createFakeSheet('headsets', ['Brand', 'Model', 'Status', 'Note']);
  const workbook = createFakeWorkbook([reviewSheet, headsetsSheet]);
  const { api } = createRuntime({ __workbook: workbook });

  const denied = responsePayload(api.doPost(postEvent('denyHeadset', 'sam-current', {
    review_id: 'review-1', brand: 'USB', model: 'OLD MODEL', note: 'Stale note', actor: 'SAM Admin',
  })));
  assert.equal(denied.ok, true);
  assert.deepEqual(headsetsSheet.values[1].slice(0, 4), ['USB', 'NEW MODEL', 'denied', 'Stale note']);
});
