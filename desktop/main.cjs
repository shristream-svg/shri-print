const { app, BrowserWindow, Menu, Tray, shell, ipcMain, dialog, nativeImage } = require('electron');
const { spawn } = require('child_process');
const { join, dirname, resolve /* basename */ } = require('path');
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs');

const APP_NAME = 'SHRI Print Admin';
const APP_VERSION = '2.0.1';
const LOCAL_CONTROLLER_PORT = 4888;
const LOCAL_CONTROLLER_ORIGIN = `http://localhost:${LOCAL_CONTROLLER_PORT}`;
const DESKTOP_CONFIG_NAME = 'desktop-config.json';
const LAUNCH_SCRIPT_NAME = 'launch.ps1';
const SERVER_FILE_NAME = 'local/server.mjs';
const ICON_FILE_NAME = 'icon.png';
const _SINGLE_INSTANCE_LOCK = 'shri-print-admin-singleton';
const AGENT_CONFIG_NAME = 'agent/config.json';

let mainWindow = null;
let tray = null;
let localControllerProcess = null;
let isQuitting = false;
let cloudServerOrigin = 'https://shri-print-bahadurgarh.shristream.chatgpt.site';
let projectRoot = null;
let statusPollInterval = null;
const _startupHealthCheckTimer = null;

function getUserDataPath() {
  const customPath = join(app.getPath('appData'), 'SHRI Print Admin');
  if (!existsSync(customPath)) {
    mkdirSync(customPath, { recursive: true });
  }
  return customPath;
}

function findProjectRoot() {
  const desktopConfigPath = join(dirname(process.execPath), DESKTOP_CONFIG_NAME);

  if (existsSync(desktopConfigPath)) {
    try {
      const config = JSON.parse(readFileSync(desktopConfigPath, 'utf8'));
      if (config.projectRoot && existsSync(config.projectRoot)) {
        return resolve(config.projectRoot);
      }
    } catch (_e) {
      console.warn('Failed to read desktop-config.json');
    }
  }

  const devRoot = resolve(__dirname, '..');
  if (
    existsSync(join(devRoot, SERVER_FILE_NAME)) &&
    existsSync(join(devRoot, LAUNCH_SCRIPT_NAME))
  ) {
    return devRoot;
  }

  const fallbackRoot = resolve(dirname(process.execPath), '..', 'shri-print');
  if (
    existsSync(join(fallbackRoot, SERVER_FILE_NAME)) &&
    existsSync(join(fallbackRoot, LAUNCH_SCRIPT_NAME))
  ) {
    return fallbackRoot;
  }

  return null;
}

function validateProjectRoot(root) {
  if (!root) return false;
  const serverPath = join(root, SERVER_FILE_NAME);
  const launchPath = join(root, LAUNCH_SCRIPT_NAME);
  return existsSync(serverPath) && existsSync(launchPath);
}

function loadCloudServerOrigin(root) {
  const configPath = join(root, 'agent', 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      if (config.server && typeof config.server === 'string') {
        const url = new URL(config.server);
        if (url.protocol === 'https:') {
          cloudServerOrigin = `${url.protocol}//${url.host}`;
        }
      }
    } catch (_e) {
      console.warn('Failed to read cloud server from agent/config.json');
    }
  }
}

function launchLocalController(root) {
  return new Promise((resolve, reject) => {
    const launchScript = join(root, LAUNCH_SCRIPT_NAME);
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launchScript, '-NoOpen'];
    const env = { ...process.env };
    delete env.PSModulePath;

    localControllerProcess = spawn('powershell.exe', args, {
      shell: false,
      windowsHide: true,
      cwd: root,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    });

    localControllerProcess.on('error', err => {
      console.error('Failed to launch local controller');
      reject(err);
    });

    localControllerProcess.stdout?.on('data', data => {
      console.log('[Local Controller]', data.toString().trim());
    });

    localControllerProcess.stderr?.on('data', data => {
      console.error('[Local Controller Error]', data.toString().trim());
    });

    setTimeout(() => resolve(), 2000);
  });
}

