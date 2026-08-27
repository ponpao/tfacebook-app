// ---------------------------------------------------------------------------
// ImportProxyModal.tsx  — paste a proxy list and distribute it across the
// selected accounts (sequential / random / shared-per-N).
// ---------------------------------------------------------------------------
import { useState } from 'react'
import { Globe } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'
import type { ProxyAssignMode } from '../../../types/marketing'

export function ImportProxyModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const selectedIds = useAccountStore((s) => s.selectedIds)
  const showToast = useAccountStore((s) => s.showToast)
  const refresh = useAccountStore((s) => s.refresh)

  const [text, setText] = useState('')
  const [mode, setMode] = useState<ProxyAssignMode>('sequential')
  const [sharePerN, setSharePerN] = useState(2)
  const [busy, setBusy] = useState(false)

  const count = selectedIds().length
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

  const apply = async (): Promise<void> => {
    const ids = selectedIds()
    if (ids.length === 0) {
      showToast('Select at least one account first.')
      return
    }
    if (lines.length === 0) {
      showToast('Paste at least one proxy.')
      return
    }
    setBusy(true)
    try {
      const res = await window.api.accounts.assignProxies({
        accountIds: ids,
        proxies: lines,
        mode,
        sharePerN
      })
      showToast(`Assigned proxies to ${res.assigned} account(s).`)
      await refresh()
      onClose()
      setText('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Import Proxy"
      icon={Globe}
      width="max-w-xl"
      footer={
        <>
          <span className="mr-auto text-[11px] text-slate-500">
            {count} account(s) selected · {lines.length} proxy line(s)
          </span>
          <button className="win-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="win-btn-accent" onClick={() => void apply()} disabled={busy}>
            {busy ? 'Applying…' : 'Assign Proxies'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[12px]">
        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-slate-700">
            Proxy list (one per line — ip:port, ip:port:user:pass, or socks5://...)
          </span>
          <textarea
            className="h-40 resize-none rounded border border-slate-300 bg-white p-2 font-mono text-[12px] text-slate-900 outline-none focus:border-[#0078d4]"
            placeholder={'192.168.1.10:8080\n192.168.1.11:8080:user:pass\nsocks5://user:pass@10.0.0.1:1080'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>

        <fieldset className="win-fieldset flex flex-wrap items-center gap-4">
          <legend>Assignment Mode</legend>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="proxy-mode"
              checked={mode === 'sequential'}
              onChange={() => setMode('sequential')}
            />
            Assign 1:1 sequentially
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="proxy-mode"
              checked={mode === 'random'}
              onChange={() => setMode('random')}
            />
            Random assignment
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="proxy-mode"
              checked={mode === 'shared'}
              onChange={() => setMode('shared')}
            />
            Share 1 proxy per
            <input
              type="number"
              min={1}
              max={100}
              className="win-input w-14 text-center"
              value={sharePerN}
              onChange={(e) => setSharePerN(Number(e.target.value))}
              disabled={mode !== 'shared'}
            />
            accounts
          </label>
        </fieldset>
      </div>
    </ModalShell>
  )
}
