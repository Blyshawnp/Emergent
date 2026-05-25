/**
 * Mock Testing Suite — Electron Main Process
 * Manages the application window, system tray, backend server, and auto-updates.
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');
const http = require('http');
const { pathToFileURL } = require('url');
const Store = require('electron-store');
let desktopPackage = {};

try {
  desktopPackage = require('../package.json');
} catch (err) {
  console.warn('[APP] Could not load desktop package metadata:', err.message);
}

const APP_ID = 'com.acddirect.mocktestingsuite';
const NOTIFICATION_MANAGER_APP_ID = 'com.acddirect.mocktestingsuite.notificationmanager';
const isDev = !app.isPackaged;
const isNotificationManagerMode = process.env.MTS_NOTIFICATION_MANAGER === '1';
const BACKEND_PORT = isNotificationManagerMode ? 8601 : 8600;
const DEFAULT_APP_VERSION = '1.0.1';
const APP_DISPLAY_NAME = isNotificationManagerMode ? 'Sam' : 'Mock Testing Suite';
const APP_RUNTIME_ID = isNotificationManagerMode ? NOTIFICATION_MANAGER_APP_ID : APP_ID;
const APP_STORAGE_DIR_NAME = isNotificationManagerMode ? 'Sam' : 'Mock Testing Suite';
const BACKEND_STARTUP_RETRY_DELAY_MS = 500;
const BACKEND_STARTUP_RETRIES = isDev ? 40 : 120;
const BACKEND_READY_REQUEST_TIMEOUT_MS = 1500;
const SAM_NOTIFICATION_BACKEND_RETRY_LIMIT = 6;
const SAM_NOTIFICATION_BACKEND_RETRY_BASE_DELAY_MS = 2000;
const SAM_NOTIFICATION_BACKEND_RETRY_MAX_DELAY_MS = 12000;
const ADMIN_TOKEN_HEADER = 'X-MTS-Admin-Token';

app.setName(APP_DISPLAY_NAME);
app.setPath('userData', path.join(app.getPath('appData'), APP_STORAGE_DIR_NAME));

const store = new Store({
  name: isNotificationManagerMode ? 'sam-config' : 'mock-testing-suite-config',
});

let mainWindow = null;
let tray = null;
let backendProcess = null;
let backendLaunchError = null;
let backendLogTail = [];
let backendCommandLabel = '';
let usingExternalBackend = false;
let isHandlingCloseConfirmation = false;
let allowWindowClose = false;
let hasUnsavedChanges = false;
let hasRegisteredProcessCleanupHandlers = false;
let quitConfirmationResolver = null;
let sharedAdminToken = '';
let heartbeatTimer = null;
let backendStartedByThisApp = false;
let backendConnectionStatus = 'initializing';
let backendReadyRetryCount = 0;
let backendLastError = '';
let backendRetryTimer = null;
let backendRetryAttemptCount = 0;

const STORE_PENDING_UPDATE_KEY = 'updater.pendingUpdate';
const STORE_LAST_INSTALLED_UPDATE_KEY = 'updater.lastInstalledUpdate';
const STORE_LAST_ACKNOWLEDGED_VERSION_KEY = 'updater.lastAcknowledgedInstalledVersion';
const HEARTBEAT_STALE_MS = 8000;

function isVersionString(value) {
  return /^\d+(?:\.\d+)*$/.test(String(value || '').trim());
}

function resolveAppVersion() {
  const packageVersion = String(desktopPackage.version || '').trim();
  if (isVersionString(packageVersion)) {
    return packageVersion;
  }

  const electronVersion = String(app.getVersion?.() || '').trim();
  if (isVersionString(electronVersion)) {
    return electronVersion;
  }

  return DEFAULT_APP_VERSION;
}

const APP_VERSION = resolveAppVersion();

// ═══════════════════════════════════════════════════════════════
// PATHS
// ═══════════════════════════════════════════════════════════════
function getDesktopPath(subpath = '') {
  if (isDev) {
    return path.join(path.resolve(__dirname, '..'), subpath);
  }
  return path.join(process.resourcesPath, subpath);
}

function getBackendPath(subpath = '') {
  if (isDev) {
    return path.join(path.resolve(__dirname, '..', '..', 'backend'), subpath);
  }
  return path.join(process.resourcesPath, 'backend', subpath);
}

function getSqliteDbPath() {
  return path.join(app.getPath('userData'), 'mock_testing_suite.sqlite3');
}

function getSharedAppDataPath(subpath = '') {
  return path.join(app.getPath('appData'), APP_STORAGE_DIR_NAME, subpath);
}

function getSharedAdminToken() {
  if (sharedAdminToken) {
    return sharedAdminToken;
  }

  const tokenPath = getSharedAppDataPath('admin-token');
  try {
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    if (fs.existsSync(tokenPath)) {
      sharedAdminToken = fs.readFileSync(tokenPath, 'utf8').trim();
    }
    if (!sharedAdminToken) {
      sharedAdminToken = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(tokenPath, sharedAdminToken, { encoding: 'utf8', flag: 'w' });
    }
  } catch (err) {
    console.warn('[APP] Failed to read/write shared admin token; using session token only:', err.message);
    sharedAdminToken = crypto.randomBytes(32).toString('hex');
  }
  return sharedAdminToken;
}

function getAppModeName() {
  return isNotificationManagerMode ? 'notification-manager' : 'main';
}

function getHeartbeatPath(mode = getAppModeName()) {
  return getSharedAppDataPath(`${mode}.heartbeat.json`);
}

function getBackendOwnerPath() {
  return getSharedAppDataPath('backend-owner.json');
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data), { encoding: 'utf8', flag: 'w' });
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function writeHeartbeat() {
  try {
    writeJsonFile(getHeartbeatPath(), {
      pid: process.pid,
      mode: getAppModeName(),
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.warn('[APP] Failed to write app heartbeat:', err.message);
  }
}

function startHeartbeat() {
  writeHeartbeat();
  heartbeatTimer = setInterval(writeHeartbeat, 2000);
  heartbeatTimer.unref?.();
}

function clearHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  try {
    fs.rmSync(getHeartbeatPath(), { force: true });
  } catch (_err) {}
}

function isOtherAppActive() {
  const otherMode = isNotificationManagerMode ? 'main' : 'notification-manager';
  const heartbeat = readJsonFile(getHeartbeatPath(otherMode));
  return Boolean(
    heartbeat
    && heartbeat.pid
    && heartbeat.pid !== process.pid
    && Number.isFinite(Number(heartbeat.updatedAt))
    && (Date.now() - Number(heartbeat.updatedAt)) < HEARTBEAT_STALE_MS
  );
}

function writeBackendOwner(pid) {
  try {
    writeJsonFile(getBackendOwnerPath(), {
      pid,
      ownerPid: process.pid,
      ownerMode: getAppModeName(),
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.warn('[BACKEND] Failed to write backend owner file:', err.message);
  }
}

function clearBackendOwnerForPid(pid) {
  const owner = readJsonFile(getBackendOwnerPath());
  if (!owner || String(owner.pid) !== String(pid)) {
    return;
  }
  try {
    fs.rmSync(getBackendOwnerPath(), { force: true });
  } catch (_err) {}
}

function getFrontendPath(subpath = '') {
  if (isDev) {
    return path.join(path.resolve(__dirname, '..', '..', 'frontend', 'build'), subpath);
  }
  return path.join(process.resourcesPath, 'frontend', subpath);
}

function getAssetPath(filename) {
  return path.join(getDesktopPath('assets'), filename);
}

function getAppIconPath() {
  return getAssetPath(isNotificationManagerMode ? 'notification-taskbar.ico' : 'mts-micro.ico');
}

function getTrayIconPath() {
  return getAssetPath(isNotificationManagerMode ? 'notification-tray.ico' : 'mts-tray.ico');
}

function getNotificationTrayPngPath() {
  const scaleFactor = Math.max(1, screen.getPrimaryDisplay?.().scaleFactor || 1);
  const targetSize = Math.round(16 * scaleFactor);
  const traySize = targetSize <= 16 ? 16 : targetSize <= 20 ? 20 : targetSize <= 24 ? 24 : 32;
  return getAssetPath(`notification-tray-${traySize}.png`);
}

function createTrayIcon() {
  if (!isNotificationManagerMode || process.platform !== 'win32') {
    const iconPath = getTrayIconPath();
    const icon = nativeImage.createFromPath(iconPath);
    return icon.isEmpty() ? iconPath : icon;
  }

  const pngPath = getNotificationTrayPngPath();
  let icon = nativeImage.createFromPath(pngPath);
  if (icon.isEmpty()) {
    icon = nativeImage.createFromPath(getTrayIconPath());
  }
  if (!icon.isEmpty()) {
    icon.setTemplateImage(false);
    return icon;
  }
  return getTrayIconPath();
}

function isSafeExternalUrl(value, allowedProtocols = ['http:', 'https:', 'mailto:']) {
  try {
    const parsed = new URL(value);
    return allowedProtocols.includes(parsed.protocol);
  } catch (_err) {
    return false;
  }
}

function compareVersions(left, right) {
  const leftParts = String(left).split('.').map((part) => parseInt(part, 10) || 0);
  const rightParts = String(right).split('.').map((part) => parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] || 0;
    const rightValue = rightParts[index] || 0;

    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }

  return 0;
}

function appendBackendLog(line) {
  if (!line) return;
  backendLogTail.push(line);
  if (backendLogTail.length > 12) {
    backendLogTail = backendLogTail.slice(-12);
  }
}

function getBackendFailureMessage(reason) {
  const details = [];

  if (reason) {
    details.push(reason);
  }

  if (backendCommandLabel) {
    details.push(`Backend command: ${backendCommandLabel}`);
  }

  details.push(`Backend path: ${getBackendPath()}`);
  details.push(`SQLite database: ${getSqliteDbPath()}`);

  if (backendLogTail.length > 0) {
    details.push(`Recent backend output:\n${backendLogTail.join('\n')}`);
  }

  details.push(isDev
    ? 'Verify that Python 3.10+ is installed and available to the development app.'
    : 'Verify that the packaged backend.exe and browser driver files are present in resources.');

  return details.join('\n\n');
}

function requireRuntimePath(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} was not found at:\n${targetPath}`);
  }
}

function resolveWindowsCommand(name, { rejectWindowsApps = false } = {}) {
  const lookup = spawnSync('where.exe', [name], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (lookup.status !== 0) {
    return null;
  }

  const matches = lookup.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !rejectWindowsApps || !entry.toLowerCase().includes('\\windowsapps\\'));

  return matches[0] || null;
}

function resolvePythonLauncher() {
  if (process.platform === 'win32') {
    const pyLauncher = resolveWindowsCommand('py');
    if (pyLauncher) {
      return {
        command: pyLauncher,
        args: ['-3'],
        label: 'py -3',
      };
    }

    const pythonLauncher = resolveWindowsCommand('python', { rejectWindowsApps: true });
    if (pythonLauncher) {
      return {
        command: pythonLauncher,
        args: [],
        label: pythonLauncher,
      };
    }

    throw new Error('Python 3 was not found on PATH. Install Python 3.10+ and ensure the launcher is available to the app.');
  }

  return {
    command: 'python3',
    args: [],
    label: 'python3',
  };
}

function killChildProcessTree(child, label) {
  if (!child || !child.pid) {
    return;
  }

  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      child.kill('SIGTERM');
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (!/not found|no running instance|has terminated/i.test(message)) {
      console.warn(`[APP] Failed to stop ${label}: ${message}`);
    }
  }
}

function registerProcessCleanupHandlers() {
  if (hasRegisteredProcessCleanupHandlers) {
    return;
  }

  const cleanup = () => {
    app.isQuitting = true;
    clearHeartbeat();
    stopBackend();
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  hasRegisteredProcessCleanupHandlers = true;
}

function getBackendState() {
  return {
    mode: getAppModeName(),
    port: BACKEND_PORT,
    status: backendConnectionStatus,
    startedByNotificationApp: Boolean(isNotificationManagerMode && backendStartedByThisApp),
    startedByThisApp: Boolean(backendStartedByThisApp),
    usingExternalBackend: Boolean(usingExternalBackend),
    retryCount: backendReadyRetryCount,
    pid: backendProcess?.pid || 0,
    command: backendCommandLabel,
    lastError: backendLastError,
  };
}

function setBackendConnectionStatus(status, detail = '') {
  backendConnectionStatus = status;
  backendLastError = detail || '';
  sendAppEvent('backend:state', getBackendState());
}

// ═══════════════════════════════════════════════════════════════
// BACKEND SERVER
// ═══════════════════════════════════════════════════════════════
function startBackend() {
  if (backendProcess && backendProcess.exitCode === null) {
    return;
  }

  setBackendConnectionStatus('starting');

  if (!isDev) {
    const backendPath = path.join(process.resourcesPath, 'backend', 'backend.exe');
    const backendCwd = path.dirname(backendPath);
    const driverDir = path.join(process.resourcesPath, 'backend', 'drivers');
    const backendConfigDir = path.join(process.resourcesPath, 'backend', 'config');
    const backendRuntimeConfigPath = path.join(backendConfigDir, 'runtime_config.json');
    const backendDefaultsDir = path.join(process.resourcesPath, 'backend', 'defaults');
    const googleServiceAccountPath = path.join(backendConfigDir, 'google-service-account.json');
    requireRuntimePath(backendPath, 'Bundled backend executable');
    requireRuntimePath(driverDir, 'Bundled browser drivers directory');
    requireRuntimePath(backendRuntimeConfigPath, 'Bundled backend runtime config');
    requireRuntimePath(backendDefaultsDir, 'Bundled backend defaults directory');

    backendLaunchError = null;
    backendLogTail = [];
    backendCommandLabel = backendPath;

    console.log('[BACKEND] Launching packaged backend');
    console.log(`[BACKEND] backendPath: ${backendPath}`);
    console.log(`[BACKEND] cwd: ${backendCwd}`);
    console.log(`[BACKEND] runtimeConfig: ${backendRuntimeConfigPath}`);
    console.log(`[BACKEND] defaultsDir: ${backendDefaultsDir}`);
    console.log(`[BACKEND] googleServiceAccount: ${fs.existsSync(googleServiceAccountPath) ? googleServiceAccountPath : 'not bundled'}`);

    try {
      backendProcess = spawn(backendPath, [], {
        cwd: backendCwd,
        env: {
          ...process.env,
          BACKEND_PORT: String(BACKEND_PORT),
          SQLITE_DB_PATH: getSqliteDbPath(),
          BROWSER_DRIVER_DIR: driverDir,
          APP_VERSION,
          APP_RESOURCES_PATH: process.resourcesPath,
          GOOGLE_SERVICE_ACCOUNT_FILE: googleServiceAccountPath,
          MTS_ADMIN_TOKEN: getSharedAdminToken(),
        },
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      backendLaunchError = err;
      backendProcess = null;
      console.error('[BACKEND] spawn threw before process creation:', err);
      throw err;
    }

    if (!backendProcess || !backendProcess.pid) {
      backendLaunchError = new Error(`Spawn did not return a running process for ${backendPath}`);
      console.error('[BACKEND] Process was not created.');
      throw backendLaunchError;
    }

    console.log(`[BACKEND] Spawned backend.exe with pid ${backendProcess.pid}`);
    backendStartedByThisApp = true;
    writeBackendOwner(backendProcess.pid);

    backendProcess.stdout.on('data', (data) => appendBackendLog(data.toString().trim()));
    backendProcess.stderr.on('data', (data) => appendBackendLog(data.toString().trim()));
    backendProcess.on('error', (err) => {
      backendLaunchError = err;
      backendStartedByThisApp = false;
      setBackendConnectionStatus('error', err.message);
      backendProcess = null;
      console.error('[BACKEND] Failed to start:', err);
      if (!app.isQuitting) {
        dialog.showErrorBox('Startup Error', getBackendFailureMessage(`The backend executable could not be started.\n${err.message}`));
      }
    });
    backendProcess.on('exit', (code) => {
      backendProcess = null;
      console.log(`[BACKEND] backend.exe exited with code ${code}`);
      if (code !== 0 && code !== null) {
        backendLaunchError = new Error(`Backend executable exited with code ${code}.`);
        setBackendConnectionStatus('error', backendLaunchError.message);
      } else if (!app.isQuitting) {
        setBackendConnectionStatus('stopped');
      }
      if (!app.isQuitting && code !== 0 && code !== null && mainWindow) {
        dialog.showErrorBox('Backend Error', getBackendFailureMessage(`The backend executable stopped unexpectedly (exit code ${code}).`));
      }
    });
    return;
  }

  const backendDir = getBackendPath();
  requireRuntimePath(backendDir, 'Backend directory');
  requireRuntimePath(path.join(backendDir, 'server.py'), 'Backend entry file');

  const launcher = resolvePythonLauncher();
  const pythonCmd = launcher.command;
  const pythonArgs = launcher.args;

  backendLaunchError = null;
  backendLogTail = [];
  backendCommandLabel = `${launcher.label} -m uvicorn server:app --host 127.0.0.1 --port ${BACKEND_PORT}`;

  backendProcess = spawn(pythonCmd, [
    ...pythonArgs,
    '-m', 'uvicorn', 'server:app',
    '--host', '127.0.0.1',
    '--port', String(BACKEND_PORT),
    '--log-level', 'warning'
  ], {
    cwd: backendDir,
    env: {
      ...process.env,
      SQLITE_DB_PATH: getSqliteDbPath(),
      APP_VERSION,
      MTS_ADMIN_TOKEN: getSharedAdminToken(),
      PYTHONUNBUFFERED: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  backendStartedByThisApp = true;

  backendProcess.stdout.on('data', (data) => {
    const message = data.toString().trim();
    appendBackendLog(message);
    console.log(`[BACKEND] ${message}`);
  });

  backendProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    appendBackendLog(msg);
    if (msg && !msg.includes('INFO:')) console.error(`[BACKEND] ${msg}`);
  });

  backendProcess.on('error', (err) => {
    backendLaunchError = err;
    backendStartedByThisApp = false;
    setBackendConnectionStatus('error', err.message);
    backendProcess = null;
    console.error('[BACKEND] Failed to start:', err.message);
    if (!app.isQuitting) {
      dialog.showErrorBox(
        'Startup Error',
        getBackendFailureMessage(`The backend server process could not be started.\n${err.message}`)
      );
    }
  });

  backendProcess.on('exit', (code) => {
    backendProcess = null;
    console.log(`[BACKEND] Process exited with code ${code}`);
    if (code !== 0 && code !== null) {
      backendLaunchError = new Error(`Backend exited with code ${code}.`);
      setBackendConnectionStatus('error', backendLaunchError.message);
    } else if (!app.isQuitting) {
      setBackendConnectionStatus('stopped');
    }

    if (!app.isQuitting && code !== 0 && code !== null && mainWindow) {
      dialog.showErrorBox('Backend Error', getBackendFailureMessage(`The backend server stopped unexpectedly (exit code ${code}).`));
    }
  });
}

function stopBackend() {
  if (backendRetryTimer) {
    clearTimeout(backendRetryTimer);
    backendRetryTimer = null;
  }

  if (backendProcess) {
    if (isOtherAppActive()) {
      console.log('[BACKEND] Leaving backend running because the companion app is active.');
      backendProcess = null;
      return;
    }
    const pid = backendProcess.pid;
    killChildProcessTree(backendProcess, 'backend process');
    clearBackendOwnerForPid(pid);
    backendProcess = null;
    backendStartedByThisApp = false;
    setBackendConnectionStatus('stopped');
    return;
  }

  if (usingExternalBackend && !isOtherAppActive()) {
    const owner = readJsonFile(getBackendOwnerPath());
    const pid = Number(owner?.pid || 0);
    if (pid > 0) {
      killChildProcessTree({ pid }, 'shared backend process');
      clearBackendOwnerForPid(pid);
      setBackendConnectionStatus('stopped');
    }
  }
}

function probeBackend() {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port: BACKEND_PORT,
      path: '/api/runtime/verify-token',
      headers: { 'X-MTS-Admin-Token': getSharedAdminToken() },
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(BACKEND_READY_REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function waitForBackend(retries = BACKEND_STARTUP_RETRIES) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      backendReadyRetryCount = Math.max(0, retries - remaining);
      setBackendConnectionStatus(backendReadyRetryCount > 0 ? 'retrying' : 'starting');

      if (backendLaunchError) {
        setBackendConnectionStatus('error', backendLaunchError.message);
        return reject(new Error(getBackendFailureMessage(backendLaunchError.message)));
      }

      if (!backendProcess && !usingExternalBackend) {
        setBackendConnectionStatus('error', 'Backend process was not created.');
        return reject(new Error(getBackendFailureMessage('Backend process was not created.')));
      }

      if (backendProcess && backendProcess.exitCode !== null) {
        setBackendConnectionStatus('error', `Backend exited with code ${backendProcess.exitCode}.`);
        return reject(new Error(getBackendFailureMessage(`Backend exited with code ${backendProcess.exitCode}.`)));
      }

      if (remaining <= 0) {
        const timeoutSeconds = Math.round((BACKEND_STARTUP_RETRIES * BACKEND_STARTUP_RETRY_DELAY_MS) / 1000);
        setBackendConnectionStatus('timeout', `Backend did not respond within ${timeoutSeconds} seconds.`);
        return reject(new Error(getBackendFailureMessage(`Backend did not respond within ${timeoutSeconds} seconds.`)));
      }

      const req = http.get({
        hostname: '127.0.0.1',
        port: BACKEND_PORT,
        path: '/api/runtime/verify-token',
        headers: { 'X-MTS-Admin-Token': getSharedAdminToken() },
      }, (res) => {
        if (res.statusCode === 200) {
          backendReadyRetryCount = Math.max(0, retries - remaining);
          setBackendConnectionStatus('connected');
          resolve();
        } else {
          setTimeout(() => attempt(remaining - 1), BACKEND_STARTUP_RETRY_DELAY_MS);
        }
      });
      req.setTimeout(BACKEND_READY_REQUEST_TIMEOUT_MS, () => {
        req.destroy();
      });
      req.on('error', () => setTimeout(() => attempt(remaining - 1), BACKEND_STARTUP_RETRY_DELAY_MS));
      req.end();
    };
    attempt(retries);
  });
}

// ═══════════════════════════════════════════════════════════════
// WINDOW
// ═══════════════════════════════════════════════════════════════
function createMainWindow() {
  const iconPath = getAppIconPath();
  const appIcon = nativeImage.createFromPath(iconPath);

  mainWindow = new BrowserWindow({
    width: isNotificationManagerMode ? 1180 : 1280,
    height: isNotificationManagerMode ? 760 : 800,
    minWidth: isNotificationManagerMode ? 960 : 1024,
    minHeight: isNotificationManagerMode ? 640 : 700,
    icon: appIcon.isEmpty() ? iconPath : appIcon,
    title: `${APP_DISPLAY_NAME} v${APP_VERSION}`,
    show: false,
    backgroundColor: '#0f1117',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Load the frontend
  if (isDev) {
    const devUrl = isNotificationManagerMode
      ? 'http://localhost:3000/#/notification-manager'
      : 'http://localhost:3000';
    mainWindow.loadURL(devUrl);
  } else {
    const frontendPath = getFrontendPath('index.html');
    requireRuntimePath(frontendPath, 'Packaged frontend index');
    if (isNotificationManagerMode) {
      mainWindow.loadFile(frontendPath, { hash: '/notification-manager' });
    } else {
      mainWindow.loadFile(frontendPath);
    }
  }

  mainWindow.once('ready-to-show', () => {
    if (!appIcon.isEmpty()) {
      mainWindow.setIcon(appIcon);
    }
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    if (app.isQuitting || allowWindowClose) {
      return;
    }

    e.preventDefault();
    promptForQuitConfirmation();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url);
    } else {
      console.warn('[SECURITY] Blocked external URL:', url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) {
        shell.openExternal(url);
      } else {
        console.warn('[SECURITY] Blocked navigation URL:', url);
      }
    }
  });

  mainWindow.webContents.on('context-menu', (event, params) => {
    const editFlags = params.editFlags || {};
    const hasSelection = Boolean(String(params.selectionText || '').trim());
    const template = [];

    if (params.isEditable) {
      template.push(
        { role: 'undo', enabled: Boolean(editFlags.canUndo) },
        { role: 'redo', enabled: Boolean(editFlags.canRedo) },
        { type: 'separator' },
        { role: 'cut', enabled: Boolean(editFlags.canCut) },
        { role: 'copy', enabled: Boolean(editFlags.canCopy) },
        { role: 'paste', enabled: Boolean(editFlags.canPaste) },
        { type: 'separator' },
        { role: 'selectAll', enabled: Boolean(editFlags.canSelectAll) },
      );
    } else if (hasSelection) {
      template.push(
        { role: 'copy', enabled: Boolean(editFlags.canCopy) || hasSelection },
        { type: 'separator' },
        { role: 'selectAll', enabled: Boolean(editFlags.canSelectAll) },
      );
    }

    if (template.length === 0) {
      return;
    }

    event.preventDefault();
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });
}

async function ensureBackendAvailable() {
  setBackendConnectionStatus('checking');
  if (await probeBackend()) {
    usingExternalBackend = true;
    backendStartedByThisApp = false;
    backendReadyRetryCount = 0;
    backendRetryAttemptCount = 0;
    setBackendConnectionStatus('connected');
    console.log(`[APP] Reusing existing backend on port ${BACKEND_PORT}`);
    return;
  }

  usingExternalBackend = false;
  startBackend();
  await waitForBackend();
  backendRetryAttemptCount = 0;
  console.log('[APP] Backend is ready');
}

function clearNotificationBackendRetryTimer() {
  if (backendRetryTimer) {
    clearTimeout(backendRetryTimer);
    backendRetryTimer = null;
  }
}

function scheduleNotificationBackendRetry(detail = '') {
  if (!isNotificationManagerMode || app.isQuitting || backendRetryTimer) {
    return;
  }

  if (backendRetryAttemptCount >= SAM_NOTIFICATION_BACKEND_RETRY_LIMIT) {
    setBackendConnectionStatus('error', detail || 'SAM backend startup retries reached the limit.');
    return;
  }

  backendRetryAttemptCount += 1;
  const delay = Math.min(
    SAM_NOTIFICATION_BACKEND_RETRY_MAX_DELAY_MS,
    SAM_NOTIFICATION_BACKEND_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, backendRetryAttemptCount - 1)),
  );
  setBackendConnectionStatus(
    'retrying',
    detail
      ? `${detail} Retrying in ${Math.round(delay / 1000)} seconds.`
      : `SAM backend startup retry ${backendRetryAttemptCount}/${SAM_NOTIFICATION_BACKEND_RETRY_LIMIT}. Retrying in ${Math.round(delay / 1000)} seconds.`,
  );

  backendRetryTimer = setTimeout(async () => {
    backendRetryTimer = null;
    try {
      await ensureBackendAvailable();
      backendRetryAttemptCount = 0;
    } catch (err) {
      const message = err?.message || 'SAM backend startup failed.';
      console.warn('[BACKEND] Sam backend retry failed:', message);
      scheduleNotificationBackendRetry(message);
    }
  }, delay);
  backendRetryTimer.unref?.();
}

async function retryNotificationBackendStartup(options = {}) {
  if (!isNotificationManagerMode) {
    return { ok: false, error: 'Manual backend retry is only available in SAM.' };
  }

  clearNotificationBackendRetryTimer();
  if (options?.resetAttempts !== false) {
    backendRetryAttemptCount = 0;
  }

  try {
    await ensureBackendAvailable();
    backendRetryAttemptCount = 0;
    return { ok: true };
  } catch (err) {
    const message = err?.message || 'Unable to start the SAM backend.';
    scheduleNotificationBackendRetry(message);
    return { ok: false, error: message };
  }
}

async function promptForQuitConfirmation(parentWindow = mainWindow) {
  if (app.isQuitting || isHandlingCloseConfirmation) {
    return false;
  }

  isHandlingCloseConfirmation = true;

  try {
    if (isNotificationManagerMode) {
      const { response } = await dialog.showMessageBox(parentWindow || null, {
        type: 'question',
        buttons: ['Exit App', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Exit Sam',
        message: 'Are you sure you want to exit Sam?',
      });

      if (response !== 0) {
        return false;
      }

      tray = null;
      app.isQuitting = true;
      allowWindowClose = true;
      clearHeartbeat();
      stopBackend();
      app.quit();
      return true;
    }

    let confirmed = false;

    if (parentWindow && !parentWindow.isDestroyed()) {
      if (parentWindow.isMinimized()) {
        parentWindow.restore();
      }
      if (!parentWindow.isVisible()) {
        parentWindow.show();
      }
      parentWindow.focus();

      confirmed = await new Promise((resolve) => {
        const cleanup = () => {
          parentWindow.removeListener('closed', handleRendererUnavailable);
          parentWindow.webContents.removeListener('render-process-gone', handleRendererUnavailable);
        };

        const handleRendererUnavailable = () => {
          if (!quitConfirmationResolver) {
            return;
          }
          quitConfirmationResolver = null;
          cleanup();
          resolve(null);
        };

        quitConfirmationResolver = (value) => {
          quitConfirmationResolver = null;
          cleanup();
          resolve(Boolean(value));
        };

        parentWindow.once('closed', handleRendererUnavailable);
        parentWindow.webContents.once('render-process-gone', handleRendererUnavailable);
        sendAppEvent('app:confirm-quit', {
          hasUnsavedChanges,
        });
      });
    }

    if (confirmed === null || (!parentWindow || parentWindow.isDestroyed())) {
      const { response } = await dialog.showMessageBox(parentWindow || null, {
        type: 'question',
        buttons: ['Yes', 'No'],
        defaultId: 1,
        cancelId: 1,
        title: 'Close App',
        message: hasUnsavedChanges
          ? 'You have unsaved work. Are you sure you want to close the app?'
          : 'Are you sure you want to close the app?',
      });
      confirmed = response === 0;
    }

    if (!confirmed) {
      return false;
    }

    tray = null;
    app.isQuitting = true;
    allowWindowClose = true;
    clearHeartbeat();
    stopBackend();
    app.quit();
    return true;
  } finally {
    isHandlingCloseConfirmation = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// SYSTEM TRAY
// ═══════════════════════════════════════════════════════════════
function createTray() {
  tray = new Tray(createTrayIcon());

  const contextMenu = Menu.buildFromTemplate([
    { label: `${APP_DISPLAY_NAME} v${APP_VERSION}`, enabled: false },
    { type: 'separator' },
    { label: 'Show App', click: () => { if (mainWindow) mainWindow.show(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { promptForQuitConfirmation(); }}
  ]);

  tray.setToolTip(`${APP_DISPLAY_NAME} v${APP_VERSION}`);
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { if (mainWindow) mainWindow.show(); });
}

function createAppMenu() {
  if (isNotificationManagerMode) {
    const template = [
      {
        label: 'File',
        submenu: [
          {
            label: 'Exit',
            click: () => {
              promptForQuitConfirmation();
            },
          },
        ],
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Help / About',
            click: () => sendAppEvent('menu:about', getAboutDetails()),
          },
          {
            label: 'Replay Tutorial',
            click: () => sendAppEvent('menu:replay-tutorial'),
          },
        ],
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    return;
  }

  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Settings',
          click: () => sendAppEvent('menu:navigate', { page: 'settings' }),
        },
        { type: 'separator' },
        {
          label: 'Exit',
          click: () => {
            promptForQuitConfirmation();
          },
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Help',
          click: () => sendAppEvent('menu:navigate', { page: 'help' }),
        },
        {
          label: 'About',
          click: () => sendAppEvent('menu:about', getAboutDetails()),
        },
        {
          label: 'Check for Updates',
          click: () => sendAppEvent('menu:check-updates'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function getAboutDetails() {
  return {
    version: APP_VERSION,
    creatorName: 'Shawn Bly',
    creatorEmail: 'blyshawnp@gmail.com',
  };
}

// ═══════════════════════════════════════════════════════════════
// IPC
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('app:quit', () => {
  return promptForQuitConfirmation();
});

ipcMain.on('app:getVersion', (event) => {
  event.returnValue = APP_VERSION;
});

ipcMain.on('app:isNotificationManager', (event) => {
  event.returnValue = isNotificationManagerMode;
});

ipcMain.on('backend:getUrl', (event) => {
  event.returnValue = `http://127.0.0.1:${BACKEND_PORT}`;
});

ipcMain.on('app:getAdminToken', (event) => {
  event.returnValue = getSharedAdminToken();
});

ipcMain.handle('app:quit-response', (_event, confirmed) => {
  if (quitConfirmationResolver) {
    quitConfirmationResolver(Boolean(confirmed));
  }
  return { ok: true };
});

ipcMain.handle('app:setUnsavedChanges', (_event, value) => {
  hasUnsavedChanges = Boolean(value);
  return { ok: true };
});

ipcMain.handle('shell:openExternal', async (_event, url) => {
  if (!isSafeExternalUrl(url)) {
    throw new Error('Blocked unsafe external URL.');
  }

  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('updates:check', async () => {
  return checkForUpdates({ promptUser: true });
});

ipcMain.handle('updates:getState', () => {
  return getUpdateState();
});

ipcMain.handle('updates:installPending', async () => {
  const pending = getPendingUpdate();
  if (!pending) {
    return { ok: false, error: 'No pending update is available.' };
  }

  if (!pending.downloadUrl) {
    return {
      ok: false,
      error: 'An update was detected, but the published update sheet does not include a download URL yet.',
    };
  }

  if (!isSafeExternalUrl(pending.downloadUrl, ['https:'])) {
    return { ok: false, error: 'The update download URL is not a safe HTTPS link.' };
  }

  await shell.openExternal(pending.downloadUrl);
  return { ok: true };
});

ipcMain.handle('updates:ackInstalled', () => {
  store.set(STORE_LAST_ACKNOWLEDGED_VERSION_KEY, APP_VERSION);
  sendAppEvent('update:state-changed', getUpdateState());
  return { ok: true };
});

ipcMain.handle('app:getAboutInfo', () => {
  return getAboutDetails();
});

ipcMain.handle('backend:getState', () => {
  return getBackendState();
});

ipcMain.handle('backend:retryStartup', async (_event, options = {}) => {
  return retryNotificationBackendStartup(options || {});
});

ipcMain.handle('assets:getUrl', (_event, filename) => {
  const safeName = path.basename(String(filename || ''));
  if (!safeName) {
    return '';
  }
  const assetPath = getAssetPath(safeName);
  return fs.existsSync(assetPath) ? pathToFileURL(assetPath).toString() : '';
});

// ═══════════════════════════════════════════════════════════════
// AUTO-UPDATE CHECK (from master Google Sheet via backend)
// ═══════════════════════════════════════════════════════════════
function isValidVersionString(value) {
  return isVersionString(value);
}

function sendAppEvent(type, payload = null) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('app:event', type, payload);
}

function fetchUpdateMetadataFromBackend() {
  return new Promise((resolve, reject) => {
    const appKey = isNotificationManagerMode ? 'sam' : 'mts';
    const request = http.get({
      hostname: '127.0.0.1',
      port: BACKEND_PORT,
      path: `/api/update?app=${encodeURIComponent(appKey)}`,
      timeout: 10000,
      headers: { [ADMIN_TOKEN_HEADER]: getSharedAdminToken() },
    }, (res) => {
      const statusCode = res.statusCode || 0;
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`Update sheet request failed with status ${statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body || '{}'));
        } catch (_err) {
          reject(new Error('Update sheet response was not valid JSON.'));
        }
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error('Update sheet request timed out.'));
    });
    request.on('error', reject);
  });
}

function getPendingUpdate() {
  return store.get(STORE_PENDING_UPDATE_KEY) || null;
}

function setPendingUpdate(updateInfo) {
  store.set(STORE_PENDING_UPDATE_KEY, updateInfo);
  sendAppEvent('update:state-changed', getUpdateState());
}

function clearPendingUpdate() {
  store.delete(STORE_PENDING_UPDATE_KEY);
  sendAppEvent('update:state-changed', getUpdateState());
}

function getInstalledUpdateNotice() {
  const installed = store.get(STORE_LAST_INSTALLED_UPDATE_KEY) || null;
  const acknowledgedVersion = store.get(STORE_LAST_ACKNOWLEDGED_VERSION_KEY) || '';
  if (!installed) return null;
  if (installed.latestVersion !== APP_VERSION) return null;
  if (acknowledgedVersion === APP_VERSION) return null;
  return installed;
}

function getUpdateState() {
  return {
    currentVersion: APP_VERSION,
    pendingUpdate: getPendingUpdate(),
    installedUpdate: getInstalledUpdateNotice(),
  };
}

function reconcileStoredUpdateState() {
  const pending = getPendingUpdate();
  if (!pending) return;

  if (pending.latestVersion && compareVersions(APP_VERSION, pending.latestVersion) >= 0) {
    store.set(STORE_LAST_INSTALLED_UPDATE_KEY, pending);
    store.delete(STORE_PENDING_UPDATE_KEY);
  }
}

async function checkForUpdates({ promptUser = true } = {}) {
  try {
    const data = await fetchUpdateMetadataFromBackend();
    if (!data?.ok) {
      return {
        ok: false,
        error: data?.error || 'The update sheet could not be read.',
      };
    }
    const latestVersion = data.latestVersion || '';
    const requiredVersion = data.requiredVersion || '';
    const downloadUrl = data.downloadUrl || '';
    const releaseDate = data.releaseDate || '';
    const releaseTitle = data.releaseTitle || '';
    const notes = Array.isArray(data.notes) ? data.notes : [];
    if (!latestVersion) {
      console.log('[UPDATE] No update metadata version published in master sheet.');
      clearPendingUpdate();
      return {
        ok: true,
        updateAvailable: false,
        currentVersion: APP_VERSION,
      };
    }
    if (!isValidVersionString(latestVersion)) {
      console.warn('[UPDATE] Parsed remote version is invalid:', latestVersion);
      return {
        ok: false,
        error: `The update sheet returned an invalid version: ${latestVersion}`,
      };
    }
    if (requiredVersion && !isValidVersionString(requiredVersion)) {
      console.warn('[UPDATE] Parsed required version is invalid:', requiredVersion);
      return {
        ok: false,
        error: `The update sheet returned an invalid required version: ${requiredVersion}`,
      };
    }
    if (!isValidVersionString(APP_VERSION)) {
      console.warn('[UPDATE] Local app version is invalid:', APP_VERSION);
      return {
        ok: false,
        error: `The local app version is invalid: ${APP_VERSION}`,
      };
    }

    console.log(`[UPDATE] Current version: ${APP_VERSION}, remote version: ${latestVersion}`);
    const required = Boolean(requiredVersion && compareVersions(APP_VERSION, requiredVersion) < 0);

    if (required || compareVersions(latestVersion, APP_VERSION) > 0) {
      const updateInfo = {
        latestVersion,
        requiredVersion,
        required,
        currentVersion: APP_VERSION,
        releaseDate,
        releaseTitle,
        notes,
        downloadUrl,
        source: data.source || 'master-google-sheet',
      };

      setPendingUpdate(updateInfo);

      if (promptUser) {
        sendAppEvent('update:available', updateInfo);
      }

      return { ok: true, updateAvailable: true, updateInfo };
    } else {
      clearPendingUpdate();
      console.log('[UPDATE] No update available.');
      return { ok: true, updateAvailable: false, currentVersion: APP_VERSION };
    }
  } catch (err) {
    console.log('[UPDATE] Check failed:', err.message);
    return {
      ok: false,
      error: err.message,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// APP LIFECYCLE
// ═══════════════════════════════════════════════════════════════
process.on('uncaughtException', (err) => {
  console.error('[APP] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[APP] Unhandled rejection:', reason);
});

app.whenReady().then(async () => {
  console.log(`[APP] ${APP_DISPLAY_NAME} v${APP_VERSION} starting...`);
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_RUNTIME_ID);
  }
  reconcileStoredUpdateState();
  registerProcessCleanupHandlers();
  startHeartbeat();
  createMainWindow();
  createTray();
  createAppMenu();

  try {
    await ensureBackendAvailable();
  } catch (err) {
    if (isNotificationManagerMode) {
      console.warn('[BACKEND] Sam will keep retrying backend startup:', err.message);
      setBackendConnectionStatus('retrying', err.message);
      scheduleNotificationBackendRetry();
    } else {
      stopBackend();
      dialog.showErrorBox('Startup Error', err.message);
      app.quit();
      return;
    }
  }

  sendAppEvent('update:state-changed', getUpdateState());
  setTimeout(() => {
    checkForUpdates({ promptUser: true });
  }, 5000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    clearHeartbeat();
    stopBackend();
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) createMainWindow();
  else mainWindow.show();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  tray = null;
  clearHeartbeat();
  stopBackend();
});