async function pollLocalConfig(timeoutMs = 30000) {
  const startTime = Date.now();
  const intervalMs = 500;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`${LOCAL_CONTROLLER_ORIGIN}/api/config`);
      if (response.ok) {
        const config = await response.json();
        if (config.server && typeof config.server === 'string') {
          const url = new URL(config.server);
          if (url.protocol === 'https:') {
            cloudServerOrigin = `${url.protocol}//${url.host}`;
          }
        }
        return true;
      }
    } catch (_e) {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

function isAllowedOrigin(urlString) {
  try {
    const parsed = new URL(urlString);
    const allowed = [LOCAL_CONTROLLER_ORIGIN, cloudServerOrigin];
    return allowed.some(origin => {
      const allowedUrl = new URL(origin);
      return parsed.protocol === allowedUrl.protocol && parsed.host === allowedUrl.host;
    });
  } catch (_e) {
    return false;
  }
}

function isHttpsOrLocal(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol === 'http:' && parsed.host === `localhost:${LOCAL_CONTROLLER_PORT}`)
      return true;
    return false;
  } catch (_e) {
    return false;
  }
}

function createMainWindow() {
  const iconPath = join(__dirname, ICON_FILE_NAME);
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : null;
  const preloadPath = join(__dirname, 'preload.cjs');

  mainWindow = new BrowserWindow({
    title: 'SHRI Print — Admin Desk',
    width: 1360,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    frame: false,
    backgroundColor: '#f3f4eb',
    show: false,
    icon: icon,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      experimentalFeatures: false,
      allowRunningInsecureContent: false,
      autoplayPolicy: 'document-user-activation-required',
      preload: preloadPath,
      defaultFontFamily: {
        standard: 'Segoe UI',
        sansSerif: 'Segoe UI',
        serif: 'Segoe UI',
        monospace: 'Consolas',
      },
    },
  });

  // Local presentation assets are applied only inside this installed window.
  // The customer site and its assets are not changed by this desktop release.
  mainWindow.webContents.on('dom-ready', async () => {
    const contents = mainWindow?.webContents;
    if (!contents || contents.isDestroyed() || !isAllowedOrigin(contents.getURL())) return;
    try {
      await contents.insertCSS(readFileSync(join(__dirname, 'desktop-ui.css'), 'utf8'));
      await contents.executeJavaScript(readFileSync(join(__dirname, 'desktop-ui.js'), 'utf8'));
    } catch (error) {
      console.warn('Desktop visual layer could not be applied:', error.message);
    }
  });

  mainWindow.webContents.on('page-title-updated', event => {
    event.preventDefault();
    mainWindow.setTitle('SHRI Print — Admin Desk');
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('close', event => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isAllowedOrigin(navigationUrl)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('will-redirect', (event, navigationUrl) => {
    if (!isAllowedOrigin(navigationUrl)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('new-window', (event, navigationUrl) => {
    event.preventDefault();
    if (isAllowedOrigin(navigationUrl)) {
      try {
        const parsed = new URL(navigationUrl);
        const allowed = [LOCAL_CONTROLLER_ORIGIN, cloudServerOrigin];
        const isCustomerOrPdf = allowed.some(o => {
          const a = new URL(o);
          return (
            parsed.protocol === a.protocol &&
            parsed.host === a.host &&
            (parsed.pathname === '/' ||
              parsed.pathname === '/preview' ||
              /^\/api\/orders\/[A-Za-z0-9_-]+\/file$/.test(parsed.pathname))
          );
        });
        if (isCustomerOrPdf && isHttpsOrLocal(navigationUrl)) {
          shell.openExternal(navigationUrl).catch(() => {});
        }
      } catch (_e) {}
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedOrigin(url)) {
      try {
        const parsed = new URL(url);
        const allowed = [LOCAL_CONTROLLER_ORIGIN, cloudServerOrigin];
        const isCustomerOrPdf = allowed.some(o => {
          const a = new URL(o);
          return (
            parsed.protocol === a.protocol &&
            parsed.host === a.host &&
            (parsed.pathname === '/' ||
              parsed.pathname === '/preview' ||
              /^\/api\/orders\/[A-Za-z0-9_-]+\/file$/.test(parsed.pathname))
          );
        });
        if (isCustomerOrPdf && isHttpsOrLocal(url)) {
          shell.openExternal(url).catch(() => {});
        }
      } catch (_e) {}
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    }
  );

  mainWindow.webContents.session.setPermissionCheckHandler(
    (_webContents, _permission, _requestingOrigin, _details) => {
      return false;
    }
  );

  return mainWindow;
}

function validateIpcSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  try {
    if (event.senderFrame !== mainWindow.webContents.mainFrame) return false;
    const url = event.senderFrame.url;
    const parsed = new URL(url);
    const allowed = [LOCAL_CONTROLLER_ORIGIN, cloudServerOrigin];
    return allowed.some(origin => {
      const allowedUrl = new URL(origin);
      return parsed.protocol === allowedUrl.protocol && parsed.host === allowedUrl.host;
    });
  } catch (_e) {
    return false;
  }
}

function getAgentConfigPath() {
  return join(projectRoot, AGENT_CONFIG_NAME);
}

ipcMain.on('shri-print:window-control', (event, action) => {
  if (!validateIpcSender(event)) return;
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'maximize')
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  if (action === 'close') mainWindow.close();
  if (action === 'exit') {
    isQuitting = true;
    app.quit();
  }
  if (action === 'reload') mainWindow.webContents.reload();
});

function readAgentConfig() {
  const configPath = getAgentConfigPath();
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeAgentConfig(config) {
  const configPath = getAgentConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

async function fetchLocalStatus() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${LOCAL_CONTROLLER_ORIGIN}/api/local/status`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (response.ok) return await response.json();
  } catch {}
  return null;
}

function startStatusPolling() {
  if (statusPollInterval) clearInterval(statusPollInterval);
  statusPollInterval = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const status = await fetchLocalStatus();
    if (status) {
      mainWindow.webContents.send('shri-print:status-update', status);
    }
  }, 5000);
}

function _stopStatusPolling() {
  if (statusPollInterval) {
    clearInterval(statusPollInterval);
    statusPollInterval = null;
  }
}

ipcMain.handle('shri-print:get-status', async event => {
  if (!validateIpcSender(event)) throw new Error('Unauthorized');
  const status = await fetchLocalStatus();
  if (status) return status;
  const config = readAgentConfig();
  return {
    pid: localControllerProcess?.pid ?? null,
    mode: config?.mode ?? 'dry-run',
    heartbeatAt: null,
    inventoryAt: null,
    printing: false,
    lastError: null,
    server: cloudServerOrigin,
    alive: !!localControllerProcess && !localControllerProcess.killed,
    now: Date.now(),
    isLocalBackup: true,
  };
});

ipcMain.handle('shri-print:set-mode', async (event, mode) => {
  if (!validateIpcSender(event)) throw new Error('Unauthorized');
  if (mode !== 'live' && mode !== 'dry-run') throw new Error('Invalid mode');
  const config = readAgentConfig();
  if (!config) throw new Error('Agent config not found');
  config.mode = mode;
  writeAgentConfig(config);
  try {
    await fetch(`${LOCAL_CONTROLLER_ORIGIN}/api/admin/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
  } catch {}
  return { ok: true, mode };
});

ipcMain.handle('shri-print:reconnect', async event => {
  if (!validateIpcSender(event)) throw new Error('Unauthorized');
  if (!projectRoot) throw new Error('Project root not initialized');
  const launchScript = join(projectRoot, LAUNCH_SCRIPT_NAME);
  if (!existsSync(launchScript)) throw new Error('Launch script not found');
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launchScript, '-NoOpen'];
    const env = { ...process.env };
    delete env.PSModulePath;
    const proc = spawn('powershell.exe', args, {
      shell: false,
      windowsHide: true,
      cwd: projectRoot,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    });
    proc.on('error', reject);
    setTimeout(() => resolve({ ok: true }), 2000);
  });
});

