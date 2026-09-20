// ---------------------------------------------------------------------------
// ImportNoteModal.tsx — paste one note for all selected rows, or one line
// per selected row (grid order). Writes the existing accounts.notes column.
// ---------------------------------------------------------------------------
import { useState } from 'react'
import { StickyNote } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'
import { planNoteImport } from '../../utils/importNotes'
import type { Account } from '../../../types/account'

export function ImportNoteModal({
  accounts,
  onClose
}: {
  accounts: Account[] | null
  onClose: () => void
}): React.JSX.Element | null {
  const showToast = useAccountStore((s) => s.showToast)
  const refresh = useAccountStore((s) => s.refresh)
  const applyAccountUpdate = useAccountStore((s) => s.applyAccountUpdate)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

  if (!accounts) return null

  const plan = planNoteImport(text, accounts.length)
  const mismatch = plan.mode === 'mismatch'
  const canApply = plan.mode !== 'empty'

  const apply = async (): Promise<void> => {
    if (plan.mode === 'empty') return
    setSaving(true)
    try {
      let n = 0
      if (plan.mode === 'broadcast') {
        n = await window.api.accounts.bulkSetField(
          'notes',
          accounts.map((a) => a.id),
          plan.note
        )
      } else {
        const slice = plan.mode === 'per_row' ? plan.notes : plan.notes.slice(0, accounts.length)
        const assignments = slice.map((value, i) => ({ id: accounts[i].id, value }))
        n = await window.api.accounts.bulkAssign('notes', assignments)
      }
      for (const a of accounts.slice(0, n || accounts.length)) {
        const fresh = await window.api.accounts.get(a.id)
        if (fresh) applyAccountUpdate(fresh)
      }
      showToast(`Imported notes on ${n} account(s).`)
      await refresh()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Import Note"
      icon={StickyNote}
      width="max-w-md"
      height="h-auto max-h-[88vh]"
      footer={
        <>
          <button className="win-btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="win-btn-accent"
            onClick={() => void apply()}
            disabled={saving || !canApply}
          >
            {saving ? 'Applying…' : mismatch ? 'Apply first ' + plan.notes.length + ' only' : 'Apply'}
          </button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5 text-[12px]">
        <span className="font-medium text-ink">Paste note(s) here...</span>
        <textarea
          autoFocus
          className="win-input min-h-[120px] resize-y"
          placeholder={'One note for every selected account\nor\none line per selected account'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <p className="mt-2 text-[11px] text-ink-muted">
        {accounts.length} account{accounts.length === 1 ? '' : 's'} selected. One non-empty line
        applies to all; one line per account assigns in grid order.
      </p>
      {mismatch && (
        <p className="mt-2 rounded-md border border-[#c98a00]/40 bg-[#c98a00]/10 px-2 py-1.5 text-[12px] text-[#c98a00]">
          Selected {plan.selected} accounts but received {plan.notes.length} note lines.
        </p>
      )}
    </ModalShell>
  )
}
