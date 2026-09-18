// ---------------------------------------------------------------------------
// AssignUrlModal.tsx  — batch "Assign Target URL" prompt, opened from the row
// context menu's 🔗 ដាក់ Link URL action. Single selection: one text input
// pre-filled with the existing target_url. Multiple selections: choose
// between applying the same URL to every selected account, or a multi-line
// list mapped 1:1 to the selected accounts by row order.
// ---------------------------------------------------------------------------
import { useState } from 'react'
import { Link2 } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'
import type { Account } from '../../../types/account'

type Mode = 'same' | 'list'

export function AssignUrlModal({
  accounts,
  onClose
}: {
  /** The target accounts, in the same order they're selected/displayed in the grid — null when the modal is closed. */
  accounts: Account[] | null
  onClose: () => void
}): React.JSX.Element | null {
  const showToast = useAccountStore((s) => s.showToast)
  const refresh = useAccountStore((s) => s.refresh)
  const applyAccountUpdate = useAccountStore((s) => s.applyAccountUpdate)

  // Pre-filled with the existing URL only in the single-account case — with
  // multiple different accounts there's no single existing value to show.
  const [sameUrl, setSameUrl] = useState('')
  const [listText, setListText] = useState('')
  const [mode, setMode] = useState<Mode>('same')
  const [saving, setSaving] = useState(false)
  const [initializedFor, setInitializedFor] = useState<number | null>(null)

  if (!accounts || accounts.length === 0) return null

  // Reset the form's prefill exactly once per modal open (keyed by the first
  // account's id, which is stable for the lifetime of one open) — every
  // render afterward keeps whatever the user is currently typing.
  const openKey = accounts[0].id
  if (initializedFor !== openKey) {
    setInitializedFor(openKey)
    setSameUrl(accounts.length === 1 ? accounts[0].target_url ?? '' : '')
    setListText(accounts.length > 1 ? accounts.map((a) => a.target_url ?? '').join('\n') : '')
    setMode('same')
  }

  const apply = async (): Promise<void> => {
    setSaving(true)
    try {
      if (accounts.length === 1 || mode === 'same') {
        const n = await window.api.accounts.bulkSetField(
          'target_url',
          accounts.map((a) => a.id),
          sameUrl.trim()
        )
        showToast(`Assigned Target URL on ${n} account(s).`)
      } else {
        // List mode: one line per selected account, mapped 1:1 by order.
        // Fewer lines than accounts leaves the remaining accounts' URL
        // untouched (bulkAssign only writes an entry for accounts that
        // actually have a corresponding line) rather than blanking them out.
        const lines = listText.split('\n')
        const assignments = accounts
          .slice(0, lines.length)
          .map((a, i) => ({ id: a.id, value: lines[i].trim() }))
        const n = await window.api.accounts.bulkAssign('target_url', assignments)
        showToast(`Assigned ${n} Target URL(s) across selected accounts.`)
      }
      // Patch every affected row in the grid immediately rather than waiting
      // on refresh()'s full re-fetch — same immediate-feedback pattern the
      // other batch actions in this app use (e.g. downloadAvatarFast).
      for (const a of accounts) {
        const fresh = await window.api.accounts.get(a.id)
        if (fresh) applyAccountUpdate(fresh)
      }
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
      title="ដាក់ Link URL (Assign Target URL)"
      icon={Link2}
      width="max-w-lg"
      footer={
        <>
          <button className="win-btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="win-btn-accent" onClick={() => void apply()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {accounts.length > 1 && (
        <div className="mb-3 flex gap-4 text-[12px]">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={mode === 'same'}
              onChange={() => setMode('same')}
            />
            Same URL for all selected accounts
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={mode === 'list'}
              onChange={() => setMode('list')}
            />
            List of URLs (1 per row)
          </label>
        </div>
      )}

      {(accounts.length === 1 || mode === 'same') ? (
        <label className="flex flex-col gap-1.5 text-[12px]">
          <span className="font-medium text-ink">
            Target URL — applied to {accounts.length} account(s)
          </span>
          <input
            autoFocus
            type="text"
            className="win-input"
            placeholder="https://www.facebook.com/..."
            value={sameUrl}
            onChange={(e) => setSameUrl(e.target.value)}
          />
        </label>
      ) : (
        <label className="flex flex-col gap-1.5 text-[12px]">
          <span className="font-medium text-ink">
            One URL per line, mapped in order to the {accounts.length} selected account(s)
          </span>
          <textarea
            autoFocus
            className="win-input min-h-[160px] resize-y font-mono"
            placeholder={'https://www.facebook.com/post1\nhttps://www.facebook.com/post2\n...'}
            value={listText}
            onChange={(e) => setListText(e.target.value)}
          />
          <span className="text-[11px] text-ink-muted">
            Line {'{i}'} → row {'{i}'} of the current selection ({accounts.length} row(s), in selected order).
          </span>
        </label>
      )}
    </ModalShell>
  )
}