function _createApplicationMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Dashboard', click: () => navigateTo('/admin') },
        { label: 'Printers', click: () => navigateTo('/admin#printers') },
        { label: 'Reports', click: () => navigateTo('/admin#reports') },
        { label: 'Settings', click: () => navigateTo('/admin#settings') },
        { type: 'separator' },
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.reload(),
        },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => mainWindow?.webContents.reloadIgnoringCache(),
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => zoom(1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoom(-1) },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => zoom(0) },
        { type: 'separator' },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'F12',
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Minimize', accelerator: 'CmdOrCtrl+M', role: 'minimize' },
        { label: 'Close', accelerator: 'CmdOrCtrl+W', role: 'close' },
      ],
    },
    {
      label: 'Connection',
      submenu: [
        { label: 'Connection Status', click: () => showConnectionStatus() },
        { type: 'separator' },
        { label: 'Reconnect Local Controller', click: () => reconnectLocalController() },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open Customer Page',
          click: () => shell.openExternal(cloudServerOrigin).catch(() => {}),
        },
        {
          label: 'Local Controls',
          click: () => shell.openExternal(LOCAL_CONTROLLER_ORIGIN).catch(() => {}),
        },
        { type: 'separator' },
        { label: 'About SHRI Print Admin', click: () => showAboutDialog() },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function navigateTo(fragment) {
  if (mainWindow) {
    const url = `${cloudServerOrigin}${fragment}`;
    mainWindow.loadURL(url).catch(() => {});
  }
}

function zoom(delta) {
  if (!mainWindow) return;
  const currentZoom = mainWindow.webContents.getZoomFactor();
  if (delta === 0) {
    mainWindow.webContents.setZoomFactor(1.0);
  } else {
    mainWindow.webContents.setZoomFactor(Math.max(0.5, Math.min(3.0, currentZoom + delta * 0.1)));
  }
}

function showAboutDialog() {
  if (mainWindow) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'About SHRI Print Admin',
      message: 'SHRI Print Admin',
      detail: `Version ${APP_VERSION}\nDesktop admin interface for SHRI Print`,
      buttons: ['OK'],
    });
  }
}

