// ---------------------------------------------------------------------------
// DeletePagePostsV2Modal.tsx — Facebook Internal GraphQL API Post & Reel Deleter (V2)
// High speed, direct page DOM scanning & Relay mutation (useCometTrashPostMutation)
// ---------------------------------------------------------------------------
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  Trash2,
  Calendar,
  Layers,
  RefreshCw,
  Search,
  CheckSquare,
  Square,
  AlertTriangle,
  Film,
  Image as ImageIcon,
  FileText,
  Clock,
  CheckCircle,
  XCircle,
  User,
  Zap,
  Monitor,
  Timer,
  Sparkles
} from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'
import { useLanguageStore } from '../../store/useLanguageStore'
import type { ManagedPage, PagePost, PagePostType, Account } from '../../../types/account'
import { ALL_FOLDERS } from '../../../types/folder'

interface DeletePagePostsV2ModalProps {
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

export function DeletePagePostsV2Modal({ open, onClose }: DeletePagePostsV2ModalProps): React.JSX.Element | null {
  const accounts = useAccountStore((s) => s.accounts)
  const folders = useAccountStore((s) => s.folders)
  const rowSelection = useAccountStore((s) => s.rowSelection)
  const showToast = useAccountStore((s) => s.showToast)
  const refreshAccounts = useAccountStore((s) => s.refresh)
  const t = useLanguageStore((s) => s.t)

  // Category Folder filter
  const [selectedFolderId, setSelectedFolderId] = useState<number>(ALL_FOLDERS)

  // Automation Headless / Headed mode toggle
  const [headlessMode, setHeadlessMode] = useState<boolean>(true)

  // Accounts directly fetched from SQLite for the selected folder
  const [dbAccounts, setDbAccounts] = useState<Account[]>([])

  const fetchAccountsForFolder = useCallback(
    async (folderId: number) => {
      try {
        const res = await window.api.accounts.list({
          folderId: folderId === ALL_FOLDERS ? undefined : folderId,
          limit: 10000
        })
        setDbAccounts(res.rows)
      } catch (err) {
        console.error('Failed to fetch accounts for DeletePagePostsV2Modal:', err)
      }
    },
    []
  )

  // Fetch when modal opens or folder changes
  useEffect(() => {
    if (open) {
      setSelectedLeftKeys(new Set())
      setActiveRowKey('')
      setPosts([])
      setSelectedPostIds(new Set())
      fetchAccountsForFolder(selectedFolderId)
    }
  }, [open, selectedFolderId, fetchAccountsForFolder])

  // Multi-selected left account/page row keys
  const [selectedLeftKeys, setSelectedLeftKeys] = useState<Set<string>>(new Set())

  // Drag-to-select and range selection for the left table
  const [dragAnchorIndex, setDragAnchorIndex] = useState<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const lastClickedIndexRef = useRef<number | null>(null)
  const dragBaseSelectionRef = useRef<Set<string>>(new Set())

  // Build the list of Account + Page pairs for the left column
  const accountPageList = useMemo<AccountPageRow[]>(() => {
    const list: AccountPageRow[] = []
    const JUNK_PAGE_KEYWORDS = [
      'login', 'messenger', 'lite', 'privacy', 'policy', 'terms', 'help', 'cookies',
      'about', 'careers', 'ad_campaign', 'create ad', '1.php', 'reg/'
    ]

    const sourceAccounts = dbAccounts.length > 0 ? dbAccounts : accounts

    for (const acc of sourceAccounts) {
      if (acc.pages_data) {
        try {
          const parsed: ManagedPage[] = JSON.parse(acc.pages_data)
          if (Array.isArray(parsed) && parsed.length > 0) {
            const valid = parsed.filter(
              (p) =>
                p.pageId &&
                p.status !== 'Deactivated / Deleted' &&
                p.status !== 'Summary' &&
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
            } else {
              list.push({
                account: acc,
                pageId: '-',
                pageName: 'No Page',
                assetId: '-'
              })
            }
          }
        } catch {
          list.push({
            account: acc,
            pageId: '-',
            pageName: 'No Page',
            assetId: '-'
          })
        }
      } else {
        list.push({
          account: acc,
          pageId: '-',
          pageName: 'No Page',
          assetId: '-'
        })
      }
    }
    return list
  }, [dbAccounts, accounts])

  // Active selected row from left column
  const [activeRowKey, setActiveRowKey] = useState<string>('')
  const activeRow = useMemo(() => {
    return accountPageList.find((r) => `${r.account.id}-${r.pageId}` === activeRowKey) || accountPageList[0] || null
  }, [accountPageList, activeRowKey])

  // Filter state
  const [fromDate, setFromDate] = useState<string>('')
  const [toDate, setToDate] = useState<string>('')
  const [targetType, setTargetType] = useState<PagePostType>('ALL')

  // Concurrency Threads
  const [threads, setThreads] = useState<number>(2)

  // Posts state
  const [posts, setPosts] = useState<PagePost[]>([])
  const [selectedPostIds, setSelectedPostIds] = useState<Set<string>>(new Set())
  const [loadingPosts, setLoadingPosts] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [progressMsg, setProgressMsg] = useState<string>('')
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [searchAccountQuery, setSearchAccountQuery] = useState('')

  // Mouse Drag-to-Select for Posts Table
  const [postDragAnchorIndex, setPostDragAnchorIndex] = useState<number | null>(null)
  const [isPostDragging, setIsPostDragging] = useState(false)
  const lastClickedPostIndexRef = useRef<number | null>(null)
  const postDragBaseSelectionRef = useRef<Set<string>>(new Set())

  // Deletion Live Timer & Progress State
  const [deleteSeconds, setDeleteSeconds] = useState<number>(0)
  const [deleteTotal, setDeleteTotal] = useState<number>(0)
  const [deleteDone, setDeleteDone] = useState<number>(0)
  const deleteTimerRef = useRef<any>(null)
  const threadsRef = useRef<number>(2)
  const postIdsArrayRef = useRef<string[]>([])

  // Filtered account page list based on search
  const filteredAccountPageList = useMemo(() => {
    if (!searchAccountQuery.trim()) return accountPageList
    const q = searchAccountQuery.toLowerCase()
    return accountPageList.filter(
      (r) =>
        (r.account.uid || '').toLowerCase().includes(q) ||
        r.pageId.toLowerCase().includes(q) ||
        r.pageName.toLowerCase().includes(q) ||
        (r.account.name && r.account.name.toLowerCase().includes(q))
    )
  }, [accountPageList, searchAccountQuery])

  // Visible posts filtered by target type
  const visiblePosts = useMemo(() => {
    if (targetType === 'ALL') return posts
    return posts.filter((p) => p.type.toUpperCase() === targetType.toUpperCase())
  }, [posts, targetType])

  // Global mouseup handler to release drag selections
  useEffect(() => {
    const onMouseUp = (): void => {
      setIsDragging(false)
      setIsPostDragging(false)
    }
    document.addEventListener('mouseup', onMouseUp)
    return () => document.removeEventListener('mouseup', onMouseUp)
  }, [])

  // Listen to IPC progress for V2
  useEffect(() => {
    if (!open) return
    const unsubFetchV2 = window.api.pages?.onFetchV2Progress?.((e) => {
      setProgressMsg(e.message)
    })
    const unsubDeleteV2 = window.api.pages?.onDeleteV2Progress?.((e) => {
      setProgressMsg(e.message)
      if (typeof e.deletedCount === 'number') {
        setDeleteDone(e.deletedCount)
      }
      const doneSet = Array.isArray(e.completedIds) ? new Set(e.completedIds) : new Set<string>()
      const currentBatchSet = Array.isArray(e.currentBatchIds)
        ? new Set(e.currentBatchIds)
        : new Set<string>()

      setPosts((prev) =>
        prev.map((p) => {
          if (doneSet.has(p.id)) {
            return { ...p, status: '✓ Completed' }
          }
          if (currentBatchSet.has(p.id)) {
            return { ...p, status: 'Deleting...' }
          }
          return p
        })
      )
    })
    return () => {
      unsubFetchV2?.()
      unsubDeleteV2?.()
    }
  }, [open])

  // Format timer MM:SS
  const formatTimer = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  // Range select for left column
  const selectLeftRange = (fromIndex: number, toIndex: number, isToggle = false): void => {
    const start = Math.min(fromIndex, toIndex)
    const end = Math.max(fromIndex, toIndex)
    const rangeKeys = filteredAccountPageList.slice(start, end + 1).map((r) => `${r.account.id}-${r.pageId}`)

    const next = new Set(isToggle ? dragBaseSelectionRef.current : [])
    rangeKeys.forEach((k) => next.add(k))
    setSelectedLeftKeys(next)
  }

  const toggleSelectAllLeft = (): void => {
    if (selectedLeftKeys.size === filteredAccountPageList.length) {
      setSelectedLeftKeys(new Set())
    } else {
      setSelectedLeftKeys(new Set(filteredAccountPageList.map((r) => `${r.account.id}-${r.pageId}`)))
    }
  }

  // Range select for right posts table
  const selectPostRange = (fromIndex: number, toIndex: number, isToggle = false): void => {
    const start = Math.min(fromIndex, toIndex)
    const end = Math.max(fromIndex, toIndex)
    const rangeIds = visiblePosts
      .slice(start, end + 1)
      .filter((p) => p.status !== '✓ Completed')
      .map((p) => p.id)

    const next = new Set(isToggle ? postDragBaseSelectionRef.current : [])
    rangeIds.forEach((id) => next.add(id))
    setSelectedPostIds(next)
  }

  // Fetch posts via V2 (Internal GraphQL / Direct Page DOM)
  const handleGetData = async (): Promise<void> => {
    if (!activeRow) {
      showToast('Please select an account and page first')
      return
    }

    if (!activeRow.pageId || activeRow.pageId === '-') {
      showToast('This account has no valid page selected')
      return
    }

    if (typeof window.api.pages?.fetchPostsV2 !== 'function') {
      showToast('⚠️ សូម Restart កម្មវិធី (បិទរួចបើកឡើងវិញ) ដើម្បីដំណើរការ API V2 ថ្មី!')
      return
    }

    setLoadingPosts(true)
    setProgressMsg(`[V2] Scanning posts & reels for ${activeRow.pageName}…`)
    setPosts([])
    setSelectedPostIds(new Set())

    try {
      const res = await window.api.pages.fetchPostsV2(
        activeRow.account.id,
        activeRow.pageId,
        {
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
          targetType: targetType
        },
        headlessMode
      )
      setPosts(res.posts)
      const matching =
        targetType === 'ALL'
          ? res.posts
          : res.posts.filter((p) => p.type.toUpperCase() === targetType.toUpperCase())
      setSelectedPostIds(new Set(matching.map((p) => p.id)))
      showToast(`[V2] Found ${res.posts.length} post(s) for ${activeRow.pageName}`)
    } catch (err: any) {
      showToast(`[V2] Failed to fetch posts: ${err.message || err}`)
    } finally {
      setLoadingPosts(false)
      setProgressMsg('')
    }
  }

  // Bulk delete selected posts via V2 GraphQL Mutation
  const handleConfirmDelete = async (): Promise<void> => {
    if (!activeRow || selectedPostIds.size === 0) return
    if (!activeRow.pageId || activeRow.pageId === '-') return

    if (typeof window.api.pages?.deletePostsV2 !== 'function') {
      showToast('⚠️ សូម Restart កម្មវិធី (បិទរួចបើកឡើងវិញ) ដើម្បីដំណើរការ API V2 ថ្មី!')
      return
    }

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
    setProgressMsg(`[V2] Deleting ${totalToDelete} post(s) via GraphQL API...`)

    // Start live deletion timer
    deleteTimerRef.current = setInterval(() => {
      setDeleteSeconds((s) => s + 1)
    }, 1000)

    setPosts((prev) =>
      prev.map((p) => {
        const idx = postIdsArray.indexOf(p.id)
        if (idx === -1) return p
        if (idx < effectiveThreads) return { ...p, status: 'Deleting...' }
        return { ...p, status: 'Processing...' }
      })
    )

    try {
      const itemsToDelete = postIdsArray.map((id) => {
        const found = posts.find((p) => p.id === id)
        return {
          id,
          type: found?.type || 'Reel'
        }
      })

      const res = await window.api.pages.deletePostsV2(
        activeRow.account.id,
        activeRow.pageId,
        itemsToDelete,
        headlessMode,
        effectiveThreads
      )
      if (res.success) {
        setDeleteDone(res.deletedCount)
        showToast(`[V2] Successfully moved ${res.deletedCount} post(s) to trash via GraphQL API!`)
        setPosts((prev) =>
          prev.map((p) => (selectedPostIds.has(p.id) ? { ...p, status: '✓ Completed' } : p))
        )
        setSelectedPostIds(new Set())
      } else {
        showToast(`[V2] Deletion finished with note: ${res.detail}`)
        setPosts((prev) =>
          prev.map((p) =>
            selectedPostIds.has(p.id) && p.status !== '✓ Completed' ? { ...p, status: '✗ Failed' } : p
          )
        )
      }
    } catch (err: any) {
      showToast(`[V2] Error deleting posts: ${err.message || err}`)
      setPosts((prev) =>
        prev.map((p) => (selectedPostIds.has(p.id) ? { ...p, status: '✗ Failed' } : p))
      )
    } finally {
      if (deleteTimerRef.current) clearInterval(deleteTimerRef.current)
      setDeleting(false)
      setProgressMsg('')
    }
  }

  const isRunning = deleting || loadingPosts

  const handleStop = async (): Promise<void> => {
    try {
      await window.api.pages?.stopDeleteV2?.()
    } catch {
      /* ignore */
    }
    if (deleteTimerRef.current) clearInterval(deleteTimerRef.current)
    setDeleting(false)
    setLoadingPosts(false)
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

  if (!open) return null

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="លុបការបង្ហោះតាម API (Facebook GraphQL API V2)"
      icon={Sparkles}
      width="max-w-[1320px]"
      height="h-[88vh] max-h-[760px]"
      bodyClassName="flex-1 min-h-0 overflow-hidden p-2 bg-[#f0f2f5]"
      footer={
        <div className="flex w-full items-center justify-between">
          {/* Left Footer Info / Progress */}
          <div className="flex items-center gap-2 text-xs text-slate-600 truncate max-w-[440px]">
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

          {/* Right Footer Controls */}
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
              <span>{loadingPosts ? 'Scanning V2...' : 'ទាញទិន្នន័យ (Get Data)'}</span>
            </button>

            {/* Delete Posts Button */}
            <button
              type="button"
              onClick={() => setConfirmDeleteOpen(true)}
              disabled={loadingPosts || deleting || selectedPostIds.size === 0}
              className="win-btn-danger px-3 py-1 font-semibold flex items-center gap-1 text-xs shadow-xs"
            >
              <Trash2 size={13} />
              <span>លុប Post ({selectedPostIds.size})</span>
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
          {/* Header */}
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

          {/* Category Folder selector & Search box */}
          <div className="border-b border-slate-200 p-1.5 bg-slate-50 flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <label className="text-[11px] font-semibold text-slate-700 whitespace-nowrap">Folder:</label>
              <select
                value={selectedFolderId}
                onChange={(e) => setSelectedFolderId(Number(e.target.value))}
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 focus:outline-none focus:border-blue-500 shadow-2xs"
              >
                <option value={ALL_FOLDERS}>
                  All Folders ({folders.reduce((acc, f) => acc + (f.account_count || 0), 0)})
                </option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} [{f.account_count ?? 0}]
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1">
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

          {/* Table list */}
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
                          return
                        }
                        if (e.shiftKey && lastClickedIndexRef.current !== null) {
                          selectLeftRange(lastClickedIndexRef.current, index, e.ctrlKey || e.metaKey)
                        } else if (e.ctrlKey || e.metaKey) {
                          const next = new Set(selectedLeftKeys)
                          if (next.has(key)) next.delete(key)
                          else next.add(key)
                          setSelectedLeftKeys(next)
                        } else {
                          setActiveRowKey(key)
                        }
                        lastClickedIndexRef.current = index
                      }}
                      className={`cursor-pointer transition-colors ${
                        isActive
                          ? 'bg-blue-600 text-white font-semibold'
                          : isChecked
                            ? 'bg-blue-100 text-blue-900 font-medium'
                            : 'hover:bg-slate-50 text-slate-800'
                      }`}
                    >
                      <td className="py-1 px-2 text-center" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="win-checkbox"
                          checked={isChecked}
                          onChange={() => {
                            const next = new Set(selectedLeftKeys)
                            if (next.has(key)) next.delete(key)
                            else next.add(key)
                            setSelectedLeftKeys(next)
                          }}
                        />
                      </td>
                      <td className="py-1 px-2 font-mono text-[11px] truncate" title={row.account.uid || ''}>
                        {row.account.uid || ''}
                      </td>
                      <td className="py-1 px-2 font-mono text-[11px] truncate" title={row.pageId}>
                        {row.pageId}
                      </td>
                      <td className="py-1 px-2 truncate" title={row.pageName}>
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
        {/* RIGHT COLUMN: Filters, Metrics Bar, and Posts Table                      */}
        {/* ========================================================================= */}
        <div className="flex flex-1 min-w-0 flex-col rounded border border-slate-300 bg-white shadow-sm overflow-hidden">
          {/* Top Controls Card */}
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
                {(['ALL', 'REEL', 'PHOTO', 'STATUS'] as PagePostType[]).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setTargetType(type)}
                    className={`rounded px-2 py-0.5 text-[11px] font-semibold transition-all ${
                      targetType === type ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {type === 'ALL' ? 'All' : type}
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

              <div className="ml-auto flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                <Sparkles size={12} className="text-emerald-600" />
                <span>GraphQL API V2 Engine</span>
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
                <span>
                  Select All ({selectedPostIds.size}/{visiblePosts.filter((p) => p.status !== '✓ Completed').length})
                </span>
              </button>
            </div>

            <div className="flex items-center gap-3 text-xs text-slate-600">
              <span className="flex items-center gap-1">
                <Layers size={13} className="text-blue-600" /> Posts: <strong>{visiblePosts.length}</strong>
              </span>
            </div>
          </div>

          {/* Posts Table */}
          <div className="flex-1 overflow-y-auto select-none">
            {visiblePosts.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-slate-400 text-xs gap-2">
                <Layers size={36} className="text-slate-300" />
                <span>មិនទាន់មានការបង្ហោះទាញចូលទេ</span>
                <span className="text-[11px] text-slate-400">
                  សូមជ្រើសរើសគណនី និង Page នៅខាងឆ្វេង កំណត់កាលបរិច្ឆេទ រួចចុច "ទាញទិន្នន័យ (Get Data)"
                </span>
              </div>
            ) : (
              <table className="w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-slate-100 text-[11px] font-bold text-slate-700 border-b border-slate-200 shadow-xs">
                  <tr>
                    <th className="py-1 px-2 w-8 text-center">#</th>
                    <th className="py-1 px-2 w-16 text-center">Type</th>
                    <th className="py-1 px-2 w-[150px]">Post / Reel ID</th>
                    <th className="py-1 px-2">Title / Caption</th>
                    <th className="py-1 px-2 w-[100px]">Date</th>
                    <th className="py-1 px-2 w-[110px] text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visiblePosts.map((post, pIdx) => {
                    const isChecked = selectedPostIds.has(post.id)
                    const isDone = post.status === '✓ Completed'
                    const isDeletingThis = post.status === 'Deleting...'
                    const isProcessingThis = post.status === 'Processing...'

                    return (
                      <tr
                        key={post.id}
                        style={{ userSelect: isPostDragging ? 'none' : undefined }}
                        onMouseDown={(e) => {
                          if (e.button !== 0 || isDone) return
                          postDragBaseSelectionRef.current = new Set(selectedPostIds)
                          setPostDragAnchorIndex(pIdx)
                          setIsPostDragging(true)
                        }}
                        onMouseEnter={(e) => {
                          if (isPostDragging && postDragAnchorIndex !== null) {
                            selectPostRange(postDragAnchorIndex, pIdx, e.ctrlKey || e.metaKey)
                          }
                        }}
                        onClick={(e) => {
                          if (isDone) return
                          if (postDragAnchorIndex !== null && postDragAnchorIndex !== pIdx) {
                            lastClickedPostIndexRef.current = pIdx
                            return
                          }
                          if (e.shiftKey && lastClickedPostIndexRef.current !== null) {
                            selectPostRange(lastClickedPostIndexRef.current, pIdx, e.ctrlKey || e.metaKey)
                          } else if (e.ctrlKey || e.metaKey) {
                            toggleSelectPost(post.id)
                          } else {
                            toggleSelectPost(post.id)
                          }
                          lastClickedPostIndexRef.current = pIdx
                        }}
                        className={`transition-colors cursor-pointer ${
                          isDone
                            ? 'bg-slate-50 text-slate-400 line-through'
                            : isDeletingThis
                              ? 'bg-rose-100 font-semibold text-rose-900 animate-pulse'
                              : isProcessingThis
                                ? 'bg-amber-50 font-semibold text-amber-800'
                                : isChecked
                                  ? 'bg-blue-50 text-blue-900 font-medium'
                                  : 'hover:bg-slate-50 text-slate-800'
                        }`}
                      >
                        <td className="py-1 px-2 text-center" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="win-checkbox"
                            disabled={isDone}
                            checked={isChecked}
                            onChange={() => toggleSelectPost(post.id)}
                          />
                        </td>
                        <td className="py-1 px-2 text-center">
                          {post.type === 'Reel' ? (
                            <span className="inline-flex items-center gap-1 rounded bg-purple-100 text-purple-800 font-semibold text-[10px] px-1.5 py-0.5">
                              <Film size={10} /> Reel
                            </span>
                          ) : post.type === 'Photo' ? (
                            <span className="inline-flex items-center gap-1 rounded bg-sky-100 text-sky-800 font-semibold text-[10px] px-1.5 py-0.5">
                              <ImageIcon size={10} /> Photo
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded bg-slate-100 text-slate-700 font-semibold text-[10px] px-1.5 py-0.5">
                              <FileText size={10} /> Status
                            </span>
                          )}
                        </td>
                        <td className="py-1 px-2 font-mono text-[11px] truncate text-slate-600" title={post.id}>
                          {post.id}
                        </td>
                        <td className="py-1 px-2 truncate font-medium text-[11px]" title={post.title}>
                          {post.title}
                        </td>
                        <td className="py-1 px-2 text-[11px] text-slate-500 whitespace-nowrap">
                          {post.date}
                        </td>
                        <td className="py-1 px-2 text-center">
                          {isDone ? (
                            <span className="inline-flex items-center gap-0.5 text-emerald-700 font-bold text-[10px] bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                              <CheckCircle size={11} /> Completed
                            </span>
                          ) : isDeletingThis ? (
                            <span className="inline-flex items-center gap-0.5 text-rose-700 font-bold text-[10px] bg-rose-50 px-1.5 py-0.5 rounded border border-rose-200 animate-pulse">
                              <RefreshCw size={10} className="animate-spin" /> Deleting...
                            </span>
                          ) : isProcessingThis ? (
                            <span className="inline-flex items-center gap-0.5 text-amber-700 font-medium text-[10px] bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
                              <Clock size={10} /> Waiting...
                            </span>
                          ) : post.status === '✗ Failed' ? (
                            <span className="inline-flex items-center gap-0.5 text-rose-600 font-bold text-[10px]">
                              <XCircle size={11} /> Failed
                            </span>
                          ) : (
                            <span className="text-slate-400 text-[10px]">Published</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Confirmation Modal before Deleting via GraphQL API */}
      {confirmDeleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-2xs animate-in fade-in">
          <div className="w-[420px] rounded-lg border border-slate-300 bg-white p-4 shadow-xl">
            <div className="flex items-center gap-2 text-rose-600 mb-2">
              <AlertTriangle size={20} />
              <h3 className="font-bold text-sm">បញ្ជាក់ការលុបតាម GraphQL API V2</h3>
            </div>
            <p className="text-xs text-slate-600 mb-4 leading-relaxed">
              តើអ្នកប្រាកដជាចង់លុប <strong>{selectedPostIds.size} Posts/Reels</strong> នៃ Page{' '}
              <strong>"{activeRow?.pageName}"</strong> មែនទេ?
              <br />
              <span className="text-[11px] text-slate-500 mt-1 block">
                ប្រព័ន្ធនឹងផ្ញើ GraphQL Mutation (useCometTrashPostMutation) ទៅកាន់ Facebook Server ដោយផ្ទាល់។
              </span>
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="win-btn px-3 py-1 text-xs"
                onClick={() => setConfirmDeleteOpen(false)}
              >
                បោះបង់ (Cancel)
              </button>
              <button
                type="button"
                className="win-btn-danger px-3 py-1 text-xs font-semibold"
                onClick={handleConfirmDelete}
              >
                យល់ព្រមលុប (Confirm Delete)
              </button>
            </div>
          </div>
        </div>
      )}
    </ModalShell>
  )
}
