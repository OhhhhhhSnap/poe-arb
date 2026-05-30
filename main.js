'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, screen, nativeImage, globalShortcut, Notification } = require('electron');
const path = require('path');

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ─── Lazy-load dependencies after app is ready ───────────────────────────────
let store;
let fetchPoe2Currency;
let fetchPoe2Leagues;
let findArbitrageOpportunities;

// ─── State ────────────────────────────────────────────────────────────────────
let tray = null;
let mainWindow = null;
let cachedOpportunities = [];
let isLoading = false;
let lastUpdated = null;
let lastError = null;
let refreshTimer = null;

// Notification state — keys of opportunities above threshold seen in the previous fetch
let prevNotifiableKeys = new Set();

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const KNOWN_LEAGUES = [
  'Runes of Aldur',
  'HC Runes of Aldur',
  'Return of the Ancients',
  'HC Return of the Ancients',
  'Mercenaries',
  'HC Mercenaries',
  'Dawn of the Hunt',
  'HC Dawn of the Hunt',
  'Standard',
  'Hardcore',
];
const DEFAULT_LEAGUE = 'Runes of Aldur';

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  const Store = require('electron-store');
  store = new Store({ defaults: { league: DEFAULT_LEAGUE } });
  ({ fetchPoe2Currency, fetchPoe2Leagues } = require('./src/ninja-client'));
  ({ findArbitrageOpportunities } = require('./src/arbitrage'));

  // Fetch active leagues from poe.ninja and merge with fallback list
  fetchPoe2Leagues().then((live) => {
    if (live.length > 0) {
      // Prepend live leagues, keeping any hardcoded ones not returned as fallbacks
      const merged = [...new Set([...live, ...KNOWN_LEAGUES])];
      KNOWN_LEAGUES.length = 0;
      merged.forEach(l => KNOWN_LEAGUES.push(l));
      // If saved league is no longer active, reset to first live league
      const saved = store.get('league', DEFAULT_LEAGUE);
      if (!live.includes(saved)) {
        store.set('league', live[0]);
      }
      updateTrayMenu();
    }
  });

  createTray();
  createWindow();
  fetchData();
  scheduleRefresh();

  globalShortcut.register('F9', () => toggleWindow());
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (refreshTimer) clearInterval(refreshTimer);
});
app.on('second-instance', () => {
  if (mainWindow) { positionWindow(); mainWindow.show(); mainWindow.focus(); }
});

// ─── Tray ─────────────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'tray-icon.png')
    : path.join(__dirname, 'assets', 'tray-icon.png');
  tray = new Tray(iconPath);
  tray.setToolTip('PoE Arb — Click to view arbitrage opportunities');
  tray.on('click', toggleWindow);
  tray.on('double-click', toggleWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: 'PoE Arb', enabled: false },
    { type: 'separator' },
    { label: 'Show / Hide', accelerator: 'CmdOrCtrl+Shift+A', click: toggleWindow },
    { label: 'Refresh Now', click: () => fetchData() },
    {
      label: store?.get('notificationsMuted', false) ? 'Unmute Notifications' : 'Mute Notifications',
      click: () => {
        const muted = store.get('notificationsMuted', false);
        store.set('notificationsMuted', !muted);
        updateTrayMenu();
        if (mainWindow?.isVisible()) mainWindow.webContents.send('notifications-muted-changed', !muted);
      },
    },
    { type: 'separator' },
    {
      label: 'League',
      submenu: KNOWN_LEAGUES.map((league) => ({
        label: league,
        type: 'radio',
        checked: store.get('league') === league,
        click: () => { store.set('league', league); updateTrayMenu(); fetchData(); },
      })),
    },
    { type: 'separator' },
    { label: 'Quit PoE Arb', click: () => app.exit(0) },
  ]);
  tray.setContextMenu(menu);
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 700,
    minWidth: 380,
    minHeight: 400,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#0f0c07',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('blur', () => {
    if (mainWindow && !mainWindow.webContents.isDevToolsFocused())
      mainWindow.hide();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function toggleWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    positionWindow();
    mainWindow.show();
    mainWindow.focus();
    sendDataToRenderer();
  }
}

function positionWindow() {
  if (!tray || !mainWindow) return;
  const trayBounds = tray.getBounds();
  const [winW, winH] = mainWindow.getSize();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const { x: workX, y: workY, width: workW, height: workH } = display.workArea;

  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winW / 2);
  let y;
  const trayBottom    = trayBounds.y + trayBounds.height;
  const taskbarAtBottom = trayBottom >= workY + workH - 4;
  const taskbarAtTop    = trayBounds.y <= workY + 4;

  if (taskbarAtBottom)     y = workY + workH - winH - 8;
  else if (taskbarAtTop)   y = workY + trayBounds.height + 8;
  else                     y = Math.round(trayBounds.y + trayBounds.height / 2 - winH / 2);

  x = Math.max(workX + 4, Math.min(x, workX + workW - winW - 4));
  y = Math.max(workY + 4, Math.min(y, workY + workH - winH - 4));
  mainWindow.setPosition(x, y, false);
}

