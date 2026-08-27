// ---------------------------------------------------------------------------
// Electron main process entry point.
// ---------------------------------------------------------------------------
import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { appendFileSync } from 'fs'
import { config as loadDotenv } from 'dotenv'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase, closeDatabase } from './db/database'
import { registerIpcHandlers } from './ipc/registerHandlers'
import { initAutoUpdater } from './updater'

// Load project-root .env (dev only — a packaged build ships no .env, and
// Cloud Sync falls back to a key file under app.getPath('userData') instead;
// see firebaseConfig.ts). Must run before any other module reads
// process.env, so this stays the very first thing this file does.
loadDotenv({ path: join(__dirname, '../../.env') })

// Packaged builds pick up build/icon.ico via electron-builder's `win.icon`
// automatically; this path only matters for `npm run dev`/unpackaged runs,
// where BrowserWindow's own `icon` option is what sets the taskbar/title-bar
// icon. Resolved relative to the compiled main bundle (out/main), so it
// walks up to the project root the same way in both dev and a local preview.
const appIconPath = join(__dirname, '../../build/icon.ico')

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

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
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

  mainWindow.on('ready-to-show', () => mainWindow.show())

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

  // Boot the database and IPC layer before opening a window.
  initDatabase()
  registerIpcHandlers()
  initAutoUpdater()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  closeDatabase()
})
