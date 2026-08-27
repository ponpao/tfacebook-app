// ---------------------------------------------------------------------------
// RecycleBinModal.tsx  — view soft-deleted accounts, restore them, or purge
// them permanently (which also cleans up their saved browser profile).
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react'
import { Trash2, RotateCcw, XCircle } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'
import type { Account } from '../../../types/account'

export function RecycleBinModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const showToast = useAccountStore((s) => s.showToast)
  const refresh = useAccountStore((s) => s.refresh)
  const refreshFolders = useAccountStore((s) => s.refreshFolders)

  const [deleted, setDeleted] = useState<Account[]>([])
  const [selected, setSelected] = useState<Record<number, boolean>>({})
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => {
    const rows = await window.api.accounts.getDeleted()
    setDeleted(rows)
    setSelected({})
  }

  useEffect(() => {
    if (open) void load()
  }, [open])

  const selectedIds = Object.keys(selected)
    .filter((k) => selected[Number(k)])
    .map(Number)

  const toggle = (id: number): void =>
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }))
  const toggleAll = (checked: boolean): void =>
    setSelected(checked ? Object.fromEntries(deleted.map((a) => [a.id, true])) : {})

  const restoreSelected = async (): Promise<void> => {
    if (selectedIds.length === 0) {
      showToast('Select at least one account to restore.')
      return
    }
    setBusy(true)
    try {
      const n = await window.api.accounts.restore(selectedIds)
      showToast(`Restored ${n} account(s).`)
      await load()
      await refresh()
      await refreshFolders()
    } finally {
      setBusy(false)
    }
  }

  const permanentlyDeleteSelected = async (): Promise<void> => {
    if (selectedIds.length === 0) {
      showToast('Select at least one account to delete.')
      return
    }
    if (
      !confirm(
        `Permanently delete ${selectedIds.length} account(s)? This cannot be undone and also removes their saved browser profile.`
      )
    )
      return
    setBusy(true)
    try {
      const res = await window.api.accounts.permanentDelete(selectedIds)
      showToast(`Permanently deleted ${res.removed} account(s).`)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const emptyBin = async (): Promise<void> => {
    if (deleted.length === 0) return
    if (
      !confirm(
        `Empty the Recycle Bin? This will permanently delete all ${deleted.length} account(s) in it. This cannot be undone.`
      )
    )
      return
    setBusy(true)
    try {
      const res = await window.api.accounts.emptyRecycleBin()
      showToast(`Recycle Bin emptied — ${res.removed} account(s) permanently deleted.`)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const allChecked = deleted.length > 0 && selectedIds.length === deleted.length

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Recycle Bin"
      icon={Trash2}
      width="max-w-4xl"
      footer={
        <>
          <span className="mr-auto text-[11px] text-slate-500">
            {deleted.length} account(s) in bin · {selectedIds.length} selected
          </span>
          <button className="win-btn" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button
            className="win-btn"
            onClick={() => void restoreSelected()}
            disabled={busy || selectedIds.length === 0}
          >
            <RotateCcw size={13} className="text-[#1e9e4a]" />
            Restore Selected
          </button>
          <button
            className="win-btn"
            onClick={() => void permanentlyDeleteSelected()}
            disabled={busy || selectedIds.length === 0}
          >
            <Trash2 size={13} className="text-[#c81e1e]" />
            Permanently Delete
          </button>
          <button
            className="win-btn-accent"
            onClick={() => void emptyBin()}
            disabled={busy || deleted.length === 0}
          >
            <XCircle size={13} />
            Empty Bin
          </button>
        </>
      }
    >
      <div className="flex h-full flex-col overflow-hidden border border-[#a0a0a0] bg-white text-[12px]">
        <div className="sticky top-0 z-10 flex border-b border-[#a0a0a0] bg-mc-headbg text-2xs font-semibold text-slate-900">
          <div className="flex w-8 shrink-0 items-center justify-center border-r border-[#a0a0a0] py-1.5">
            <input
              type="checkbox"
              className="accent-[#0078d4]"
              checked={allChecked}
              onChange={(e) => toggleAll(e.target.checked)}
            />
          </div>
          <div className="flex-1 border-r border-[#a0a0a0] px-2 py-1.5">UID</div>
          <div className="flex-1 border-r border-[#a0a0a0] px-2 py-1.5">Email</div>
          <div className="w-32 border-r border-[#a0a0a0] px-2 py-1.5">Status</div>
          <div className="w-40 px-2 py-1.5">Deleted At</div>
        </div>

        <div className="flex-1 overflow-auto">
          {deleted.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-[12px] text-slate-400">
              Recycle Bin is empty.
            </div>
          ) : (
            deleted.map((a, i) => {
              const isSel = !!selected[a.id]
              return (
                <div
                  key={a.id}
                  className={`flex cursor-default border-b border-[#e0e0e0] ${
                    isSel ? 'bg-[#0078d4] text-white' : i % 2 === 0 ? 'bg-white' : 'bg-[#f6f6f6]'
                  }`}
                  onClick={() => toggle(a.id)}
                >
                  <div
                    className="flex w-8 shrink-0 items-center justify-center py-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      className="accent-[#0078d4]"
                      checked={isSel}
                      onChange={() => toggle(a.id)}
                    />
                  </div>
                  <div className="flex-1 truncate px-2 py-1">{a.uid ?? '—'}</div>
                  <div className="flex-1 truncate px-2 py-1">{a.email ?? '—'}</div>
                  <div className="w-32 truncate px-2 py-1">{a.status}</div>
                  <div className="w-40 truncate px-2 py-1">{a.deleted_at ?? '—'}</div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </ModalShell>
  )
}
