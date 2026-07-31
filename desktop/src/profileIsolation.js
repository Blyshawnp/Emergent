const fs = require('fs');
const path = require('path');

const TEST_USER_DATA_ENV = 'MTS_SAM_TEST_USER_DATA_DIR';
const ROLE_DIRECTORY_NAMES = Object.freeze({
  mts: 'MTS',
  sam: 'SAM',
});

function resolveTestUserDataProfile({ env = process.env, role, fsImpl = fs, pathImpl = path } = {}) {
  if (!Object.prototype.hasOwnProperty.call(env, TEST_USER_DATA_ENV)) {
    return { active: false, rootPath: '', userDataPath: '' };
  }

  const rawValue = env[TEST_USER_DATA_ENV];
  const configuredRoot = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!configuredRoot) {
    throw new Error(`${TEST_USER_DATA_ENV} must be a non-empty absolute directory.`);
  }
  if (/[\x00-\x1f]/.test(configuredRoot)) {
    throw new Error(`${TEST_USER_DATA_ENV} contains invalid control characters.`);
  }
  if (!pathImpl.isAbsolute(configuredRoot)) {
    throw new Error(`${TEST_USER_DATA_ENV} must be an absolute directory.`);
  }

  const rootPath = pathImpl.resolve(configuredRoot);
  const parsedRoot = pathImpl.parse(rootPath).root;
  if (!rootPath || rootPath === parsedRoot) {
    throw new Error(`${TEST_USER_DATA_ENV} cannot target a filesystem root.`);
  }

  const roleDirectory = ROLE_DIRECTORY_NAMES[role];
  if (!roleDirectory) {
    throw new Error('Test-profile isolation requires an explicit MTS or SAM role.');
  }

  const userDataPath = pathImpl.join(rootPath, roleDirectory);
  fsImpl.mkdirSync(userDataPath, { recursive: true });
  if (!fsImpl.statSync(userDataPath).isDirectory()) {
    throw new Error(`${TEST_USER_DATA_ENV} did not resolve to a usable directory.`);
  }

  return { active: true, rootPath, userDataPath };
}

function applyUserDataProfile({ app, env = process.env, role, productionDirectoryName } = {}) {
  const testProfile = resolveTestUserDataProfile({ env, role });
  const userDataPath = testProfile.active
    ? testProfile.userDataPath
    : path.join(app.getPath('appData'), productionDirectoryName);

  if (!testProfile.active) {
    fs.mkdirSync(userDataPath, { recursive: true });
  }
  app.setPath('userData', userDataPath);
  return { ...testProfile, userDataPath };
}

function buildBackendStorageEnvironment({ env = process.env, userDataPath } = {}) {
  if (!userDataPath || !path.isAbsolute(userDataPath)) {
    throw new Error('Backend storage requires an absolute Electron user-data path.');
  }
  return {
    ...env,
    SQLITE_DB_PATH: path.join(userDataPath, 'mock_testing_suite.sqlite3'),
    APP_DATA_DIR: userDataPath,
    BACKEND_LOG_DIR: path.join(userDataPath, 'logs'),
  };
}

module.exports = {
  TEST_USER_DATA_ENV,
  ROLE_DIRECTORY_NAMES,
  resolveTestUserDataProfile,
  applyUserDataProfile,
  buildBackendStorageEnvironment,
};
