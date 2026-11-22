const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const tracker = require('./services/tracker');
const SpotifyService = require('./services/spotify');
const lyricsEngine = require('./services/lyricsEngine');

// Performance & Memory optimization: Limit V8 heap to 64MB and disable unnecessary background caches
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=64');
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-background-timer-throttling');

let mainWindow = null;
let tray = null;
let isGhostMode = false;

// Dynamic dimensions: compact height matches the exact macOS menu bar height (30px on M1)
// Perfectly flush at y = 0 against top screen bezel with zero offside into application windows
function getNotchDimensions() {
  return {
    compactWidth: 340,
    compactHeight: 30, // Exact menu bar height (30px)
    expandedWidth: 460,
    expandedHeight: 155
  };
}

function createNotchWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth } = primaryDisplay.bounds;
  const { compactWidth, compactHeight } = getNotchDimensions();

  // Perfectly centered horizontally at y = 0 (flush against top bezel)
  const initialX = Math.round((screenWidth - compactWidth) / 2);
  const initialY = 0;

  const windowOpts = {
    width: compactWidth,
    height: compactHeight,
    x: initialX,
    y: initialY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false, // ZERO SHADOW on window
    roundedCorners: false, // Disables macOS Big Sur+ NSWindow corner mask
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  };

  if (process.platform === 'darwin') {
    windowOpts.type = 'panel'; // NSPanel sits flush over macOS top bezel
  }

  mainWindow = new BrowserWindow(windowOpts);

  if (process.platform === 'darwin') {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  } else {
    mainWindow.setAlwaysOnTop(true, 'floating');
  }

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  tracker.on('update', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tracker-update', data);
    }
  });

  tracker.on('idle', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tracker-idle', data);
    }
  });

  const config = loadConfig();
  if (typeof config.offset === 'number') {
    tracker.setOffset(config.offset);
  }

  tracker.start();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function updateWindowSize(isExpanded) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth } = primaryDisplay.bounds;
  const { compactWidth, compactHeight, expandedWidth, expandedHeight } = getNotchDimensions();

  const targetWidth = isExpanded ? expandedWidth : compactWidth;
  const targetHeight = isExpanded ? expandedHeight : compactHeight;
  const x = Math.round((screenWidth - targetWidth) / 2);

  mainWindow.setBounds({ x, y: 0, width: targetWidth, height: targetHeight });
}

const fs = require('fs');

function getConfigPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadConfig() {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {
    // ignore
  }
  return { offset: 0.8 };
}

function saveConfig(cfg) {
  try {
    const configPath = getConfigPath();
    const existing = loadConfig();
    const updated = { ...existing, ...cfg };
    fs.writeFileSync(configPath, JSON.stringify(updated, null, 2), 'utf8');
  } catch (e) {
    // ignore
  }
}

function setGlobalOffset(offset) {
  const rounded = parseFloat(Number(offset).toFixed(1));
  tracker.setOffset(rounded);
  saveConfig({ offset: rounded });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('offset-updated', rounded);
  }
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const currentOffset = tracker.offset;
  const offsetPresets = [
    { label: '0.0s (Tepat Waktu / Pas Audio)', val: 0.0 },
    { label: '0.5s Lebih Cepat', val: 0.5 },
    { label: '0.8s Lebih Cepat (Default)', val: 0.8 },
    { label: '1.0s Lebih Cepat', val: 1.0 },
    { label: '1.5s Lebih Cepat', val: 1.5 }
  ];

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'NotchVala v1.0',
      enabled: false
    },
    { type: 'separator' },
    {
      label: `Kecepatan Lirik: ${currentOffset >= 0 ? '+' : ''}${currentOffset.toFixed(1)}s`,
      submenu: offsetPresets.map(preset => ({
        label: preset.label,
        type: 'radio',
        checked: Math.abs(currentOffset - preset.val) < 0.05,
        click: () => setGlobalOffset(preset.val)
      }))
    },
    {
      label: 'Ghost Mode (Klik Tembus Pandang)',
      type: 'checkbox',
      checked: isGhostMode,
      click: (item) => toggleGhostMode(item.checked)
    },
    { type: 'separator' },
    {
      label: 'Demo: NIKI - Backburner',
      click: () => tracker.setManualTrack({ title: 'Backburner', artist: 'NIKI', duration: 236 })
    },
    {
      label: 'Demo: Adele - Someone Like You',
      click: () => tracker.setManualTrack({ title: 'Someone Like You', artist: 'Adele', duration: 285 })
    },
    {
      label: 'Deteksi Otomatis (Spotify / YouTube)',
      click: () => tracker.clearManualMode()
    },
    { type: 'separator' },
    {
      label: 'Keluar dari NotchVala',
      role: 'quit'
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function createTray() {
  let icon;
  try {
    let trayIconPath;
    if (process.platform === 'darwin') {
      trayIconPath = path.join(__dirname, 'assets', 'trayTemplate.png');
    } else if (process.platform === 'win32') {
      trayIconPath = path.join(__dirname, 'assets', 'icon.ico');
    } else {
      trayIconPath = path.join(__dirname, 'assets', 'icon.png');
    }
    icon = nativeImage.createFromPath(trayIconPath);
    if (!icon.isEmpty()) {
      if (process.platform === 'darwin') {
        icon.setTemplateImage(true);
      }
    } else {
      icon = nativeImage.createFromNamedImage('NSStatusAvailable');
    }
  } catch (e) {
    icon = nativeImage.createFromNamedImage('NSStatusAvailable');
  }

  tray = new Tray(icon);
  tray.setToolTip('NotchVala');
  updateTrayMenu();
}

function toggleGhostMode(enabled) {
  isGhostMode = enabled;
  if (mainWindow) {
    mainWindow.setIgnoreMouseEvents(isGhostMode, { forward: true });
  }
}

// IPC Handlers
ipcMain.handle('set-window-size', (event, { width, height }) => {
  const { compactHeight } = getNotchDimensions();
  const isExpanded = height > compactHeight;
  updateWindowSize(isExpanded);
  return true;
});

ipcMain.handle('set-ignore-mouse', (event, ignore) => {
  toggleGhostMode(ignore);
  return isGhostMode;
});

ipcMain.handle('player-playpause', async () => {
  return SpotifyService.playPause();
});

ipcMain.handle('player-next', async () => {
  return SpotifyService.next();
});

ipcMain.handle('player-prev', async () => {
  return SpotifyService.previous();
});

ipcMain.handle('set-offset', (event, offset) => {
  setGlobalOffset(offset);
  return tracker.offset;
});

ipcMain.handle('get-offset', () => {
  return tracker.offset;
});

ipcMain.handle('set-manual-track', async (event, song) => {
  await tracker.setManualTrack(song);
  return true;
});

ipcMain.handle('clear-manual-mode', () => {
  tracker.clearManualMode();
  return true;
});

ipcMain.handle('close-app', () => {
  app.quit();
});

app.whenReady().then(() => {
  if (app.dock) {
    app.dock.hide();
  }

  createNotchWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createNotchWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
