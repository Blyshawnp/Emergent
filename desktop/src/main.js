/**
 * Mock Testing Suite — Electron Main Process
 * Manages the application window, system tray, backend server, and auto-updates.
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const Store = require('electron-store');

const store = new Store();
const APP_VERSION = '2.5.0';
const BACKEND_PORT = 8600;
const isDev = !app.isPackaged;

let mainWindow = null;
let tray = null;
let backendProcess = null;

// ═══════════════════════════════════════════════════════════════
// PATHS
// ═══════════════════════════════════════════════════════════════
function getResourcePath(subpath) {
  if (isDev) return path.join(__dirname, '..', subpath);
  return path.join(process.resourcesPath, subpath);
}

function getAssetPath(filename) {
  return path.join(getResourcePath('assets'), filename);
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

// ═══════════════════════════════════════════════════════════════
// BACKEND SERVER
// ═══════════════════════════════════════════════════════════════
function startBackend() {
  const backendDir = getResourcePath('backend');
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

  backendProcess = spawn(pythonCmd, [
    '-m', 'uvicorn', 'server:app',
    '--host', '127.0.0.1',
    '--port', String(BACKEND_PORT),
    '--log-level', 'warning'
  ], {
    cwd: backendDir,
    env: {
      ...process.env,
      MONGO_URL: store.get('mongo_url', 'mongodb://localhost:27017'),
      DB_NAME: store.get('db_name', 'mock_testing_suite'),
      PYTHONUNBUFFERED: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  backendProcess.stdout.on('data', (data) => {
    console.log(`[BACKEND] ${data.toString().trim()}`);
  });

  backendProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg && !msg.includes('INFO:')) console.error(`[BACKEND] ${msg}`);
  });

  backendProcess.on('error', (err) => {
    console.error('[BACKEND] Failed to start:', err.message);
    if (!app.isQuitting) {
      dialog.showErrorBox(
        'Startup Error',
        'The backend server could not be started. Please make sure Python and MongoDB are installed and available on this PC.'
      );
    }
  });

  backendProcess.on('exit', (code) => {
    console.log(`[BACKEND] Process exited with code ${code}`);
    if (!app.isQuitting && code !== 0 && code !== null && mainWindow) {
      dialog.showErrorBox('Backend Error', 'The backend server has stopped unexpectedly. The app may not function correctly.');
    }
  });
}

function stopBackend() {
  if (backendProcess) {
    if (!backendProcess.killed) {
      backendProcess.kill();
    }
    backendProcess = null;
  }
}

function waitForBackend(retries = 30) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      if (remaining <= 0) return reject(new Error('Backend failed to start'));
      const req = http.get(`http://127.0.0.1:${BACKEND_PORT}/api/`, (res) => {
        if (res.statusCode === 200) resolve();
        else setTimeout(() => attempt(remaining - 1), 500);
      });
      req.on('error', () => setTimeout(() => attempt(remaining - 1), 500));
      req.end();
    };
    attempt(retries);
  });
}

// ═══════════════════════════════════════════════════════════════
// WINDOW
// ═══════════════════════════════════════════════════════════════
function createMainWindow() {
  const iconPath = getAssetPath('icon.png');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    icon: iconPath,
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
    const frontendPath = path.join(getResourcePath('frontend'), 'index.html');
    mainWindow.loadFile(frontendPath);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    if (tray) {
      e.preventDefault();
      mainWindow.hide();
    }
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
}

// ═══════════════════════════════════════════════════════════════
// SYSTEM TRAY
// ═══════════════════════════════════════════════════════════════
function createTray() {
  const iconPath = getAssetPath('icon.png');
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    { label: `Mock Testing Suite v${APP_VERSION}`, enabled: false },
    { type: 'separator' },
    { label: 'Show App', click: () => { if (mainWindow) mainWindow.show(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => {
      tray = null;
      stopBackend();
      app.quit();
    }}
  ]);

  tray.setToolTip(`Mock Testing Suite v${APP_VERSION}`);
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { if (mainWindow) mainWindow.show(); });
}

// ═══════════════════════════════════════════════════════════════
// AUTO-UPDATE CHECK (from Google Doc)
// ═══════════════════════════════════════════════════════════════
const UPDATE_DOC_URL = 'https://docs.google.com/document/d/1_5L1LS6i5bYWxRYUiBrmaVonbQq9nEhY68XrL5G9c1w/export?format=txt';

async function checkForUpdates() {
  try {
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      https.get(UPDATE_DOC_URL, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve(body));
        res.on('error', reject);
      }).on('error', reject);
    });

    const lines = data.trim().split('\n').map(l => l.trim()).filter(Boolean);
    // Expected format in doc:
    // Line 1: VERSION=2.6.0
    // Line 2: URL=https://example.com/download/MockTestingSuite-Setup-2.6.0.exe
    // Line 3: NOTES=Bug fixes and improvements
    const versionLine = lines.find(l => l.startsWith('VERSION='));
    const urlLine = lines.find(l => l.startsWith('URL='));
    const notesLine = lines.find(l => l.startsWith('NOTES='));

    if (!versionLine) return;
    const latestVersion = versionLine.split('=')[1].trim();
    const downloadUrl = urlLine ? urlLine.split('=').slice(1).join('=').trim() : '';
    const notes = notesLine ? notesLine.split('=').slice(1).join('=').trim() : 'A new version is available.';

    if (compareVersions(latestVersion, APP_VERSION) > 0) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Available',
        message: `Mock Testing Suite v${latestVersion} is available!`,
        detail: `${notes}\n\nCurrent: v${APP_VERSION}\nNew: v${latestVersion}`,
        buttons: downloadUrl ? ['Download Update', 'Later'] : ['OK'],
        defaultId: 0
      });
      if (response === 0 && downloadUrl && isSafeExternalUrl(downloadUrl, ['https:'])) {
        shell.openExternal(downloadUrl);
      } else if (response === 0 && downloadUrl) {
        console.warn('[UPDATE] Blocked non-HTTPS download URL:', downloadUrl);
      }
    }
  } catch (err) {
    console.log('[UPDATE] Check failed:', err.message);
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

  // Start backend
  startBackend();
  try {
    await waitForBackend();
    console.log('[APP] Backend is ready');
  } catch (err) {
    dialog.showErrorBox('Startup Error', 'Could not start the backend server. Please make sure Python and MongoDB are installed.');
    app.quit();
    return;
  }

  createMainWindow();
  createTray();

  // Check for updates after a short delay
  setTimeout(checkForUpdates, 5000);
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
