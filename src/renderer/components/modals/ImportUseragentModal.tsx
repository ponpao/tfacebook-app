// ---------------------------------------------------------------------------
// ImportUseragentModal.tsx  — paste a User-Agent list and distribute it
// across the selected accounts (sequential / random / shared-per-N).
// ---------------------------------------------------------------------------
import { useState } from 'react'
import { Upload, Zap } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'
import type { ProxyAssignMode } from '../../../types/marketing'
import { generateUserAgents } from '../../utils/userAgentGenerator'

export function ImportUseragentModal({
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

  const autoGenerate = (): void => {
    const generated = generateUserAgents(60)
    setText(generated.join('\n'))
    showToast(`Generated ${generated.length} realistic User-Agent strings.`)
  }

  const apply = async (): Promise<void> => {
    const ids = selectedIds()
    if (ids.length === 0) {
      showToast('Select at least one account first.')
      return
    }
    if (lines.length === 0) {
      showToast('Paste at least one User-Agent string.')
      return
    }
    setBusy(true)
    try {
      const res = await window.api.accounts.assignUseragents({
        accountIds: ids,
        userAgents: lines,
        mode,
        sharePerN
      })
      showToast(`Assigned User-Agents to ${res.assigned} account(s).`)
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
      title="Import Useragent"
      icon={Upload}
      width="max-w-xl"
      footer={
        <>
          <span className="mr-auto text-[11px] text-slate-500">
            {count} account(s) selected · {lines.length} User-Agent line(s)
          </span>
          <button className="win-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="win-btn-accent" onClick={() => void apply()} disabled={busy}>
            {busy ? 'Applying…' : 'Assign User-Agents'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[12px]">
        <button
          className="win-btn-accent w-full justify-center py-1.5 text-[13px] font-semibold"
          onClick={autoGenerate}
        >
          <Zap size={14} className="fill-current" />
          Auto-Generate Realistic Useragents
        </button>

        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-slate-700">User-Agent list (one per line)</span>
          <textarea
            className="h-40 resize-none rounded border border-slate-300 bg-white p-2 font-mono text-[11px] text-slate-900 outline-none focus:border-[#0078d4]"
            placeholder={
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>

        <fieldset className="win-fieldset flex flex-wrap items-center gap-4">
          <legend>Assignment Mode</legend>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="ua-mode"
              checked={mode === 'sequential'}
              onChange={() => setMode('sequential')}
            />
            Assign 1:1 sequentially
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="ua-mode"
              checked={mode === 'random'}
              onChange={() => setMode('random')}
            />
            Random assignment
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="ua-mode"
              checked={mode === 'shared'}
              onChange={() => setMode('shared')}
            />
            Share 1 User-Agent per
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
