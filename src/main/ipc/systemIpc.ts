// ---------------------------------------------------------------------------
// systemIpc.ts  — OS-level integrations that don't belong to any single
// domain repo/automation module.
//   * Clipboard access: routing copy-to-clipboard through the main process
//     (Electron's `clipboard` module) rather than the renderer's
//     `navigator.clipboard`, since the renderer API can silently no-op when
//     the window doesn't have focus (e.g. copying from a context menu
//     action right after a click moved focus elsewhere).
//   * App version: exposes Electron's own app.getVersion() (which reads the
//     packaged app's package.json — the single source of truth already
//     bumped on every release) so the UI never has a second, driftable
//     hardcoded copy of the version number.
//   * Auto Shutdown PC (General Settings): schedules/cancels a real OS
//     shutdown via Windows' own `shutdown` command — the countdown dialog
//     itself lives in the renderer (AutoShutdownDialog.tsx), this just
//     executes/cancels the actual command since a renderer can't spawn
//     processes directly.
// ---------------------------------------------------------------------------
import { ipcMain, clipboard, app, shell } from 'electron'
import { exec } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import { IPC } from './channels'

export function registerSystemIpcHandlers(): void {
  ipcMain.handle(IPC.system.clipboardWriteText, (_e, text: string) => {
    clipboard.writeText(text ?? '')
    return true
  })

  ipcMain.handle(IPC.system.getAppVersion, () => app.getVersion())

  ipcMain.handle(IPC.system.scheduleShutdown, (_e, seconds: number) => {
    if (process.platform !== 'win32') {
      return { ok: false, message: 'Auto Shutdown is only supported on Windows.' }
    }
    exec(`shutdown /s /t ${Math.max(0, Math.floor(seconds))}`, (err) => {
      if (err) console.error('[shutdown] schedule failed:', err.message)
    })
    return { ok: true }
  })

  ipcMain.handle(IPC.system.cancelShutdown, () => {
    if (process.platform !== 'win32') return { ok: false }
    exec('shutdown /a', (err) => {
      // ERROR_NOT_FOUND (1116) just means nothing was scheduled to cancel —
      // not a real failure worth surfacing.
      if (err && !err.message.includes('1116')) console.error('[shutdown] cancel failed:', err.message)
    })
    return { ok: true }
  })

  ipcMain.handle(IPC.system.checkFont, async () => {
    if (process.platform !== 'win32') return { installed: true }
    try {
      const userFonts = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Windows', 'Fonts')
      const winFonts = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
      const hasReg =
        existsSync(join(userFonts, 'KantumruyPro-Regular.ttf')) ||
        existsSync(join(winFonts, 'KantumruyPro-Regular.ttf')) ||
        existsSync(join(winFonts, 'KantumruyPro.ttf'))
      return { installed: hasReg }
    } catch {
      return { installed: false }
    }
  })

  ipcMain.handle(IPC.system.installFont, async () => {
    if (process.platform !== 'win32') {
      return { ok: false, message: 'Font installation is only supported on Windows.' }
    }
    try {
      const userFontsDir = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Windows', 'Fonts')
      if (!existsSync(userFontsDir)) {
        await fs.mkdir(userFontsDir, { recursive: true })
      }

      const candidateDirs = [
        join(process.cwd(), 'resources', 'fonts'),
        join(app.getAppPath(), 'resources', 'fonts'),
        join(process.resourcesPath ?? '', 'fonts'),
        join(process.resourcesPath ?? '', 'app.asar.unpacked', 'resources', 'fonts')
      ]

      let fontDir = ''
      for (const dir of candidateDirs) {
        if (existsSync(join(dir, 'KantumruyPro-Regular.ttf'))) {
          fontDir = dir
          break
        }
      }

      if (!fontDir) {
        return { ok: false, message: 'Font files not found in application directory.' }
      }

      const regSrc = join(fontDir, 'KantumruyPro-Regular.ttf')
      const boldSrc = join(fontDir, 'KantumruyPro-Bold.ttf')
      const regDst = join(userFontsDir, 'KantumruyPro-Regular.ttf')
      const boldDst = join(userFontsDir, 'KantumruyPro-Bold.ttf')

      await fs.copyFile(regSrc, regDst)
      if (existsSync(boldSrc)) {
        await fs.copyFile(boldSrc, boldDst)
      }

      // Register font for the current user in Windows Registry
      exec(
        `reg add "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts" /v "Kantumruy Pro (TrueType)" /t REG_SZ /d "KantumruyPro-Regular.ttf" /f`
      )
      exec(
        `reg add "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts" /v "Kantumruy Pro Bold (TrueType)" /t REG_SZ /d "KantumruyPro-Bold.ttf" /f`
      )

      // Also trigger open in Windows font viewer for direct confirmation
      void shell.openPath(regDst)

      return { ok: true, message: 'Kantumruy Pro installed successfully!' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `Font installation failed: ${message}` }
    }
  })
}
