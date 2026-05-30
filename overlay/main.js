'use strict'

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron')
const { OverlayController, OVERLAY_WINDOW_OPTS } = require('electron-overlay-window')
const { uIOhook, UiohookKey } = require('uiohook-napi')
const { spawn } = require('child_process')
const http = require('http')
const path = require('path')

// ---------------------------------------------------------------------------
// Config — override via env vars
// ---------------------------------------------------------------------------
const FLASK_PORT    = parseInt(process.env.FLASK_PORT    || '5000', 10)
// PoE2 standalone + Steam both use "Path of Exile 2".
// PoE1 standalone = "Path of Exile", Steam = "Path of Exile" as well.
// Override with POE_WINDOW env var if your client uses a different title.
const POE_WINDOW    = process.env.POE_WINDOW             || 'Path of Exile 2'
// F9 toggles overlay. Change to UiohookKey.F8, .Home, etc. as desired.
const TOGGLE_KEY    = parseInt(process.env.TOGGLE_KEYCODE || UiohookKey.F9, 10)

// ---------------------------------------------------------------------------
// Resolve the Flask backend root — works both in dev and when packaged
// ---------------------------------------------------------------------------
const BACKEND_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'backend')
  : path.join(__dirname, '..')

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let win           = null
let tray          = null
let flask         = null
let isInteractable = false
let gameIsFocused  = false

// ---------------------------------------------------------------------------
// Flask lifecycle
// ---------------------------------------------------------------------------

function spawnFlask() {
  const isPackaged = app.isPackaged
  let cmd, args, cwd

  if (isPackaged) {
    // Use the PyInstaller-bundled exe — no Python needed on friends' machines
    cmd = path.join(process.resourcesPath, 'poe-arb-server.exe')
    args = []
    cwd = process.resourcesPath
  } else {
    cmd = 'python'
    args = ['app.py']
    cwd = BACKEND_ROOT
  }

  console.log('[overlay] spawning Flask:', cmd)
  flask = spawn(cmd, args, {
    cwd,
    env: {
      ...process.env,
      BIND_ALL_INTERFACES: 'false',
      FLASK_PORT: String(FLASK_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  flask.stdout.on('data', d => process.stdout.write('[flask] ' + d))
  flask.stderr.on('data', d => process.stderr.write('[flask] ' + d))
  flask.on('exit', code => {
    console.log('[flask] exited with code', code)
    flask = null
  })
}

function waitForFlask(retries = 40) {
  return new Promise((resolve, reject) => {
    let attempts = 0
    const check = () => {
      const req = http.get(
        `http://127.0.0.1:${FLASK_PORT}/api/status`,
        res => { if (res.statusCode === 200) resolve(); else retry() }
      )
      req.on('error', retry)
      req.setTimeout(400, () => { req.destroy(); retry() })
    }
    const retry = () => {
      if (++attempts >= retries) return reject(new Error('Flask did not start'))
      setTimeout(check, 500)
    }
    check()
  })
}

// ---------------------------------------------------------------------------
// Overlay window
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    ...OVERLAY_WINDOW_OPTS,
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  win.loadURL(`http://127.0.0.1:${FLASK_PORT}`)

  // Attach to game window by title
  OverlayController.attachByTitle(win, POE_WINDOW)

  // Track whether the game window is currently focused
  OverlayController.events.on('focus', () => {
    gameIsFocused = true
  })
  OverlayController.events.on('blur', () => {
    gameIsFocused = false
    // Auto-hide overlay if the game loses focus
    if (isInteractable) setInteractable(false)
  })

  // Escape from within overlay → return to game
  win.webContents.on('before-input-event', (_event, input) => {
    if (isInteractable && input.type === 'keyDown' && input.key === 'Escape') {
      setInteractable(false)
    }
  })

  // Start in click-through mode
  setInteractable(false)

  win.webContents.on('did-finish-load', () => {
    console.log('[overlay] page loaded')
  })
}

function setInteractable(value) {
  isInteractable = value
  if (value) {
    win.setIgnoreMouseEvents(false)
    OverlayController.activateOverlay()
    console.log('[overlay] overlay active')
  } else {
    win.setIgnoreMouseEvents(true, { forward: true })
    OverlayController.focusTarget()
    console.log('[overlay] game active')
  }
}

// ---------------------------------------------------------------------------
// Global hotkey (works while game is focused)
// ---------------------------------------------------------------------------

function setupHotkey() {
  uIOhook.on('keydown', e => {
    if (e.keycode === TOGGLE_KEY) {
      setInteractable(!isInteractable)
    }
  })
  uIOhook.start()
  console.log(`[overlay] hotkey registered (keycode ${TOGGLE_KEY} = F9 by default)`)
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------

function createTray() {
  // Use an empty image — replace with a real icon if desired
  tray = new Tray(nativeImage.createEmpty())
  tray.setToolTip(`poe-arb  |  F9 to toggle overlay`)
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open in browser',
      click: () => shell.openExternal(`http://127.0.0.1:${FLASK_PORT}`),
    },
    { type: 'separator' },
    { label: 'Quit poe-arb', click: () => app.quit() },
  ]))
  tray.on('double-click', () => {
    shell.openExternal(`http://127.0.0.1:${FLASK_PORT}`)
  })
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Only one instance at a time
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

app.on('before-quit', () => {
  try { uIOhook.stop() } catch (_) {}
  if (flask) { flask.kill(); flask = null }
})

// Keep alive — no quit on all-windows-closed (overlay window may be hidden)
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  try {
    spawnFlask()
    console.log('[overlay] waiting for Flask...')
    await waitForFlask()
    console.log('[overlay] Flask ready')

    createWindow()
    setupHotkey()
    createTray()
  } catch (err) {
    console.error('[overlay] startup failed:', err)
    app.quit()
  }
})
