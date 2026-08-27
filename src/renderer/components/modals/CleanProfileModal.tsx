// ---------------------------------------------------------------------------
// CleanProfileModal.tsx  — batch "Clean Profile Storage" prompt, opened from
// the row context menu. Offers the two profileOptimizer.ts modes as radio
// options and reports freed disk space / per-account failures on completion.
// ---------------------------------------------------------------------------
import { useState } from 'react'
import { Sparkles, AlertTriangle } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'
import type { CleanMode } from '../../../types/profileOptimizer'

export function CleanProfileModal({
  accountIds,
  onClose
}: {
  accountIds: number[] | null
  onClose: () => void
}): React.JSX.Element | null {
  const showToast = useAccountStore((s) => s.showToast)
  const refresh = useAccountStore((s) => s.refresh)
  const [mode, setMode] = useState<CleanMode>('safe_fb_only')
  const [running, setRunning] = useState(false)

  if (!accountIds) return null
  const count = accountIds.length

  const run = async (): Promise<void> => {
    if (mode === 'full_wipe') {
      const ok = confirm(
        `Full Wipe will permanently erase the entire local profile for ${count} account(s) — cookies, cache, and the saved login session. Each account will need to log in again. Continue?`
      )
      if (!ok) return
    }
    setRunning(true)
    try {
      const summary = await window.api.profiles.clean(accountIds, mode)
      showToast(
        mode === 'full_wipe'
          ? `Wiped ${summary.succeeded}/${summary.total} profile(s).`
          : `Cleaned ${summary.succeeded}/${summary.total} profile(s) — freed ${summary.freedSpaceMB} MB.`,
        6000
      )
      await refresh()
      onClose()
    } finally {
      setRunning(false)
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Clean Profile Storage"
      icon={Sparkles}
      width="max-w-md"
      footer={
        <>
          <button className="win-btn" onClick={onClose} disabled={running}>
            Cancel
          </button>
          <button
            className={mode === 'full_wipe' ? 'win-btn bg-[#c81e1e] text-white hover:bg-[#a81818]' : 'win-btn-accent'}
            onClick={() => void run()}
            disabled={running}
          >
            {running ? 'Cleaning…' : '🧹 Run Clean'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[12px]">
        <p className="text-slate-600">
          Target: <b>{count}</b> account(s).
        </p>

        <label
          className={`flex cursor-pointer flex-col gap-1 rounded border px-3 py-2.5 ${
            mode === 'safe_fb_only' ? 'border-[#1e9e4a] bg-[#eafaf0]' : 'border-slate-300 bg-white'
          }`}
        >
          <span className="flex items-center gap-2 font-medium text-slate-800">
            <input
              type="radio"
              name="clean-mode"
              checked={mode === 'safe_fb_only'}
              onChange={() => setMode('safe_fb_only')}
            />
            🟢 Optimize &amp; Keep Facebook Login (Recommended)
          </span>
          <span className="pl-5 text-slate-500">
            Clears cache, logs, and crash-reporting bloat — frees the majority of a profile's disk
            usage while the account stays logged in.
          </span>
        </label>

        <label
          className={`flex cursor-pointer flex-col gap-1 rounded border px-3 py-2.5 ${
            mode === 'full_wipe' ? 'border-[#c81e1e] bg-[#fdecec]' : 'border-slate-300 bg-white'
          }`}
        >
          <span className="flex items-center gap-2 font-medium text-slate-800">
            <input
              type="radio"
              name="clean-mode"
              checked={mode === 'full_wipe'}
              onChange={() => setMode('full_wipe')}
            />
            🔴 Full Wipe / Reset Profile
          </span>
          <span className="pl-5 text-slate-500">
            Completely erases the profile folder — all cookies, cache, and the local session.
            The account will need to log in again.
          </span>
        </label>

        {mode === 'full_wipe' && (
          <div className="flex items-start gap-2 rounded border border-[#e8b4b4] bg-[#fdecec] px-3 py-2 text-[11px] text-[#c81e1e]">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>This cannot be undone. Only use this if the profile is corrupted or you want a clean slate.</span>
          </div>
        )}

        <p className="text-[11px] text-slate-400">
          A profile currently open in a browser window is skipped automatically — close it first to
          clean that account.
        </p>
      </div>
    </ModalShell>
  )
}