function createTray() {
  const iconPath = join(__dirname, ICON_FILE_NAME);
  const icon = existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('SHRI Print Admin');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Admin',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'Reload',
      click: () => mainWindow?.webContents.reload(),
    },
    {
      label: 'Open Customer Page',
      click: () => shell.openExternal(cloudServerOrigin).catch(() => {}),
    },
    {
      label: 'Local Controls',
      click: () => shell.openExternal(LOCAL_CONTROLLER_ORIGIN).catch(() => {}),
    },
    { type: 'separator' },
    {
      label: 'Connection Status',
      click: () => {
        if (mainWindow) showConnectionStatus();
      },
    },
    {
      label: 'Reconnect Local Controller',
      click: () => reconnectLocalController(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

async function showConnectionStatus() {
  if (!mainWindow) return;
  const status = await fetchLocalStatus();
  if (status) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Connection Status',
      message: `Agent: ${status.alive ? 'Running' : 'Stopped'} (PID: ${status.pid || 'N/A'})`,
      detail: `Mode: ${status.mode}\nServer: ${status.server}\nHeartbeat: ${status.heartbeatAt ? new Date(status.heartbeatAt).toLocaleString() : 'Never'}\nInventory: ${status.inventoryAt ? new Date(status.inventoryAt).toLocaleString() : 'Never'}\nPrinting: ${status.printing ? 'Yes' : 'No'}\nError: ${status.lastError || 'None'}`,
      buttons: ['OK'],
    });
  } else {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Connection Status',
      message: 'Could not fetch local controller status',
      detail: 'The local controller may not be running.',
      buttons: ['OK'],
    });
  }
}

function reconnectLocalController() {
  if (!projectRoot) return;
  const launchScript = join(projectRoot, LAUNCH_SCRIPT_NAME);
  if (!existsSync(launchScript)) {
    dialog.showErrorBox('Error', 'Launch script not found');
    return;
  }
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launchScript, '-NoOpen'];
    const env = { ...process.env };
    delete env.PSModulePath;
    const proc = spawn('powershell.exe', args, {
      shell: false,
      windowsHide: true,
      cwd: projectRoot,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    });
    proc.on('error', reject);
    setTimeout(() => resolve({ ok: true }), 2000);
  });
}

function showErrorDialog(message) {
  if (!mainWindow) return;
  const response = dialog.showMessageBoxSync(mainWindow, {
    type: 'error',
    title: 'Connection Error',
    message: 'Failed to connect to local controller',
    detail: message,
    buttons: ['Retry Connection', 'Open Local Controls', 'Quit'],
    defaultId: 0,
    cancelId: 2,
  });

  if (response === 0) {
    performStartupHealthCheck();
  } else if (response === 1) {
    shell.openExternal(LOCAL_CONTROLLER_ORIGIN).catch(() => {});
  } else {
    isQuitting = true;
    app.quit();
  }
}

