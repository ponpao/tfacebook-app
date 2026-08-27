// ---------------------------------------------------------------------------
// EditAccountModal.tsx  — edit a single account's stored fields. Opened from
// the row context menu ("Edit Account Info"); the account to edit is carried
// on the store (editAccountTarget) rather than passed as a prop, since the
// modal is mounted once in App.tsx alongside every other modal.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'
import type { Account, AccountStatus } from '../../../types/account'

const STATUS_OPTIONS: AccountStatus[] = ['Live', 'Die', 'Checkpoint', 'Changed Pass', 'Unknown']

type FormState = Pick<
  Account,
  | 'uid'
  | 'name'
  | 'password'
  | 'two_fa'
  | 'email'
  | 'email_pass'
  | 'proxy'
  | 'folder_id'
  | 'status'
  | 'notes'
>

function toFormState(account: Account): FormState {
  return {
    uid: account.uid,
    name: account.name,
    password: account.password,
    two_fa: account.two_fa,
    email: account.email,
    email_pass: account.email_pass,
    proxy: account.proxy,
    folder_id: account.folder_id,
    status: account.status,
    notes: account.notes
  }
}

export function EditAccountModal(): React.JSX.Element | null {
  const account = useAccountStore((s) => s.editAccountTarget)
  const onClose = useAccountStore((s) => s.closeEditAccount)
  const folders = useAccountStore((s) => s.folders)
  const showToast = useAccountStore((s) => s.showToast)
  const applyAccountUpdate = useAccountStore((s) => s.applyAccountUpdate)

  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)

  // Reset the form whenever a (possibly different) account is opened for
  // editing — keyed on the account id so re-opening the same row after a
  // save picks up the freshest values rather than stale in-progress edits.
  useEffect(() => {
    setForm(account ? toFormState(account) : null)
  }, [account?.id])

  if (!account || !form) return null

  const patch = (p: Partial<FormState>): void => setForm((f) => (f ? { ...f, ...p } : f))

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const updated = await window.api.accounts.update(account.id, form)
      if (updated) {
        applyAccountUpdate(updated)
        showToast(`Saved changes for ${updated.name || updated.uid || 'account'}.`)
        onClose()
      } else {
        showToast('Save failed — account not found.')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Edit Account Info"
      icon={Pencil}
      width="max-w-lg"
      footer={
        <>
          <button className="win-btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="win-btn-accent" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : '💾 Save Changes'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 text-[12px]">
        <label className="flex flex-col gap-1">
          <span className="font-medium text-slate-700">UID</span>
          <input
            className="win-input"
            value={form.uid ?? ''}
            onChange={(e) => patch({ uid: e.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-medium text-slate-700">Name</span>
          <input
            className="win-input"
            value={form.name ?? ''}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-medium text-slate-700">Password</span>
          <input
            className="win-input"
            value={form.password ?? ''}
            onChange={(e) => patch({ password: e.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-medium text-slate-700">2FA Secret</span>
          <input
            className="win-input"
            value={form.two_fa ?? ''}
            onChange={(e) => patch({ two_fa: e.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-medium text-slate-700">Email</span>
          <input
            className="win-input"
            value={form.email ?? ''}
            onChange={(e) => patch({ email: e.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-medium text-slate-700">Mail Password</span>
          <input
            className="win-input"
            value={form.email_pass ?? ''}
            onChange={(e) => patch({ email_pass: e.target.value })}
          />
        </label>

        <label className="col-span-2 flex flex-col gap-1">
          <span className="font-medium text-slate-700">
            Proxy <span className="text-slate-400">(ip:port or ip:port:user:pass)</span>
          </span>
          <input
            className="win-input"
            placeholder="127.0.0.1:8080 or 127.0.0.1:8080:user:pass"
            value={form.proxy ?? ''}
            onChange={(e) => patch({ proxy: e.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-medium text-slate-700">Folder</span>
          <select
            className="win-input"
            value={form.folder_id ?? ''}
            onChange={(e) => patch({ folder_id: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">(none)</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-medium text-slate-700">Status</span>
          <select
            className="win-input"
            value={form.status}
            onChange={(e) => patch({ status: e.target.value as AccountStatus })}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="col-span-2 flex flex-col gap-1">
          <span className="font-medium text-slate-700">Notes</span>
          <textarea
            className="win-input min-h-[70px] resize-y"
            value={form.notes ?? ''}
            onChange={(e) => patch({ notes: e.target.value })}
          />
        </label>
      </div>
    </ModalShell>
  )
}
