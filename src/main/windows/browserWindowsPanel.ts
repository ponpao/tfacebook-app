// ---------------------------------------------------------------------------
// browserWindowsPanel.ts — creates/focuses the Browser Windows panel as a
// genuinely separate OS window (its own taskbar entry, movable/resizable
// independent of the main app window) rather than a floating div layered
// inside the main window's renderer, per user request.
//
// Reuses the SAME compiled renderer bundle the main window loads
// (out/renderer/index.html) — no second Vite entry point needed. The
// renderer branches at the top of App.tsx on a `?panel=browserWindows`
// query param and renders only <BrowserWindowsModal>, not the full
// Dashboard. The same preload script is reused too, so window.api is
// identical in both windows.
// ---------------------------------------------------------------------------
import { BrowserWindow, app } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

let panel: BrowserWindow | null = null

/**
 * A single-instance window — a second "open panel" request focuses the
 * existing one instead of spawning a duplicate, same as double-clicking a
 * taskbar icon for an already-open program.
 */
export function openBrowserWindowsPanel(appIconPath: string): void {
  if (panel && !panel.isDestroyed()) {
    if (panel.isMinimized()) panel.restore()
    panel.focus()
    return
  }

  panel = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 480,
    minHeight: 360,
    title: 'Browser Windows — TKFACEBOOK',
    icon: appIconPath,
    // Native OS window frame — Windows itself handles drag/resize/minimize/
    // maximize, no custom titlebar code needed (unlike the main window,
    // which is frame:false with its own TitleBar component).
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    panel.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?panel=browserWindows`)
  } else {
    panel.loadFile(join(__dirname, '../renderer/index.html'), { query: { panel: 'browserWindows' } })
  }

  panel.on('closed', () => {
    panel = null
  })
}

/** Closes the panel if open — used on app quit so it doesn't linger as an orphaned window. */
export function closeBrowserWindowsPanel(): void {
  if (panel && !panel.isDestroyed()) panel.close()
}

// Never let this second window keep the app process alive on its own once
// the main window is gone — window-all-closed in index.ts already quits on
// non-macOS when zero windows remain, but explicitly closing the panel on
// quit keeps its lifecycle tidy rather than relying on that alone.
app.on('before-quit', closeBrowserWindowsPanel)
