/**
 * Mock Testing Suite — Electron Main Process
 * Manages the application window, system tray, backend server, and auto-updates.
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const http = require('http');
const Store = require('electron-store');
let desktopPackage = {};

try {
  desktopPackage = require('../package.json');
} catch (err) {
  console.warn('[APP] Could not load desktop package metadata:', err.message);
}

const store = new Store();
const APP_ID = 'com.acddirect.mocktestingsuite';
const BACKEND_PORT = 8600;
const isDev = !app.isPackaged;
const DEFAULT_APP_VERSION = '1.0.1';
const BACKEND_STARTUP_RETRY_DELAY_MS = 500;
const BACKEND_STARTUP_RETRIES = isDev ? 40 : 120;
const BACKEND_READY_REQUEST_TIMEOUT_MS = 1500;

let mainWindow = null;
let tray = null;
let backendProcess = null;
let backendLaunchError = null;
let backendLogTail = [];
let backendCommandLabel = '';
let isHandlingCloseConfirmation = false;
let allowWindowClose = false;
let hasUnsavedChanges = false;
let hasRegisteredProcessCleanupHandlers = false;
let quitConfirmationResolver = null;

const STORE_PENDING_UPDATE_KEY = 'updater.pendingUpdate';
const STORE_LAST_INSTALLED_UPDATE_KEY = 'updater.lastInstalledUpdate';
const STORE_LAST_ACKNOWLEDGED_VERSION_KEY = 'updater.lastAcknowledgedInstalledVersion';

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
  if (process.platform === 'win32') {
    return getAssetPath('newMTS.ico');
  }
  return getAssetPath('newMTS.ico');
}

function getTrayIconPath() {
  return getAssetPath('systray-32.png');
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

// ═══════════════════════════════════════════════════════════════
// BACKEND SERVER
// ═══════════════════════════════════════════════════════════════
function startBackend() {
  if (!isDev) {
    const backendPath = path.join(process.resourcesPath, 'backend', 'backend.exe');
    const backendCwd = path.dirname(backendPath);
    const driverDir = path.join(process.resourcesPath, 'backend', 'drivers');
    requireRuntimePath(backendPath, 'Bundled backend executable');
    requireRuntimePath(driverDir, 'Bundled browser drivers directory');

    backendLaunchError = null;
    backendLogTail = [];
    backendCommandLabel = backendPath;

    console.log('[BACKEND] Launching packaged backend');
    console.log(`[BACKEND] backendPath: ${backendPath}`);
    console.log(`[BACKEND] cwd: ${backendCwd}`);

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

    backendProcess.stdout.on('data', (data) => appendBackendLog(data.toString().trim()));
    backendProcess.stderr.on('data', (data) => appendBackendLog(data.toString().trim()));
    backendProcess.on('error', (err) => {
      backendLaunchError = err;
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
      PYTHONUNBUFFERED: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

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
    }

    if (!app.isQuitting && code !== 0 && code !== null && mainWindow) {
      dialog.showErrorBox('Backend Error', getBackendFailureMessage(`The backend server stopped unexpectedly (exit code ${code}).`));
    }
  });
}

function stopBackend() {
  if (backendProcess) {
    killChildProcessTree(backendProcess, 'backend process');
    backendProcess = null;
  }
}

function waitForBackend(retries = BACKEND_STARTUP_RETRIES) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      if (backendLaunchError) {
        return reject(new Error(getBackendFailureMessage(backendLaunchError.message)));
      }

      if (!backendProcess) {
        return reject(new Error(getBackendFailureMessage('Backend process was not created.')));
      }

      if (backendProcess.exitCode !== null) {
        return reject(new Error(getBackendFailureMessage(`Backend exited with code ${backendProcess.exitCode}.`)));
      }

      if (remaining <= 0) {
        const timeoutSeconds = Math.round((BACKEND_STARTUP_RETRIES * BACKEND_STARTUP_RETRY_DELAY_MS) / 1000);
        return reject(new Error(getBackendFailureMessage(`Backend did not respond within ${timeoutSeconds} seconds.`)));
      }

      const req = http.get(`http://127.0.0.1:${BACKEND_PORT}/api/`, (res) => {
        if (res.statusCode === 200) resolve();
        else setTimeout(() => attempt(remaining - 1), BACKEND_STARTUP_RETRY_DELAY_MS);
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
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    icon: appIcon.isEmpty() ? iconPath : appIcon,
    title: `Mock Testing Suite v${APP_VERSION}`,
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
    mainWindow.loadURL('http://localhost:3000');
  } else {
    const frontendPath = getFrontendPath('index.html');
    requireRuntimePath(frontendPath, 'Packaged frontend index');
    mainWindow.loadFile(frontendPath);
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

async function promptForQuitConfirmation(parentWindow = mainWindow) {
  if (app.isQuitting || isHandlingCloseConfirmation) {
    return false;
  }

  isHandlingCloseConfirmation = true;

  try {
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
  const iconPath = getTrayIconPath();
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    { label: `Mock Testing Suite v${APP_VERSION}`, enabled: false },
    { type: 'separator' },
    { label: 'Show App', click: () => { if (mainWindow) mainWindow.show(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { promptForQuitConfirmation(); }}
  ]);

  tray.setToolTip(`Mock Testing Suite v${APP_VERSION}`);
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { if (mainWindow) mainWindow.show(); });
}

function createAppMenu() {
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
      error: 'An update was detected, but the published update document does not include a download URL yet.',
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

// ═══════════════════════════════════════════════════════════════
// AUTO-UPDATE CHECK (from Google Doc)
// ═══════════════════════════════════════════════════════════════
const UPDATE_DOC_URL = 'https://docs.google.com/document/d/1-eNbA4KriCkE8pKnnpj0FReUhUmMvTVjG8Y7B7ppu_A/export?format=txt';

function isValidVersionString(value) {
  return isVersionString(value);
}

function sendAppEvent(type, payload = null) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('app:event', type, payload);
}

function parseColonField(lines, label) {
  const match = lines.find((line) => new RegExp(`^${label}\\s*:`, 'i').test(line));
  if (!match) return '';
  return match.replace(new RegExp(`^${label}\\s*:\\s*`, 'i'), '').trim();
}

function parseEqualsField(lines, label) {
  const match = lines.find((line) => new RegExp(`^${label}\\s*=`, 'i').test(line));
  if (!match) return '';
  return match.replace(new RegExp(`^${label}\\s*=\\s*`, 'i'), '').trim();
}

function parseNotesSection(lines) {
  const notesHeaderIndex = lines.findIndex((line) => /^notes\s*:?\s*$/i.test(line));
  if (notesHeaderIndex >= 0) {
    return lines
      .slice(notesHeaderIndex + 1)
      .filter((line) => line.trim().startsWith('-'))
      .map((line) => line.replace(/^-\s*/, '').trim())
      .filter(Boolean);
  }

  const inlineNotes = parseEqualsField(lines, 'NOTES') || parseColonField(lines, 'NOTES');
  if (!inlineNotes) return [];
  return inlineNotes
    .split(/\s*[;|]\s*/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseUpdateDoc(body) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map((line) => String(line || '').replace(/^\uFEFF/, '').replace(/\u00A0/g, ' ').trim())
    .filter(Boolean);

  let latestVersion =
    parseColonField(lines, 'Latest Version') ||
    parseEqualsField(lines, 'VERSION');

  if (!latestVersion && lines.length > 0 && isValidVersionString(lines[0])) {
    latestVersion = lines[0];
  }

  const releaseDate = parseColonField(lines, 'Release Date');
  const releaseTitle = parseColonField(lines, 'Release Title');
  const downloadUrl =
    parseColonField(lines, 'URL') ||
    parseEqualsField(lines, 'URL');
  const notes = parseNotesSection(lines);

  return {
    latestVersion,
    releaseDate,
    releaseTitle,
    downloadUrl,
    notes,
    lines,
  };
}

