// ---------------------------------------------------------------------------
// Electron main process entry point.
// ---------------------------------------------------------------------------
import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { appendFileSync, existsSync } from 'fs'
import { config as loadDotenv } from 'dotenv'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase, closeDatabase } from './db/database'
import { registerIpcHandlers } from './ipc/registerHandlers'
import { initAutoUpdater } from './updater'
import { startNetworkWatchdog } from './services/networkWatchdog'
import { registerAvatarProtocolScheme, registerAvatarProtocolHandler } from './services/avatarProtocol'

// Must run at module load, before app.whenReady() — Electron only accepts
// privileged scheme registration (avatar://) at that point, not inside the
// ready callback. Doesn't read process.env, so its position relative to
// loadDotenv() below doesn't matter.
registerAvatarProtocolScheme()

// Load project-root .env (dev only — a packaged build ships no .env, and
// Cloud Sync falls back to a key file under app.getPath('userData') instead;
// see firebaseConfig.ts). Must run before any other module reads
// process.env — quiet: true suppresses dotenv's own console output
// (including its rotating self-promotional "tip" messages), since this is a
// GUI app with no visible console in a packaged build.
loadDotenv({ path: join(__dirname, '../../.env'), quiet: true })

// Packaged builds pick up build/icon.ico via electron-builder's `win.icon`
// automatically; this path only matters for `npm run dev`/unpackaged runs,
// where BrowserWindow's own `icon` option is what sets the taskbar/title-bar
// icon. Resolved relative to the compiled main bundle (out/main), so it
// walks up to the project root the same way in both dev and a local preview.
const appIconPath = join(__dirname, '../../build/icon.ico')

// splash.html is a plain static file, not a bundled entry point, so
// electron-vite's build never copies it into out/main/ on its own —
// scripts/postbuild.cjs copies it there for `npm run build`/packaged
// builds. `npm run dev` never runs postbuild.cjs at all, so this falls
// back to the source file directly (src/main/splash.html) in that case —
// resolved relative to the compiled bundle either way, so both paths work
// regardless of dev vs. packaged.
const splashHtmlPath = existsSync(join(__dirname, 'splash.html'))
  ? join(__dirname, 'splash.html')
  : join(__dirname, '../../src/main/splash.html')

// This is a GUI-subsystem app with no attached console, so an uncaught error
// in the main process would otherwise fail silently (window never appears,
// process just exits). Log it to disk so it's diagnosable post-mortem.
function logFatal(label: string, err: unknown): void {
  try {
    const line = `[${new Date().toISOString()}] ${label}: ${err instanceof Error ? err.stack : err}\n`
    appendFileSync(join(app.getPath('userData'), 'crash.log'), line)
  } catch {
    /* nothing more we can do */
  }
}
process.on('uncaughtException', (err) => logFatal('uncaughtException', err))
process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason))

/**
 * Frameless, transparent splash shown immediately on launch — before the
 * database/IPC layer boots and before the (much heavier) main window's own
 * renderer bundle finishes loading. Purely cosmetic: the 4 progress labels
 * inside splash.html are spread evenly across a fixed 10s timer (2.5s per
 * stage), not tied to any real init signal — the actual startup work
 * (initDatabase, registerIpcHandlers, etc.) all runs synchronously and
 * finishes in well under a second, so there's no meaningful "slow step" to
 * report progress against. The main window's own show is deliberately
 * delayed by the same 10s (see SPLASH_DURATION_MS below) so the splash's
 * animation always has time to run to completion before it's replaced.
 */
function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 540,
    height: 280,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    show: false,
    center: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      // Static, local, no app data or IPC involved — plain defaults are
      // fine here; no preload needed for a fire-and-forget splash.
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  splash.once('ready-to-show', () => splash.show())
  splash.loadFile(splashHtmlPath, { query: { v: app.getVersion() } })
  return splash
}

function createWindow(splash: BrowserWindow): void {
  const mainWindow = new BrowserWindow({
    // Fixed, non-resizable window — the redesigned toolbar/table layout is
    // tuned to this exact size, so locking it out avoids ever needing to
    // reflow around an arbitrary window size again. resizable: false also
    // implies non-maximizable on Windows.
    width: 1280,
    height: 780,
    resizable: false,
    show: false,
    frame: false, // custom WinForms-style title bar
    autoHideMenuBar: true,
    backgroundColor: '#f0f0f0',
    title: 'TFACEBOOK',
    icon: appIconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Coordinated splash → main-window handoff: wait a fixed 10s once the
  // main window is actually ready to paint (not just loaded — ready-to-show
  // fires after the first real frame) so the splash's own progress
  // bar/status-label animation (also tuned to exactly 10s — see
  // splash.html) has time to run to completion before the main window
  // takes over. If the splash was already closed for some other reason
  // (e.g. it was never created), showing the main window still proceeds
  // normally.
  const SPLASH_DURATION_MS = 10000
  mainWindow.once('ready-to-show', () => {
    setTimeout(() => {
      mainWindow.show()
      if (!splash.isDestroyed()) splash.close()
    }, SPLASH_DURATION_MS)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer in dev, built file in prod.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.tfacebook.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Splash appears immediately; the (much heavier) main window is created
  // concurrently in the background with show:false, so its own renderer
  // bundle load overlaps with the splash's brief on-screen time instead of
  // happening only after the splash closes.
  const splash = createSplashWindow()

  // Boot the database and IPC layer before opening a window.
  initDatabase()
  registerIpcHandlers()
  initAutoUpdater()
  startNetworkWatchdog()
  registerAvatarProtocolHandler()

  createWindow(splash)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(createSplashWindow())
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  closeDatabase()
})
