// ---------------------------------------------------------------------------
// SetNotesModal.tsx  — batch "Set Notes" prompt, opened from the row context
// menu. Applies the entered text as `notes` on every account id passed in.
// ---------------------------------------------------------------------------
import { useState } from 'react'
import { StickyNote } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'

export function SetNotesModal({
  accountIds,
  onClose
}: {
  accountIds: number[] | null
  onClose: () => void
}): React.JSX.Element | null {
  const showToast = useAccountStore((s) => s.showToast)
  const refresh = useAccountStore((s) => s.refresh)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

  if (!accountIds) return null

  const apply = async (): Promise<void> => {
    setSaving(true)
    try {
      const n = await window.api.accounts.bulkSetField('notes', accountIds, text)
      showToast(`Set notes on ${n} account(s).`)
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
      title="Set Notes (Batch)"
      icon={StickyNote}
      width="max-w-md"
      footer={
        <>
          <button className="win-btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="win-btn-accent" onClick={() => void apply()} disabled={saving}>
            {saving ? 'Applying…' : 'Apply'}
          </button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5 text-[12px]">
        <span className="font-medium text-slate-700">
          Notes text — applied to {accountIds.length} account(s)
        </span>
        <textarea
          autoFocus
          className="win-input min-h-[80px] resize-y"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
    </ModalShell>
  )
}
