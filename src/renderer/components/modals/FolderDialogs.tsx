// ---------------------------------------------------------------------------
// FolderDialogs.tsx  — modal dialogs for folder management:
//   - add     : create a new folder
//   - rename  : rename the active folder
//   - delete  : delete the active folder (reassign accounts to fallback)
//   - move    : move selected accounts into another folder
// A single component driven by a `mode` prop keeps the modal styling in one place.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react'
import { X, FolderPlus, FolderPen, FolderMinus, FolderInput } from 'lucide-react'
import type { Folder } from '../../../types/folder'
import { HEADER_HEX_PATTERN_URL } from '../../assets/headerHexPattern'

export type FolderDialogMode = 'add' | 'rename' | 'delete' | 'move' | null

const DEFAULT_ID = 1

interface Props {
  mode: FolderDialogMode
  folders: Folder[]
  activeFolder: Folder | null
  selectedCount: number
  onClose: () => void
  onCreate: (name: string) => Promise<void>
  onRename: (id: number, name: string) => Promise<void>
  onDelete: (id: number, fallbackId: number) => Promise<void>
  onMove: (targetFolderId: number) => Promise<void>
}

const CONFIG: Record<
  Exclude<FolderDialogMode, null>,
  { title: string; Icon: typeof FolderPlus }
> = {
  add: { title: 'Add Folder', Icon: FolderPlus },
  rename: { title: 'Rename Folder', Icon: FolderPen },
  delete: { title: 'Delete Folder', Icon: FolderMinus },
  move: { title: 'Move Accounts to Folder', Icon: FolderInput }
}

export function FolderDialogs({
  mode,
  folders,
  activeFolder,
  selectedCount,
  onClose,
  onCreate,
  onRename,
  onDelete,
  onMove
}: Props): React.JSX.Element | null {
  const [name, setName] = useState('')
  const [targetId, setTargetId] = useState<number>(DEFAULT_ID)
  const [busy, setBusy] = useState(false)

  // Seed fields whenever the dialog opens.
  useEffect(() => {
    if (mode === 'rename' && activeFolder) setName(activeFolder.name)
    else if (mode === 'add') setName('')
    if (mode === 'move') {
      const firstOther = folders.find((f) => f.id !== activeFolder?.id)
      setTargetId(firstOther?.id ?? DEFAULT_ID)
    }
  }, [mode, activeFolder, folders])

  if (!mode) return null
  const { title, Icon } = CONFIG[mode]

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      if (mode === 'add') {
        if (!name.trim()) return
        await onCreate(name.trim())
      } else if (mode === 'rename' && activeFolder) {
        if (!name.trim()) return
        await onRename(activeFolder.id, name.trim())
      } else if (mode === 'delete' && activeFolder) {
        await onDelete(activeFolder.id, DEFAULT_ID)
      } else if (mode === 'move') {
        await onMove(targetId)
      }
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25">
      <div className="w-[420px] rounded-[4px] border border-[#999] bg-mc-bg shadow-2xl">
        {/* Title bar */}
        <div
          className="flex items-center justify-between border-b border-[#e4d8bc] bg-[#fdf9f0] px-3 py-1.5"
          style={{
            backgroundImage: HEADER_HEX_PATTERN_URL,
            backgroundSize: '56px 98px',
            backgroundRepeat: 'repeat'
          }}
        >
          <div className="flex items-center gap-1.5">
            <Icon size={15} className="text-[#4a6a8a]" />
            <span className="text-[12px] font-semibold">{title}</span>
          </div>
          <button onClick={onClose} className="text-[#666] hover:text-[#e81123]">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-4 text-[12px]">
          {(mode === 'add' || mode === 'rename') && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[#444]">Folder name</span>
              <input
                autoFocus
                className="win-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
                placeholder="Enter folder name..."
              />
            </label>
          )}

          {mode === 'delete' && activeFolder && (
            <p className="leading-relaxed text-[#333]">
              Are you sure you want to delete the folder{' '}
              <b>&ldquo;{activeFolder.name}&rdquo;</b>?
              <br />
              <span className="text-[#666]">
                Its {activeFolder.account_count} account(s) will be moved to the{' '}
                <b>Default Folder</b>.
              </span>
            </p>
          )}

          {mode === 'move' && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[#444]">
                Move <b>{selectedCount}</b> selected account(s) to:
              </span>
              <select
                className="win-select"
                value={targetId}
                onChange={(e) => setTargetId(Number(e.target.value))}
              >
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} [{f.account_count}]
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-[#d0d0d0] bg-[#f6f6f6] px-4 py-2.5">
          <button className="win-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={mode === 'delete' ? 'win-btn text-[#c81e1e]' : 'win-btn'}
            onClick={() => void submit()}
            disabled={busy || (mode === 'move' && selectedCount === 0)}
          >
            {mode === 'delete' ? 'Delete' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}
