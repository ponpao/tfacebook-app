import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import {
  RefreshCw,
  Download,
  CheckSquare,
  Square,
  Search,
  Layers,
  Sparkles,
  Play,
  Square as StopIcon,
  CheckCircle2,
  Trash2,
  Copy,
  ClipboardPaste,
  ArrowUpDown,
  ArrowUp,
  ArrowDown
} from 'lucide-react'
import { ModalShell } from './ModalShell'
import type { Account, ManagedPage } from '../../../types/account'
import { ALL_FOLDERS } from '../../../types/folder'
import { useAccountStore } from '../../store/useAccountStore'

interface GetPageInfoModalProps {
  open?: boolean
  isOpen?: boolean
  onClose: () => void
}

interface FlattenedPageRow {
  rowKey: string
  accountId: number
  accountUid: string
  accountName: string
  pageId: string
  name: string
  assetId?: string
  url?: string
  followers: string
  following: string
  category: string
  website: string
  status: string
  deactivatedCount: number
  folderImage: string
  folderVideo: string
  folderReel: string
  note: string
}

type AccountSortKey = 'no' | 'uid' | 'name' | 'pages' | 'deact' | 'status'
type PageSortKey =
  | 'no'
  | 'accountUid'
  | 'pageId'
  | 'name'
  | 'followers'
  | 'deactivatedCount'
  | 'folderImage'
  | 'folderVideo'
  | 'folderReel'

interface SortConfig<T> {
  key: T
  dir: 'asc' | 'desc'
}