function fetchTextWithRedirects(url, redirectCount = 0) {
  const MAX_REDIRECTS = 5;
  const client = url.startsWith('https:') ? require('https') : require('http');

  return new Promise((resolve, reject) => {
    client
      .get(url, (res) => {
        const statusCode = res.statusCode || 0;
        const location = res.headers.location;

        if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
          if (redirectCount >= MAX_REDIRECTS) {
            reject(new Error(`Too many redirects while fetching update doc from ${url}`));
            return;
          }

          const nextUrl = new URL(location, url).toString();
          res.resume();
          resolve(fetchTextWithRedirects(nextUrl, redirectCount + 1));
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          reject(new Error(`Update doc request failed with status ${statusCode}`));
          return;
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve(body));
        res.on('error', reject);
      })
      .on('error', reject);
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
    const data = await fetchTextWithRedirects(UPDATE_DOC_URL);

    const { latestVersion, downloadUrl, releaseDate, releaseTitle, notes, lines } = parseUpdateDoc(data);
    if (!latestVersion) {
      console.warn('[UPDATE] Could not parse a version from update doc. Expected either VERSION=x.y.z or a plain first-line version string.', lines);
      return {
        ok: false,
        error: 'The update document could not be parsed. Expected a valid version line.',
      };
    }
    if (!isValidVersionString(latestVersion)) {
      console.warn('[UPDATE] Parsed remote version is invalid:', latestVersion);
      return {
        ok: false,
        error: `The update document returned an invalid version: ${latestVersion}`,
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

    if (compareVersions(latestVersion, APP_VERSION) > 0) {
      const updateInfo = {
        latestVersion,
        currentVersion: APP_VERSION,
        releaseDate,
        releaseTitle,
        notes,
        downloadUrl,
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
  console.log(`[APP] Mock Testing Suite v${APP_VERSION} starting...`);
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_ID);
  }
  reconcileStoredUpdateState();
  registerProcessCleanupHandlers();
  createMainWindow();
  createTray();
  createAppMenu();

  try {
    startBackend();
    await waitForBackend();
    console.log('[APP] Backend is ready');
  } catch (err) {
    stopBackend();
    dialog.showErrorBox('Startup Error', err.message);
    app.quit();
    return;
  }

  sendAppEvent('update:state-changed', getUpdateState());
  // Check for updates after a short delay
  setTimeout(() => {
    checkForUpdates({ promptUser: true });
  }, 5000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
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
  stopBackend();
});
