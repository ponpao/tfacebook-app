// ---------------------------------------------------------------------------
// HelpAboutModal.tsx  — app branding, quick docs (hotkeys, thread guidance,
// proxy format), and cache/reset info. Triggered from the top menu bar.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react'
import { Info, RefreshCw, KeyRound } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { AppLogo } from '../AppLogo'
import { useAccountStore } from '../../store/useAccountStore'
import type { LicenseStatus } from '../../../types/license'

/** TFA-XXXX-XXXX-XXXX -> TFA-****-****-XXXX — only the last group stays visible. */
function maskLicenseKey(key: string): string {
  const groups = key.split('-')
  if (groups.length < 2) return key
  return groups.map((g, i) => (i === 0 || i === groups.length - 1 ? g : '*'.repeat(g.length))).join('-')
}

export function HelpAboutModal({
  open,
  onClose,
  onRequireActivation
}: {
  open: boolean
  onClose: () => void
  /** Called after Deactivate — the caller (App.tsx) re-shows the license gate. */
  onRequireActivation: () => void
}): React.JSX.Element | null {
  const showToast = useAccountStore((s) => s.showToast)
  const [checking, setChecking] = useState(false)
  const [license, setLicense] = useState<LicenseStatus | null>(null)
  const [deactivating, setDeactivating] = useState(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    void window.api.license.getStatus().then(setLicense)
    void window.api.system.getAppVersion().then(setAppVersion)
  }, [open])

  const deactivate = async (): Promise<void> => {
    if (deactivating) return
    setDeactivating(true)
    try {
      await window.api.license.deactivate()
      onClose()
      onRequireActivation()
    } finally {
      setDeactivating(false)
    }
  }

  // "Up to date" has no dedicated UI elsewhere (UpdateNotificationModal only
  // reacts to 'update-available') — surface it here as a toast so a manual
  // check always gives some visible result, not just silence when there's
  // nothing new.
  useEffect(() => {
    return window.api.updater.onUpdateNotAvailable(() => {
      showToast("You're already on the latest version.")
    })
  }, [showToast])

  // Opening the actual update UI on an available update is the
  // UpdateNotificationModal's job — it listens for the same
  // 'update-available' event this check triggers, independent of whether
  // this modal is still open. This just surfaces immediate feedback
  // ("checking…", or "no update"/error if that's the outcome) here.
  const checkForUpdates = async (): Promise<void> => {
    setChecking(true)
    try {
      const res = await window.api.updater.check()
      if (!res.ok) showToast(`Update check failed: ${res.error ?? 'unknown error'}`, 6000)
    } finally {
      setChecking(false)
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Help & About"
      icon={Info}
      width="max-w-lg"
      footer={
        <button className="win-btn-accent" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="flex flex-col gap-4 text-[12px]">
        <div className="flex items-center gap-3 border-b border-slate-300 pb-3">
          <AppLogo size={44} />
          <div className="flex-1">
            <div className="text-[15px] font-bold text-slate-800">
              TFACEBOOK Automation Studio
            </div>
            <div className="text-slate-500">Version {appVersion ?? '…'}</div>
          </div>
          <button className="win-btn" onClick={() => void checkForUpdates()} disabled={checking}>
            <RefreshCw size={13} className={`text-[#4a6a8a] ${checking ? 'animate-spin' : ''}`} />
            {checking ? 'Checking…' : 'Check for Updates'}
          </button>
        </div>

        <fieldset className="win-fieldset">
          <legend>License</legend>
          {license?.isActivated ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Key</span>
                <code className="font-mono text-[11px] text-slate-800">
                  {license.licenseKey ? maskLicenseKey(license.licenseKey) : '—'}
                </code>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Expires</span>
                <span className="text-slate-800">{license.expiresAt ?? 'Never'}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="shrink-0 text-slate-600">Device Hash</span>
                <code className="truncate font-mono text-[10px] text-slate-500">
                  {license.deviceHash}
                </code>
              </div>
              <button
                type="button"
                className="win-btn mt-1 self-start"
                onClick={() => void deactivate()}
                disabled={deactivating}
              >
                <KeyRound size={12} className="text-[#c81e1e]" />
                {deactivating ? 'Deactivating…' : 'Deactivate / Change Key'}
              </button>
            </div>
          ) : (
            <p className="text-slate-500">Loading license status…</p>
          )}
        </fieldset>

        <fieldset className="win-fieldset">
          <legend>Keyboard Shortcuts</legend>
          <table className="w-full">
            <tbody>
              {[
                ['Escape', 'Close the active modal / context menu'],
                ['Ctrl / Cmd + A', 'Select all rows in the grid (when focused)'],
                ['Delete', 'Move selected accounts to Recycle Bin'],
                ['F5', 'Refresh the accounts grid']
              ].map(([key, desc]) => (
                <tr key={key}>
                  <td className="w-32 py-0.5 pr-2 font-mono text-[11px] text-slate-700">{key}</td>
                  <td className="py-0.5 text-slate-600">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </fieldset>

        <fieldset className="win-fieldset">
          <legend>Thread Recommendations</legend>
          <p className="text-slate-600">
            Run <strong>5–10 concurrent threads</strong> depending on your CPU/RAM — each thread
            opens its own Chrome instance. Lower-end machines (4 cores / 8GB RAM) should stay
            closer to 2–4; a strong workstation (8+ cores / 16GB+ RAM) can comfortably handle
            8–10. Running more than your hardware supports slows every account down rather than
            speeding the batch up.
          </p>
        </fieldset>

        <fieldset className="win-fieldset">
          <legend>Proxy Formatting</legend>
          <p className="text-slate-600">
            Accepted formats: <code className="rounded bg-slate-200 px-1">ip:port</code> or{' '}
            <code className="rounded bg-slate-200 px-1">ip:port:user:pass</code> for authenticated
            proxies. One proxy per line when importing in bulk.
          </p>
        </fieldset>

        <fieldset className="win-fieldset">
          <legend>Clear Cache / Factory Reset</legend>
          <p className="text-slate-600">
            Browser profiles live under the configured{' '}
            <strong>Chrome Profile Storage Path</strong> (General Settings → Custom Profile
            Directory) — deleting an account's profile folder there resets its browser fingerprint
            and cookies from scratch. To fully reset the app, close it and delete its userData
            folder (<code className="rounded bg-slate-200 px-1">%APPDATA%\TFACEBOOK</code> on
            Windows), which removes the SQLite database, settings, and all local profiles — this
            cannot be undone, so export any accounts you want to keep first.
          </p>
        </fieldset>
      </div>
    </ModalShell>
  )
}
