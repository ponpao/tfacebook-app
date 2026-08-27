// ---------------------------------------------------------------------------
// LicenseGateModal.tsx  — un-dismissible 1-PC-1-License activation lock.
// Rendered instead of the main dashboard (App.tsx) whenever the license
// status check comes back unactivated. No backdrop-click / Escape close —
// this is a hard gate, not a regular modal, so it deliberately does NOT use
// ModalShell (which supports both of those dismiss paths).
// ---------------------------------------------------------------------------
import { useState } from 'react'
import { KeyRound, Copy, Check, AlertTriangle } from 'lucide-react'
import { AppLogo } from './AppLogo'
import type { LicenseStatus } from '../../types/license'

export function LicenseGateModal({
  deviceHash,
  initialMessage,
  onActivated
}: {
  deviceHash: string
  initialMessage?: string
  onActivated: (status: LicenseStatus) => void
}): React.JSX.Element {
  const [licenseKey, setLicenseKey] = useState('')
  const [activating, setActivating] = useState(false)
  const [error, setError] = useState<string | null>(initialMessage ?? null)
  const [copied, setCopied] = useState(false)

  const copyDeviceHash = async (): Promise<void> => {
    try {
      await window.api.system.clipboardWriteText(deviceHash)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard failure isn't worth surfacing here — the hash is still visible to select manually */
    }
  }

  const formatKeyInput = (raw: string): string => {
    // Auto-format as TFA-XXXX-XXXX-XXXX while typing — strip everything but
    // alphanumerics, uppercase it, then re-insert the dashes at fixed offsets.
    const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
    const body = cleaned.startsWith('TFA') ? cleaned.slice(3) : cleaned
    const groups = body.match(/.{1,4}/g) ?? []
    return ['TFA', ...groups.slice(0, 3)].join('-')
  }

  const activate = async (): Promise<void> => {
    if (!licenseKey.trim() || activating) return
    setActivating(true)
    setError(null)
    try {
      const res = await window.api.license.activate(licenseKey.trim())
      if (res.ok && res.status) {
        onActivated(res.status)
      } else {
        setError(res.message ?? 'Activation failed.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActivating(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#0a0e1a]/95 p-6">
      <div className="flex w-full max-w-md flex-col overflow-hidden rounded border border-slate-600 bg-[#f0f2f5] shadow-2xl">
        {/* Header */}
        <div className="flex flex-col items-center gap-2 border-b border-slate-300 bg-white px-6 py-6">
          <AppLogo size={48} />
          <div className="text-[15px] font-bold text-slate-800">TFACEBOOK</div>
          <div className="text-[12px] font-medium text-slate-500">Product Activation Required</div>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5 text-[12px]">
          <p className="text-slate-600">
            This copy of TFACEBOOK is not activated on this PC. Enter a valid license key below to
            unlock the dashboard.
          </p>

          {/* Device ID display */}
          <fieldset className="win-fieldset">
            <legend>Device ID</legend>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded border border-slate-300 bg-white px-2 py-1.5 font-mono text-[11px] text-slate-700">
                {deviceHash}
              </code>
              <button
                type="button"
                className="win-btn shrink-0"
                onClick={() => void copyDeviceHash()}
                title="Copy device ID"
              >
                {copied ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-slate-500">
              Send this Device ID to your admin if you need a license issued for this PC.
            </p>
          </fieldset>

          {/* License key input */}
          <fieldset className="win-fieldset">
            <legend>License Key</legend>
            <input
              type="text"
              className="win-input w-full text-center font-mono tracking-wider"
              placeholder="TFA-XXXX-XXXX-XXXX"
              value={licenseKey}
              maxLength={19}
              onChange={(e) => setLicenseKey(formatKeyInput(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void activate()
              }}
              autoFocus
            />
          </fieldset>

          {error && (
            <div className="flex items-start gap-2 rounded border border-[#e8b4b4] bg-[#fdecec] px-3 py-2 text-[11px] text-[#c81e1e]">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="button"
            className="win-btn-accent flex items-center justify-center gap-2 py-2"
            onClick={() => void activate()}
            disabled={activating || !licenseKey.trim()}
          >
            {activating ? (
              <>
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Activating…
              </>
            ) : (
              <>
                <KeyRound size={14} />
                Activate License
              </>
            )}
          </button>
        </div>

        <div className="border-t border-slate-300 bg-[#f6f6f6] px-6 py-3 text-center text-[11px] text-slate-500">
          Need a license?{' '}
          <a
            href="#"
            className="text-[#0067c0] hover:underline"
            onClick={(e) => {
              e.preventDefault()
              window.api.system.clipboardWriteText(deviceHash).catch(() => void 0)
            }}
          >
            Contact Admin
          </a>
        </div>
      </div>
    </div>
  )
}
