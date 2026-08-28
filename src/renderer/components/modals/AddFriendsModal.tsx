// ---------------------------------------------------------------------------
// AddFriendsModal.tsx  — batch "Add Friends (By UID List / Manual Input)"
// prompt, opened from the row context menu. Runs runAddFriendsByUidList
// across every target account against every pasted UID.
// ---------------------------------------------------------------------------
import { useState } from 'react'
import { UserPlus } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'

export function AddFriendsModal({
  accountIds,
  onClose
}: {
  accountIds: number[] | null
  onClose: () => void
}): React.JSX.Element | null {
  const showToast = useAccountStore((s) => s.showToast)
  const refresh = useAccountStore((s) => s.refresh)
  const threadCount = useAccountStore((s) => s.threadCount)
  const withQueueRunning = useAccountStore((s) => s.withQueueRunning)
  const [text, setText] = useState('')
  const [running, setRunning] = useState(false)
  const [removeOnSuccess, setRemoveOnSuccess] = useState(true)

  if (!accountIds) return null

  const apply = async (): Promise<void> => {
    const targetUids = text
      .split(/[\r\n,]+/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (targetUids.length === 0) {
      showToast('Paste at least one target UID first.')
      return
    }
    setRunning(true)
    // Strips a successfully-added UID out of the textarea the instant it
    // resolves — matched against whatever the textarea currently shows
    // (via the functional setText updater) so a user editing the list
    // mid-run never loses their own in-flight edits.
    const offItemProgress = removeOnSuccess
      ? window.api.automation.onFriendsGroupsItemProgress((event) => {
          if (!event.success) return
          setText((prev) =>
            prev
              .split(/\r?\n/)
              .filter((line) => line.trim() !== event.targetId)
              .join('\n')
          )
        })
      : null
    try {
      await withQueueRunning(async () => {
        showToast(`Adding ${targetUids.length} friend(s) across ${accountIds.length} account(s)…`)
        const summary = await window.api.automation.addFriendsByUidList({
          accountIds,
          concurrency: threadCount,
          targetUids
        })
        showToast(
          `Add Friends: ${summary.succeeded}/${summary.total} account(s) succeeded${summary.failed ? `, ${summary.failed} failed` : ''}.`,
          6000
        )
      })
      await refresh()
      onClose()
    } finally {
      offItemProgress?.()
      setRunning(false)
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Add Friends (By UID List)"
      icon={UserPlus}
      width="max-w-md"
      footer={
        <>
          <button className="win-btn" onClick={onClose} disabled={running}>
            Cancel
          </button>
          <button className="win-btn-accent" onClick={() => void apply()} disabled={running}>
            {running ? 'Running…' : 'Add Friends'}
          </button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5 text-[12px]">
        <span className="font-medium text-slate-700">
          Target UIDs — one per line, applied from {accountIds.length} selected account(s)
        </span>
        <textarea
          autoFocus
          className="win-input min-h-[140px] resize-y font-mono"
          placeholder={'100012345678901\n100098765432109'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <label className="mt-2 flex items-center gap-2 text-[12px] text-slate-700">
        <input
          type="checkbox"
          checked={removeOnSuccess}
          onChange={(e) => setRemoveOnSuccess(e.target.checked)}
        />
        Delete / Remove UID from list after successfully used
      </label>
    </ModalShell>
  )
}
