// ---------------------------------------------------------------------------
// appPaths.ts — small shared path constants needed by more than one main-
// process module (index.ts's main window AND browserWindowsPanel.ts's
// second window both need the app icon), kept out of index.ts to avoid a
// circular import between it and registerHandlers.ts (which needs this
// path to wire the "open Browser Windows panel" IPC handler).
// ---------------------------------------------------------------------------
import { join } from 'path'

// Packaged builds pick up build/icon.ico via electron-builder's `win.icon`
// automatically; this path only matters for `npm run dev`/unpackaged runs,
// where BrowserWindow's own `icon` option is what sets the taskbar/title-bar
// icon. Resolved relative to the compiled main bundle (out/main), so it
// walks up to the project root the same way in both dev and a local preview.
export const appIconPath = join(__dirname, '../../build/icon.ico')
