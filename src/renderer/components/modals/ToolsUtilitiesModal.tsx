// ---------------------------------------------------------------------------
// ToolsUtilitiesModal.tsx  — Tools & Utilities menu:
//   1. Fast UID Live Checker (public Graph/avatar probe, no browser)
//   2. Bulk Proxy Health Checker (TCP-connect latency test)
//   3. Remove Duplicate Accounts (by UID)
//   4. Backup & Restore (Zip) — export accounts + profiles to a .zip,
//      restore from one into the "Receive Account" folder
//   5. Cloud Sync (Firebase) — push accounts + profiles to another PC's
//      Machine ID, or pull whatever is waiting under this PC's Machine ID
//      (auto-deleted from the cloud immediately after a successful pull)
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react'
import { Wrench, Zap, Globe2, Copy, PackagePlus, CloudCog } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'
import type { UidCheckResult, ProxyHealthResult, DuplicateAccountSummary } from '../../../types/tools'

type Tab = 'uid' | 'proxy' | 'dupes' | 'backup' | 'cloudsync'

export function ToolsUtilitiesModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const selectedIds = useAccountStore((s) => s.selectedIds)
  const accounts = useAccountStore((s) => s.accounts)
  const showToast = useAccountStore((s) => s.showToast)
  const refresh = useAccountStore((s) => s.refresh)
  const refreshFolders = useAccountStore((s) => s.refreshFolders)

  const [tab, setTab] = useState<Tab>('uid')

  // --- UID checker state ---
  const [uidRunning, setUidRunning] = useState(false)
  const [uidResults, setUidResults] = useState<UidCheckResult[]>([])
  const [uidProgress, setUidProgress] = useState({ done: 0, total: 0 })

  // --- Proxy checker state ---
  const [proxyRunning, setProxyRunning] = useState(false)
  const [proxyResults, setProxyResults] = useState<ProxyHealthResult[]>([])
  const [proxyProgress, setProxyProgress] = useState({ done: 0, total: 0 })

  // --- Dedupe state ---
  const [dupesLoading, setDupesLoading] = useState(false)
  const [dupes, setDupes] = useState<DuplicateAccountSummary[]>([])
  const [dupesRemoving, setDupesRemoving] = useState(false)

  // --- Backup & Restore state ---
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)

  // --- Cloud Sync state ---
  const [myMachineId, setMyMachineId] = useState<string | null>(null)
  const [pushTargetId, setPushTargetId] = useState('')
  const [pulling, setPulling] = useState(false)
  const [pushing, setPushing] = useState(false)

  useEffect(() => {
    if (!open) return
    const offUid = window.api.tools.onUidCheckProgress(({ index, total }) =>
      setUidProgress({ done: index, total })
    )
    const offProxy = window.api.tools.onProxyCheckProgress(({ index, total }) =>
      setProxyProgress({ done: index, total })
    )
    // A restore triggered from this exact modal already refreshes locally in
    // runImport() below — this broadcast listener covers the case where a
    // restore is kicked off from somewhere else entirely (this component
    // just needs the grid/folder list current if it's open at the time).
    const offImported = window.api.backup.onImported(() => {
      void refresh()
      void refreshFolders()
    })
    const offPulled = window.api.cloudSync.onPulled(() => {
      void refresh()
      void refreshFolders()
    })
    void window.api.cloudSync.getMachineId().then(setMyMachineId)
    return () => {
      offUid()
      offProxy()
      offImported()
      offPulled()
    }
  }, [open, refresh, refreshFolders])

  useEffect(() => {
    if (!open) {
      setUidResults([])
      setProxyResults([])
      setDupes([])
      setTab('uid')
    }
  }, [open])

  const runUidCheck = async (): Promise<void> => {
    const ids = selectedIds()
    const targets = ids.length > 0 ? ids : accounts.map((a) => a.id)
    if (targets.length === 0) {
      showToast('No accounts to check.')
      return
    }
    setUidRunning(true)
    setUidResults([])
    setUidProgress({ done: 0, total: targets.length })
    try {
      const results = await window.api.tools.checkUidsLive(targets)
      setUidResults(results)
      const live = results.filter((r) => r.status === 'Live').length
      const dead = results.filter((r) => r.status === 'Die').length
      showToast(`UID check done: ${live} Live, ${dead} Die, ${results.length - live - dead} Unknown.`, 6000)
      await refresh()
    } finally {
      setUidRunning(false)
    }
  }

  const runProxyCheck = async (): Promise<void> => {
    const proxies = [...new Set(accounts.map((a) => a.proxy).filter((p): p is string => !!p?.trim()))]
    if (proxies.length === 0) {
      showToast('No proxies assigned to any account.')
      return
    }
    setProxyRunning(true)
    setProxyResults([])
    setProxyProgress({ done: 0, total: proxies.length })
    try {
      const results = await window.api.tools.checkProxiesHealth(proxies)
      setProxyResults(results)
      const alive = results.filter((r) => r.alive).length
      showToast(`Proxy check done: ${alive}/${results.length} alive.`, 6000)
    } finally {
      setProxyRunning(false)
    }
  }

  const scanDupes = async (): Promise<void> => {
    setDupesLoading(true)
    try {
      const found = await window.api.tools.findDuplicateAccounts()
      setDupes(found)
      showToast(found.length === 0 ? 'No duplicate UIDs found.' : `Found ${found.length} duplicate account(s).`)
    } finally {
      setDupesLoading(false)
    }
  }

  const removeDupes = async (): Promise<void> => {
    if (!confirm(`Move ${dupes.length} duplicate account(s) to the Recycle Bin?`)) return
    setDupesRemoving(true)
    try {
      const res = await window.api.tools.removeDuplicateAccounts()
      showToast(`Removed ${res.removed} duplicate account(s) to the Recycle Bin.`)
      setDupes([])
      await refresh()
      await refreshFolders()
    } finally {
      setDupesRemoving(false)
    }
  }

  const runExport = async (): Promise<void> => {
    const ids = selectedIds()
    const targets = ids.length > 0 ? ids : accounts.map((a) => a.id)
    if (targets.length === 0) {
      showToast('No accounts to back up.')
      return
    }
    setExporting(true)
    try {
      const res = await window.api.backup.export(targets)
      if (res.ok) {
        showToast(`Backed up ${res.accountCount} account(s) to ${res.filePath}`, 6000)
      } else if (res.message && res.message !== 'Backup canceled.') {
        showToast(res.message, 6000)
      }
    } finally {
      setExporting(false)
    }
  }

  const runImport = async (): Promise<void> => {
    setImporting(true)
    try {
      const res = await window.api.backup.import()
      if (res.success) {
        showToast(res.message ?? `Imported ${res.importedCount} account(s).`, 6000)
        await refresh()
        await refreshFolders()
      } else if (res.message && res.message !== 'Import canceled.') {
        showToast(res.message, 6000)
      }
    } finally {
      setImporting(false)
    }
  }

  const runCloudPush = async (): Promise<void> => {
    const targetId = pushTargetId.trim().toUpperCase()
    if (!targetId) {
      showToast('Enter the target PC\'s Machine ID first.')
      return
    }
    const ids = selectedIds()
    const targets = ids.length > 0 ? ids : accounts.map((a) => a.id)
    if (targets.length === 0) {
      showToast('No accounts to push.')
      return
    }
    setPushing(true)
    try {
      const res = await window.api.cloudSync.push(targetId, targets)
      if (res.ok) {
        showToast(`Pushed ${res.accountCount} account(s) to ${res.targetMachineId}.`, 6000)
      } else {
        showToast(res.message ?? 'Cloud Sync push failed.', 6000)
      }
    } finally {
      setPushing(false)
    }
  }

  const runCloudPull = async (): Promise<void> => {
    if (!myMachineId) return
    setPulling(true)
    try {
      const res = await window.api.cloudSync.pull(myMachineId)
      if (res.success) {
        await refresh()
        await refreshFolders()
        alert(`Successfully pulled ${res.count} account(s)!`)
        onClose()
      } else {
        alert(res.message ?? 'Cloud Sync pull failed.')
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setPulling(false)
    }
  }

  const TABS: { key: Tab; label: string; icon: typeof Zap }[] = [
    { key: 'uid', label: 'Fast UID Live Checker', icon: Zap },
    { key: 'proxy', label: 'Bulk Proxy Health Checker', icon: Globe2 },
    { key: 'dupes', label: 'Remove Duplicate Accounts', icon: Copy },
    { key: 'backup', label: 'Backup & Restore (Zip)', icon: PackagePlus },
    { key: 'cloudsync', label: 'Cloud Sync (Firebase)', icon: CloudCog }
  ]

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Tools & Utilities"
      icon={Wrench}
      width="max-w-2xl"
      footer={
        <button className="win-btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="flex flex-col gap-3 text-[12px]">
        <div className="flex gap-1 border-b border-slate-300 pb-2">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              className={`inline-flex items-center gap-1.5 rounded-[3px] px-2.5 py-1.5 text-[12px] ${
                tab === key
                  ? 'bg-[#0078d4] text-white'
                  : 'text-slate-700 hover:bg-slate-200'
              }`}
              onClick={() => setTab(key)}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>

        {tab === 'uid' && (
          <div className="flex flex-col gap-3">
            <p className="text-[11px] text-slate-500">
              Checks each UID via Facebook's public avatar API without opening a browser — fast,
              but heuristic (a resolvable, non-default profile picture ⇒ Live).
            </p>
            <div className="flex items-center gap-2">
              <button className="win-btn-accent" onClick={() => void runUidCheck()} disabled={uidRunning}>
                {uidRunning ? 'Checking…' : 'Run Live Check'}
              </button>
              <span className="text-[11px] text-slate-500">
                {selectedIds().length > 0
                  ? `${selectedIds().length} selected account(s)`
                  : `All ${accounts.length} account(s)`}
              </span>
              {uidRunning && (
                <span className="text-[11px] text-slate-500">
                  {uidProgress.done}/{uidProgress.total}
                </span>
              )}
            </div>
            {uidResults.length > 0 && (
              <div className="max-h-64 overflow-auto rounded border border-slate-300 bg-white">
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-mc-headbg">
                    <tr>
                      <th className="border-b border-r border-[#a0a0a0] px-2 py-1 text-left">UID</th>
                      <th className="border-b border-r border-[#a0a0a0] px-2 py-1 text-left">Status</th>
                      <th className="border-b border-[#a0a0a0] px-2 py-1 text-left">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {uidResults.map((r) => (
                      <tr key={r.accountId} className="odd:bg-mc-row even:bg-mc-rowAlt">
                        <td className="border-b border-r border-[#b8cbb0] px-2 py-1">{r.uid ?? '—'}</td>
                        <td
                          className={`border-b border-r border-[#b8cbb0] px-2 py-1 font-semibold ${
                            r.status === 'Live'
                              ? 'text-[#1e9e4a]'
                              : r.status === 'Die'
                                ? 'text-[#c81e1e]'
                                : 'text-[#6b7280]'
                          }`}
                        >
                          {r.status}
                        </td>
                        <td className="border-b border-[#b8cbb0] px-2 py-1 text-slate-600">{r.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === 'proxy' && (
          <div className="flex flex-col gap-3">
            <p className="text-[11px] text-slate-500">
              Tests TCP connectivity and latency for every distinct proxy currently assigned to an
              account.
            </p>
            <div className="flex items-center gap-2">
              <button className="win-btn-accent" onClick={() => void runProxyCheck()} disabled={proxyRunning}>
                {proxyRunning ? 'Testing…' : 'Run Health Check'}
              </button>
              {proxyRunning && (
                <span className="text-[11px] text-slate-500">
                  {proxyProgress.done}/{proxyProgress.total}
                </span>
              )}
            </div>
            {proxyResults.length > 0 && (
              <div className="max-h-64 overflow-auto rounded border border-slate-300 bg-white">
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-mc-headbg">
                    <tr>
                      <th className="border-b border-r border-[#a0a0a0] px-2 py-1 text-left">Proxy</th>
                      <th className="border-b border-r border-[#a0a0a0] px-2 py-1 text-left">Status</th>
                      <th className="border-b border-[#a0a0a0] px-2 py-1 text-left">Latency / Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proxyResults.map((r, i) => (
                      <tr key={`${r.proxy}-${i}`} className="odd:bg-mc-row even:bg-mc-rowAlt">
                        <td className="border-b border-r border-[#b8cbb0] px-2 py-1 font-mono">{r.proxy}</td>
                        <td
                          className={`border-b border-r border-[#b8cbb0] px-2 py-1 font-semibold ${
                            r.alive ? 'text-[#1e9e4a]' : 'text-[#c81e1e]'
                          }`}
                        >
                          {r.alive ? 'Alive' : 'Dead'}
                        </td>
                        <td className="border-b border-[#b8cbb0] px-2 py-1 text-slate-600">
                          {r.alive ? `${r.latencyMs}ms` : r.detail}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === 'dupes' && (
          <div className="flex flex-col gap-3">
            <p className="text-[11px] text-slate-500">
              Scans every account for duplicate UIDs, keeping the oldest account and moving the
              rest to the Recycle Bin.
            </p>
            <div className="flex items-center gap-2">
              <button className="win-btn" onClick={() => void scanDupes()} disabled={dupesLoading}>
                {dupesLoading ? 'Scanning…' : 'Scan for Duplicates'}
              </button>
              {dupes.length > 0 && (
                <button
                  className="win-btn-accent"
                  onClick={() => void removeDupes()}
                  disabled={dupesRemoving}
                >
                  {dupesRemoving ? 'Removing…' : `Remove ${dupes.length} Duplicate(s)`}
                </button>
              )}
            </div>
            {dupes.length > 0 && (
              <div className="max-h-64 overflow-auto rounded border border-slate-300 bg-white">
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-mc-headbg">
                    <tr>
                      <th className="border-b border-r border-[#a0a0a0] px-2 py-1 text-left">UID</th>
                      <th className="border-b border-r border-[#a0a0a0] px-2 py-1 text-left">Email</th>
                      <th className="border-b border-[#a0a0a0] px-2 py-1 text-left">Name</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dupes.map((d) => (
                      <tr key={d.accountId} className="odd:bg-mc-row even:bg-mc-rowAlt">
                        <td className="border-b border-r border-[#b8cbb0] px-2 py-1">{d.uid ?? '—'}</td>
                        <td className="border-b border-r border-[#b8cbb0] px-2 py-1">{d.email ?? '—'}</td>
                        <td className="border-b border-[#b8cbb0] px-2 py-1">{d.name ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === 'backup' && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2 rounded border border-slate-300 bg-white p-3">
              <div className="flex items-center gap-2 text-[12px] font-semibold text-slate-800">
                <PackagePlus size={14} className="text-[#0067c0]" />
                📦 Backup Accounts &amp; Profiles (Zip)
              </div>
              <p className="text-[11px] text-slate-500">
                Packs the selected accounts' database records, folder assignment, and Chrome
                profile folders (cookies/session data) into a single .zip you choose where to
                save.
              </p>
              <div className="flex items-center gap-2">
                <button className="win-btn-accent" onClick={() => void runExport()} disabled={exporting}>
                  {exporting ? 'Backing up…' : 'Backup Accounts & Profiles (Zip)'}
                </button>
                <span className="text-[11px] text-slate-500">
                  {selectedIds().length > 0
                    ? `${selectedIds().length} selected account(s)`
                    : `All ${accounts.length} account(s)`}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-2 rounded border border-slate-300 bg-white p-3">
              <div className="flex items-center gap-2 text-[12px] font-semibold text-slate-800">
                <PackagePlus size={14} className="text-[#0067c0]" />
                📂 Import Backup Zip
              </div>
              <p className="text-[11px] text-slate-500">
                Restores accounts and their Chrome profile folders from a previously exported
                .zip. Every restored account is placed into (or merged into) a folder named{' '}
                <strong>Receive Account</strong>, created automatically if it doesn't already
                exist. An account whose UID already exists locally is not duplicated, but its
                profile folder is still restored.
              </p>
              <div>
                <button className="win-btn" onClick={() => void runImport()} disabled={importing}>
                  {importing ? 'Importing…' : 'Import Backup Zip'}
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === 'cloudsync' && (
          <div className="flex flex-col gap-4">
            <p className="text-[11px] text-slate-500">
              Transfers accounts and their Chrome profile folders (sessions) between two PCs via
              Firebase, addressed by each PC's Machine ID. The cloud copy is deleted automatically
              the moment a pull finishes successfully — it never lingers, and it is never removed
              if anything goes wrong.
            </p>

            <div className="flex flex-col gap-2 rounded border border-slate-300 bg-white p-3">
              <div className="flex items-center gap-2 text-[12px] font-semibold text-slate-800">
                <CloudCog size={14} className="text-[#0067c0]" />
                ⬆️ Push to Another PC
              </div>
              <p className="text-[11px] text-slate-500">
                Bundles the selected accounts' database records and Chrome profile folders and
                uploads them to Firebase under the target PC's Machine ID.
              </p>
              <div className="flex items-center gap-2">
                <input
                  className="win-input w-40 font-mono uppercase"
                  placeholder="e.g. TFA90488"
                  value={pushTargetId}
                  onChange={(e) => setPushTargetId(e.target.value)}
                  maxLength={12}
                />
                <button className="win-btn-accent" onClick={() => void runCloudPush()} disabled={pushing}>
                  {pushing ? 'Pushing…' : 'Push to Machine ID'}
                </button>
                <span className="text-[11px] text-slate-500">
                  {selectedIds().length > 0
                    ? `${selectedIds().length} selected account(s)`
                    : `All ${accounts.length} account(s)`}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-2 rounded border border-slate-300 bg-white p-3">
              <div className="flex items-center gap-2 text-[12px] font-semibold text-slate-800">
                <CloudCog size={14} className="text-[#0067c0]" />
                ⬇️ Pull to This PC
              </div>
              <p className="text-[11px] text-slate-500">
                Downloads whatever payload is waiting under this PC's own Machine ID and restores
                the accounts and profile folders into a folder named <strong>Receive Account</strong>
                , created automatically if it doesn't already exist.
              </p>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-slate-600">
                  This PC's Machine ID:{' '}
                  <b className="font-mono">{myMachineId ?? '…'}</b>
                </span>
                <button
                  className="win-btn"
                  onClick={() => void runCloudPull()}
                  disabled={pulling || !myMachineId}
                >
                  {pulling ? 'Checking Cloud...' : 'Pull My Pending Data'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </ModalShell>
  )
}