export const GetPageInfoModal: React.FC<GetPageInfoModalProps> = (props) => {
  const isOpen = props.open ?? props.isOpen ?? false
  const { onClose } = props
  const folders = useAccountStore((s) => s.folders)

  // Accounts state fetched directly from DB
  const [dbAccounts, setDbAccounts] = useState<Account[]>([])
  const [selectedFolderId, setSelectedFolderId] = useState<number>(ALL_FOLDERS)
  const [searchQuery, setSearchQuery] = useState('')
  const [engineVersion, setEngineVersion] = useState<'V1' | 'V2'>('V2')
  const [headlessMode, setHeadlessMode] = useState<boolean>(true)

  // Selection states
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<number>>(new Set())
  const [selectedPageKeys, setSelectedPageKeys] = useState<Set<string>>(new Set())

  // Sorting states
  const [accountSort, setAccountSort] = useState<SortConfig<AccountSortKey> | null>(null)
  const [pageSort, setPageSort] = useState<SortConfig<PageSortKey> | null>(null)

  // Mouse Drag selection tracking
  const [accDragging, setAccDragging] = useState(false)
  const accDragAnchorRef = useRef<number | null>(null)

  const [pageDragging, setPageDragging] = useState(false)
  const pageDragAnchorRef = useRef<number | null>(null)

  // Execution & Progress state
  const [isRunning, setIsRunning] = useState(false)
  const [progressMsg, setProgressMsg] = useState('')
  const [progressStats, setProgressStats] = useState({ current: 0, total: 0, pages: 0 })
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  // Media paths overrides
  const [pageOverrides, setPageOverrides] = useState<
    Record<string, { folderImage?: string; folderVideo?: string; folderReel?: string; note?: string }>
  >({})

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean
    x: number
    y: number
    targetRowKey?: string
    isPageTable: boolean
    targetAccountId?: number
  } | null>(null)

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(null), 3500)
  }, [])

  // Fetch accounts directly from DB
  const fetchAccountsForFolder = useCallback(
    async (folderId: number) => {
      try {
        const res = await window.api.accounts.list({
          folderId: folderId === ALL_FOLDERS ? undefined : folderId,
          limit: 10000
        })
        setDbAccounts(res.rows)
      } catch (err) {
        console.error('Failed to fetch accounts for GetPageInfoModal:', err)
      }
    },
    []
  )

  // Reset order & state when modal opens or closes
  useEffect(() => {
    if (isOpen) {
      setAccountSort(null)
      setPageSort(null)
      fetchAccountsForFolder(selectedFolderId)
    } else {
      setContextMenu(null)
      setAccDragging(false)
      setPageDragging(false)
      setAccountSort(null)
      setPageSort(null)
    }
  }, [isOpen, selectedFolderId, fetchAccountsForFolder])

  // Global mouseup & click to cancel dragging & context menu
  useEffect(() => {
    const handleMouseUp = () => {
      setAccDragging(false)
      setPageDragging(false)
    }
    const handleGlobalClick = () => {
      setContextMenu(null)
    }
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('click', handleGlobalClick)
    return () => {
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('click', handleGlobalClick)
    }
  }, [])

  // Calculate deactivated count per account
  const accountDeactivatedCounts = useMemo(() => {
    const map: Record<number, number> = {}
    dbAccounts.forEach((acc) => {
      if (!acc.pages_data) return
      try {
        const pages = JSON.parse(acc.pages_data) as ManagedPage[]
        if (!Array.isArray(pages)) return
        let count = 0
        pages.forEach((p) => {
          if (typeof p.deactivatedCount === 'number') {
            count = Math.max(count, p.deactivatedCount)
          } else if (p.status === 'Deactivated / Deleted') {
            count++
          }
        })
        map[acc.id] = count
      } catch {}
    })
    return map
  }, [dbAccounts])

  // Filtered Accounts by search
  const filteredAccounts = useMemo(() => {
    return dbAccounts.filter((acc) => {
      if (!searchQuery.trim()) return true
      const q = searchQuery.toLowerCase()
      const matchUid = acc.uid?.toLowerCase().includes(q)
      const matchName = acc.name?.toLowerCase().includes(q)
      return matchUid || matchName
    })
  }, [dbAccounts, searchQuery])

  // Sorted Accounts
  const sortedAccounts = useMemo(() => {
    if (!accountSort) return filteredAccounts
    const list = [...filteredAccounts]
    const { key, dir } = accountSort

    list.sort((a, b) => {
      let cmp = 0
      if (key === 'no') {
        cmp = a.id - b.id
      } else if (key === 'uid') {
        cmp = (a.uid || '').localeCompare(b.uid || '')
      } else if (key === 'name') {
        cmp = (a.name || '').localeCompare(b.name || '')
      } else if (key === 'pages') {
        cmp = (a.pages_count || 0) - (b.pages_count || 0)
      } else if (key === 'deact') {
        cmp = (accountDeactivatedCounts[a.id] || 0) - (accountDeactivatedCounts[b.id] || 0)
      } else if (key === 'status') {
        cmp = (a.status || '').localeCompare(b.status || '')
      }
      return dir === 'asc' ? cmp : -cmp
    })
    return list
  }, [filteredAccounts, accountSort, accountDeactivatedCounts])

  // Accounts in scope for Pages list
  const activeScopeAccounts = useMemo(() => {
    if (selectedAccountIds.size > 0) {
      return sortedAccounts.filter((a) => selectedAccountIds.has(a.id))
    }
    return sortedAccounts
  }, [sortedAccounts, selectedAccountIds])

  // Flattened Pages List — ONLY ACTIVE PAGES!
  const flattenedPages = useMemo<FlattenedPageRow[]>(() => {
    const list: FlattenedPageRow[] = []

    activeScopeAccounts.forEach((acc) => {
      if (!acc.pages_data) return
      try {
        const pages = JSON.parse(acc.pages_data) as ManagedPage[]
        if (!Array.isArray(pages)) return

        const deactCount = accountDeactivatedCounts[acc.id] || 0

        pages.forEach((p, idx) => {
          // EXCLUDE Deactivated pages & Summary markers from table rows!
          if (p.status === 'Deactivated / Deleted' || p.status === 'Summary' || !p.name) {
            return
          }

          const rowKey = `${acc.id}_${p.pageId || p.name || idx}`
          const override = pageOverrides[rowKey] || {}

          list.push({
            rowKey,
            accountId: acc.id,
            accountUid: acc.uid || `#${acc.id}`,
            accountName: acc.name || '',
            pageId: p.pageId || '-',
            name: p.name || 'Untitled Page',
            assetId: p.assetId || '',
            url: p.url,
            followers: p.followers || '0',
            following: p.following || '0',
            category: p.category || 'Unspecified',
            website: p.website || '',
            status: 'Active',
            deactivatedCount: deactCount,
            folderImage: override.folderImage ?? p.folderImage ?? '',
            folderVideo: override.folderVideo ?? p.folderVideo ?? '',
            folderReel: override.folderReel ?? p.folderReel ?? '',
            note: override.note ?? p.note ?? ''
          })
        })
      } catch {}
    })

    return list
  }, [activeScopeAccounts, pageOverrides, accountDeactivatedCounts])

  // Sorted Pages
  const sortedPages = useMemo(() => {
    if (!pageSort) return flattenedPages
    const list = [...flattenedPages]
    const { key, dir } = pageSort

    list.sort((a, b) => {
      let cmp = 0
      if (key === 'no') {
        cmp = a.rowKey.localeCompare(b.rowKey)
      } else if (key === 'accountUid') {
        cmp = a.accountUid.localeCompare(b.accountUid)
      } else if (key === 'pageId') {
        cmp = a.pageId.localeCompare(b.pageId)
      } else if (key === 'name') {
        cmp = a.name.localeCompare(b.name)
      } else if (key === 'followers') {
        const fA = parseInt(a.followers.replace(/,/g, ''), 10) || 0
        const fB = parseInt(b.followers.replace(/,/g, ''), 10) || 0
        cmp = fA - fB
      } else if (key === 'deactivatedCount') {
        cmp = a.deactivatedCount - b.deactivatedCount
      } else if (key === 'folderImage') {
        cmp = a.folderImage.localeCompare(b.folderImage)
      } else if (key === 'folderVideo') {
        cmp = a.folderVideo.localeCompare(b.folderVideo)
      } else if (key === 'folderReel') {
        cmp = a.folderReel.localeCompare(b.folderReel)
      }
      return dir === 'asc' ? cmp : -cmp
    })
    return list
  }, [flattenedPages, pageSort])

  // Sort handlers (Double click or click on header)
  const handleAccountSort = (key: AccountSortKey) => {
    setAccountSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return null
    })
  }

  const handlePageSort = (key: PageSortKey) => {
    setPageSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return null
    })
  }

  // Select all / deselect all accounts
  const toggleSelectAllAccounts = () => {
    if (selectedAccountIds.size === sortedAccounts.length) {
      setSelectedAccountIds(new Set())
    } else {
      setSelectedAccountIds(new Set(sortedAccounts.map((a) => a.id)))
    }
  }

  // Select all / deselect all pages
  const toggleSelectAllPages = () => {
    if (selectedPageKeys.size === sortedPages.length) {
      setSelectedPageKeys(new Set())
    } else {
      setSelectedPageKeys(new Set(sortedPages.map((p) => p.rowKey)))
    }
  }

  // Drag selection handlers for Accounts table
  const handleAccMouseDown = (index: number, e: React.MouseEvent) => {
    if (e.button !== 0) return
    setAccDragging(true)
    accDragAnchorRef.current = index
    const acc = sortedAccounts[index]
    if (!acc) return

    if (e.shiftKey && accDragAnchorRef.current !== null) {
      const start = Math.min(accDragAnchorRef.current, index)
      const end = Math.max(accDragAnchorRef.current, index)
      const next = new Set(selectedAccountIds)
      for (let i = start; i <= end; i++) {
        if (sortedAccounts[i]) next.add(sortedAccounts[i].id)
      }
      setSelectedAccountIds(next)
    } else if (e.ctrlKey) {
      const next = new Set(selectedAccountIds)
      if (next.has(acc.id)) next.delete(acc.id)
      else next.add(acc.id)
      setSelectedAccountIds(next)
    } else {
      setSelectedAccountIds(new Set([acc.id]))
    }
  }

  const handleAccMouseEnter = (index: number) => {
    if (!accDragging || accDragAnchorRef.current === null) return
    const start = Math.min(accDragAnchorRef.current, index)
    const end = Math.max(accDragAnchorRef.current, index)
    const next = new Set<number>()
    for (let i = start; i <= end; i++) {
      if (sortedAccounts[i]) next.add(sortedAccounts[i].id)
    }
    setSelectedAccountIds(next)
  }

  // Drag selection handlers for Pages table
  const handlePageMouseDown = (index: number, e: React.MouseEvent) => {
    if (e.button !== 0) return
    setPageDragging(true)
    pageDragAnchorRef.current = index
    const page = sortedPages[index]
    if (!page) return

    if (e.shiftKey && pageDragAnchorRef.current !== null) {
      const start = Math.min(pageDragAnchorRef.current, index)
      const end = Math.max(pageDragAnchorRef.current, index)
      const next = new Set(selectedPageKeys)
      for (let i = start; i <= end; i++) {
        if (sortedPages[i]) next.add(sortedPages[i].rowKey)
      }
      setSelectedPageKeys(next)
    } else if (e.ctrlKey) {
      const next = new Set(selectedPageKeys)
      if (next.has(page.rowKey)) next.delete(page.rowKey)
      else next.add(page.rowKey)
      setSelectedPageKeys(next)
    } else {
      setSelectedPageKeys(new Set([page.rowKey]))
    }
  }

  const handlePageMouseEnter = (index: number) => {
    if (!pageDragging || pageDragAnchorRef.current === null) return
    const start = Math.min(pageDragAnchorRef.current, index)
    const end = Math.max(pageDragAnchorRef.current, index)
    const next = new Set<string>()
    for (let i = start; i <= end; i++) {
      if (sortedPages[i]) next.add(sortedPages[i].rowKey)
    }
    setSelectedPageKeys(next)
  }

  // Run Extraction
  const handleStartExtraction = async () => {
    if (isRunning) return

    const targetAccs =
      selectedAccountIds.size > 0
        ? sortedAccounts.filter((a) => selectedAccountIds.has(a.id))
        : sortedAccounts

    if (targetAccs.length === 0) {
      showToast('No accounts available to scan')
      return
    }

    setIsRunning(true)
    setProgressStats({ current: 0, total: targetAccs.length, pages: 0 })
    setProgressMsg(`Starting ${engineVersion} scan for ${targetAccs.length} account(s)…`)

    try {
      const ids = targetAccs.map((a) => a.id)

      if (engineVersion === 'V2') {
        const cleanupProgress = window.api.pages.onExtractV2Progress?.((payload) => {
          setProgressStats({
            current: payload.index,
            total: payload.total,
            pages: payload.pagesFound
          })
          setProgressMsg(`[${payload.index}/${payload.total}] ${payload.name || payload.uid}: ${payload.message}`)
        })

        const res = await window.api.pages.extractPagesV2(ids, headlessMode)
        cleanupProgress?.()

        showToast(`V2 Scan complete! Scanned ${res.totalScanned} account(s), found ${res.totalPagesFound} page(s)`)
      } else {
        const cleanupProgress = window.api.pages.onBatchScanProgress((payload) => {
          setProgressStats((prev) => ({
            current: payload.index,
            total: payload.total,
            pages: prev.pages + payload.count
          }))
          setProgressMsg(`[${payload.index}/${payload.total}] ${payload.name}: Found ${payload.count} page(s)`)
        })

        const res = await window.api.pages.batchScanPages(ids)
        cleanupProgress?.()

        showToast(`V1 Scan complete! Found ${res.totalPagesFound} page(s)`)
      }

      await fetchAccountsForFolder(selectedFolderId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast(`Extraction error: ${msg}`)
    } finally {
      setIsRunning(false)
      setProgressMsg('Extraction finished.')
    }
  }

  // Stop Extraction
  const handleStopExtraction = async () => {
    if (!isRunning) return
    setProgressMsg('Stopping extraction…')
    if (engineVersion === 'V2') {
      await window.api.pages.stopExtractV2()
    } else {
      await window.api.pages.stopOperation()
    }
    setIsRunning(false)
  }

  // Context Menu opener
  const handleContextMenu = (
    e: React.MouseEvent,
    isPageTable: boolean,
    targetRowKey?: string,
    targetAccountId?: number
  ) => {
    e.preventDefault()
    e.stopPropagation()

    if (isPageTable && targetRowKey) {
      if (!selectedPageKeys.has(targetRowKey)) {
        setSelectedPageKeys(new Set([targetRowKey]))
      }
    } else if (!isPageTable && targetAccountId) {
      if (!selectedAccountIds.has(targetAccountId)) {
        setSelectedAccountIds(new Set([targetAccountId]))
      }
    }

    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      isPageTable,
      targetRowKey,
      targetAccountId
    })
  }

  const closeContextMenu = () => {
    setContextMenu(null)
  }

  // Clipboard Paste Import (NO FOLDER PICKER DIALOG)
  const handleImportClipboard = async (field: 'folderImage' | 'folderVideo' | 'folderReel') => {
    closeContextMenu()
    try {
      const clipText = (await navigator.clipboard.readText()).trim()
      if (!clipText) {
        showToast('Clipboard is empty! Please copy path(s) first.')
        return
      }

      const lines = clipText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)

      if (lines.length === 0) return

      const targetRows = sortedPages.filter((p) => selectedPageKeys.has(p.rowKey))
      if (targetRows.length === 0 && contextMenu?.targetRowKey) {
        const r = sortedPages.find((p) => p.rowKey === contextMenu.targetRowKey)
        if (r) targetRows.push(r)
      }

      if (targetRows.length === 0) {
        showToast('Please select at least 1 page row first')
        return
      }

      const nextOverrides = { ...pageOverrides }
      const affectedAccounts = new Set<number>()

      targetRows.forEach((row, i) => {
        const pathVal = lines.length === 1 ? lines[0] : lines[i % lines.length]
        nextOverrides[row.rowKey] = {
          ...nextOverrides[row.rowKey],
          [field]: pathVal
        }
        affectedAccounts.add(row.accountId)
      })

      setPageOverrides(nextOverrides)

      // Persist to database
      for (const accId of affectedAccounts) {
        const acc = dbAccounts.find((a) => a.id === accId)
        if (!acc || !acc.pages_data) continue
        try {
          const pages = JSON.parse(acc.pages_data) as ManagedPage[]
          const updated = pages.map((p, idx) => {
            const key = `${accId}_${p.pageId || p.name || idx}`
            const over = nextOverrides[key]
            if (!over) return p
            return {
              ...p,
              folderImage: over.folderImage !== undefined ? over.folderImage : p.folderImage,
              folderVideo: over.folderVideo !== undefined ? over.folderVideo : p.folderVideo,
              folderReel: over.folderReel !== undefined ? over.folderReel : p.folderReel
            }
          })
          await window.api.accounts.update(accId, { pages_data: JSON.stringify(updated) })
        } catch {}
      }

      const fieldLabel = field === 'folderImage' ? 'Image' : field === 'folderVideo' ? 'Video' : 'Reel'
      showToast(`Pasted ${fieldLabel} path (${lines.length} line(s)) to ${targetRows.length} row(s)`)
    } catch (err) {
      showToast(`Failed to read clipboard: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Clear Path Actions
  const handleClearPath = async (field: 'folderImage' | 'folderVideo' | 'folderReel' | 'all') => {
    closeContextMenu()
    const targetRows = sortedPages.filter((p) => selectedPageKeys.has(p.rowKey))
    if (targetRows.length === 0 && contextMenu?.targetRowKey) {
      const r = sortedPages.find((p) => p.rowKey === contextMenu.targetRowKey)
      if (r) targetRows.push(r)
    }

    if (targetRows.length === 0) return

    const nextOverrides = { ...pageOverrides }
    const affectedAccounts = new Set<number>()

    targetRows.forEach((row) => {
      if (field === 'all') {
        nextOverrides[row.rowKey] = {
          ...nextOverrides[row.rowKey],
          folderImage: '',
          folderVideo: '',
          folderReel: ''
        }
      } else {
        nextOverrides[row.rowKey] = {
          ...nextOverrides[row.rowKey],
          [field]: ''
        }
      }
      affectedAccounts.add(row.accountId)
    })

    setPageOverrides(nextOverrides)

    // Persist to database
    for (const accId of affectedAccounts) {
      const acc = dbAccounts.find((a) => a.id === accId)
      if (!acc || !acc.pages_data) continue
      try {
        const pages = JSON.parse(acc.pages_data) as ManagedPage[]
        const updated = pages.map((p, idx) => {
          const key = `${accId}_${p.pageId || p.name || idx}`
          const over = nextOverrides[key]
          if (!over) return p
          return {
            ...p,
            folderImage: over.folderImage !== undefined ? over.folderImage : p.folderImage,
            folderVideo: over.folderVideo !== undefined ? over.folderVideo : p.folderVideo,
            folderReel: over.folderReel !== undefined ? over.folderReel : p.folderReel
          }
        })
        await window.api.accounts.update(accId, { pages_data: JSON.stringify(updated) })
      } catch {}
    }

    showToast(`Cleared media path(s) for ${targetRows.length} row(s)`)
  }

  // Bulk Copy Actions (Accounts Table)
  const handleCopyAccounts = (prop: 'uid' | 'name') => {
    closeContextMenu()
    const target = sortedAccounts.filter((a) => selectedAccountIds.has(a.id))
    if (target.length === 0 && contextMenu?.targetAccountId) {
      const a = sortedAccounts.find((x) => x.id === contextMenu.targetAccountId)
      if (a) target.push(a)
    }

    if (target.length === 0) return
    const values = target.map((a) => a[prop] || '').filter(Boolean)
    navigator.clipboard.writeText(values.join('\n'))
    showToast(`Copied ${values.length} ${prop.toUpperCase()}(s) to clipboard`)
  }

  // Bulk Copy Actions (Pages Table)
  const handleCopyPages = (prop: 'pageId' | 'name' | 'accountUid' | 'url' | 'folderImage' | 'folderVideo' | 'folderReel') => {
    closeContextMenu()
    const target = sortedPages.filter((p) => selectedPageKeys.has(p.rowKey))
    if (target.length === 0 && contextMenu?.targetRowKey) {
      const p = sortedPages.find((x) => x.rowKey === contextMenu.targetRowKey)
      if (p) target.push(p)
    }

    if (target.length === 0) return
    const values = target.map((p) => p[prop] || '').filter(Boolean)
    navigator.clipboard.writeText(values.join('\n'))
    showToast(`Copied ${values.length} value(s) to clipboard`)
  }

  // Export CSV
  const handleExportCSV = () => {
    if (sortedPages.length === 0) {
      showToast('No pages to export')
      return
    }

    const headers = [
      'Account UID',
      'Account Name',
      'Page ID',
      'Page Name',
      'Followers',
      'Following',
      'Category',
      'Page Deactivate Count',
      'Image Path',
      'Video Path',
      'Reel Path',
      'URL'
    ]

    const rows = sortedPages.map((p) => [
      `"${p.accountUid}"`,
      `"${(p.accountName || '').replace(/"/g, '""')}"`,
      `"${p.pageId}"`,
      `"${p.name.replace(/"/g, '""')}"`,
      `"${p.followers}"`,
      `"${p.following}"`,
      `"${p.category}"`,
      `"${p.deactivatedCount}"`,
      `"${(p.folderImage || '').replace(/"/g, '""')}"`,
      `"${(p.folderVideo || '').replace(/"/g, '""')}"`,
      `"${(p.folderReel || '').replace(/"/g, '""')}"`,
      `"${p.url || ''}"`
    ])

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.setAttribute('href', url)
    link.setAttribute('download', `facebook_pages_export_${Date.now()}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    showToast(`Exported ${sortedPages.length} pages to CSV`)
  }

  // Sort indicator helper
  const renderSortIndicator = (currentKey: string, activeConfig: SortConfig<any> | null) => {
    if (!activeConfig || activeConfig.key !== currentKey) {
      return <ArrowUpDown className="w-3 h-3 text-slate-400 opacity-0 group-hover:opacity-70 inline ml-1 transition-opacity" />
    }
    return activeConfig.dir === 'asc' ? (
      <ArrowUp className="w-3 h-3 text-blue-600 inline ml-1 font-bold" />
    ) : (
      <ArrowDown className="w-3 h-3 text-blue-600 inline ml-1 font-bold" />
    )
  }

  if (!isOpen) return null

  return (
    <ModalShell
      open={isOpen}
      onClose={onClose}
      title="Get Page Info — Facebook Pages Manager & Extractor (V1 & V2)"
      icon={Layers}
      width="max-w-[1420px]"
      height="h-[92vh] max-h-[880px]"
      bodyClassName="flex-1 min-h-0 overflow-hidden flex flex-col p-2.5 bg-surface-sunken"
      footer={
        <div className="flex w-full items-center justify-between text-xs text-ink-muted">
          <div className="flex items-center gap-4">
            <span>
              Accounts in Folder: <strong className="text-ink">{sortedAccounts.length}</strong>
            </span>
            <span>
              Selected Accounts: <strong className="text-blue-700">{selectedAccountIds.size}</strong>
            </span>
            <span>
              Active Pages Displayed: <strong className="text-emerald-700">{sortedPages.length}</strong>
            </span>
            {selectedPageKeys.size > 0 && (
              <span className="px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-500/15 text-blue-800 dark:text-blue-300 font-semibold text-[11px]">
                Selected Pages: {selectedPageKeys.size}
              </span>
            )}
          </div>
          <button
            type="button"
            className="win-btn px-5 py-1 text-xs font-semibold"
            onClick={onClose}
          >
            បិទ
          </button>
        </div>
      }
    >
      {/* Toast Notification */}
      {toastMsg && (
        <div className="absolute top-12 right-6 z-50 px-4 py-2 bg-slate-800 text-white font-medium text-xs rounded-lg animate-in slide-in-from-top-2 duration-150 flex items-center gap-2 border border-slate-700">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>{toastMsg}</span>
        </div>
      )}

      {/* TOP TOOLBAR: Single clean row, NO WRAP, perfectly aligned on one line */}
      <div className="flex items-center justify-between gap-2 rounded-xl border border-edge bg-surface px-3 py-1.5 mb-2 shrink-0">
        {/* Left Controls in a single non-wrapping flex row */}
        <div className="flex items-center gap-2.5 flex-nowrap min-w-0">
          {/* Category Folder selector */}
          <div className="flex items-center gap-1.5 shrink-0">
            <label className="text-xs font-semibold text-ink-muted whitespace-nowrap">Category Folder:</label>
            <select
              value={selectedFolderId}
              onChange={(e) => {
                const fid = Number(e.target.value)
                setSelectedFolderId(fid)
                setSelectedAccountIds(new Set())
                setSelectedPageKeys(new Set())
              }}
              className="rounded-lg border border-edge bg-surface px-2 py-1 text-xs text-ink focus:outline-none focus:border-blue-500 max-w-[150px] truncate"
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

          {/* Search box */}
          <div className="flex items-center gap-1 rounded-lg border border-edge bg-surface px-2 py-1 w-36 shrink-0">
            <Search size={12} className="text-ink-muted shrink-0" />
            <input
              type="text"
              placeholder="Search UID / Name…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full text-xs text-ink focus:outline-none bg-transparent"
            />
          </div>

          {/* Engine selector */}
          <div className="flex items-center gap-1.5 shrink-0">
            <Sparkles size={13} className="text-blue-600 shrink-0" />
            <label className="text-xs font-semibold text-ink-muted whitespace-nowrap">Engine:</label>
            <select
              value={engineVersion}
              onChange={(e) => setEngineVersion(e.target.value as 'V1' | 'V2')}
              className="rounded-lg border border-edge bg-surface px-2 py-1 text-xs font-semibold text-blue-800 focus:outline-none focus:border-blue-500 max-w-[210px] truncate"
            >
              <option value="V2">V2 (Fast Extractor — Anti Obfuscation & Details)</option>
              <option value="V1">V1 (Standard Page Extractor)</option>
            </select>
          </div>

          {/* Headless Toggle */}
          <label className="flex items-center gap-1.5 text-xs text-ink-muted font-medium cursor-pointer shrink-0 whitespace-nowrap">
            <input
              type="checkbox"
              checked={headlessMode}
              onChange={(e) => setHeadlessMode(e.target.checked)}
              className="rounded border-slate-300 text-blue-600 focus:ring-0"
            />
            <span>Headless</span>
          </label>
        </div>

        {/* Right Controls: Get Page Info & Export CSV (Aligned to the FAR RIGHT) */}
        <div className="flex items-center gap-2 shrink-0">
          {!isRunning ? (
            <button
              onClick={handleStartExtraction}
              className="flex items-center gap-1.5 px-3.5 py-1 text-xs font-bold bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white rounded shadow-xs transition-all"
            >
              <Play size={12} className="fill-current" />
              <span>Get Page Info</span>
            </button>
          ) : (
            <button
              onClick={handleStopExtraction}
              className="flex items-center gap-1.5 px-3.5 py-1 text-xs font-bold bg-rose-600 hover:bg-rose-700 active:scale-95 text-white rounded shadow-xs transition-all"
            >
              <StopIcon size={12} className="fill-current" />
              <span>Stop</span>
            </button>
          )}

          <button
            onClick={handleExportCSV}
            className="win-btn flex items-center gap-1.5 px-3.5 py-1 text-xs font-medium text-ink-muted"
          >
            <Download size={12} />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* Progress & Live Status Banner */}
      {progressMsg && (
        <div className="flex items-center justify-between rounded-xl border border-edge bg-surface px-3 py-1.5 mb-2 text-xs shrink-0">
          <div className="flex items-center gap-2 text-ink-muted font-medium">
            {isRunning ? (
              <RefreshCw size={13} className="text-blue-600 animate-spin shrink-0" />
            ) : (
              <CheckCircle2 size={13} className="text-emerald-600 shrink-0" />
            )}
            <span className="truncate max-w-xl">{progressMsg}</span>
          </div>
          <div className="flex items-center gap-4 text-ink-muted font-semibold text-[11px]">
            <span>
              Progress: <strong className="text-ink">{progressStats.current}/{progressStats.total}</strong>
            </span>
            <span>
              Pages Found: <strong className="text-emerald-700">{progressStats.pages}</strong>
            </span>
          </div>
        </div>
      )}

      {/* Split Tables Container */}
      <div className="flex-1 flex gap-2 overflow-hidden min-h-0">
        {/* LEFT PANEL: Accounts Table (w-[450px]) */}
        <div className="w-[450px] shrink-0 rounded-xl border border-edge bg-surface overflow-hidden flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-edge bg-surface-sunken px-3 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <button
                onClick={toggleSelectAllAccounts}
                className="text-ink-muted hover:text-ink transition-colors"
                title="Select / Deselect All Accounts"
              >
                {selectedAccountIds.size === sortedAccounts.length && sortedAccounts.length > 0 ? (
                  <CheckSquare size={13} className="text-blue-600" />
                ) : (
                  <Square size={13} className="text-ink-muted" />
                )}
              </button>
              <span className="font-bold text-ink">
                Accounts ({sortedAccounts.length})
              </span>
            </div>
            <span className="text-[10px] text-ink-muted italic">
              Drag mouse or double-click to sort
            </span>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-y-auto select-none">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-surface-sunken text-[11px] font-bold text-ink-muted border-b border-edge">
                <tr>
                  <th
                    className="w-10 px-2 py-1.5 text-center group cursor-pointer"
                    onClick={() => handleAccountSort('no')}
                    onDoubleClick={() => handleAccountSort('no')}
                    title="Double-click to sort"
                  >
                    No.{renderSortIndicator('no', accountSort)}
                  </th>
                  <th className="w-8 px-1 py-1.5 text-center">✓</th>
                  <th
                    className="px-2 py-1.5 group cursor-pointer"
                    onClick={() => handleAccountSort('uid')}
                    onDoubleClick={() => handleAccountSort('uid')}
                    title="Double-click to sort"
                  >
                    UID{renderSortIndicator('uid', accountSort)}
                  </th>
                  <th
                    className="px-2 py-1.5 group cursor-pointer"
                    onClick={() => handleAccountSort('name')}
                    onDoubleClick={() => handleAccountSort('name')}
                    title="Double-click to sort"
                  >
                    Name{renderSortIndicator('name', accountSort)}
                  </th>
                  <th
                    className="w-12 px-2 py-1.5 text-center group cursor-pointer"
                    onClick={() => handleAccountSort('pages')}
                    onDoubleClick={() => handleAccountSort('pages')}
                    title="Double-click to sort"
                  >
                    Pages{renderSortIndicator('pages', accountSort)}
                  </th>
                  <th
                    className="w-12 px-2 py-1.5 text-center text-rose-600 group cursor-pointer"
                    onClick={() => handleAccountSort('deact')}
                    onDoubleClick={() => handleAccountSort('deact')}
                    title="Deactivated count (Double-click to sort)"
                  >
                    Deact.{renderSortIndicator('deact', accountSort)}
                  </th>
                  <th
                    className="w-14 px-2 py-1.5 text-center group cursor-pointer"
                    onClick={() => handleAccountSort('status')}
                    onDoubleClick={() => handleAccountSort('status')}
                    title="Double-click to sort"
                  >
                    Status{renderSortIndicator('status', accountSort)}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sortedAccounts.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-ink-muted">
                      No accounts found in this folder.
                    </td>
                  </tr>
                ) : (
                  sortedAccounts.map((acc, index) => {
                    const isSelected = selectedAccountIds.has(acc.id)
                    const deactCount = accountDeactivatedCounts[acc.id] || 0

                    return (
                      <tr
                        key={acc.id}
                        onMouseDown={(e) => handleAccMouseDown(index, e)}
                        onMouseEnter={() => handleAccMouseEnter(index)}
                        onContextMenu={(e) => handleContextMenu(e, false, undefined, acc.id)}
                        className={`cursor-pointer select-none transition-colors ${
                          isSelected
                            ? 'bg-blue-100 dark:bg-blue-500/15 text-blue-900 dark:text-blue-300 font-medium'
                            : index % 2 === 0
                            ? 'bg-surface hover:bg-surface-sunken'
                            : 'bg-surface-sunken/70 hover:bg-surface-sunken'
                        }`}
                      >
                        <td className="px-2 py-1.5 text-center text-ink-muted font-mono text-[11px]">
                          {index + 1}
                        </td>
                        <td className="px-1 py-1.5 text-center">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {
                              const next = new Set(selectedAccountIds)
                              if (next.has(acc.id)) next.delete(acc.id)
                              else next.add(acc.id)
                              setSelectedAccountIds(next)
                            }}
                            className="rounded border-slate-300 text-blue-600 focus:ring-0"
                          />
                        </td>
                        <td className="px-2 py-1.5 font-mono text-[11px] text-slate-700 truncate max-w-[110px]" title={acc.uid || ''}>
                          {acc.uid || `#${acc.id}`}
                        </td>
                        <td className="px-2 py-1.5 font-medium text-ink truncate max-w-[120px]" title={acc.name || ''}>
                          {acc.name || '-'}
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <span className="inline-block px-1.5 py-0.2 rounded text-[11px] font-bold bg-emerald-100 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700/40">
                            {acc.pages_count ?? 0}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          {deactCount > 0 ? (
                            <span className="inline-block px-1.5 py-0.2 rounded text-[11px] font-bold bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-300 dark:border-rose-700/40">
                              {deactCount}
                            </span>
                          ) : (
                            <span className="text-slate-400 text-[11px]">0</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <span
                            className={`inline-block px-1.5 py-0.2 rounded text-[10px] font-bold ${
                              acc.status === 'Live'
                                ? 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-300'
                                : acc.status === 'Checkpoint'
                                ? 'bg-amber-100 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300'
                                : 'bg-rose-100 dark:bg-rose-500/15 text-rose-800 dark:text-rose-300'
                            }`}
                          >
                            {acc.status || 'Live'}
                          </span>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* RIGHT PANEL: Pages List Table */}
        <div className="flex-1 rounded-xl border border-edge bg-surface overflow-hidden flex flex-col min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-edge bg-surface-sunken px-3 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <button
                onClick={toggleSelectAllPages}
                className="text-ink-muted hover:text-ink transition-colors"
                title="Select / Deselect All Pages"
              >
                {selectedPageKeys.size === sortedPages.length && sortedPages.length > 0 ? (
                  <CheckSquare size={13} className="text-blue-600" />
                ) : (
                  <Square size={13} className="text-ink-muted" />
                )}
              </button>
              <span className="font-bold text-ink">
                Pages List ({sortedPages.length})
              </span>
              {selectedAccountIds.size > 0 && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-500/15 text-blue-800 dark:text-blue-300">
                  Filtered by {selectedAccountIds.size} selected account(s)
                </span>
              )}
            </div>
            <span className="text-[10px] text-ink-muted italic">
              Right-click: Import / Clear media paths | Double-click to sort
            </span>
          </div>

          {/* Table with horizontal & vertical scroll */}
          <div className="flex-1 overflow-x-auto overflow-y-auto select-none">
            <table className="w-max min-w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 z-10 bg-surface-sunken text-[11px] font-bold text-ink-muted border-b border-edge">
                <tr>
                  <th
                    className="w-10 min-w-[40px] px-2 py-1.5 text-center group cursor-pointer"
                    onClick={() => handlePageSort('no')}
                    onDoubleClick={() => handlePageSort('no')}
                    title="Double-click to sort"
                  >
                    No.{renderSortIndicator('no', pageSort)}
                  </th>
                  <th className="w-8 min-w-[32px] px-1 py-1.5 text-center">✓</th>
                  <th
                    className="w-[130px] min-w-[130px] px-2.5 py-1.5 group cursor-pointer"
                    onClick={() => handlePageSort('accountUid')}
                    onDoubleClick={() => handlePageSort('accountUid')}
                    title="Double-click to sort"
                  >
                    UID Acc{renderSortIndicator('accountUid', pageSort)}
                  </th>
                  <th
                    className="w-[140px] min-w-[140px] px-2.5 py-1.5 group cursor-pointer"
                    onClick={() => handlePageSort('pageId')}
                    onDoubleClick={() => handlePageSort('pageId')}
                    title="Double-click to sort"
                  >
                    ID Page{renderSortIndicator('pageId', pageSort)}
                  </th>
                  <th
                    className="w-[180px] min-w-[180px] px-2.5 py-1.5 group cursor-pointer"
                    onClick={() => handlePageSort('name')}
                    onDoubleClick={() => handlePageSort('name')}
                    title="Double-click to sort"
                  >
                    Name Page{renderSortIndicator('name', pageSort)}
                  </th>
                  <th
                    className="w-[90px] min-w-[90px] px-2 py-1.5 text-center group cursor-pointer"
                    onClick={() => handlePageSort('followers')}
                    onDoubleClick={() => handlePageSort('followers')}
                    title="Double-click to sort"
                  >
                    Followers{renderSortIndicator('followers', pageSort)}
                  </th>
                  <th
                    className="w-[120px] min-w-[120px] px-2 py-1.5 text-center text-rose-600 group cursor-pointer"
                    onClick={() => handlePageSort('deactivatedCount')}
                    onDoubleClick={() => handlePageSort('deactivatedCount')}
                    title="Deactivated count for this account (Double-click to sort)"
                  >
                    Page Deactivate{renderSortIndicator('deactivatedCount', pageSort)}
                  </th>
                  <th
                    className="w-[160px] min-w-[160px] px-2.5 py-1.5 group cursor-pointer"
                    onClick={() => handlePageSort('folderImage')}
                    onDoubleClick={() => handlePageSort('folderImage')}
                    title="Image folder path (Double-click to sort)"
                  >
                    Image{renderSortIndicator('folderImage', pageSort)}
                  </th>
                  <th
                    className="w-[160px] min-w-[160px] px-2.5 py-1.5 group cursor-pointer"
                    onClick={() => handlePageSort('folderVideo')}
                    onDoubleClick={() => handlePageSort('folderVideo')}
                    title="Video folder path (Double-click to sort)"
                  >
                    Video{renderSortIndicator('folderVideo', pageSort)}
                  </th>
                  <th
                    className="w-[160px] min-w-[160px] px-2.5 py-1.5 group cursor-pointer"
                    onClick={() => handlePageSort('folderReel')}
                    onDoubleClick={() => handlePageSort('folderReel')}
                    title="Reel folder path (Double-click to sort)"
                  >
                    Reel{renderSortIndicator('folderReel', pageSort)}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sortedPages.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-16 text-center text-ink-muted">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <Layers size={32} className="text-ink-muted" />
                        <p>No active pages extracted yet. Select accounts and click <strong>Get Page Info</strong> above.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  sortedPages.map((row, index) => {
                    const isSelected = selectedPageKeys.has(row.rowKey)

                    return (
                      <tr
                        key={row.rowKey}
                        onMouseDown={(e) => handlePageMouseDown(index, e)}
                        onMouseEnter={() => handlePageMouseEnter(index)}
                        onContextMenu={(e) => handleContextMenu(e, true, row.rowKey)}
                        className={`cursor-pointer select-none transition-colors ${
                          isSelected
                            ? 'bg-blue-100 dark:bg-blue-500/15 text-blue-900 dark:text-blue-300 font-medium'
                            : index % 2 === 0
                            ? 'bg-surface hover:bg-surface-sunken'
                            : 'bg-surface-sunken/70 hover:bg-surface-sunken'
                        }`}
                      >
                        <td className="w-10 min-w-[40px] px-2 py-1.5 text-center text-ink-muted font-mono text-[11px]">
                          {index + 1}
                        </td>
                        <td className="w-8 min-w-[32px] px-1 py-1.5 text-center">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {
                              const next = new Set(selectedPageKeys)
                              if (next.has(row.rowKey)) next.delete(row.rowKey)
                              else next.add(row.rowKey)
                              setSelectedPageKeys(next)
                            }}
                            className="rounded border-slate-300 text-blue-600 focus:ring-0"
                          />
                        </td>
                        <td className="w-[130px] min-w-[130px] px-2.5 py-1.5 font-mono text-[11px] text-ink-muted truncate" title={row.accountUid}>
                          {row.accountUid}
                        </td>
                        <td className="w-[140px] min-w-[140px] px-2.5 py-1.5 font-mono text-[11px] text-blue-700 font-semibold truncate" title={row.pageId}>
                          {row.pageId}
                        </td>
                        <td className="w-[180px] min-w-[180px] px-2.5 py-1.5 font-medium text-ink truncate" title={row.name}>
                          {row.name}
                        </td>
                        <td className="w-[90px] min-w-[90px] px-2 py-1.5 text-center font-mono font-bold text-emerald-700">
                          {row.followers || '0'}
                        </td>
                        <td className="w-[120px] min-w-[120px] px-2 py-1.5 text-center">
                          {row.deactivatedCount > 0 ? (
                            <span className="inline-block px-1.5 py-0.2 rounded text-[11px] font-bold bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-300 dark:border-rose-700/40">
                              {row.deactivatedCount}
                            </span>
                          ) : (
                            <span className="text-ink-muted text-[11px]">0</span>
                          )}
                        </td>
                        {/* Image Column: Clean plain text without boxes */}
                        <td className="w-[160px] min-w-[160px] px-2.5 py-1.5 truncate" title={row.folderImage}>
                          {row.folderImage ? (
                            <span className="text-ink font-mono text-[11px] select-all">{row.folderImage}</span>
                          ) : (
                            <span className="text-ink-muted italic text-[11px]">-</span>
                          )}
                        </td>
                        {/* Video Column: Clean plain text without boxes */}
                        <td className="w-[160px] min-w-[160px] px-2.5 py-1.5 truncate" title={row.folderVideo}>
                          {row.folderVideo ? (
                            <span className="text-ink font-mono text-[11px] select-all">{row.folderVideo}</span>
                          ) : (
                            <span className="text-ink-muted italic text-[11px]">-</span>
                          )}
                        </td>
                        {/* Reel Column: Clean plain text without boxes */}
                        <td className="w-[160px] min-w-[160px] px-2.5 py-1.5 truncate" title={row.folderReel}>
                          {row.folderReel ? (
                            <span className="text-ink font-mono text-[11px] select-all">{row.folderReel}</span>
                          ) : (
                            <span className="text-ink-muted italic text-[11px]">-</span>
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Context Menu (WinForms clean white shadow style) */}
      {contextMenu?.visible && (
        <div
          className="fixed z-50 min-w-[210px] py-1 bg-surface border border-edge rounded-xl text-xs text-ink animate-in fade-in zoom-in-95 duration-100"
          style={{
            top: Math.min(contextMenu.y, window.innerHeight - 280),
            left: Math.min(contextMenu.x, window.innerWidth - 230)
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.isPageTable ? (
            <>
              <div className="px-3 py-1 text-[10px] font-bold tracking-wider text-ink-muted uppercase border-b border-edge">
                Import Paths from Clipboard
              </div>
              <button
                onClick={() => handleImportClipboard('folderImage')}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-sunken hover:text-blue-700 text-left transition-colors font-medium"
              >
                <ClipboardPaste size={13} className="text-blue-600" />
                <span>Import Image Path (Paste)</span>
              </button>
              <button
                onClick={() => handleImportClipboard('folderVideo')}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-sunken hover:text-blue-700 text-left transition-colors font-medium"
              >
                <ClipboardPaste size={13} className="text-blue-600" />
                <span>Import Video Path (Paste)</span>
              </button>
              <button
                onClick={() => handleImportClipboard('folderReel')}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-sunken hover:text-blue-700 text-left transition-colors font-medium"
              >
                <ClipboardPaste size={13} className="text-blue-600" />
                <span>Import Reel Path (Paste)</span>
              </button>

              <div className="my-1 border-t border-edge" />
              <div className="px-3 py-1 text-[10px] font-bold tracking-wider text-ink-muted uppercase">
                Clear Media Paths
              </div>
              <button
                onClick={() => handleClearPath('folderImage')}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-rose-50 dark:hover:bg-rose-500/15 hover:text-rose-700 dark:hover:text-rose-300 text-left transition-colors"
              >
                <Trash2 size={13} className="text-rose-600" />
                <span>Clear Image Path</span>
              </button>
              <button
                onClick={() => handleClearPath('folderVideo')}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-rose-50 dark:hover:bg-rose-500/15 hover:text-rose-700 dark:hover:text-rose-300 text-left transition-colors"
              >
                <Trash2 size={13} className="text-rose-600" />
                <span>Clear Video Path</span>
              </button>
              <button
                onClick={() => handleClearPath('folderReel')}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-rose-50 dark:hover:bg-rose-500/15 hover:text-rose-700 dark:hover:text-rose-300 text-left transition-colors"
              >
                <Trash2 size={13} className="text-rose-600" />
                <span>Clear Reel Path</span>
              </button>
              <button
                onClick={() => handleClearPath('all')}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-rose-50 dark:hover:bg-rose-500/15 hover:text-rose-700 dark:hover:text-rose-300 text-left transition-colors"
              >
                <Trash2 size={13} className="text-rose-600" />
                <span>Clear All Media Paths</span>
              </button>

              <div className="my-1 border-t border-edge" />
              <div className="px-3 py-1 text-[10px] font-bold tracking-wider text-ink-muted uppercase">
                Copy Values ({selectedPageKeys.size > 0 ? selectedPageKeys.size : 1})
              </div>
              <button
                onClick={() => handleCopyPages('pageId')}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-sunken text-left transition-colors"
              >
                <Copy size={13} className="text-ink-muted" />
                <span>Copy Page ID(s)</span>
              </button>
              <button
                onClick={() => handleCopyPages('name')}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-sunken text-left transition-colors"
              >
                <Copy size={13} className="text-ink-muted" />
                <span>Copy Page Name(s)</span>
              </button>
              <button
                onClick={() => handleCopyPages('accountUid')}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-sunken text-left transition-colors"
              >
                <Copy size={13} className="text-ink-muted" />
                <span>Copy Account UID(s)</span>
              </button>
              <button
                onClick={() => handleCopyPages('url')}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-sunken text-left transition-colors"
              >
                <Copy size={13} className="text-ink-muted" />
                <span>Copy Page URL(s)</span>
              </button>
            </>
          ) : (
            <>
              <div className="px-3 py-1 text-[10px] font-bold tracking-wider text-ink-muted uppercase border-b border-edge">
                Copy Account Data ({selectedAccountIds.size > 0 ? selectedAccountIds.size : 1})
              </div>
              <button
                onClick={() => handleCopyAccounts('uid')}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-sunken text-left transition-colors"
              >
                <Copy size={13} className="text-ink-muted" />
                <span>Copy UID(s)</span>
              </button>
              <button
                onClick={() => handleCopyAccounts('name')}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-sunken text-left transition-colors"
              >
                <Copy size={13} className="text-ink-muted" />
                <span>Copy Account Name(s)</span>
              </button>
            </>
          )}
        </div>
      )}
    </ModalShell>
  )
}
