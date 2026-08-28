// ---------------------------------------------------------------------------
// JoinGroupsModal.tsx  — batch "Join Groups (By Group ID / URL List)" prompt,
// opened from the row context menu. Runs runJoinGroupsByIdList across every
// target account against every pasted group id/URL.
// ---------------------------------------------------------------------------
import { useState } from 'react'
import { Users } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'

export function JoinGroupsModal({
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
    const targetGroups = text
      .split(/[\r\n,]+/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (targetGroups.length === 0) {
      showToast('Paste at least one group ID or URL first.')
      return
    }
    setRunning(true)
    // Strips a successfully-joined group out of the textarea the instant it
    // resolves — matched against whatever the textarea currently shows (via
    // the functional setText updater) so a user editing the list mid-run
    // never loses their own in-flight edits. Matches either the raw pasted
    // line or the normalized id the backend resolved it to (a pasted full
    // URL won't equal the bare id broadcast back), so both a bare-id list
    // and a pasted-URL list actually get their used lines stripped.
    const offItemProgress = removeOnSuccess
      ? window.api.automation.onFriendsGroupsItemProgress((event) => {
          if (!event.success) return
          setText((prev) =>
            prev
              .split(/\r?\n/)
              .filter((line) => {
                const trimmed = line.trim()
                return trimmed !== event.targetId && !trimmed.includes(event.targetId)
              })
              .join('\n')
          )
        })
      : null
    try {
      await withQueueRunning(async () => {
        showToast(`Joining ${targetGroups.length} group(s) across ${accountIds.length} account(s)…`)
        const summary = await window.api.automation.joinGroupsByIdList({
          accountIds,
          concurrency: threadCount,
          targetGroups
        })
        showToast(
          `Join Groups: ${summary.succeeded}/${summary.total} account(s) succeeded${summary.failed ? `, ${summary.failed} failed` : ''}.`,
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
      title="Join Groups (By Group ID / URL List)"
      icon={Users}
      width="max-w-md"
      footer={
        <>
          <button className="win-btn" onClick={onClose} disabled={running}>
            Cancel
          </button>
          <button className="win-btn-accent" onClick={() => void apply()} disabled={running}>
            {running ? 'Running…' : 'Join Groups'}
          </button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5 text-[12px]">
        <span className="font-medium text-slate-700">
          Group IDs or URLs — one per line, applied from {accountIds.length} selected account(s)
        </span>
        <textarea
          autoFocus
          className="win-input min-h-[140px] resize-y font-mono"
          placeholder={'123456789012345\nhttps://www.facebook.com/groups/somegroupname'}
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
        Delete / Remove Group ID from list after successfully used
      </label>
    </ModalShell>
  )
}
