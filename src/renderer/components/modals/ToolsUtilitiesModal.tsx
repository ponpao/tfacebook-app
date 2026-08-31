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
import { useEffect, useState, useMemo } from 'react'
import {
  Wrench,
  Zap,
  Globe2,
  Copy,
  PackagePlus,
  CloudCog,
  FileArchive,
  FolderArchive,
  RefreshCw,
  UploadCloud,
  CheckCircle2,
  XCircle,
  Activity,
  BarChart3,
  Trash2,
  Search,
  Download,
  FileText,
  ShieldCheck,
  MapPin,
  Check,
  Filter,
  Link,
  Share2,
  ExternalLink,
  Scissors,
  Database,
  ClipboardPaste
} from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'
import { useLanguageStore } from '../../store/useLanguageStore'
import type { UidCheckResult, ProxyHealthResult, DuplicateAccountSummary } from '../../../types/tools'

type Tab = 'uid' | 'proxy' | 'dupes' | 'getfbid' | 'googlelink' | 'backup' | 'cloudsync'

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
  const [dupesCleaned, setDupesCleaned] = useState(false)

  // --- Filter & Mode states ---
  const [uidFilter, setUidFilter] = useState<'ALL' | 'LIVE' | 'DIE'>('ALL')
  const [proxyFilter, setProxyFilter] = useState<'ALL' | 'HEALTHY' | 'DEAD'>('ALL')

  // Tab 1: UID Dual Input
  const [uidInputMode, setUidInputMode] = useState<'DB' | 'CUSTOM'>('DB')
  const [customUidText, setCustomUidText] = useState('')

  // Tab 3: Dupes Dual Input
  const [dupesInputMode, setDupesInputMode] = useState<'DB' | 'CUSTOM'>('DB')
  const [customDupesText, setCustomDupesText] = useState('')
  const [crossCheckWithDb, setCrossCheckWithDb] = useState(true)

  // Tab 4: Get FB ID
  const [fbLinksInput, setFbLinksInput] = useState('')
  const [extractedFbIds, setExtractedFbIds] = useState<
    Array<{ link: string; id: string; type: string }>
  >([])

  // Tab 5: Google Share Link Converter
  const [googleUrlsInput, setGoogleUrlsInput] = useState('')
  const [googleEngine, setGoogleEngine] = useState<'SEARCH' | 'IMAGES' | 'MAPS'>('SEARCH')

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
        const suffix = res.message ? ` ${res.message}` : ''
        showToast(`Backed up ${res.accountCount} account(s) to ${res.filePath}.${suffix}`, 6000)
      } else if (res.message && res.message !== 'Backup canceled.') {
        showToast(res.message, 6000)
      }
    } finally {
      setExporting(false)
    }
  }

  const [isDragOver, setIsDragOver] = useState(false)
  const t = useLanguageStore((s) => s.t)

  const runImport = async (explicitPath?: string): Promise<void> => {
    setImporting(true)
    try {
      const res = await window.api.backup.import(explicitPath)
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

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!isDragOver) setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }

  const handleDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    const files = e.dataTransfer.files
    if (!files || files.length === 0) return
    const file = files[0]
    // Electron File object has .path
    const filePath = (file as unknown as { path?: string }).path
    if (filePath && filePath.toLowerCase().endsWith('.zip')) {
      await runImport(filePath)
    } else {
      showToast('Please drop a valid .zip backup file.', 4000)
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

  const accountMap = useMemo(() => {
    const map = new Map<number, (typeof accounts)[0]>()
    for (const a of accounts) {
      map.set(a.id, a)
    }
    return map
  }, [accounts])

  const copyUidResults = (): void => {
    if (uidResults.length === 0) return
    const text = uidResults.map((r) => `${r.uid}\t${r.status}\t${r.detail}`).join('\n')
    void navigator.clipboard.writeText(text)
    showToast('UID check results copied to clipboard', 3000)
  }

  const copyLiveUids = (): void => {
    const liveUids = uidResults.filter((r) => r.status === 'Live' && r.uid).map((r) => r.uid)
    if (liveUids.length === 0) {
      showToast('No Live UIDs to copy.', 3000)
      return
    }
    void navigator.clipboard.writeText(liveUids.join('\n'))
    showToast(`Copied ${liveUids.length} Live UID(s) to clipboard!`, 3000)
  }

  const exportUidCsv = (): void => {
    if (uidResults.length === 0) {
      showToast('No results to export.', 3000)
      return
    }
    const header = 'No,UID,Name,Status,Detail\n'
    const rows = uidResults
      .map((r, i) => {
        const name = accountMap.get(r.accountId)?.name || ''
        return `${i + 1},"${r.uid ?? ''}","${name.replace(/"/g, '""')}","${r.status}","${(r.detail ?? '').replace(/"/g, '""')}"`
      })
      .join('\n')
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `UID_Check_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    showToast('Exported UID results to CSV!', 3000)
  }

  const copyProxyResults = (): void => {
    if (proxyResults.length === 0) return
    const text = proxyResults
      .map((r) => `${r.proxy}\t${r.alive ? 'Alive' : 'Dead'}\t${r.alive ? r.latencyMs + 'ms' : r.detail}`)
      .join('\n')
    void navigator.clipboard.writeText(text)
    showToast('Proxy results copied to clipboard', 3000)
  }

  const copyWorkingProxies = (): void => {
    const working = proxyResults.filter((p) => p.alive).map((p) => p.proxy)
    if (working.length === 0) {
      showToast('No working proxies to copy.', 3000)
      return
    }
    void navigator.clipboard.writeText(working.join('\n'))
    showToast(`Copied ${working.length} working proxy(ies) to clipboard!`, 3000)
  }

  const removeDeadProxies = async (): Promise<void> => {
    const deadSet = new Set(proxyResults.filter((p) => !p.alive).map((p) => p.proxy.trim()))
    if (deadSet.size === 0) {
      showToast('No dead proxies detected to remove.', 3000)
      return
    }
    const affectedAccounts = accounts.filter((a) => a.proxy && deadSet.has(a.proxy.trim()))
    if (affectedAccounts.length === 0) {
      showToast('No accounts are currently using these dead proxies.', 3000)
      return
    }
    if (!confirm(`Clear dead proxies from ${affectedAccounts.length} account(s)?`)) return
    let updated = 0
    for (const a of affectedAccounts) {
      await window.api.accounts.update(a.id, { proxy: null })
      updated++
    }
    await refresh()
    showToast(`Removed dead proxies from ${updated} account(s)!`, 4000)
  }

  const copyDupes = (): void => {
    if (dupes.length === 0) return
    const text = dupes.map((d) => `${d.uid}\t${d.email ?? ''}\t${d.name ?? ''}`).join('\n')
    void navigator.clipboard.writeText(text)
    showToast('Duplicate accounts copied to clipboard', 3000)
  }

  const avgProxyLatency = useMemo(() => {
    const alive = proxyResults.filter((p) => p.alive && (p.latencyMs ?? 0) > 0)
    if (alive.length === 0) return 0
    return Math.round(alive.reduce((acc, p) => acc + (p.latencyMs ?? 0), 0) / alive.length)
  }, [proxyResults])

  const uidLiveCount = useMemo(() => uidResults.filter((r) => r.status === 'Live').length, [uidResults])
  const uidDeadCount = useMemo(() => uidResults.filter((r) => r.status === 'Die').length, [uidResults])
  const uidOtherCount = useMemo(() => uidResults.filter((r) => r.status !== 'Live' && r.status !== 'Die').length, [uidResults])

  const proxyAliveCount = useMemo(() => proxyResults.filter((r) => r.alive).length, [proxyResults])
  const proxyDeadCount = useMemo(() => proxyResults.filter((r) => !r.alive).length, [proxyResults])

  const filteredUidResults = useMemo(() => {
    if (uidFilter === 'LIVE') return uidResults.filter((r) => r.status === 'Live')
    if (uidFilter === 'DIE') return uidResults.filter((r) => r.status === 'Die')
    return uidResults
  }, [uidResults, uidFilter])

  const filteredProxyResults = useMemo(() => {
    if (proxyFilter === 'HEALTHY') return proxyResults.filter((r) => r.alive)
    if (proxyFilter === 'DEAD') return proxyResults.filter((r) => !r.alive)
    return proxyResults
  }, [proxyResults, proxyFilter])

  const duplicateGroups = useMemo(() => {
    const groups = new Map<string, DuplicateAccountSummary[]>()
    for (const d of dupes) {
      const uidKey = d.uid || 'unknown'
      if (!groups.has(uidKey)) groups.set(uidKey, [])
      groups.get(uidKey)!.push(d)
    }
    return Array.from(groups.entries()).map(([uid, list]) => ({
      uid,
      occurrences: list.length,
      accounts: list
    }))
  }, [dupes])

  const getResponseTimeBadge = (detail: string): React.ReactNode => {
    const m = detail.match(/(\d+)\s*ms/i)
    if (m) {
      const ms = parseInt(m[1], 10)
      const colorClass =
        ms < 250
          ? 'text-emerald-700 font-bold'
          : ms < 600
            ? 'text-amber-700 font-bold'
            : 'text-rose-700 font-bold'
      return <span className={colorClass}>{ms}ms</span>
    }
    if (detail.includes('200')) return <span className="text-emerald-700 font-semibold">Fast (200)</span>
    if (detail.includes('404')) return <span className="text-rose-700 font-semibold">404</span>
    return <span className="text-slate-500 font-mono text-[11px]">{detail || '—'}</span>
  }

  const getLatencyBadge = (p: ProxyHealthResult): React.ReactNode => {
    if (!p.alive) {
      return <span className="font-bold text-rose-600">Timeout</span>
    }
    const ms = p.latencyMs ?? 0
    if (ms < 200) {
      return <span className="font-bold text-emerald-600">{ms}ms</span>
    }
    if (ms < 500) {
      return <span className="font-bold text-amber-600">{ms}ms</span>
    }
    return <span className="font-bold text-rose-600">{ms}ms</span>
  }

  const getProxyGeo = (proxyStr: string): string => {
    const host = proxyStr.split(':')[0] || ''
    if (host.endsWith('.kh')) return '🇰🇭 KH'
    if (host.endsWith('.us') || host.includes('.us.')) return '🇺🇸 US'
    if (host.endsWith('.uk') || host.includes('.uk.')) return '🇬🇧 UK'
    if (host.endsWith('.vn')) return '🇻🇳 VN'
    if (host.endsWith('.th')) return '🇹🇭 TH'
    if (host.endsWith('.sg')) return '🇸🇬 SG'
    return '🌐 Global'
  }

  const parsedCustomUids = useMemo(() => {
    // Splits on newlines, commas, semicolons, pipes, or tabs; extracts valid numeric/alphanumeric UIDs (4-25 digits)
    const tokens = customUidText
      .split(/[\r\n,;|]+/)
      .map((s) => {
        const trimmed = s.trim().replace(/['"]/g, '')
        // If line has format UID|pass|... take first segment
        const segment = trimmed.split(/[\t\s]+/)[0] || trimmed
        return segment
      })
      .filter((s) => /^\d{4,25}$/.test(s))
    return [...new Set(tokens)]
  }, [customUidText])

  const runCustomUidCheck = async (): Promise<void> => {
    if (parsedCustomUids.length === 0) {
      showToast('No valid UIDs found in the paste area.', 3000)
      return
    }
    setUidRunning(true)
    setUidResults([])
    setUidProgress({ done: 0, total: parsedCustomUids.length })

    const results: UidCheckResult[] = []
    let doneCount = 0
    const batchSize = 10

    for (let i = 0; i < parsedCustomUids.length; i += batchSize) {
      const chunk = parsedCustomUids.slice(i, i + batchSize)
      await Promise.all(
        chunk.map(async (uid) => {
          const t0 = performance.now()
          let status: 'Live' | 'Die' = 'Die'
          let detail = ''
          try {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 6000)
            const res = await fetch(
              `https://graph.facebook.com/${encodeURIComponent(uid)}/picture?type=normal&redirect=false`,
              { signal: controller.signal }
            )
            clearTimeout(timer)
            const json = (await res.json().catch(() => null)) as {
              data?: { url?: string }
              error?: { code?: number }
            } | null
            const elapsed = Math.round(performance.now() - t0)
            if (json?.data?.url) {
              status = 'Live'
              detail = `${elapsed}ms`
            } else {
              status = 'Die'
              detail = `${elapsed}ms`
            }
          } catch {
            const elapsed = Math.round(performance.now() - t0)
            status = 'Die'
            detail = `${elapsed}ms (Timeout)`
          }
          results.push({ accountId: -(results.length + 1), uid, status, detail })
          doneCount++
          setUidProgress({ done: doneCount, total: parsedCustomUids.length })
        })
      )
    }

    setUidResults(results)
    setUidRunning(false)
    const live = results.filter((r) => r.status === 'Live').length
    showToast(`Checked ${results.length} UIDs: ${live} Live, ${results.length - live} Die.`, 5000)
  }

  const customDupesAnalysis = useMemo(() => {
    const rawLines = customDupesText
      .split(/[\r\n]+/)
      .map((l) => l.trim())
      .filter(Boolean)

    const lineCounts = new Map<string, { count: number; originalLines: string[]; uid: string }>()
    const dbUids = new Set(accounts.map((a) => a.uid?.trim()).filter(Boolean))

    for (const line of rawLines) {
      const parts = line.split(/[|,;\t]/)
      const potentialUid = parts[0]?.trim() || line
      const key = /^\d{4,25}$/.test(potentialUid) ? potentialUid : line

      if (!lineCounts.has(key)) {
        lineCounts.set(key, { count: 0, originalLines: [], uid: potentialUid })
      }
      const entry = lineCounts.get(key)!
      entry.count++
      entry.originalLines.push(line)
    }

    const duplicateItems: Array<{
      item: string
      occurrences: number
      inDb: boolean
      sampleLines: string[]
    }> = []
    const uniqueLines: string[] = []
    const duplicateLines: string[] = []

    for (const [, entry] of lineCounts.entries()) {
      uniqueLines.push(entry.originalLines[0])
      if (entry.count > 1) {
        duplicateLines.push(...entry.originalLines.slice(1))
        duplicateItems.push({
          item: entry.uid,
          occurrences: entry.count,
          inDb: dbUids.has(entry.uid),
          sampleLines: entry.originalLines
        })
      }
    }

    return {
      totalLines: rawLines.length,
      uniqueCount: uniqueLines.length,
      duplicateCount: rawLines.length - uniqueLines.length,
      duplicateItems,
      uniqueLines,
      duplicateLines
    }
  }, [customDupesText, accounts])

  const extractFacebookId = (url: string): { id: string; type: string } | null => {
    const trimmed = url.trim()
    if (!trimmed) return null

    const postMatch = trimmed.match(/\/posts\/(\d+)/i)
    if (postMatch) return { id: postMatch[1], type: 'Post' }

    const photoMatch = trimmed.match(/\/photos\/[^/]+\/(\d+)/i)
    if (photoMatch) return { id: photoMatch[1], type: 'Photo' }

    const storyFbidMatch = trimmed.match(/[?&]story_fbid=(\d+)/i)
    if (storyFbidMatch) return { id: storyFbidMatch[1], type: 'Post' }

    const fbidMatch = trimmed.match(/[?&]fbid=(\d+)/i)
    if (fbidMatch) return { id: fbidMatch[1], type: 'Photo/Post' }

    const groupMatch = trimmed.match(/\/groups\/(\d+)/i)
    if (groupMatch) return { id: groupMatch[1], type: 'Group' }

    const groupSlugMatch = trimmed.match(/\/groups\/([a-zA-Z0-9._-]+)/i)
    if (groupSlugMatch && !['permalink', 'posts', 'about'].includes(groupSlugMatch[1])) {
      return { id: groupSlugMatch[1], type: 'Group' }
    }

    const reelMatch = trimmed.match(/\/reel\/(\d+)/i)
    if (reelMatch) return { id: reelMatch[1], type: 'Reel' }

    const videoMatch = trimmed.match(/\/videos\/(\d+)/i)
    if (videoMatch) return { id: videoMatch[1], type: 'Video' }

    const watchMatch = trimmed.match(/\/watch\/?\?v=(\d+)/i)
    if (watchMatch) return { id: watchMatch[1], type: 'Video' }

    const sharePostMatch = trimmed.match(/\/share\/p\/([a-zA-Z0-9]+)/i)
    if (sharePostMatch) return { id: sharePostMatch[1], type: 'Share Post' }

    const shareReelMatch = trimmed.match(/\/share\/r\/([a-zA-Z0-9]+)/i)
    if (shareReelMatch) return { id: shareReelMatch[1], type: 'Share Reel' }

    const shareVideoMatch = trimmed.match(/\/share\/v\/([a-zA-Z0-9]+)/i)
    if (shareVideoMatch) return { id: shareVideoMatch[1], type: 'Share Video' }

    const shareGeneralMatch = trimmed.match(/\/share\/([a-zA-Z0-9]+)/i)
    if (shareGeneralMatch) return { id: shareGeneralMatch[1], type: 'Share Link' }

    const profileIdMatch = trimmed.match(/[?&]id=(\d+)/i)
    if (profileIdMatch) return { id: profileIdMatch[1], type: 'Profile' }

    const vanityMatch = trimmed.match(/facebook\.com\/([a-zA-Z0-9._-]+)/i)
    if (vanityMatch) {
      const slug = vanityMatch[1]
      const reserved = [
        'groups',
        'watch',
        'reel',
        'reels',
        'share',
        'photo',
        'photos',
        'pages',
        'marketplace',
        'events',
        'gaming',
        'hashtag',
        'messages',
        'notifications',
        'settings',
        'help'
      ]
      if (!reserved.includes(slug.toLowerCase())) {
        return { id: slug, type: 'Profile / Page' }
      }
    }

    const rawIdMatch = trimmed.match(/\b(\d{8,20})\b/)
    if (rawIdMatch) return { id: rawIdMatch[1], type: 'ID' }

    return null
  }

  const runExtractFbIds = (): void => {
    const lines = fbLinksInput
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length === 0) {
      showToast('Please paste Facebook links first.', 3000)
      return
    }
    const extracted: Array<{ link: string; id: string; type: string }> = []
    for (const link of lines) {
      const res = extractFacebookId(link)
      if (res) {
        extracted.push({ link, id: res.id, type: res.type })
      } else {
        extracted.push({ link, id: 'Not Found', type: 'Unknown' })
      }
    }
    setExtractedFbIds(extracted)
    const successCount = extracted.filter((e) => e.id !== 'Not Found').length
    showToast(`Extracted ${successCount} Facebook ID(s)!`, 3000)
  }

  const copyAllExtractedFbIds = (): void => {
    const ids = extractedFbIds.filter((e) => e.id !== 'Not Found').map((e) => e.id)
    if (ids.length === 0) {
      showToast('No extracted IDs to copy.', 3000)
      return
    }
    void navigator.clipboard.writeText(ids.join('\n'))
    showToast(`Copied ${ids.length} Facebook ID(s) to clipboard!`, 3000)
  }

  const convertedGoogleUrls = useMemo(() => {
    const lines = googleUrlsInput
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    return lines.map((targetUrl) => {
      let cleanUrl = targetUrl.trim()
      if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
        cleanUrl = 'https://' + cleanUrl
      }
      // DIRECT CLEAN REDIRECTS (NO %2F OR %3A ENCODING - BYPASSES REDIRECT NOTICE)
      if (googleEngine === 'IMAGES') {
        return `https://images.google.com/url?q=${cleanUrl}`
      }
      if (googleEngine === 'MAPS') {
        return `https://maps.google.com/url?q=${cleanUrl}`
      }
      return `https://www.google.com/url?q=${cleanUrl}`
    })
  }, [googleUrlsInput, googleEngine])

  const copyConvertedGoogleUrls = (): void => {
    if (convertedGoogleUrls.length === 0) {
      showToast('No converted Google links to copy.', 3000)
      return
    }
    void navigator.clipboard.writeText(convertedGoogleUrls.join('\n'))
    showToast(`Copied ${convertedGoogleUrls.length} Google Share links!`, 3000)
  }

  const TABS: { key: Tab; label: string; icon: typeof Zap }[] = [
    { key: 'uid', label: t('uidCheckerTab'), icon: Zap },
    { key: 'proxy', label: t('proxyCheckerTab'), icon: Globe2 },
    { key: 'dupes', label: t('removeDupesTab'), icon: Copy },
    { key: 'getfbid', label: t('getFbIdTab'), icon: Link },
    { key: 'googlelink', label: t('googleLinkTab'), icon: Share2 },
    { key: 'backup', label: t('backupRestoreTab'), icon: PackagePlus },
    { key: 'cloudsync', label: t('cloudSyncTab'), icon: CloudCog }
  ]

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={t('toolsUtilities')}
      icon={Wrench}
      width="max-w-5xl"
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

        {/* ========================================================================= */}
        {/* 1. Fast UID Live Checker — Interactive Result Table                       */}
        {/* ========================================================================= */}
        {tab === 'uid' && (
          <div className="flex flex-col gap-2.5">
            {/* Dual Input Mode Toggle & Action Bar */}
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/80 p-2 rounded-lg">
              <div className="flex items-center gap-1 rounded bg-slate-200/90 p-0.5 text-xs font-semibold">
                <button
                  onClick={() => setUidInputMode('DB')}
                  className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs transition-colors cursor-pointer ${
                    uidInputMode === 'DB'
                      ? 'bg-white text-blue-600 shadow-2xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Database size={12} />
                  <span>{t('selectedDbAccounts')}</span>
                </button>
                <button
                  onClick={() => setUidInputMode('CUSTOM')}
                  className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs transition-colors cursor-pointer ${
                    uidInputMode === 'CUSTOM'
                      ? 'bg-white text-blue-600 shadow-2xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <ClipboardPaste size={12} />
                  <span>{t('customUidInput')}</span>
                  {parsedCustomUids.length > 0 && (
                    <span className="rounded-full bg-blue-100 px-1.5 py-0.2 text-[10px] text-blue-700">
                      {parsedCustomUids.length}
                    </span>
                  )}
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  className="win-btn-accent px-3 py-1 font-semibold flex items-center gap-1.5"
                  onClick={() => (uidInputMode === 'DB' ? void runUidCheck() : void runCustomUidCheck())}
                  disabled={uidRunning}
                >
                  <Zap size={13} className={uidRunning ? 'animate-bounce' : ''} />
                  <span>
                    {uidRunning
                      ? 'Checking…'
                      : uidInputMode === 'DB'
                        ? t('checkLiveUids')
                        : `Check ${parsedCustomUids.length} Custom UIDs`}
                  </span>
                </button>
                {uidResults.length > 0 && (
                  <button
                    className="win-btn px-2 py-1 text-xs text-slate-500 hover:text-rose-600"
                    onClick={() => setUidResults([])}
                    title="Clear all current results"
                  >
                    {t('clearResults')}
                  </button>
                )}
              </div>
            </div>

            {/* Custom Multi-line UID Batch Textarea if Mode === CUSTOM */}
            {uidInputMode === 'CUSTOM' && (
              <div className="flex flex-col gap-1.5 rounded-lg border border-blue-200 bg-blue-50/50 p-2.5 shadow-2xs">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-800">
                      Multi-line Raw UID Batch Input (1 per line)
                    </span>
                    <span className="text-[10px] text-slate-500 bg-white px-1.5 py-0.5 rounded border border-slate-200">
                      Auto-sanitizes spaces, commas, pipes, quotes
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full">
                      {t('totalInputUids')}: {parsedCustomUids.length}
                    </span>
                    {customUidText && (
                      <button
                        type="button"
                        onClick={() => setCustomUidText('')}
                        className="text-[11px] text-slate-500 hover:text-rose-600 cursor-pointer"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
                <textarea
                  className="win-input h-28 w-full font-mono text-xs p-2 bg-white resize-y shadow-2xs"
                  placeholder="Paste thousands of UIDs here (1 UID per line or comma/pipe separated)...&#10;100012345678901&#10;100098765432109&#10;100055556666777"
                  value={customUidText}
                  onChange={(e) => setCustomUidText(e.target.value)}
                />
              </div>
            )}

            {/* Split View Container */}
            <div className="grid grid-cols-12 gap-3 min-h-[340px] h-[370px]">
              {/* Left Panel: Metrics & Live Counters */}
              <div className="col-span-4 flex flex-col gap-2.5 rounded-lg border border-slate-200 bg-slate-50/70 p-3 shadow-2xs">
                <div className="flex items-center gap-1.5 border-b border-slate-200 pb-2 text-xs font-bold text-slate-800">
                  <BarChart3 size={14} className="text-blue-600" />
                  <span>{t('summaryStats')}</span>
                </div>

                <div className="flex flex-col gap-2 flex-1 justify-center">
                  <div className="flex items-center justify-between rounded bg-white p-2 border border-slate-200 shadow-2xs">
                    <span className="text-xs text-slate-600 font-medium">
                      {uidInputMode === 'DB' ? t('totalAccounts') : 'Total UIDs'}
                    </span>
                    <strong className="text-sm font-bold text-slate-800">
                      {uidInputMode === 'DB'
                        ? selectedIds().length > 0
                          ? selectedIds().length
                          : accounts.length
                        : parsedCustomUids.length}
                    </strong>
                  </div>

                  <div className="flex items-center justify-between rounded bg-emerald-50/80 p-2 border border-emerald-200 shadow-2xs">
                    <span className="flex items-center gap-1 text-xs text-emerald-800 font-semibold">
                      <CheckCircle2 size={13} className="text-emerald-600" />
                      {t('liveAccounts')}
                    </span>
                    <strong className="text-sm font-extrabold text-emerald-700">{uidLiveCount}</strong>
                  </div>

                  <div className="flex items-center justify-between rounded bg-rose-50/80 p-2 border border-rose-200 shadow-2xs">
                    <span className="flex items-center gap-1 text-xs text-rose-800 font-semibold">
                      <XCircle size={13} className="text-rose-600" />
                      {t('deadAccounts')}
                    </span>
                    <strong className="text-sm font-extrabold text-rose-700">{uidDeadCount}</strong>
                  </div>

                  {uidOtherCount > 0 && (
                    <div className="flex items-center justify-between rounded bg-slate-100 p-2 border border-slate-200">
                      <span className="text-xs text-slate-600 font-medium">Other / Unknown</span>
                      <strong className="text-sm font-bold text-slate-700">{uidOtherCount}</strong>
                    </div>
                  )}

                  {uidRunning && (
                    <div className="mt-1 flex flex-col gap-1">
                      <div className="flex justify-between text-[11px] font-semibold text-blue-700">
                        <span>Checking Progress...</span>
                        <span>{uidProgress.done} / {uidProgress.total}</span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                        <div
                          className="h-full bg-blue-600 transition-all duration-300"
                          style={{
                            width: `${uidProgress.total > 0 ? (uidProgress.done / uidProgress.total) * 100 : 0}%`
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Right Panel: Interactive Table with Quick Action Toolbar */}
              <div className="col-span-8 flex flex-col rounded-lg border border-slate-200 bg-white shadow-2xs overflow-hidden">
                {/* Quick Action Toolbar (Filter tabs + Action Buttons) */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-100 px-3 py-1.5">
                  {/* Filter tabs */}
                  <div className="flex items-center gap-1">
                    <button
                      className={`rounded px-2 py-0.5 text-xs font-semibold transition-colors cursor-pointer ${
                        uidFilter === 'ALL'
                          ? 'bg-blue-600 text-white shadow-2xs'
                          : 'text-slate-600 hover:bg-slate-200'
                      }`}
                      onClick={() => setUidFilter('ALL')}
                    >
                      {t('filterAll')} ({uidResults.length})
                    </button>
                    <button
                      className={`rounded px-2 py-0.5 text-xs font-semibold transition-colors cursor-pointer ${
                        uidFilter === 'LIVE'
                          ? 'bg-emerald-600 text-white shadow-2xs'
                          : 'text-emerald-700 hover:bg-emerald-100'
                      }`}
                      onClick={() => setUidFilter('LIVE')}
                    >
                      {t('filterLive')} ({uidLiveCount})
                    </button>
                    <button
                      className={`rounded px-2 py-0.5 text-xs font-semibold transition-colors cursor-pointer ${
                        uidFilter === 'DIE'
                          ? 'bg-rose-600 text-white shadow-2xs'
                          : 'text-rose-700 hover:bg-rose-100'
                      }`}
                      onClick={() => setUidFilter('DIE')}
                    >
                      {t('filterDie')} ({uidDeadCount})
                    </button>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5">
                    <button
                      className="win-btn flex items-center gap-1 text-[11px] px-2 py-0.5"
                      onClick={copyLiveUids}
                      disabled={uidLiveCount === 0}
                      title="Copy all Live UIDs (newline separated)"
                    >
                      <Copy size={11} className="text-emerald-600" />
                      <span>{t('copyLiveUids')}</span>
                    </button>
                    <button
                      className="win-btn flex items-center gap-1 text-[11px] px-2 py-0.5"
                      onClick={exportUidCsv}
                      disabled={uidResults.length === 0}
                      title="Export table results to CSV"
                    >
                      <Download size={11} className="text-[#0067c0]" />
                      <span>{t('exportResults')}</span>
                    </button>
                  </div>
                </div>

                {/* Table Body */}
                <div className="flex-1 overflow-y-auto">
                  {filteredUidResults.length > 0 ? (
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-slate-100 border-b border-slate-200 font-bold text-slate-700 text-[11px] shadow-2xs">
                        <tr>
                          <th className="px-2.5 py-1.5 text-center w-12">{t('colIndex')}</th>
                          <th className="px-3 py-1.5 text-left w-36">UID</th>
                          <th className="px-3 py-1.5 text-left">{t('colAccountName')}</th>
                          <th className="px-3 py-1.5 text-center w-24">{t('colStatus')}</th>
                          <th className="px-3 py-1.5 text-left w-36">{t('colResponseTime')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-[11px]">
                        {filteredUidResults.map((r, idx) => {
                          const acc = r.accountId > 0 ? accountMap.get(r.accountId) : null
                          return (
                            <tr key={`${r.uid}-${idx}`} className="hover:bg-blue-50/40 transition-colors">
                              <td className="px-2.5 py-1.5 text-center text-slate-400 font-mono">
                                {idx + 1}
                              </td>
                              <td className="px-3 py-1.5 font-mono font-semibold text-slate-800">
                                <div className="flex items-center gap-1.5">
                                  <span>{r.uid ?? '—'}</span>
                                  {r.uid && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        void navigator.clipboard.writeText(r.uid!)
                                        showToast('UID copied to clipboard!', 2000)
                                      }}
                                      className="text-slate-400 hover:text-blue-600 transition-colors cursor-pointer"
                                      title="Copy UID"
                                    >
                                      <Copy size={11} />
                                    </button>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-1.5 text-slate-700 font-medium truncate max-w-[150px]">
                                {acc?.name || (r.accountId < 0 ? 'Custom Input' : '—')}
                              </td>
                              <td className="px-3 py-1.5 text-center">
                                <span
                                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                    r.status === 'Live'
                                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                                      : r.status === 'Die'
                                        ? 'bg-rose-100 text-rose-800 border border-rose-300'
                                        : 'bg-slate-100 text-slate-700 border border-slate-300'
                                  }`}
                                >
                                  {r.status === 'Live' ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
                                  {r.status}
                                </span>
                              </td>
                              <td className="px-3 py-1.5">
                                {getResponseTimeBadge(r.detail)}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center p-6 text-center text-slate-400">
                      <Activity size={32} className="text-slate-300 mb-1.5" />
                      <p className="text-xs">{t('noActivityYet')}</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* 2. Bulk Proxy Health Checker — Interactive Result Grid                    */}
        {/* ========================================================================= */}
        {tab === 'proxy' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-slate-500">
                Tests TCP connectivity and ping latency for every proxy assigned to accounts.
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  className="win-btn-accent px-3 py-1 font-semibold flex items-center gap-1.5"
                  onClick={() => void runProxyCheck()}
                  disabled={proxyRunning}
                >
                  <Globe2 size={13} className={proxyRunning ? 'animate-spin' : ''} />
                  <span>{proxyRunning ? 'Testing…' : t('checkProxies')}</span>
                </button>
              </div>
            </div>

            {/* Split View Container */}
            <div className="grid grid-cols-12 gap-3 min-h-[340px] h-[380px]">
              {/* Left Panel: Metrics */}
              <div className="col-span-4 flex flex-col gap-2.5 rounded-lg border border-slate-200 bg-slate-50/70 p-3 shadow-2xs">
                <div className="flex items-center gap-1.5 border-b border-slate-200 pb-2 text-xs font-bold text-slate-800">
                  <BarChart3 size={14} className="text-blue-600" />
                  <span>{t('summaryStats')}</span>
                </div>

                <div className="flex flex-col gap-2 flex-1 justify-center">
                  <div className="flex items-center justify-between rounded bg-white p-2 border border-slate-200 shadow-2xs">
                    <span className="text-xs text-slate-600 font-medium">{t('totalProxies')}</span>
                    <strong className="text-sm font-bold text-slate-800">{proxyResults.length}</strong>
                  </div>

                  <div className="flex items-center justify-between rounded bg-emerald-50/80 p-2 border border-emerald-200 shadow-2xs">
                    <span className="flex items-center gap-1 text-xs text-emerald-800 font-semibold">
                      <CheckCircle2 size={13} className="text-emerald-600" />
                      {t('healthyProxies')}
                    </span>
                    <strong className="text-sm font-extrabold text-emerald-700">{proxyAliveCount}</strong>
                  </div>

                  <div className="flex items-center justify-between rounded bg-rose-50/80 p-2 border border-rose-200 shadow-2xs">
                    <span className="flex items-center gap-1 text-xs text-rose-800 font-semibold">
                      <XCircle size={13} className="text-rose-600" />
                      {t('deadProxies')}
                    </span>
                    <strong className="text-sm font-extrabold text-rose-700">{proxyDeadCount}</strong>
                  </div>

                  <div className="flex items-center justify-between rounded bg-blue-50/80 p-2 border border-blue-200 shadow-2xs">
                    <span className="text-xs text-blue-800 font-semibold">{t('avgPing')}</span>
                    <strong className="text-sm font-extrabold text-blue-700">
                      {avgProxyLatency > 0 ? `${avgProxyLatency}ms` : '—'}
                    </strong>
                  </div>

                  {proxyRunning && (
                    <div className="mt-1 flex flex-col gap-1">
                      <div className="flex justify-between text-[11px] font-semibold text-blue-700">
                        <span>Testing Progress...</span>
                        <span>{proxyProgress.done} / {proxyProgress.total}</span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                        <div
                          className="h-full bg-blue-600 transition-all duration-300"
                          style={{
                            width: `${proxyProgress.total > 0 ? (proxyProgress.done / proxyProgress.total) * 100 : 0}%`
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Right Panel: Interactive Proxy Table with Toolbar */}
              <div className="col-span-8 flex flex-col rounded-lg border border-slate-200 bg-white shadow-2xs overflow-hidden">
                {/* Quick Action Toolbar */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-100 px-3 py-1.5">
                  {/* Filter tabs */}
                  <div className="flex items-center gap-1">
                    <button
                      className={`rounded px-2 py-0.5 text-xs font-semibold transition-colors cursor-pointer ${
                        proxyFilter === 'ALL'
                          ? 'bg-blue-600 text-white shadow-2xs'
                          : 'text-slate-600 hover:bg-slate-200'
                      }`}
                      onClick={() => setProxyFilter('ALL')}
                    >
                      {t('filterAll')} ({proxyResults.length})
                    </button>
                    <button
                      className={`rounded px-2 py-0.5 text-xs font-semibold transition-colors cursor-pointer ${
                        proxyFilter === 'HEALTHY'
                          ? 'bg-emerald-600 text-white shadow-2xs'
                          : 'text-emerald-700 hover:bg-emerald-100'
                      }`}
                      onClick={() => setProxyFilter('HEALTHY')}
                    >
                      {t('filterHealthy')} ({proxyAliveCount})
                    </button>
                    <button
                      className={`rounded px-2 py-0.5 text-xs font-semibold transition-colors cursor-pointer ${
                        proxyFilter === 'DEAD'
                          ? 'bg-rose-600 text-white shadow-2xs'
                          : 'text-rose-700 hover:bg-rose-100'
                      }`}
                      onClick={() => setProxyFilter('DEAD')}
                    >
                      {t('filterDead')} ({proxyDeadCount})
                    </button>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5">
                    <button
                      className="win-btn flex items-center gap-1 text-[11px] px-2 py-0.5"
                      onClick={copyWorkingProxies}
                      disabled={proxyAliveCount === 0}
                      title="Copy all working proxies"
                    >
                      <Copy size={11} className="text-emerald-600" />
                      <span>{t('copyWorkingProxies')}</span>
                    </button>
                    <button
                      className="win-btn flex items-center gap-1 text-[11px] px-2 py-0.5 text-rose-700 hover:bg-rose-50"
                      onClick={() => void removeDeadProxies()}
                      disabled={proxyDeadCount === 0}
                      title="Clear dead proxies from affected accounts"
                    >
                      <Trash2 size={11} className="text-rose-600" />
                      <span>{t('removeDeadProxies')}</span>
                    </button>
                  </div>
                </div>

                {/* Table Body */}
                <div className="flex-1 overflow-y-auto">
                  {filteredProxyResults.length > 0 ? (
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-slate-100 border-b border-slate-200 font-bold text-slate-700 text-[11px] shadow-2xs">
                        <tr>
                          <th className="px-2.5 py-1.5 text-center w-12">{t('colIndex')}</th>
                          <th className="px-3 py-1.5 text-left">{t('colProxyAddress')}</th>
                          <th className="px-3 py-1.5 text-center w-28">{t('colLocationGeo')}</th>
                          <th className="px-3 py-1.5 text-right w-24">{t('colLatency')}</th>
                          <th className="px-3 py-1.5 text-center w-28">{t('colStatus')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                        {filteredProxyResults.map((r, i) => (
                          <tr key={`${r.proxy}-${i}`} className="hover:bg-blue-50/40 transition-colors">
                            <td className="px-2.5 py-1.5 text-center text-slate-400">
                              {i + 1}
                            </td>
                            <td className="px-3 py-1.5 font-semibold text-slate-800">
                              <div className="flex items-center gap-1.5 truncate max-w-[200px]" title={r.proxy}>
                                <span className="truncate">{r.proxy}</span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    void navigator.clipboard.writeText(r.proxy)
                                    showToast('Proxy copied to clipboard!', 2000)
                                  }}
                                  className="text-slate-400 hover:text-blue-600 transition-colors cursor-pointer shrink-0"
                                  title="Copy Proxy"
                                >
                                  <Copy size={11} />
                                </button>
                              </div>
                            </td>
                            <td className="px-3 py-1.5 text-center">
                              <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 text-[10px] font-sans font-semibold text-slate-700 border border-slate-200">
                                {getProxyGeo(r.proxy)}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 text-right">
                              {getLatencyBadge(r)}
                            </td>
                            <td className="px-3 py-1.5 text-center">
                              <span
                                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                  r.alive
                                    ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                                    : 'bg-rose-100 text-rose-800 border border-rose-300'
                                }`}
                              >
                                {r.alive ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
                                {r.alive ? 'Healthy' : 'Dead / Refused'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center p-6 text-center text-slate-400">
                      <Globe2 size={32} className="text-slate-300 mb-1.5" />
                      <p className="text-xs">{t('noActivityYet')}</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* 3. Remove Duplicate Accounts — Dual Input: DB vs Custom List Dedupe       */}
        {/* ========================================================================= */}
        {tab === 'dupes' && (
          <div className="flex flex-col gap-2.5">
            {/* Dual Input Mode Toggle & Action Bar */}
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/80 p-2 rounded-lg">
              <div className="flex items-center gap-1 rounded bg-slate-200/90 p-0.5 text-xs font-semibold">
                <button
                  onClick={() => setDupesInputMode('DB')}
                  className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs transition-colors cursor-pointer ${
                    dupesInputMode === 'DB'
                      ? 'bg-white text-blue-600 shadow-2xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Database size={12} />
                  <span>{t('scanDatabaseAccounts')}</span>
                </button>
                <button
                  onClick={() => setDupesInputMode('CUSTOM')}
                  className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs transition-colors cursor-pointer ${
                    dupesInputMode === 'CUSTOM'
                      ? 'bg-white text-blue-600 shadow-2xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Scissors size={12} />
                  <span>{t('customListDedupe')}</span>
                  {customDupesAnalysis.totalLines > 0 && (
                    <span className="rounded-full bg-blue-100 px-1.5 py-0.2 text-[10px] text-blue-700">
                      {customDupesAnalysis.totalLines}
                    </span>
                  )}
                </button>
              </div>

              {dupesInputMode === 'DB' ? (
                <button
                  className="win-btn-primary px-3 py-1 font-semibold flex items-center gap-1.5 text-xs"
                  onClick={() => {
                    setDupesCleaned(false)
                    void scanDupes()
                  }}
                  disabled={dupesLoading}
                >
                  <Search size={13} className={dupesLoading ? 'animate-spin' : ''} />
                  <span>{dupesLoading ? 'Scanning…' : t('scanDuplicates')}</span>
                </button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <label className="flex items-center gap-1.5 text-xs text-slate-700 font-medium cursor-pointer mr-2 select-none">
                    <input
                      type="checkbox"
                      checked={crossCheckWithDb}
                      onChange={(e) => setCrossCheckWithDb(e.target.checked)}
                      className="rounded border-slate-300 text-blue-600 focus:ring-0 cursor-pointer"
                    />
                    <span>{t('crossCheckWithDb')}</span>
                  </label>
                  <button
                    className="win-btn flex items-center gap-1 text-[11px] px-2.5 py-1 text-emerald-700 font-semibold"
                    onClick={() => {
                      void navigator.clipboard.writeText(customDupesAnalysis.uniqueLines.join('\n'))
                      showToast(`Copied ${customDupesAnalysis.uniqueLines.length} unique lines!`, 2500)
                    }}
                    disabled={customDupesAnalysis.uniqueLines.length === 0}
                    title="Copy unique lines only"
                  >
                    <Copy size={11} />
                    <span>{t('copyUniqueList')}</span>
                  </button>
                  <button
                    className="win-btn flex items-center gap-1 text-[11px] px-2.5 py-1 text-amber-700 font-semibold"
                    onClick={() => {
                      void navigator.clipboard.writeText(customDupesAnalysis.duplicateLines.join('\n'))
                      showToast(`Copied ${customDupesAnalysis.duplicateLines.length} duplicate lines!`, 2500)
                    }}
                    disabled={customDupesAnalysis.duplicateLines.length === 0}
                    title="Copy duplicate lines only"
                  >
                    <Copy size={11} />
                    <span>{t('copyDuplicatesList')}</span>
                  </button>
                  <button
                    className="win-btn-accent flex items-center gap-1 text-[11px] px-2.5 py-1 font-bold shadow-2xs"
                    onClick={() => {
                      setCustomDupesText(customDupesAnalysis.uniqueLines.join('\n'))
                      showToast('Duplicates removed from list!', 2500)
                    }}
                    disabled={customDupesAnalysis.duplicateCount === 0}
                    title="Remove duplicate lines from paste area"
                  >
                    <Scissors size={11} />
                    <span>{t('removeDuplicateLines')} ({customDupesAnalysis.duplicateCount})</span>
                  </button>
                </div>
              )}
            </div>

            {/* Custom List Input Textarea if Mode === CUSTOM */}
            {dupesInputMode === 'CUSTOM' && (
              <div className="flex flex-col gap-1.5 rounded-lg border border-amber-200 bg-amber-50/50 p-2.5 shadow-2xs">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-slate-800">
                    Multi-line Raw UID / Account List (1 per line)
                  </span>
                  <div className="flex items-center gap-3 text-xs font-mono">
                    <span className="bg-white px-2 py-0.5 rounded border border-slate-200">
                      Total Lines: <strong>{customDupesAnalysis.totalLines}</strong>
                    </span>
                    <span className="text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded font-bold">
                      Unique: <strong>{customDupesAnalysis.uniqueCount}</strong>
                    </span>
                    <span className="text-amber-800 bg-amber-100 px-2 py-0.5 rounded font-bold">
                      Duplicates: <strong>{customDupesAnalysis.duplicateCount}</strong>
                    </span>
                    {customDupesText && (
                      <button
                        type="button"
                        onClick={() => setCustomDupesText('')}
                        className="text-[11px] text-slate-500 hover:text-rose-600 cursor-pointer font-sans"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
                <textarea
                  className="win-input h-28 w-full font-mono text-xs p-2 bg-white resize-y shadow-2xs"
                  placeholder="Paste accounts or raw UID list here (1 item per line)...&#10;100011112222&#10;100011112222&#10;100033334444|password|..."
                  value={customDupesText}
                  onChange={(e) => setCustomDupesText(e.target.value)}
                />
              </div>
            )}

            {/* Split View Container */}
            <div className="grid grid-cols-12 gap-3 min-h-[340px] h-[370px]">
              {/* Left Panel: Summary & Action */}
              <div className="col-span-4 flex flex-col gap-2.5 rounded-lg border border-slate-200 bg-slate-50/70 p-3 shadow-2xs">
                <div className="flex items-center gap-1.5 border-b border-slate-200 pb-2 text-xs font-bold text-slate-800">
                  <BarChart3 size={14} className="text-blue-600" />
                  <span>{t('summaryStats')}</span>
                </div>

                <div className="flex flex-col gap-2 flex-1 justify-center">
                  <div className="flex items-center justify-between rounded bg-white p-2 border border-slate-200 shadow-2xs">
                    <span className="text-xs text-slate-600 font-medium">
                      {dupesInputMode === 'DB' ? t('totalAccounts') : 'Total Lines'}
                    </span>
                    <strong className="text-sm font-bold text-slate-800">
                      {dupesInputMode === 'DB' ? accounts.length : customDupesAnalysis.totalLines}
                    </strong>
                  </div>

                  <div className="flex items-center justify-between rounded bg-amber-50/80 p-2 border border-amber-200 shadow-2xs">
                    <span className="flex items-center gap-1 text-xs text-amber-800 font-semibold">
                      <Copy size={13} className="text-amber-600" />
                      {dupesInputMode === 'DB' ? t('accountsToRemove') : 'Duplicate Lines'}
                    </span>
                    <strong className="text-sm font-extrabold text-amber-700">
                      {dupesInputMode === 'DB' ? dupes.length : customDupesAnalysis.duplicateCount}
                    </strong>
                  </div>

                  <div className="flex items-center justify-between rounded bg-blue-50/80 p-2 border border-blue-200 shadow-2xs">
                    <span className="text-xs text-blue-800 font-semibold">
                      {dupesInputMode === 'DB' ? t('duplicateGroups') : 'Unique Items'}
                    </span>
                    <strong className="text-sm font-extrabold text-blue-700">
                      {dupesInputMode === 'DB' ? duplicateGroups.length : customDupesAnalysis.uniqueCount}
                    </strong>
                  </div>

                  {dupesInputMode === 'DB' ? (
                    dupes.length > 0 ? (
                      <div className="mt-2 flex flex-col gap-1.5">
                        <button
                          className="win-btn-accent w-full py-2 font-bold flex items-center justify-center gap-1.5 shadow-sm text-xs"
                          onClick={() => void removeDupes()}
                          disabled={dupesRemoving}
                        >
                          <Trash2 size={13} />
                          <span>
                            {dupesRemoving ? 'Removing…' : `${t('cleanAllDuplicates')} (${dupes.length})`}
                          </span>
                        </button>
                        <p className="text-[10px] text-slate-500 text-center">
                          Safely moves extra duplicates to the Recycle Bin.
                        </p>
                      </div>
                    ) : dupesCleaned ? (
                      <div className="rounded border border-emerald-200 bg-emerald-50/80 p-2.5 text-center text-xs text-emerald-800 font-medium flex items-center justify-center gap-1.5">
                        <CheckCircle2 size={14} className="text-emerald-600" />
                        <span>{t('cleaned')}! All duplicate accounts resolved.</span>
                      </div>
                    ) : (
                      <div className="rounded border border-slate-200 bg-white p-2.5 text-center text-xs text-slate-500 font-medium">
                        Click "{t('scanDuplicates')}" to analyze database
                      </div>
                    )
                  ) : (
                    <div className="mt-2 flex flex-col gap-1.5">
                      <button
                        className="win-btn-accent w-full py-2 font-bold flex items-center justify-center gap-1.5 shadow-sm text-xs"
                        onClick={() => {
                          setCustomDupesText(customDupesAnalysis.uniqueLines.join('\n'))
                          showToast('Duplicates removed from list!', 2500)
                        }}
                        disabled={customDupesAnalysis.duplicateCount === 0}
                      >
                        <Scissors size={13} />
                        <span>Remove Duplicates from List</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Right Panel: Structured Duplicate Resolution Table */}
              <div className="col-span-8 flex flex-col rounded-lg border border-slate-200 bg-white shadow-2xs overflow-hidden">
                {/* Action Toolbar */}
                <div className="flex items-center justify-between border-b border-slate-200 bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-800">
                  <div className="flex items-center gap-1.5">
                    <Activity size={14} className="text-blue-600" />
                    <span>
                      {dupesInputMode === 'DB'
                        ? `${t('activityLog')} (${duplicateGroups.length} ${t('duplicateGroups')})`
                        : `Duplicate List Items (${customDupesAnalysis.duplicateItems.length})`}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {dupesInputMode === 'DB' && dupes.length > 0 && (
                      <>
                        <button
                          className="win-btn flex items-center gap-1 text-[11px] px-2 py-0.5"
                          onClick={copyDupes}
                          title="Copy duplicates list"
                        >
                          <Copy size={11} />
                          <span>{t('copyLog')}</span>
                        </button>
                        <button
                          className="win-btn-accent flex items-center gap-1 text-[11px] px-2 py-0.5"
                          onClick={() => void removeDupes()}
                          disabled={dupesRemoving}
                        >
                          <Trash2 size={11} />
                          <span>{t('cleanAllDuplicates')}</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Table Body */}
                <div className="flex-1 overflow-y-auto">
                  {dupesInputMode === 'DB' ? (
                    duplicateGroups.length > 0 ? (
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-slate-100 border-b border-slate-200 font-bold text-slate-700 text-[11px] shadow-2xs">
                          <tr>
                            <th className="px-2.5 py-1.5 text-center w-12">{t('colIndex')}</th>
                            <th className="px-3 py-1.5 text-left w-36">{t('colDuplicatedUid')}</th>
                            <th className="px-3 py-1.5 text-center w-28">{t('colOccurrences')}</th>
                            <th className="px-3 py-1.5 text-left">{t('colAccountDetails')}</th>
                            <th className="px-3 py-1.5 text-center w-36">{t('colAction')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-[11px]">
                          {duplicateGroups.map((g, i) => (
                            <tr key={g.uid} className="hover:bg-amber-50/40 transition-colors">
                              <td className="px-2.5 py-1.5 text-center text-slate-400 font-mono">
                                {i + 1}
                              </td>
                              <td className="px-3 py-1.5 font-mono font-bold text-slate-800">
                                <div className="flex items-center gap-1.5">
                                  <span>{g.uid}</span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      void navigator.clipboard.writeText(g.uid)
                                      showToast('UID copied to clipboard!', 2000)
                                    }}
                                    className="text-slate-400 hover:text-blue-600 transition-colors cursor-pointer"
                                    title="Copy UID"
                                  >
                                    <Copy size={11} />
                                  </button>
                                </div>
                              </td>
                              <td className="px-3 py-1.5 text-center">
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800 border border-amber-300">
                                  {g.occurrences} Accounts
                                </span>
                              </td>
                              <td className="px-3 py-1.5 font-sans">
                                <div className="flex flex-col gap-0.5 max-w-[220px]">
                                  {g.accounts.map((acc, aIdx) => (
                                    <div key={acc.accountId} className="truncate text-slate-700">
                                      <span className="font-mono text-[10px] text-slate-400 font-semibold">
                                        #{acc.accountId}
                                      </span>{' '}
                                      <span className="font-medium text-slate-800">
                                        {acc.name || acc.email || 'No Name'}
                                      </span>
                                      {aIdx === 0 && (
                                        <span className="ml-1 text-[10px] text-emerald-600 font-semibold">
                                          (Oldest)
                                        </span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </td>
                              <td className="px-3 py-1.5 text-center">
                                <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800 border border-amber-200">
                                  {t('keepOldestBinOthers')}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center p-6 text-center text-slate-400">
                        <Copy size={32} className="text-slate-300 mb-1.5" />
                        <p className="text-xs">
                          {dupesCleaned
                            ? `${t('cleaned')}! No duplicate accounts remaining.`
                            : t('noActivityYet')}
                        </p>
                      </div>
                    )
                  ) : (
                    /* Custom List Dedupe Result Table */
                    customDupesAnalysis.duplicateItems.length > 0 ? (
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-slate-100 border-b border-slate-200 font-bold text-slate-700 text-[11px] shadow-2xs">
                          <tr>
                            <th className="px-2.5 py-1.5 text-center w-12">{t('colIndex')}</th>
                            <th className="px-3 py-1.5 text-left">UID / Item</th>
                            <th className="px-3 py-1.5 text-center w-28">{t('colOccurrences')}</th>
                            <th className="px-3 py-1.5 text-center w-36">{t('dbMatchStatus')}</th>
                            <th className="px-3 py-1.5 text-center w-20">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-[11px]">
                          {customDupesAnalysis.duplicateItems.map((item, idx) => (
                            <tr key={idx} className="hover:bg-amber-50/40 transition-colors">
                              <td className="px-2.5 py-1.5 text-center text-slate-400 font-mono">
                                {idx + 1}
                              </td>
                              <td className="px-3 py-1.5 font-mono font-bold text-slate-800">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate max-w-[200px]" title={item.item}>
                                    {item.item}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      void navigator.clipboard.writeText(item.item)
                                      showToast('Copied to clipboard!', 2000)
                                    }}
                                    className="text-slate-400 hover:text-blue-600 transition-colors cursor-pointer shrink-0"
                                    title="Copy"
                                  >
                                    <Copy size={11} />
                                  </button>
                                </div>
                              </td>
                              <td className="px-3 py-1.5 text-center">
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800 border border-amber-300">
                                  {item.occurrences} Occurrences
                                </span>
                              </td>
                              <td className="px-3 py-1.5 text-center">
                                {item.inDb ? (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800 border border-emerald-300">
                                    <CheckCircle2 size={10} />
                                    {t('inDatabase')}
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600 border border-slate-200">
                                    {t('notInDatabase')}
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-1.5 text-center">
                                <button
                                  type="button"
                                  onClick={() => {
                                    void navigator.clipboard.writeText(item.item)
                                    showToast('Copied to clipboard!', 1500)
                                  }}
                                  className="text-blue-600 hover:underline text-[11px] font-medium cursor-pointer"
                                >
                                  Copy
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center p-6 text-center text-slate-400">
                        <CheckCircle2 size={32} className="text-emerald-400 mb-1.5" />
                        <p className="text-xs">
                          {customDupesAnalysis.totalLines > 0
                            ? 'All items in the custom list are unique! (0 duplicates found)'
                            : 'Paste a list above to detect and filter duplicates.'}
                        </p>
                      </div>
                    )
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* 4. Get Facebook ID Tool — Extract ID from Any Facebook Link               */}
        {/* ========================================================================= */}
        {tab === 'getfbid' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/80 p-2 rounded-lg">
              <p className="text-[11px] text-slate-500">
                Paste single or bulk Facebook links to extract target IDs (Posts, Reels, Videos, Groups, Profiles, Share Links).
              </p>
              <div className="flex items-center gap-2">
                <button
                  className="win-btn-accent px-3 py-1 font-semibold flex items-center gap-1.5"
                  onClick={runExtractFbIds}
                >
                  <Link size={13} />
                  <span>{t('extractAllIds')}</span>
                </button>
                {extractedFbIds.length > 0 && (
                  <>
                    <button
                      className="win-btn flex items-center gap-1 text-xs px-2.5 py-1 text-emerald-700"
                      onClick={copyAllExtractedFbIds}
                    >
                      <Copy size={12} />
                      <span>{t('copyAllExtractedIds')}</span>
                    </button>
                    <button
                      className="win-btn px-2 py-1 text-xs text-slate-500 hover:text-rose-600"
                      onClick={() => setExtractedFbIds([])}
                    >
                      {t('clearResults')}
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="grid grid-cols-12 gap-3 min-h-[340px] h-[380px]">
              {/* Left Input Area */}
              <div className="col-span-5 flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50/70 p-3 shadow-2xs">
                <div className="flex items-center justify-between text-xs font-bold text-slate-800 border-b border-slate-200 pb-1.5">
                  <span className="flex items-center gap-1.5">
                    <Link size={14} className="text-blue-600" />
                    <span>Facebook URLs Input</span>
                  </span>
                  <span className="font-mono text-[11px] text-blue-700">
                    {fbLinksInput.split('\n').filter((l) => l.trim()).length} link(s)
                  </span>
                </div>
                <textarea
                  className="win-input flex-1 w-full font-mono text-[11px] p-2 bg-white resize-none"
                  placeholder={t('fbLinksPlaceholder')}
                  value={fbLinksInput}
                  onChange={(e) => setFbLinksInput(e.target.value)}
                />
                <div className="flex justify-between items-center text-[10px] text-slate-400">
                  <span>Supports: Posts, Reels, Groups, Shares, Profiles</span>
                  <button
                    type="button"
                    className="text-blue-600 hover:underline cursor-pointer"
                    onClick={() => setFbLinksInput('')}
                  >
                    Clear Text
                  </button>
                </div>
              </div>

              {/* Right Result Table */}
              <div className="col-span-7 flex flex-col rounded-lg border border-slate-200 bg-white shadow-2xs overflow-hidden">
                <div className="flex items-center justify-between border-b border-slate-200 bg-slate-100 px-3 py-2 text-xs font-bold text-slate-800">
                  <div className="flex items-center gap-1.5">
                    <Activity size={14} className="text-blue-600" />
                    <span>Extracted IDs ({extractedFbIds.length})</span>
                  </div>
                  {extractedFbIds.length > 0 && (
                    <span className="text-[11px] font-semibold text-emerald-700">
                      {extractedFbIds.filter((e) => e.id !== 'Not Found').length} Resolved
                    </span>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto">
                  {extractedFbIds.length > 0 ? (
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-slate-100 border-b border-slate-200 font-bold text-slate-700 text-[11px] shadow-2xs">
                        <tr>
                          <th className="px-2.5 py-1.5 text-center w-10">{t('colIndex')}</th>
                          <th className="px-3 py-1.5 text-left">{t('colOriginalLink')}</th>
                          <th className="px-3 py-1.5 text-left w-36">{t('colExtractedId')}</th>
                          <th className="px-2.5 py-1.5 text-center w-24">{t('colLinkType')}</th>
                          <th className="px-2.5 py-1.5 text-center w-16">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-[11px]">
                        {extractedFbIds.map((item, idx) => (
                          <tr key={idx} className="hover:bg-blue-50/40 transition-colors">
                            <td className="px-2.5 py-1.5 text-center text-slate-400 font-mono">
                              {idx + 1}
                            </td>
                            <td className="px-3 py-1.5 font-mono text-[10px] text-slate-600 truncate max-w-[170px]" title={item.link}>
                              {item.link}
                            </td>
                            <td className="px-3 py-1.5 font-mono font-bold text-slate-800">
                              <span className={item.id === 'Not Found' ? 'text-rose-600' : 'text-blue-700'}>
                                {item.id}
                              </span>
                            </td>
                            <td className="px-2.5 py-1.5 text-center">
                              <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700 border border-slate-200">
                                {item.type}
                              </span>
                            </td>
                            <td className="px-2.5 py-1.5 text-center">
                              {item.id !== 'Not Found' && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    void navigator.clipboard.writeText(item.id)
                                    showToast('ID copied to clipboard!', 2000)
                                  }}
                                  className="text-slate-500 hover:text-blue-600 transition-colors cursor-pointer"
                                  title="Copy ID"
                                >
                                  <Copy size={12} />
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center p-6 text-center text-slate-400">
                      <Link size={32} className="text-slate-300 mb-1.5" />
                      <p className="text-xs">Paste links on the left and click "{t('extractAllIds')}"</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* 5. Google Share Link Converter — Safe Referral Redirects                   */}
        {/* ========================================================================= */}
        {tab === 'googlelink' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/80 p-2 rounded-lg">
              <p className="text-[11px] text-slate-500">
                Converts regular website URLs into authentic Google Search / Referrer Redirect URLs for safe Facebook posting without domain flags.
              </p>
              <div className="flex items-center gap-2">
                <button
                  className="win-btn-accent px-3 py-1 font-semibold flex items-center gap-1.5"
                  onClick={copyConvertedGoogleUrls}
                  disabled={convertedGoogleUrls.length === 0}
                >
                  <Copy size={13} />
                  <span>{t('copyConverted')} ({convertedGoogleUrls.length})</span>
                </button>
                {convertedGoogleUrls.length > 0 && (
                  <button
                    className="win-btn px-2.5 py-1 text-xs flex items-center gap-1 font-semibold text-blue-700 hover:bg-blue-50"
                    onClick={() => {
                      if (convertedGoogleUrls[0]) {
                        window.open(convertedGoogleUrls[0], '_blank')
                      }
                    }}
                    title="Test open first link directly in default browser"
                  >
                    <ExternalLink size={12} />
                    <span>{t('testDirectLink')}</span>
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-12 gap-3 min-h-[340px] h-[380px]">
              {/* Left Input Area */}
              <div className="col-span-6 flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50/70 p-3 shadow-2xs">
                <div className="flex items-center justify-between text-xs font-bold text-slate-800 border-b border-slate-200 pb-1.5">
                  <span className="flex items-center gap-1.5">
                    <Share2 size={14} className="text-blue-600" />
                    <span>Target URLs (1 per line)</span>
                  </span>
                  <span className="font-mono text-[11px] text-blue-700">
                    {googleUrlsInput.split('\n').filter((l) => l.trim()).length} link(s)
                  </span>
                </div>

                {/* Direct Google Redirect Engine Options */}
                <div className="flex flex-wrap items-center gap-3.5 py-1 text-xs">
                  <label className="flex items-center gap-1.5 cursor-pointer font-semibold text-slate-800 select-none">
                    <input
                      type="radio"
                      name="googleEngine"
                      checked={googleEngine === 'SEARCH'}
                      onChange={() => setGoogleEngine('SEARCH')}
                      className="text-blue-600 focus:ring-0 cursor-pointer"
                    />
                    <span>{t('redirectTypeSearch')}</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer font-semibold text-slate-800 select-none">
                    <input
                      type="radio"
                      name="googleEngine"
                      checked={googleEngine === 'IMAGES'}
                      onChange={() => setGoogleEngine('IMAGES')}
                      className="text-blue-600 focus:ring-0 cursor-pointer"
                    />
                    <span>{t('redirectTypeImages')}</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer font-semibold text-slate-800 select-none">
                    <input
                      type="radio"
                      name="googleEngine"
                      checked={googleEngine === 'MAPS'}
                      onChange={() => setGoogleEngine('MAPS')}
                      className="text-blue-600 focus:ring-0 cursor-pointer"
                    />
                    <span>{t('redirectTypeMaps')}</span>
                  </label>
                </div>

                <textarea
                  className="win-input flex-1 w-full font-mono text-[11px] p-2 bg-white resize-none"
                  placeholder={t('googleUrlPlaceholder')}
                  value={googleUrlsInput}
                  onChange={(e) => setGoogleUrlsInput(e.target.value)}
                />
              </div>

              {/* Right Output Area */}
              <div className="col-span-6 flex flex-col rounded-lg border border-slate-200 bg-white shadow-2xs overflow-hidden">
                <div className="flex items-center justify-between border-b border-slate-200 bg-slate-100 px-3 py-2 text-xs font-bold text-slate-800">
                  <div className="flex items-center gap-1.5">
                    <ExternalLink size={14} className="text-blue-600" />
                    <span>Converted Google Links ({convertedGoogleUrls.length})</span>
                  </div>
                  {convertedGoogleUrls.length > 0 && (
                    <button
                      className="text-[11px] text-blue-600 hover:underline cursor-pointer"
                      onClick={copyConvertedGoogleUrls}
                    >
                      1-Click Copy All
                    </button>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto p-2 bg-slate-50/50">
                  {convertedGoogleUrls.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      {convertedGoogleUrls.map((gUrl, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white p-2 text-[11px] font-mono shadow-2xs hover:border-blue-300 transition-colors"
                        >
                          <span className="truncate flex-1 text-slate-800 select-all" title={gUrl}>
                            {gUrl}
                          </span>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => {
                                void navigator.clipboard.writeText(gUrl)
                                showToast('Link copied!', 1500)
                              }}
                              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-blue-600 transition-colors cursor-pointer"
                              title="Copy Google link"
                            >
                              <Copy size={12} />
                            </button>
                            <button
                              type="button"
                              onClick={() => window.open(gUrl, '_blank')}
                              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-emerald-600 transition-colors cursor-pointer"
                              title="Open link in browser"
                            >
                              <ExternalLink size={12} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center p-6 text-center text-slate-400">
                      <Share2 size={32} className="text-slate-300 mb-1.5" />
                      <p className="text-xs">Paste links on the left to generate safe Google Share links in real time.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'backup' && (
          <div className="flex flex-col gap-5 py-1">
            {/* 1. Export Section */}
            <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50/50 p-4 shadow-2xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[13px] font-bold text-slate-800">
                  <PackagePlus size={16} className="text-[#0067c0]" />
                  <span>{t('backupTitle')}</span>
                </div>
                <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-[11px] font-semibold text-blue-700 border border-blue-200">
                  {selectedIds().length > 0
                    ? `${selectedIds().length} selected account(s)`
                    : `All ${accounts.length} account(s)`}
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-600">
                {t('backupDesc')}
              </p>
              <div>
                <button
                  className="win-btn-accent px-4 py-1.5 font-medium shadow-xs"
                  onClick={() => void runExport()}
                  disabled={exporting}
                >
                  {exporting ? 'Backing up…' : t('backupBtn')}
                </button>
              </div>
            </div>

            {/* 2. Import & Restore Section with Dedicated Drag & Drop Zone */}
            <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-2xs">
              <div className="flex items-center gap-2 text-[13px] font-bold text-slate-800">
                <FolderArchive size={16} className="text-emerald-600" />
                <span>{t('restoreTitle')}</span>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-600">
                {t('restoreDesc')}
              </p>

              {/* Dedicated Drag & Drop Drop-Zone */}
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={(e) => void handleDrop(e)}
                onClick={() => void runImport()}
                className={`group relative flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-all duration-200 ${
                  isDragOver
                    ? 'border-blue-500 bg-blue-50/90 scale-[1.01] shadow-lg ring-4 ring-blue-500/15'
                    : 'border-slate-300 bg-slate-50/70 hover:border-blue-400 hover:bg-blue-50/40 hover:shadow-xs'
                }`}
              >
                <div
                  className={`mb-3 flex h-14 w-14 items-center justify-center rounded-2xl transition-all duration-200 group-hover:scale-110 shadow-2xs ${
                    isDragOver
                      ? 'bg-blue-600 text-white shadow-blue-500/30 shadow-md'
                      : 'bg-emerald-100 text-emerald-700 group-hover:bg-blue-100 group-hover:text-blue-600'
                  }`}
                >
                  <UploadCloud size={28} className={importing ? 'animate-bounce' : ''} />
                </div>

                <div className="text-sm font-bold text-slate-800">
                  {importing ? (
                    <span className="flex items-center gap-2 text-blue-600">
                      <RefreshCw size={15} className="animate-spin" />
                      Restoring Accounts & Profiles...
                    </span>
                  ) : isDragOver ? (
                    <span className="text-blue-600 font-bold text-[14px]">{t('dragDropActive')}</span>
                  ) : (
                    <span>{t('dragDropPrompt')}</span>
                  )}
                </div>

                <p className="mt-1 text-[11px] text-slate-500">
                  {t('dragDropSub')}
                </p>

                <div className="mt-3.5 flex items-center gap-2">
                  <button
                    type="button"
                    className="win-btn px-4 py-1.5 font-medium shadow-xs hover:bg-slate-100 flex items-center gap-1.5"
                    disabled={importing}
                    onClick={(e) => {
                      e.stopPropagation()
                      void runImport()
                    }}
                  >
                    <FileArchive size={14} className="text-[#0067c0]" />
                    <span>{t('importBtn')}</span>
                  </button>
                </div>
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
