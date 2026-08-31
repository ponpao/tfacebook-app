// ---------------------------------------------------------------------------
// StatusBar.tsx  — fixed bottom footer (WinForms style).
//   Left:  ready status / app version / user
//   Right: Live/Checkpoint/Die status breakdown + highlighted/selected/total
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react'
import { useAccountStore } from '../store/useAccountStore'
import type { LicenseStatus } from '../../types/license'

export function StatusBar(): React.JSX.Element {
  const accounts = useAccountStore((s) => s.accounts)
  const total = useAccountStore((s) => s.total)
  const toast = useAccountStore((s) => s.toast)
  const [license, setLicense] = useState<LicenseStatus | null>(null)
  const [machineId, setMachineId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    void window.api.license.getStatus().then(setLicense)
    void window.api.cloudSync.getMachineId().then(setMachineId)
    void window.api.system.getAppVersion().then(setAppVersion)
  }, [])

  const copyMachineId = async (): Promise<void> => {
    if (!machineId) return
    try {
      await navigator.clipboard.writeText(machineId)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard access denied — the id is still visible to select/copy manually */
    }
  }

  const selectedCount = useAccountStore((s) => {
    let c = 0
    for (const k in s.rowSelection) {
      if (s.rowSelection[k]) c++
    }
    return c
  })

  const statusCounts = useMemo(() => {
    let live = 0
    let checkpoint = 0
    let die = 0
    for (const a of accounts) {
      if (a.status === 'Live') live += 1
      else if (a.status === 'Checkpoint') checkpoint += 1
      else if (a.status === 'Die') die += 1
    }
    return { live, checkpoint, die }
  }, [accounts])

  return (
    <div className="flex items-center justify-between border-t border-[#c8c8c8] bg-[#f0f0f0] px-3 py-1 text-[11px] text-[#333]">
      {/* Left */}
      <div className="flex items-center gap-3">
        {toast ? (
          <span className="font-semibold text-[#0067c0]">{toast}</span>
        ) : (
          <>
            <span>
              Status: <b className="text-[#1e9e4a]">Ready</b>
            </span>
            <span className="text-[#c8c8c8]">|</span>
            <span>App Version: {appVersion ?? '…'}</span>
            <span className="text-[#c8c8c8]">|</span>
            <span>User: Administrator</span>
            <span className="text-[#c8c8c8]">|</span>
            {license?.isActivated ? (
              <span>
                🟢 Licensed{license.expiresAt ? ` | Exp: ${license.expiresAt.slice(0, 10)}` : ''}
              </span>
            ) : (
              <span className="text-[#c81e1e]">🔴 Unlicensed</span>
            )}
            {machineId && (
              <>
                <span className="text-[#c8c8c8]">|</span>
                <span
                  className="cursor-pointer hover:underline"
                  onClick={() => void copyMachineId()}
                  title="Click to copy this PC's Cloud Sync Machine ID"
                >
                  Machine ID: <b className="font-mono">{machineId}</b>{' '}
                  {copied ? (
                    <span className="font-semibold text-[#1e9e4a]">Copied!</span>
                  ) : (
                    <span className="text-[#888]">📋</span>
                  )}
                </span>
              </>
            )}
          </>
        )}
      </div>

      {/* Right */}
      <div className="flex items-center gap-3">
        <span>
          Live: <b className="text-[#1e9e4a]">{statusCounts.live}</b>
        </span>
        <span className="text-[#c8c8c8]">|</span>
        <span>
          Checkpoint: <b className="text-[#c98a00]">{statusCounts.checkpoint}</b>
        </span>
        <span className="text-[#c8c8c8]">|</span>
        <span>
          Die: <b className="text-[#c81e1e]">{statusCounts.die}</b>
        </span>
        <span className="text-[#c8c8c8]">|</span>
        <span>
          Highlighted: <b>{selectedCount}</b>
        </span>
        <span className="text-[#c8c8c8]">|</span>
        <span>
          Selected: <b>{selectedCount}</b>
        </span>
        <span className="text-[#c8c8c8]">|</span>
        <span>
          Total: <b>{accounts.length.toLocaleString()}</b>
          {total !== accounts.length && (
            <span className="text-[#888]"> / {total.toLocaleString()}</span>
          )}
        </span>
      </div>
    </div>
  )
}
