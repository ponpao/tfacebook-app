// ---------------------------------------------------------------------------
// DeletePagePostsModal.tsx  — Page Posts Manager & Bulk Deletion via
// Meta Business Suite table.
// ---------------------------------------------------------------------------
import React, { useState, useEffect, useMemo, useRef } from 'react'
import {
  Trash2,
  Calendar,
  Layers,
  Eye,
  Heart,
  TrendingUp,
  RefreshCw,
  Search,
  CheckSquare,
  Square,
  AlertTriangle,
  Film,
  Image as ImageIcon,
  FileText,
  Clock,
  User,
  Monitor,
  Zap,
  CheckCircle2,
  XCircle,
  Sparkles,
  Timer,
  Eraser
} from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'
import { useLanguageStore } from '../../store/useLanguageStore'
import type { ManagedPage, PagePost, PagePostType, Account } from '../../../types/account'
import type { BatchScanProgressEvent } from '../../../types/ipc'

interface DeletePagePostsModalProps {
  open: boolean
  onClose: () => void
}

interface AccountPageRow {
  account: Account
  pageId: string
  pageName: string
  assetId: string
  url?: string
}

export function DeletePagePostsModal({ open, onClose }: DeletePagePostsModalProps): React.JSX.Element | null {
  const accounts = useAccountStore((s) => s.accounts)
  const rowSelection = useAccountStore((s) => s.rowSelection)
  const showToast = useAccountStore((s) => s.showToast)
  const refreshAccounts = useAccountStore((s) => s.refresh)

  // Automation Headless / Headed mode toggle
  const [headlessMode, setHeadlessMode] = useState<boolean>(true)

  // Selected account IDs derived reactively from rowSelection
  const selectedAccountIds = useMemo(() => {
    return Object.entries(rowSelection)
      .filter(([_, v]) => Boolean(v))
      .map(([id]) => Number(id))
  }, [rowSelection])

  // Accounts to show on the left list (strictly the ticked accounts from main UI, or all if none ticked)
  const targetAccounts = useMemo(() => {
    if (selectedAccountIds.length > 0) {
      return accounts.filter((a) => selectedAccountIds.includes(a.id))
    }
    return accounts
  }, [accounts, selectedAccountIds])

  // Temporary UI-cleared row IDs (cleared from view only until modal reopens)
  const [clearedRowKeys, setClearedRowKeys] = useState<Set<string>>(new Set())

  // Multi-selected left account/page row keys (for mouse multi-selection)
  const [selectedLeftKeys, setSelectedLeftKeys] = useState<Set<string>>(new Set())

  // Drag-to-select and range selection for the left table (like Main UI DataGridView)
  const [dragAnchorIndex, setDragAnchorIndex] = useState<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const lastClickedIndexRef = useRef<number | null>(null)
  const dragBaseSelectionRef = useRef<Set<string>>(new Set())

  // Context Menu state for right click on left table
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean
    x: number
    y: number
    row: AccountPageRow | null
  }>({ visible: false, x: 0, y: 0, row: null })

  // Build the list of Account + Page pairs for the left column (UID | ID Page | Name Page)
  const accountPageList = useMemo<AccountPageRow[]>(() => {
    const list: AccountPageRow[] = []
    const JUNK_PAGE_KEYWORDS = [
      'login', 'messenger', 'lite', 'privacy', 'policy', 'terms', 'help', 'cookies',
      'about', 'careers', 'ad_campaign', 'create ad', '1.php', 'reg/'
    ]

    for (const acc of targetAccounts) {
      if (acc.pages_data) {
        try {
          const parsed: ManagedPage[] = JSON.parse(acc.pages_data)
          if (Array.isArray(parsed) && parsed.length > 0) {
            const valid = parsed.filter(
              (p) =>
                p.pageId &&
                !JUNK_PAGE_KEYWORDS.some((kw) => p.pageId.toLowerCase().includes(kw))
            )
            if (valid.length > 0) {
              for (const p of valid) {
                list.push({
                  account: acc,
                  pageId: p.pageId,
                  pageName: p.name || 'Unnamed Page',
                  assetId: p.assetId || p.pageId,
                  url: p.url
                })
              }
              continue
            }
          }
        } catch {
          /* ignore parse error */
        }
      }
      // If no valid page data parsed yet, add account placeholder
      list.push({
        account: acc,
        pageId: '-',
        pageName: acc.pages_count > 0 ? `${acc.pages_count} Page(s) (Click to Scan)` : 'No Page',
        assetId: '',
        url: undefined
      })
    }
    return list
  }, [targetAccounts])

  // Active selected row from left column
  const [activeRowKey, setActiveRowKey] = useState<string>('')
  const activeRow = useMemo(() => {
    return accountPageList.find((r) => `${r.account.id}-${r.pageId}` === activeRowKey) || accountPageList[0] || null
  }, [accountPageList, activeRowKey])

  // Filter state
  const [fromDate, setFromDate] = useState<string>('')
  const [toDate, setToDate] = useState<string>('')
  const [targetType, setTargetType] = useState<PagePostType>('ALL')

  // Concurrency Threads (កំណត់ចំនួន Threads)
  const [threads, setThreads] = useState<number>(2)

  // Posts state
  const [posts, setPosts] = useState<PagePost[]>([])
  const [clearedPostIds, setClearedPostIds] = useState<Set<string>>(new Set())
  const [selectedPostIds, setSelectedPostIds] = useState<Set<string>>(new Set())
  const [loadingPosts, setLoadingPosts] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [progressMsg, setProgressMsg] = useState<string>('')
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [searchAccountQuery, setSearchAccountQuery] = useState('')

  // Mouse Drag-to-Select and Range Selection for Posts Table
  const [postDragAnchorIndex, setPostDragAnchorIndex] = useState<number | null>(null)
  const [isPostDragging, setIsPostDragging] = useState(false)
  const lastClickedPostIndexRef = useRef<number | null>(null)
  const postDragBaseSelectionRef = useRef<Set<string>>(new Set())

  // Right-Click Context Menu on Posts Table
  const [postContextMenu, setPostContextMenu] = useState<{
    visible: boolean
    x: number
    y: number
    post: PagePost | null
  }>({ visible: false, x: 0, y: 0, post: null })

  // Live Deletion Progress Stats
  const [deleteSeconds, setDeleteSeconds] = useState(0)
  const [deleteTotal, setDeleteTotal] = useState(0)
  const [deleteDone, setDeleteDone] = useState(0)
  const deleteTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const threadsRef = useRef<number>(2)
  const postIdsArrayRef = useRef<string[]>([])

  // Keep threadsRef in sync
  useEffect(() => {
    threadsRef.current = threads
  }, [threads])

  // Batch Scan "Get new data (Page)" Modal & Timer State
  const [batchScanOpen, setBatchScanOpen] = useState(false)
  const [batchProgress, setBatchProgress] = useState<BatchScanProgressEvent | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Filter left list by search keyword and cleared items
  const filteredAccountPageList = useMemo(() => {
    let list = accountPageList.filter((r) => !clearedRowKeys.has(`${r.account.id}-${r.pageId}`))
    if (!searchAccountQuery.trim()) return list
    const q = searchAccountQuery.toLowerCase()
    return list.filter(
      (r) =>
        (r.account.uid || '').toLowerCase().includes(q) ||
        (r.account.name || '').toLowerCase().includes(q) ||
        r.pageId.toLowerCase().includes(q) ||
        r.pageName.toLowerCase().includes(q)
    )
  }, [accountPageList, clearedRowKeys, searchAccountQuery])

  // Visible posts (filtering out cleared items and dynamically applying Type tab filter: ALL, REEL, PHOTO, STATUS)
  const visiblePosts = useMemo(() => {
    return posts.filter((p) => {
      if (clearedPostIds.has(p.id)) return false
      if (targetType !== 'ALL' && p.type.toUpperCase() !== targetType.toUpperCase()) {
        return false
      }
      return true
    })
  }, [posts, clearedPostIds, targetType])

  // Reset state when opening
  useEffect(() => {
    if (open) {
      if (accountPageList.length > 0) {
        const initialKey = `${accountPageList[0].account.id}-${accountPageList[0].pageId}`
        setActiveRowKey(initialKey)
        setSelectedLeftKeys(new Set([initialKey]))
      }
      setClearedRowKeys(new Set())
      setClearedPostIds(new Set())
      setPosts([])
      setSelectedPostIds(new Set())
      setProgressMsg('')
      setDeleteSeconds(0)
      setDeleteTotal(0)
      setDeleteDone(0)
      postIdsArrayRef.current = []
    }
  }, [open, accountPageList])

  // Close context menus on outside click
  useEffect(() => {
    const handleCloseCtx = () => {
      setContextMenu((c) => ({ ...c, visible: false }))
      setPostContextMenu((c) => ({ ...c, visible: false }))
    }
    window.addEventListener('click', handleCloseCtx)
    return () => window.removeEventListener('click', handleCloseCtx)
  }, [])

  // Listen to mouseup outside table during drag-select
  useEffect(() => {
    if (!isDragging && !isPostDragging) return
    const onMouseUp = (): void => {
      setIsDragging(false)
      setIsPostDragging(false)
    }
    document.addEventListener('mouseup', onMouseUp)
    return () => document.removeEventListener('mouseup', onMouseUp)
  }, [isDragging, isPostDragging])

  // Listen to IPC progress
  useEffect(() => {
    if (!open) return
    const unsubFetch = window.api.pages.onFetchProgress((e) => {
      setProgressMsg(e.message)
    })
    const unsubDelete = window.api.pages.onDeleteProgress((e) => {
      setProgressMsg(e.message)
      if (typeof e.deletedCount === 'number') {
        setDeleteDone(e.deletedCount)
      }
      if (Array.isArray(e.completedIds) && e.completedIds.length > 0) {
        const doneSet = new Set(e.completedIds)
        setPosts((prev) => {
          const updated = prev.map((p) => {
            if (doneSet.has(p.id)) {
              return { ...p, status: '✓ Completed' }
            }
            return p
          })

          const remainingQueue = updated.filter(
            (p) =>
              postIdsArrayRef.current.includes(p.id) &&
              p.status !== '✓ Completed' &&
              p.status !== '✗ Failed'
          )
          const limit = Math.max(1, threadsRef.current || 2)
          const activeBatchIds = new Set(remainingQueue.slice(0, limit).map((p) => p.id))

          return updated.map((p) => {
            if (p.status === '✓ Completed' || p.status === '✗ Failed') return p
            if (activeBatchIds.has(p.id)) return { ...p, status: 'Deleting...' }
            if (postIdsArrayRef.current.includes(p.id)) return { ...p, status: 'Processing...' }
            return p
          })
        })
      }
    })
    const unsubBatch = window.api.pages.onBatchScanProgress((event) => {
      setBatchProgress(event)
    })
    return () => {
      unsubFetch()
      unsubDelete()
      unsubBatch()
    }
  }, [open])

  // Format timer MM:SS
  const formatTimer = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  // Left Table Range Selection (for Drag & Shift+Click)
  const selectLeftRange = (fromIndex: number, toIndex: number, additive = false): void => {
    const lo = Math.min(fromIndex, toIndex)
    const hi = Math.max(fromIndex, toIndex)
    const next = additive ? new Set(dragBaseSelectionRef.current) : new Set<string>()
    for (let i = lo; i <= hi; i++) {
      const row = filteredAccountPageList[i]
      if (row) next.add(`${row.account.id}-${row.pageId}`)
    }
    setSelectedLeftKeys(next)
  }

  // Posts Table Range Selection (for Drag & Shift+Click)
  const selectPostRange = (fromIndex: number, toIndex: number, additive = false): void => {
    const lo = Math.min(fromIndex, toIndex)
    const hi = Math.max(fromIndex, toIndex)
    const next = additive ? new Set(postDragBaseSelectionRef.current) : new Set<string>()
    for (let i = lo; i <= hi; i++) {
      const p = visiblePosts[i]
      if (p && p.status !== '✓ Completed') next.add(p.id)
    }
    setSelectedPostIds(next)
  }

  // Right-click Handler on Left Table
  const handleContextMenu = (e: React.MouseEvent, row: AccountPageRow): void => {
    e.preventDefault()
    e.stopPropagation()
    const key = `${row.account.id}-${row.pageId}`
    if (!selectedLeftKeys.has(key)) {
      setSelectedLeftKeys(new Set([key]))
      setActiveRowKey(key)
    }
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      row
    })
  }

  // Right-click Handler on Right Posts Table
  const handlePostContextMenu = (e: React.MouseEvent, post: PagePost): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!selectedPostIds.has(post.id)) {
      setSelectedPostIds(new Set([post.id]))
    }
    setPostContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      post
    })
  }

  // Action: Clear View (temporary) on Left Table
  const handleClearView = (row: AccountPageRow | null): void => {
    setContextMenu((c) => ({ ...c, visible: false }))
    if (row && !selectedLeftKeys.has(`${row.account.id}-${row.pageId}`)) {
      setClearedRowKeys((prev) => new Set(prev).add(`${row.account.id}-${row.pageId}`))
      showToast(`Cleared ${row.pageName} from view`)
    } else {
      const keysToClear =
        selectedLeftKeys.size > 0
          ? selectedLeftKeys
          : new Set(filteredAccountPageList.map((r) => `${r.account.id}-${r.pageId}`))
      setClearedRowKeys((prev) => {
        const next = new Set(prev)
        keysToClear.forEach((k) => next.add(k))
        return next
      })
      setSelectedLeftKeys(new Set())
      showToast(`Cleared ${keysToClear.size} item(s) from view`)
    }
  }

  // Action: Clear Posts from View (temporary) on Right Table
  const handleClearPostsView = (): void => {
    setPostContextMenu((c) => ({ ...c, visible: false }))
    const count = selectedPostIds.size
    if (count === 0) return
    setClearedPostIds((prev) => {
      const next = new Set(prev)
      selectedPostIds.forEach((id) => next.add(id))
      return next
    })
    setSelectedPostIds(new Set())
    showToast(`Cleared ${count} post(s) from view`)
  }

  // Action: Delete / Clear Stored Page Data permanently from SQLite DB for selected accounts
  const handleDeletePageData = async (row: AccountPageRow | null): Promise<void> => {
    setContextMenu((c) => ({ ...c, visible: false }))
    const targetAccIds =
      selectedLeftKeys.size > 0
        ? Array.from(new Set(Array.from(selectedLeftKeys).map((k) => Number(k.split('-')[0]))))
        : row
          ? [row.account.id]
          : targetAccounts.map((a) => a.id)

    try {
      await window.api.pages.clearPageData(targetAccIds)
      await refreshAccounts()
      showToast(`Permanently cleared stored page data for ${targetAccIds.length} account(s)!`)
    } catch (err: any) {
      showToast(`Error clearing page data: ${err.message || err}`)
    }
  }

  // Left table mouse selection toggle
  const toggleLeftRowSelection = (key: string, e?: React.MouseEvent): void => {
    e?.stopPropagation()
    setSelectedLeftKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleSelectAllLeft = (): void => {
    if (selectedLeftKeys.size === filteredAccountPageList.length) {
      setSelectedLeftKeys(new Set())
    } else {
      setSelectedLeftKeys(
        new Set(filteredAccountPageList.map((r) => `${r.account.id}-${r.pageId}`))
      )
    }
  }

  // Action: "Get new data (Page)" batch scan
  const handleBatchScanPages = async (): Promise<void> => {
    setContextMenu((c) => ({ ...c, visible: false }))
    const targetIds =
      selectedLeftKeys.size > 0
        ? Array.from(new Set(Array.from(selectedLeftKeys).map((k) => Number(k.split('-')[0]))))
        : targetAccounts.map((a) => a.id)

    if (targetIds.length === 0) {
      showToast('No accounts selected to scan.')
      return
    }

    setBatchScanOpen(true)
    setElapsedSeconds(0)
    setBatchProgress({
      index: 0,
      total: targetIds.length,
      accountId: targetIds[0],
      name: targetAccounts[0].name || targetAccounts[0].uid || '',
      count: 0
    })

    timerRef.current = setInterval(() => {
      setElapsedSeconds((s) => s + 1)
    }, 1000)

    try {
      const res = await window.api.pages.batchScanPages(targetIds)
      await refreshAccounts()
      showToast(`Scan Complete: Scanned ${res.totalScanned} account(s), found ${res.totalPagesFound} page(s)!`)
    } catch (err: any) {
      showToast(`Error scanning pages: ${err.message || err}`)
    } finally {
      if (timerRef.current) clearInterval(timerRef.current)
      setTimeout(() => {
        setBatchScanOpen(false)
        setBatchProgress(null)
      }, 1500)
    }
  }

  // Fetch posts from Meta Business Suite table
  const handleGetData = async (): Promise<void> => {
    if (!activeRow) {
      showToast('Please select an account and page first')
      return
    }

    let assetId = activeRow.assetId
    if (!assetId || assetId === '-') {
      setLoadingPosts(true)
      setProgressMsg('Scanning managed pages first...')
      try {
        const p = await window.api.pages.getManagedPages(activeRow.account.id, true, headlessMode)
        await refreshAccounts()
        if (p.length > 0) {
          assetId = p[0].assetId || p[0].pageId
        } else {
          showToast('No managed pages found for this account')
          setLoadingPosts(false)
          setProgressMsg('')
          return
        }
      } catch (err: any) {
        showToast(`Scan error: ${err.message || err}`)
        setLoadingPosts(false)
        setProgressMsg('')
        return
      }
    }

    setLoadingPosts(true)
    setProgressMsg('Opening Meta Business Suite & scanning all posts...')
    setPosts([])
    setClearedPostIds(new Set())
    setSelectedPostIds(new Set())

    try {
      const res = await window.api.pages.fetchPosts(
        activeRow.account.id,
        assetId,
        {
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
          targetType: 'ALL'
        },
        headlessMode
      )
      setPosts(res.posts)
      const matching =
        targetType === 'ALL'
          ? res.posts
          : res.posts.filter((p) => p.type.toUpperCase() === targetType.toUpperCase())
      setSelectedPostIds(new Set(matching.map((p) => p.id)))
      showToast(`Found ${res.posts.length} post(s) for ${activeRow.pageName}`)
    } catch (err: any) {
      showToast(`Failed to fetch posts: ${err.message || err}`)
    } finally {
      setLoadingPosts(false)
      setProgressMsg('')
    }
  }

  // Bulk delete selected posts with live timer, thread visualization & percentage
  const handleConfirmDelete = async (): Promise<void> => {
    if (!activeRow || selectedPostIds.size === 0) return
    const assetId = activeRow.assetId || activeRow.pageId
    if (!assetId || assetId === '-') return

    const totalToDelete = selectedPostIds.size
    const postIdsArray = Array.from(selectedPostIds)
    const effectiveThreads = Math.max(1, threads || 2)
    postIdsArrayRef.current = postIdsArray
    threadsRef.current = effectiveThreads

    setConfirmDeleteOpen(false)
    setDeleting(true)
    setDeleteTotal(totalToDelete)
    setDeleteDone(0)
    setDeleteSeconds(0)
    setProgressMsg(`Deleting ${totalToDelete} post(s)...`)

    // Start live deletion timer
    deleteTimerRef.current = setInterval(() => {
      setDeleteSeconds((s) => s + 1)
    }, 1000)

    // Thread Status Visualization:
    // First `effectiveThreads` posts get "Deleting...", remaining selected get "Processing..."
    setPosts((prev) =>
      prev.map((p) => {
        const idx = postIdsArray.indexOf(p.id)
        if (idx === -1) return p
        if (idx < effectiveThreads) return { ...p, status: 'Deleting...' }
        return { ...p, status: 'Processing...' }
      })
    )

    try {
      const res = await window.api.pages.deletePosts(
        activeRow.account.id,
        assetId,
        postIdsArray,
        headlessMode,
        effectiveThreads
      )
      if (res.success) {
        setDeleteDone(res.deletedCount)
        showToast(`Successfully moved ${res.deletedCount} post(s) to trash!`)
        // Ensure all deleted posts are marked '✓ Completed'
        setPosts((prev) =>
          prev.map((p) => (selectedPostIds.has(p.id) ? { ...p, status: '✓ Completed' } : p))
        )
        setSelectedPostIds(new Set())
      } else {
        showToast(`Deletion completed with note: ${res.detail}`)
        setPosts((prev) =>
          prev.map((p) => (selectedPostIds.has(p.id) && p.status !== '✓ Completed' ? { ...p, status: '✗ Failed' } : p))
        )
      }
    } catch (err: any) {
      showToast(`Error deleting posts: ${err.message || err}`)
      setPosts((prev) =>
        prev.map((p) => (selectedPostIds.has(p.id) ? { ...p, status: '✗ Failed' } : p))
      )
    } finally {
      if (deleteTimerRef.current) clearInterval(deleteTimerRef.current)
      setDeleting(false)
      setProgressMsg('')
    }
  }

  // Stop running operation
  const isRunning = deleting || loadingPosts || batchScanOpen

  const handleStop = async (): Promise<void> => {
    try {
      await window.api.pages.stopOperation()
    } catch {
      /* ignore */
    }
    if (timerRef.current) clearInterval(timerRef.current)
    if (deleteTimerRef.current) clearInterval(deleteTimerRef.current)
    setDeleting(false)
    setLoadingPosts(false)
    setBatchScanOpen(false)
    setProgressMsg('')
    showToast('Operation stopped by user.')
  }

  const toggleSelectAll = (): void => {
    const available = visiblePosts.filter((p) => p.status !== '✓ Completed')
    if (selectedPostIds.size === available.length) {
      setSelectedPostIds(new Set())
    } else {
      setSelectedPostIds(new Set(available.map((p) => p.id)))
    }
  }

  const toggleSelectPost = (id: string): void => {
    const post = visiblePosts.find((p) => p.id === id)
    if (post?.status === '✓ Completed') return
    const next = new Set(selectedPostIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedPostIds(next)
  }

  const stats = useMemo(() => {
    return visiblePosts.reduce(
      (acc, p) => ({
        views: acc.views + p.views,
        likes: acc.likes + p.likes,
        reach: acc.reach + p.reach
      }),
      { views: 0, likes: 0, reach: 0 }
    )
  }, [visiblePosts])

  const t = useLanguageStore((s) => s.t)

  if (!open) return null

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={t('deletePostTitle')}
      icon={Trash2}
      width="max-w-[1300px]"
      height="h-[88vh] max-h-[760px]"
      bodyClassName="flex-1 min-h-0 overflow-hidden p-2 bg-[#f0f2f5]"
      footer={
        <div className="flex w-full items-center justify-between">
          {/* Left Footer Info / Progress */}
          <div className="flex items-center gap-2 text-xs text-slate-600 truncate max-w-[420px]">
            {progressMsg ? (
              <span className="flex items-center gap-1.5 font-medium text-blue-700 animate-pulse">
                <RefreshCw size={13} className="animate-spin text-blue-600 shrink-0" />
                <span className="truncate">{progressMsg}</span>
              </span>
            ) : activeRow ? (
              <span className="truncate">
                Active: <strong>{activeRow.account.name || activeRow.account.uid}</strong> | Page:{' '}
                <strong className="text-blue-800">{activeRow.pageName}</strong> (ID: {activeRow.pageId})
              </span>
            ) : null}
          </div>

          {/* Right Footer Controls (Stats Badge, Headless, Get Data, Stop, Close) */}
          <div className="flex items-center gap-2 shrink-0">
            {/* LIVE DELETION STATS BAR */}
            {(deleting || deleteTotal > 0) && (
              <div className="flex items-center gap-1.5 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs shadow-2xs animate-in fade-in">
                <span className="flex items-center gap-1 font-mono font-bold text-rose-800 text-[11px]">
                  <Timer size={12} className={deleting ? 'animate-spin text-rose-600' : 'text-rose-600'} />
                  {formatTimer(deleteSeconds)}
                </span>
                <span className="text-rose-300">|</span>
                <span className="flex items-center gap-0.5 font-bold text-rose-900 text-[11px]">
                  {deleteTotal > 0 ? Math.round((deleteDone / deleteTotal) * 100) : 0}%
                </span>
                <span className="text-rose-300">|</span>
                <span className="text-emerald-700 font-semibold text-[11px]">
                  Del: <strong>{deleteDone}</strong>/{deleteTotal}
                </span>
                <span className="text-rose-300">|</span>
                <span className="text-amber-700 font-semibold text-[11px]">
                  Rem: <strong>{Math.max(0, deleteTotal - deleteDone)}</strong>
                </span>
              </div>
            )}

            {/* Headless / Headed Toggle */}
            <button
              type="button"
              onClick={() => setHeadlessMode((h) => !h)}
              title={
                headlessMode
                  ? 'Headless Mode (Silent background, no Chrome window)'
                  : 'Headed Mode (Visible Chrome window)'
              }
              className={`flex items-center gap-1 rounded border px-2 py-1 text-xs font-semibold transition-all ${
                headlessMode
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                  : 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
              }`}
            >
              {headlessMode ? (
                <>
                  <Zap size={12} className="text-emerald-600" />
                  <span>{t('headless')}</span>
                </>
              ) : (
                <>
                  <Monitor size={12} className="text-amber-600" />
                  <span>Headed</span>
                </>
              )}
            </button>

            {/* Get Data Button */}
            <button
              type="button"
              onClick={handleGetData}
              disabled={loadingPosts || deleting || !activeRow}
              className="win-btn-primary px-3 py-1 font-semibold flex items-center gap-1 text-xs"
            >
              <Search size={13} className={loadingPosts ? 'animate-spin' : ''} />
              <span>{loadingPosts ? 'Getting Data...' : t('getData')}</span>
            </button>

            {/* Stop button */}
            {isRunning && (
              <button
                className="win-btn-stop px-3 py-1 font-semibold flex items-center gap-1 text-xs animate-pulse"
                onClick={handleStop}
              >
                <XCircle size={13} />
                <span>Stop</span>
              </button>
            )}

            {/* Close button */}
            <button className="win-btn px-4 py-1 text-xs font-medium" onClick={onClose}>
              {t('close')}
            </button>
          </div>
        </div>
      }
    >
      <div className="flex h-full w-full gap-2 overflow-hidden">
        {/* ========================================================================= */}
        {/* LEFT COLUMN: Accounts & Managed Pages (UID | ID Page | Name Page)         */}
        {/* ========================================================================= */}
        <div className="flex w-[450px] shrink-0 flex-col rounded border border-slate-300 bg-white shadow-sm overflow-hidden">
          {/* Header (Clean, no extra buttons) */}
          <div className="flex items-center justify-between border-b border-slate-200 bg-slate-100 px-3 py-2">
            <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
              <User size={14} className="text-[#0067c0]" />
              <span>{t('accountsAndPages')} ({filteredAccountPageList.length})</span>
            </div>
            {selectedLeftKeys.size > 0 && (
              <span className="text-[10px] font-bold text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded">
                {selectedLeftKeys.size} selected
              </span>
            )}
          </div>

          {/* Search box */}
          <div className="border-b border-slate-200 p-1.5 bg-slate-50 flex items-center gap-1.5">
            <div className="flex flex-1 items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1">
              <Search size={12} className="text-slate-400" />
              <input
                type="text"
                placeholder={t('searchPlaceholder')}
                className="w-full text-xs text-slate-800 focus:outline-none bg-transparent"
                value={searchAccountQuery}
                onChange={(e) => setSearchAccountQuery(e.target.value)}
              />
            </div>
          </div>

          {/* Table list with Right Click & Mouse Drag / Shift-Click Selection */}
          <div className="flex-1 overflow-y-auto select-none">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-slate-100 text-[11px] font-bold text-slate-700 border-b border-slate-200 shadow-xs">
                <tr>
                  <th className="py-1.5 px-2 w-8 text-center">
                    <button
                      type="button"
                      onClick={toggleSelectAllLeft}
                      className="text-slate-500 hover:text-slate-800"
                    >
                      {selectedLeftKeys.size === filteredAccountPageList.length && filteredAccountPageList.length > 0 ? (
                        <CheckSquare size={13} className="text-blue-600 mx-auto" />
                      ) : (
                        <Square size={13} className="text-slate-400 mx-auto" />
                      )}
                    </button>
                  </th>
                  <th className="py-1.5 px-2 w-[125px]">UID</th>
                  <th className="py-1.5 px-2 w-[125px]">ID Page</th>
                  <th className="py-1.5 px-2">Name Page</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredAccountPageList.map((row, index) => {
                  const key = `${row.account.id}-${row.pageId}`
                  const isActive = activeRowKey === key
                  const isChecked = selectedLeftKeys.has(key)
                  return (
                    <tr
                      key={key}
                      style={{ userSelect: isDragging ? 'none' : undefined }}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return
                        dragBaseSelectionRef.current = new Set(selectedLeftKeys)
                        setDragAnchorIndex(index)
                        setIsDragging(true)
                      }}
                      onMouseEnter={(e) => {
                        if (isDragging && dragAnchorIndex !== null) {
                          selectLeftRange(dragAnchorIndex, index, e.ctrlKey || e.metaKey)
                        }
                      }}
                      onClick={(e) => {
                        if (dragAnchorIndex !== null && dragAnchorIndex !== index) {
                          lastClickedIndexRef.current = index
                          setDragAnchorIndex(null)
                          return
                        }
                        setDragAnchorIndex(null)
                        if (e.shiftKey && lastClickedIndexRef.current !== null) {
                          selectLeftRange(lastClickedIndexRef.current, index, e.ctrlKey || e.metaKey)
                        } else if (e.ctrlKey || e.metaKey) {
                          toggleLeftRowSelection(key)
                          lastClickedIndexRef.current = index
                        } else {
                          setSelectedLeftKeys(new Set([key]))
                          setActiveRowKey(key)
                          setPosts([])
                          setSelectedPostIds(new Set())
                          lastClickedIndexRef.current = index
                        }
                      }}
                      onContextMenu={(e) => handleContextMenu(e, row)}
                      className={`cursor-pointer transition-colors ${
                        isChecked
                          ? isActive
                            ? 'bg-[#0078d4] text-white font-semibold border-l-4 border-l-amber-400'
                            : 'bg-[#0078d4]/90 text-white font-medium'
                          : isActive
                            ? 'bg-blue-100 text-blue-950 font-semibold border-l-4 border-l-blue-600'
                            : 'hover:bg-slate-50 text-slate-700'
                      }`}
                    >
                      <td className="py-2 px-2 text-center" onClick={(e) => toggleLeftRowSelection(key, e)}>
                        {isChecked ? (
                          <CheckSquare size={13} className={isChecked ? 'text-white mx-auto' : 'text-blue-600 mx-auto'} />
                        ) : (
                          <Square size={13} className="text-slate-400 mx-auto" />
                        )}
                      </td>
                      <td className="py-2 px-2 font-mono text-[11px] whitespace-nowrap" title={row.account.uid || ''}>
                        {row.account.uid || `ID:${row.account.id}`}
                      </td>
                      <td className={`py-2 px-2 font-mono text-[11px] whitespace-nowrap ${isChecked ? 'text-blue-100' : 'text-slate-600'}`} title={row.pageId}>
                        {row.pageId}
                      </td>
                      <td className="py-2 px-2 truncate max-w-[130px] font-medium" title={row.pageName}>
                        {row.pageName}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* ========================================================================= */}
        {/* RIGHT COLUMN: Filters, Metrics Bar, and Posts Table (Full Mouse Select)   */}
        {/* ========================================================================= */}
        <div className="flex flex-1 min-w-0 flex-col rounded border border-slate-300 bg-white shadow-sm overflow-hidden">
          {/* Top Controls Card - Ultra Slim Single Line (From, To, Type, Threads) */}
          <div className="border-b border-slate-200 bg-slate-50 px-2.5 py-1.5">
            <div className="flex items-center gap-3">
              {/* From Date */}
              <div className="flex items-center gap-1 text-xs">
                <Calendar size={13} className="text-slate-500" />
                <span className="text-slate-600 font-medium text-[11px]">From:</span>
                <input
                  type="date"
                  className="win-input text-xs h-[26px] px-1.5 py-0"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                />
              </div>

              {/* To Date */}
              <div className="flex items-center gap-1 text-xs">
                <Calendar size={13} className="text-slate-500" />
                <span className="text-slate-600 font-medium text-[11px]">To:</span>
                <input
                  type="date"
                  className="win-input text-xs h-[26px] px-1.5 py-0"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                />
              </div>

              {/* Type buttons */}
              <div className="flex items-center rounded border border-slate-300 bg-white p-0.5">
                {(['ALL', 'REEL', 'PHOTO', 'STATUS'] as PagePostType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTargetType(t)}
                    className={`rounded px-2 py-0.5 text-[11px] font-semibold transition-all ${
                      targetType === t ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {t === 'ALL' ? 'All' : t}
                  </button>
                ))}
              </div>

              {/* Threads setting */}
              <div className="flex items-center gap-1 text-xs border border-slate-300 rounded bg-white px-2 py-0.5" title="Concurrent threads for processing">
                <span className="text-slate-600 font-semibold text-[11px]">Threads:</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  className="win-input text-xs h-[22px] w-12 px-1 text-center font-bold text-blue-700"
                  value={threads}
                  onChange={(e) => setThreads(Math.max(1, parseInt(e.target.value, 10) || 1))}
                />
              </div>
            </div>
          </div>

          {/* Metrics summary bar with Select All */}
          <div className="flex items-center justify-between border-b border-slate-200 bg-slate-100 px-3 py-1 text-xs text-slate-700">
            <div className="flex items-center gap-2">
              <button
                onClick={toggleSelectAll}
                disabled={visiblePosts.length === 0}
                className="flex items-center gap-1 font-semibold text-slate-700 hover:text-slate-900 disabled:opacity-50"
              >
                {visiblePosts.length > 0 && selectedPostIds.size === visiblePosts.filter((p) => p.status !== '✓ Completed').length ? (
                  <CheckSquare size={15} className="text-blue-600" />
                ) : (
                  <Square size={15} className="text-slate-400" />
                )}
                <span>Select All ({selectedPostIds.size}/{visiblePosts.length})</span>
              </button>
            </div>

            <div className="flex items-center gap-3 text-[11px]">
              <span className="flex items-center gap-1 text-slate-600">
                <Layers size={12} className="text-blue-600" /> Posts: <strong className="text-slate-900">{visiblePosts.length}</strong>
              </span>
              <span className="flex items-center gap-1 text-slate-600">
                <Eye size={12} className="text-emerald-600" /> Views: <strong className="text-emerald-700">{stats.views.toLocaleString()}</strong>
              </span>
              <span className="flex items-center gap-1 text-slate-600">
                <Heart size={12} className="text-rose-600" /> Likes: <strong className="text-rose-700">{stats.likes.toLocaleString()}</strong>
              </span>
              <span className="flex items-center gap-1 text-slate-600">
                <TrendingUp size={12} className="text-indigo-600" /> Reach: <strong className="text-indigo-700">{stats.reach.toLocaleString()}</strong>
              </span>
            </div>
          </div>

          {/* Posts Table with Full Mouse Drag & Shift+Click Selection */}
          <div className="flex-1 overflow-y-auto select-none">
            {visiblePosts.length > 0 ? (
              <table className="w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-slate-100 text-[11px] font-bold text-slate-700 border-b border-slate-200 shadow-xs">
                  <tr>
                    <th className="py-2 px-3 w-10 text-center">#</th>
                    <th className="py-2 px-2 w-24">Type</th>
                    <th className="py-2 px-3 w-36">Date Published</th>
                    <th className="py-2 px-3">Title / Snippet</th>
                    <th className="py-2 px-3 w-20 text-right">Views</th>
                    <th className="py-2 px-3 w-20 text-right">Likes</th>
                    <th className="py-2 px-3 w-20 text-right">Reach</th>
                    <th className="py-2 px-3 w-32 text-center">Activity Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-800">
                  {visiblePosts.map((post, index) => {
                    const isSelected = selectedPostIds.has(post.id)
                    const isCompleted = post.status === '✓ Completed' || post.status === 'In Trash'
                    const isDeleting = post.status === 'Deleting...'
                    const isProcessing = post.status === 'Processing...'
                    const isFailed = post.status === '✗ Failed'
                    return (
                      <tr
                        key={post.id}
                        style={{ userSelect: isPostDragging ? 'none' : undefined }}
                        onMouseDown={(e) => {
                          if (e.button !== 0 || isCompleted || isDeleting) return
                          postDragBaseSelectionRef.current = new Set(selectedPostIds)
                          setPostDragAnchorIndex(index)
                          setIsPostDragging(true)
                        }}
                        onMouseEnter={(e) => {
                          if (isPostDragging && postDragAnchorIndex !== null) {
                            selectPostRange(postDragAnchorIndex, index, e.ctrlKey || e.metaKey)
                          }
                        }}
                        onClick={(e) => {
                          if (isCompleted || isDeleting) return
                          if (postDragAnchorIndex !== null && postDragAnchorIndex !== index) {
                            lastClickedPostIndexRef.current = index
                            setPostDragAnchorIndex(null)
                            return
                          }
                          setPostDragAnchorIndex(null)
                          if (e.shiftKey && lastClickedPostIndexRef.current !== null) {
                            selectPostRange(lastClickedPostIndexRef.current, index, e.ctrlKey || e.metaKey)
                          } else if (e.ctrlKey || e.metaKey) {
                            toggleSelectPost(post.id)
                            lastClickedPostIndexRef.current = index
                          } else {
                            setSelectedPostIds(new Set([post.id]))
                            lastClickedPostIndexRef.current = index
                          }
                        }}
                        onContextMenu={(e) => handlePostContextMenu(e, post)}
                        className={`cursor-pointer transition-colors ${
                          isCompleted
                            ? 'bg-slate-100/60 opacity-60'
                            : isSelected
                              ? 'bg-[#0078d4] text-white font-medium shadow-xs'
                              : 'hover:bg-slate-50 text-slate-800'
                        }`}
                      >
                        <td
                          className="py-2 px-3 text-center"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (!isCompleted && !isDeleting) toggleSelectPost(post.id)
                          }}
                        >
                          {isCompleted ? (
                            <CheckCircle2 size={15} className="text-emerald-600 mx-auto" />
                          ) : isDeleting ? (
                            <RefreshCw size={14} className="animate-spin text-blue-600 mx-auto" />
                          ) : isProcessing ? (
                            <Clock size={14} className="animate-pulse text-amber-500 mx-auto" />
                          ) : isSelected ? (
                            <CheckSquare size={14} className="text-white mx-auto" />
                          ) : (
                            <Square size={14} className="text-slate-400 mx-auto" />
                          )}
                        </td>
                        <td className="py-2 px-2">
                          {post.type === 'Reel' ? (
                            <span
                              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                isSelected ? 'bg-purple-900 text-purple-100' : 'bg-purple-100 text-purple-800'
                              }`}
                            >
                              <Film size={10} /> Reel
                            </span>
                          ) : post.type === 'Photo' ? (
                            <span
                              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                isSelected ? 'bg-blue-900 text-blue-100' : 'bg-blue-100 text-blue-800'
                              }`}
                            >
                              <ImageIcon size={10} /> Photo
                            </span>
                          ) : (
                            <span
                              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                isSelected ? 'bg-slate-700 text-slate-100' : 'bg-slate-100 text-slate-700'
                              }`}
                            >
                              <FileText size={10} /> Status
                            </span>
                          )}
                        </td>
                        <td
                          className={`py-2 px-3 font-mono text-[11px] whitespace-nowrap ${
                            isSelected ? 'text-blue-100' : 'text-slate-600'
                          }`}
                        >
                          {post.date}
                        </td>
                        <td className="py-2 px-3">
                          <div
                            className={`truncate max-w-[320px] font-medium ${isSelected ? 'text-white' : 'text-slate-800'}`}
                            title={post.title}
                          >
                            {post.title}
                          </div>
                          <span
                            className={`font-mono text-[10px] ${isSelected ? 'text-blue-200' : 'text-slate-400'}`}
                          >
                            ID: {post.id}
                          </span>
                        </td>
                        <td
                          className={`py-2 px-3 text-right font-mono font-bold ${
                            isSelected ? 'text-emerald-200' : 'text-emerald-700'
                          }`}
                        >
                          {post.views.toLocaleString()}
                        </td>
                        <td
                          className={`py-2 px-3 text-right font-mono font-bold ${
                            isSelected ? 'text-rose-200' : 'text-rose-600'
                          }`}
                        >
                          {post.likes.toLocaleString()}
                        </td>
                        <td
                          className={`py-2 px-3 text-right font-mono font-bold ${
                            isSelected ? 'text-indigo-200' : 'text-indigo-700'
                          }`}
                        >
                          {post.reach.toLocaleString()}
                        </td>
                        <td className="py-2 px-3 text-center">
                          {isCompleted ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800 border border-emerald-200">
                              <CheckCircle2 size={11} /> Completed
                            </span>
                          ) : isDeleting ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-800 border border-blue-200 animate-pulse">
                              <RefreshCw size={10} className="animate-spin" /> Deleting...
                            </span>
                          ) : isProcessing ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800 border border-amber-200 animate-pulse">
                              <Clock size={10} /> Processing...
                            </span>
                          ) : isFailed ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-800 border border-rose-200">
                              <XCircle size={11} /> Failed
                            </span>
                          ) : (
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold border ${
                                isSelected
                                  ? 'bg-blue-800 text-white border-blue-600'
                                  : 'bg-slate-100 text-slate-700 border-slate-200'
                              }`}
                            >
                              {post.status || 'Published'}
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ) : (
              <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center p-6 text-slate-400">
                <Layers size={36} className="text-slate-300 mb-2" />
                <h4 className="text-sm font-semibold text-slate-700">{t('noPostsLoaded')}</h4>
                <p className="text-xs text-slate-500 max-w-sm mt-0.5">
                  {t('noPostsDesc')}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right Click Context Menu on Left Accounts & Pages Table */}
      {contextMenu.visible && (
        <div
          className="fixed z-70 min-w-[260px] rounded-md border border-slate-300 bg-white py-1 shadow-2xl animate-in fade-in-50 zoom-in-95 text-xs text-slate-800"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 font-bold border-b border-slate-100 text-slate-500 text-[11px] bg-slate-50">
            {selectedLeftKeys.size > 0 ? `${selectedLeftKeys.size} Selected Item(s)` : 'Account/Page Actions'}
          </div>

          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-slate-700 hover:bg-slate-100 text-left"
            onClick={() => handleClearView(contextMenu.row)}
          >
            <Eraser size={14} className="text-slate-500" />
            <span>Clear View ({selectedLeftKeys.size > 0 ? selectedLeftKeys.size : 1} selected)</span>
          </button>

          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-blue-700 hover:bg-blue-50 text-left font-medium"
            onClick={handleBatchScanPages}
          >
            <Sparkles size={14} className="text-blue-600" />
            <span>Get new data (Page) ({selectedLeftKeys.size > 0 ? selectedLeftKeys.size : 1} selected)</span>
          </button>

          <div className="my-1 border-t border-slate-100" />

          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-rose-700 hover:bg-rose-50 text-left font-bold"
            onClick={() => handleDeletePageData(contextMenu.row)}
          >
            <Trash2 size={14} className="text-rose-600" />
            <span>Delete Page Data from DB ({selectedLeftKeys.size > 0 ? selectedLeftKeys.size : 1} selected)</span>
          </button>
        </div>
      )}

      {/* Right Click Context Menu on Right Posts Table */}
      {postContextMenu.visible && (
        <div
          className="fixed z-70 min-w-[240px] rounded-md border border-slate-300 bg-white py-1 shadow-2xl animate-in fade-in-50 zoom-in-95 text-xs text-slate-800"
          style={{ top: postContextMenu.y, left: postContextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 font-bold border-b border-slate-100 text-slate-500 text-[11px] bg-slate-50">
            {selectedPostIds.size > 0 ? `${selectedPostIds.size} Selected Post(s)` : 'Post Actions'}
          </div>

          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-rose-700 hover:bg-rose-50 text-left font-bold"
            onClick={() => {
              setPostContextMenu((c) => ({ ...c, visible: false }))
              setConfirmDeleteOpen(true)
            }}
          >
            <Trash2 size={14} className="text-rose-600" />
            <span>Move to Trash ({selectedPostIds.size > 0 ? selectedPostIds.size : 1} selected)</span>
          </button>

          <div className="my-1 border-t border-slate-100" />

          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-slate-700 hover:bg-slate-100 text-left"
            onClick={handleClearPostsView}
          >
            <Eraser size={14} className="text-slate-500" />
            <span>Clear from View ({selectedPostIds.size > 0 ? selectedPostIds.size : 1} selected)</span>
          </button>

          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-blue-700 hover:bg-blue-50 text-left font-medium"
            onClick={toggleSelectAll}
          >
            <CheckSquare size={14} className="text-blue-600" />
            <span>Select All Posts</span>
          </button>
        </div>
      )}

      {/* "Get new data (Page)" Live Progress Dialog */}
      {batchScanOpen && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4 animate-in fade-in">
          <div className="w-full max-w-md rounded-lg border border-slate-300 bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-600">
                  <Sparkles size={22} className="animate-pulse" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Get new data (Page)</h3>
                  <p className="text-xs text-slate-500">Scanning Managed Pages in Background</p>
                </div>
              </div>

              {/* Timer Badge */}
              <div className="flex items-center gap-1.5 rounded-md bg-slate-100 px-2.5 py-1 text-xs font-mono font-bold text-slate-700 border border-slate-200">
                <Clock size={13} className="text-blue-600" />
                <span>{formatTimer(elapsedSeconds)}</span>
              </div>
            </div>

            {/* Progress Bar */}
            <div className="space-y-2 mb-4">
              <div className="flex justify-between text-xs text-slate-600">
                <span>
                  Account: <strong>{batchProgress ? `${batchProgress.index} / ${batchProgress.total}` : '0 / 0'}</strong>
                </span>
                <span className="font-semibold text-blue-700">
                  {batchProgress && batchProgress.total > 0
                    ? `${Math.round((batchProgress.index / batchProgress.total) * 100)}%`
                    : '0%'}
                </span>
              </div>

              <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full bg-blue-600 transition-all duration-300 ease-out"
                  style={{
                    width: `${
                      batchProgress && batchProgress.total > 0
                        ? (batchProgress.index / batchProgress.total) * 100
                        : 0
                    }%`
                  }}
                />
              </div>
            </div>

            {/* Activity Status */}
            <div className="rounded bg-slate-50 p-2.5 border border-slate-200 text-xs text-slate-700 mb-4">
              <div className="flex items-center gap-2">
                <RefreshCw size={13} className="animate-spin text-blue-600 shrink-0" />
                <span className="truncate">
                  {batchProgress?.name
                    ? `Extracting pages for: ${batchProgress.name}`
                    : 'Initializing extraction...'}
                </span>
              </div>
            </div>

            {/* Stop button for batch scan */}
            <div className="flex justify-end">
              <button
                type="button"
                className="win-btn-stop px-4 py-1 font-semibold flex items-center gap-1 text-xs"
                onClick={handleStop}
              >
                <XCircle size={13} />
                <span>Stop Extraction</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Dialog for Move to Trash */}
      {confirmDeleteOpen && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4 animate-in fade-in">
          <div className="w-full max-w-md rounded border border-slate-300 bg-white p-5 shadow-2xl">
            <div className="flex items-center gap-2.5 mb-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-rose-100 text-rose-600">
                <AlertTriangle size={20} />
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-900">Confirm Move to Trash</h3>
                <p className="text-xs text-slate-500">Facebook Meta Business Suite</p>
              </div>
            </div>

            <p className="text-xs text-slate-700 mb-5 leading-relaxed">
              Are you sure you want to move <strong>{selectedPostIds.size} post(s)</strong> of page{' '}
              <strong className="text-blue-700">{activeRow?.pageName}</strong> to Trash?
              <br />
              <span className="text-[11px] text-slate-600 mt-2 block space-y-0.5 bg-slate-50 p-2 rounded border border-slate-200">
                <div>• Threads: <strong className="text-blue-700">{threads} thread(s)</strong></div>
                <div>
                  • Mode:{' '}
                  <strong className={headlessMode ? 'text-emerald-700' : 'text-amber-700'}>
                    {headlessMode ? '⚡ Headless (Silent)' : '🖥️ Headed (Show Chrome)'}
                  </strong>
                </div>
              </span>
            </p>

            <div className="flex justify-end gap-2">
              <button className="win-btn px-4" onClick={() => setConfirmDeleteOpen(false)}>
                Cancel
              </button>
              <button className="win-btn-stop px-4 font-semibold" onClick={handleConfirmDelete}>
                Yes, Move to Trash
              </button>
            </div>
          </div>
        </div>
      )}
    </ModalShell>
  )
}
