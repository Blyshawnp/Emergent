const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  TEST_USER_DATA_ENV,
  applyUserDataProfile,
  buildBackendStorageEnvironment,
  resolveTestUserDataProfile,
} = require('../src/profileIsolation');

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mts-sam-profile-test-'));
}

test('absent override preserves the production role directory', () => {
  const calls = [];
  const root = temporaryRoot();
  const app = {
    getPath: (name) => name === 'appData' ? root : '',
    setPath: (name, value) => calls.push([name, value]),
  };
  const result = applyUserDataProfile({ app, env: {}, role: 'mts', productionDirectoryName: 'Mock Testing Suite' });
  assert.equal(result.active, false);
  assert.equal(result.userDataPath, path.join(root, 'Mock Testing Suite'));
  assert.deepEqual(calls, [['userData', path.join(root, 'Mock Testing Suite')]]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('absolute override creates distinct MTS and SAM role profiles', () => {
  const root = temporaryRoot();
  const env = { [TEST_USER_DATA_ENV]: root };
  const mts = resolveTestUserDataProfile({ env, role: 'mts' });
  const sam = resolveTestUserDataProfile({ env, role: 'sam' });
  assert.equal(mts.userDataPath, path.join(root, 'MTS'));
  assert.equal(sam.userDataPath, path.join(root, 'SAM'));
  assert.notEqual(mts.userDataPath, sam.userDataPath);
  assert.equal(fs.statSync(mts.userDataPath).isDirectory(), true);
  assert.equal(fs.statSync(sam.userDataPath).isDirectory(), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('blank, relative, control-character, and filesystem-root overrides fail closed', () => {
  for (const invalid of ['', 'relative-profile', `bad\nprofile`, path.parse(path.resolve('.')).root]) {
    assert.throws(
      () => resolveTestUserDataProfile({ env: { [TEST_USER_DATA_ENV]: invalid }, role: 'mts' }),
      /must be|invalid|cannot target/,
    );
  }
});

test('backend storage environment uses only the selected isolated profile', () => {
  const root = temporaryRoot();
  const userDataPath = path.join(root, 'MTS');
  const env = buildBackendStorageEnvironment({ env: { SQLITE_IMPORT_PATH: path.join(root, 'seed.json') }, userDataPath });
  assert.equal(env.APP_DATA_DIR, userDataPath);
  assert.equal(env.SQLITE_DB_PATH, path.join(userDataPath, 'mock_testing_suite.sqlite3'));
  assert.equal(env.BACKEND_LOG_DIR, path.join(userDataPath, 'logs'));
  assert.equal(env.SQLITE_IMPORT_PATH, path.join(root, 'seed.json'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('main applies profile selection before Electron Store and single-instance locking', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const applyIndex = source.indexOf('userDataProfile = applyUserDataProfile(');
  assert.ok(applyIndex >= 0);
  assert.ok(applyIndex < source.indexOf('new Store('));
  assert.ok(applyIndex < source.indexOf('app.requestSingleInstanceLock('));
  assert.match(source, /buildBackendStorageEnvironment\(/);
  assert.match(source, /getSharedAppDataPath[\s\S]*app\.getPath\('userData'\)/);
});