async function performStartupHealthCheck() {
  if (!mainWindow) return;
  try {
    const status = await fetchLocalStatus();
    if (status && status.alive) {
      return; // Healthy
    }
    // If we get here, the local controller is not responding
    showErrorDialog('Local controller is not responding. Please check the connection.');
  } catch (_e) {
    showErrorDialog(
      'Failed to connect to local controller. Please ensure the agent is running on port 4888.'
    );
  }
}

async function initializeApp() {
  projectRoot = findProjectRoot();

  if (!projectRoot || !validateProjectRoot(projectRoot)) {
    const errorMsg =
      'Could not locate SHRI Print project root. Ensure desktop-config.json exists beside the EXE with projectRoot, or run from the development directory structure.';
    console.error(errorMsg);
    dialog.showErrorBox('SHRI Print Admin - Configuration Error', errorMsg);
    app.quit();
    return;
  }

  loadCloudServerOrigin(projectRoot);

  await launchLocalController(projectRoot);

  const configLoaded = await pollLocalConfig();
  if (!configLoaded) {
    console.warn('Local controller config poll timed out, proceeding anyway');
  }

  createMainWindow();
  Menu.setApplicationMenu(null);
  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);
  createTray();

  mainWindow.webContents.once('did-finish-load', async () => {
    await performStartupHealthCheck();
    startStatusPolling();
  });

  try {
    await mainWindow.loadURL(`${LOCAL_CONTROLLER_ORIGIN}/local-login`);
  } catch (_err) {
    console.error('Failed to load local-login');
    showErrorDialog('Ensure the agent is running on port 4888.');
  }
}

app.setName(APP_NAME);
app.setPath('userData', getUserDataPath());
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app
    .whenReady()
    .then(initializeApp)
    .catch(() => {});
}

app.on('window-all-closed', () => {
  if (process.platform !== 'win32') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    initializeApp();
  } else if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  if (localControllerProcess && !localControllerProcess.killed) {
    localControllerProcess.kill('SIGTERM');
  }
});

process.on('uncaughtException', _err => {
  console.error('Uncaught exception');
});

process.on('unhandledRejection', _reason => {
  console.error('Unhandled rejection');
});
const { Notification } = require('electron');
let counterPollBusy = false,
  counterCursor = Date.now(),
  counterNotified = new Set();
app.whenReady().then(() => {
  try {
    const v = JSON.parse(
      readFileSync(join(app.getPath('userData'), 'counter-alerts.json'), 'utf8')
    );
    counterCursor = v.cursor;
    counterNotified = new Set(v.ids || []);
  } catch (_e) {}
  setInterval(async () => {
    if (counterPollBusy || !projectRoot) return;
    counterPollBusy = true;
    try {
      const secret = JSON.parse(readFileSync(join(projectRoot, 'runtime', 'secrets.json'), 'utf8'));
      const response = await fetch(
        cloudServerOrigin + '/api/admin/live?after=' + Math.max(0, counterCursor - 1),
        {
          headers: { Authorization: 'Bearer ' + secret.ADMIN_TOKEN },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (!response.ok) return;
      const data = await response.json();
      for (const o of data.orders || []) {
        if (
          o.method !== 'cash' ||
          o.status !== 'awaiting_approval' ||
          o.payment === 'paid' ||
          o.updated < counterCursor ||
          counterNotified.has(o.id)
        )
          continue;
        counterNotified.add(o.id);
        if (Notification.isSupported()) {
          const n = new Notification({
            title: 'SHRI Print — Payment waiting',
            body:
              'Order #' +
              o.id.slice(0, 8).toUpperCase() +
              ' · ₹' +
              (o.amount / 100).toFixed(2) +
              ' · Confirm cash at counter',
            silent: false,
          });
          n.on('click', () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.focus();
            }
          });
          n.show();
        }
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(true);
      }
      counterCursor = data.now || counterCursor;
      writeFileSync(
        join(app.getPath('userData'), 'counter-alerts.json'),
        JSON.stringify({ cursor: counterCursor, ids: [...counterNotified].slice(-1000) })
      );
    } catch (_e) {
    } finally {
      counterPollBusy = false;
    }
  }, 1500);
});