// ─── Data fetching ────────────────────────────────────────────────────────────
async function fetchData() {
  if (isLoading) return;
  isLoading = true;
  lastError = null;
  sendDataToRenderer();

  const league = store.get('league', DEFAULT_LEAGUE);
  const arbSettings = {
    minVolumeDivine:  store.get('minVolumeDivine',  1.0),
    maxLotSize:       store.get('maxLotSize',        200),
    minMarginPct:     store.get('minMarginPct',      -100),
    maxSparklineDrop: store.get('maxSparklineDrop',  -50),
  };
  try {
    const rawData = await fetchPoe2Currency(league);
    const opps    = findArbitrageOpportunities(rawData, arbSettings);
    cachedOpportunities = opps;
    lastUpdated = new Date().toISOString();
    lastError   = null;

    // ── Desktop notifications ────────────────────────────────────────────────
    maybeNotify(opps);

    tray.setToolTip(
      opps.length > 0
        ? `PoE Arb — ${opps.length} opps — best ${opps[0].actualMarginPct >= 0 ? '+' : ''}${opps[0].actualMarginPct.toFixed(1)}%`
        : 'PoE Arb — no opportunities found'
    );
  } catch (err) {
    console.error('[main] Fetch error:', err.message);
    lastError = err.message;
    tray.setToolTip(`PoE Arb — Error: ${err.message}`);
  } finally {
    isLoading = false;
    sendDataToRenderer();
  }
}

function opPairKey(op) {
  const currencies = op.type === '3hop'
    ? [op.fromCurrency, op.viaCurrency, op.viaCurrency2]
    : [op.fromCurrency, op.viaCurrency];
  return currencies.sort().join('|||');
}

function maybeNotify(opps) {
  if (!Notification.isSupported()) return;
  const muted     = store.get('notificationsMuted', false);
  const threshold = store.get('notificationThreshold', 2.0);

  const nowAbove  = opps.filter(op => op.actualMarginPct >= threshold);
  const nowKeys   = new Set(nowAbove.map(opPairKey));

  if (!muted) {
    const newOnes = nowAbove.filter(op => !prevNotifiableKeys.has(opPairKey(op)));
    if (newOnes.length > 0) {
      const best = newOnes[0];
      const sign = best.actualMarginPct >= 0 ? '+' : '';
      const chain = best.type === '3hop'
        ? `${best.fromCurrency} → ${best.viaCurrency} → ${best.viaCurrency2}`
        : `${best.fromCurrency} ⇄ ${best.viaCurrency}`;
      const n = new Notification({
        title: `PoE Arb — ${newOnes.length} new opportunit${newOnes.length === 1 ? 'y' : 'ies'}`,
        body: `${chain}: ${sign}${best.actualMarginPct.toFixed(1)}% margin`,
        silent: false,
      });
      n.on('click', () => { if (mainWindow) { positionWindow(); mainWindow.show(); mainWindow.focus(); } });
      n.show();
    }
  }

  // Always update prev set so unmuting doesn't flood stale notifications
  prevNotifiableKeys = nowKeys;
}

function sendDataToRenderer() {
  if (!mainWindow || !mainWindow.isVisible()) return;
  mainWindow.webContents.send('data-update', buildPayload());
}

function buildPayload() {
  return {
    opportunities: cachedOpportunities,
    loading: isLoading,
    lastUpdated,
    error: lastError,
    league: store.get('league', DEFAULT_LEAGUE),
  };
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const ms = store?.get('refreshIntervalMs', REFRESH_INTERVAL_MS) ?? REFRESH_INTERVAL_MS;
  refreshTimer = setInterval(fetchData, ms);
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('get-data',    ()              => buildPayload());
ipcMain.handle('get-leagues', ()              => KNOWN_LEAGUES);
ipcMain.handle('close-window',()              => { if (mainWindow) mainWindow.hide(); });
ipcMain.handle('open-devtools',()             => { if (mainWindow) mainWindow.webContents.openDevTools({ mode: 'detach' }); });

ipcMain.handle('refresh', () => { fetchData(); return { ok: true }; });

ipcMain.handle('set-league', (_event, league) => {
  store.set('league', league);
  updateTrayMenu();
  fetchData();
  return { ok: true };
});

// Open a URL in the user's default browser
ipcMain.handle('open-url', (_event, url) => {
  // Whitelist: only allow poe.ninja and pathofexile.com
  if (/^https:\/\/([\w-]+\.)?poe\.ninja\//.test(url) ||
      /^https:\/\/([\w-]+\.)?pathofexile\.com\//.test(url)) {
    shell.openExternal(url);
  }
  return { ok: true };
});

// ─── Generic prefs IPC ───────────────────────────────────────────────────────
ipcMain.handle('get-pref', (_event, key, def) => store.get(key, def));
ipcMain.handle('set-pref', (_event, key, val) => { store.set(key, val); return { ok: true }; });

// ─── Refresh interval IPC ────────────────────────────────────────────────────
ipcMain.handle('set-refresh-interval', (_event, ms) => {
  store.set('refreshIntervalMs', ms);
  scheduleRefresh(); // restart timer immediately with new interval
  return { ok: true };
});

// ─── Notifications mute IPC ───────────────────────────────────────────────────
ipcMain.handle('set-notifications-muted', (_event, muted) => {
  store.set('notificationsMuted', muted);
  updateTrayMenu(); // reflect mute state in tray
  return { ok: true };
});

// ─── Blacklist IPC ────────────────────────────────────────────────────────────
ipcMain.handle('get-blacklist', () => {
  return store.get('blacklist', []);
});

ipcMain.handle('add-to-blacklist', (_event, key) => {
  const bl = store.get('blacklist', []);
  if (!bl.includes(key)) {
    bl.push(key);
    store.set('blacklist', bl);
  }
  return { ok: true };
});

ipcMain.handle('remove-from-blacklist', (_event, key) => {
  const bl = store.get('blacklist', []).filter(k => k !== key);
  store.set('blacklist', bl);
  return { ok: true };
});
