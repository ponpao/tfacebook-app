// ---------------------------------------------------------------------------
// RibbonToolbar.tsx  — single unified, draggable/floatable WinForms ribbon.
//   Row 1: run controls (Start/Stop), Threads/Scenario/Search/Folder Manager
//     fieldsets, and Import Accounts pushed to the far right.
//   Row 2: the automation action buttons rendered as soft pastel pills.
//   Dragging the grip handle detaches the whole ribbon into a free-floating
//   panel the user can reposition anywhere on screen; "Dock" snaps it back
//   to its normal place in the layout. Both the floating/docked state and
//   the last floating position persist across restarts (localStorage), same
//   pattern as this app's column-width/scenario persistence.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react'
import {
  Play,
  Square,
  Search,
  Plus,
  Pencil,
  Minus,
  RefreshCw,
  Download,
  FileDown,
  BookOpen,
  Share2,
  Video,
  UserCog,
  Upload,
  Globe,
  Shuffle,
  XCircle,
  GripVertical,
  PinOff,
  Trash2,
  LayoutGrid,
  ChevronDown
} from 'lucide-react'
import type { ArrangeLayout } from '../../types/ipc'
import { useAccountStore, type SearchField } from '../store/useAccountStore'
import { useLanguageStore } from '../store/useLanguageStore'
import { ALL_FOLDERS } from '../../types/folder'
import type { FolderDialogMode } from './modals/FolderDialogs'
import type { AccountStatus } from '../../types/account'
import { AutoPostModal } from './modals/AutoPostModal'
import { DeletePagePostsModal } from './modals/DeletePagePostsModal'
import { AutoShareModal } from './modals/AutoShareModal'
import { ChangeInfoModal } from './modals/ChangeInfoModal'
import { ImportProxyModal } from './modals/ImportProxyModal'
import { ImportUseragentModal } from './modals/ImportUseragentModal'
import { WatchLiveModal } from './modals/WatchLiveModal'

const SEARCH_FIELDS: { value: SearchField; label: string }[] = [
  { value: 'uid', label: 'UID' },
  { value: 'email', label: 'Email' },
  { value: 'name', label: 'Name' },
  { value: 'proxy', label: 'Proxy' }
]

const STATUS_OPTIONS: (AccountStatus | 'All')[] = [
  'All',
  'Live',
  'Checkpoint',
  'Die',
  'Changed Pass',
  'Unknown'
]

// Soft pastel pill colors per action — background/border/text triples kept
// light enough that the pill reads as a badge, not a solid button, matching
// the "Studio"-style toolbar's Row 2.
// Auto Post / Auto Share / Watch Live and Import UA / Import Proxy are each
// grouped under one "Interact" / "Import" dropdown pill (see PillDropdown)
// instead of one standalone pill per action, so this list only holds the
// remaining always-standalone Row 2 actions.
// Rendered before the Arrange Windows dropdown pill.
const ACTION_BUTTONS: {
  icon: typeof BookOpen
  label: string
  bg: string
  border: string
  text: string
}[] = [
  { icon: UserCog, label: 'Change Info', bg: '#fdf7e3', border: '#f0e2ad', text: '#8a6d10' },
  { icon: FileDown, label: 'Export', bg: '#eef0f4', border: '#d3d8e2', text: '#48505e' },
  { icon: Shuffle, label: 'Randomize', bg: '#f3ecfb', border: '#ddc7f2', text: '#6b3aa0' }
]

// Rendered after the Arrange Windows dropdown pill (Close Browsers stays
// last, at the far right of Row 2, matching "arrange before close").
const ACTION_BUTTONS_AFTER_ARRANGE: (typeof ACTION_BUTTONS)[number][] = [
  { icon: XCircle, label: 'Close Browsers', bg: '#fbebe8', border: '#f2c9c0', text: '#a8442e' }
]

// Action-handler lookup keys stay stable (independent of any display-label
// wording changes above) — Export maps to the same underlying action as
// before under its fuller original name.
const ACTION_KEYS: Record<string, string> = {
  Export: 'Export Accounts'
}

// "Arrange Browsers" dropdown — tiles/splits every currently-open headed
// browser window via windowArranger.ts (main process, CDP-driven). Grid
// 5x2 is the recommended default per spec (10 windows/screen).
const ARRANGE_OPTIONS: { layout: ArrangeLayout; label: string }[] = [
  { layout: 'grid5x2', label: '5x2' },
  { layout: 'grid4x2', label: '4x2' },
  { layout: 'leftHalf', label: 'Left Half PC' },
  { layout: 'rightHalf', label: 'Right Half PC' },
  { layout: 'maximized', label: 'Full Screen' },
  { layout: 'restore', label: 'Original Size' }
]

const TOOLBAR_POS_KEY = 'ui.toolbarFloatPosition'
const TOOLBAR_DOCKED_KEY = 'ui.toolbarDocked'

interface FloatPos {
  x: number
  y: number
}

/**
 * A Row 2 action pill that opens a small dropdown of sub-actions instead of
 * firing one action directly — used to group Auto Post / Auto Share / Watch
 * Live under "Interact" and Import UA / Import Proxy under "Import", so Row
 * 2 doesn't need one pill per individual action. Same open/close/outside-
 * click/portal-free pattern the Arrange Windows pill already used, factored
 * out here so it isn't duplicated three times.
 */
function PillDropdown({
  icon: Icon,
  label,
  bg,
  border,
  text,
  options
}: {
  icon: typeof Download
  label: string
  bg: string
  border: string
  text: string
  options: { key: string; icon: typeof Download; label: string; onClick: () => void }[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        className="action-pill"
        style={{ backgroundColor: bg, borderColor: border, color: text }}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon size={14} />
        {label}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-52 rounded border border-slate-300 bg-white py-1 shadow-lg">
          {options.map((opt) => (
            <button
              key={opt.key}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-slate-100"
              onClick={() => {
                setOpen(false)
                opt.onClick()
              }}
            >
              <opt.icon size={14} className="text-[#4a6a8a]" />
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function loadDocked(): boolean {
  try {
    const raw = localStorage.getItem(TOOLBAR_DOCKED_KEY)
    return raw === null ? true : raw === 'true'
  } catch {
    return true
  }
}

function loadFloatPos(): FloatPos {
  try {
    const raw = localStorage.getItem(TOOLBAR_POS_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* ignore corrupt/blocked storage */
  }
  return { x: 80, y: 80 }
}

export function RibbonToolbar({
  onImport,
  onFolderDialog
}: {
  onImport: () => void
  onFolderDialog: (mode: FolderDialogMode) => void
}): React.JSX.Element {
  const search = useAccountStore((s) => s.search)
  const setSearch = useAccountStore((s) => s.setSearch)
  const searchField = useAccountStore((s) => s.searchField)
  const setSearchField = useAccountStore((s) => s.setSearchField)
  const runSearch = useAccountStore((s) => s.runSearch)
  const statusFilter = useAccountStore((s) => s.statusFilter)
  const setStatusFilter = useAccountStore((s) => s.setStatusFilter)
  const folders = useAccountStore((s) => s.folders)
  const folderId = useAccountStore((s) => s.folderId)
  const setFolderId = useAccountStore((s) => s.setFolderId)
  const showToast = useAccountStore((s) => s.showToast)
  const refresh = useAccountStore((s) => s.refresh)
  const threadCount = useAccountStore((s) => s.threadCount)
  const setThreadCount = useAccountStore((s) => s.setThreadCount)
  const queueRunning = useAccountStore((s) => s.queueRunning)
  const runSelectedQueue = useAccountStore((s) => s.runSelectedQueue)
  const stopQueueRun = useAccountStore((s) => s.stopQueueRun)
  const selectedIds = useAccountStore((s) => s.selectedIds)
  const scenarios = useAccountStore((s) => s.scenarios)
  const activeScenarioId = useAccountStore((s) => s.activeScenarioId)
  const setActiveScenarioId = useAccountStore((s) => s.setActiveScenarioId)
  const shuffleDisplayOrder = useAccountStore((s) => s.shuffleDisplayOrder)
  const openExportModal = useAccountStore((s) => s.openExportModal)
  const t = useLanguageStore((s) => s.t)

  const [autoPostOpen, setAutoPostOpen] = useState(false)
  const [deletePagePostsOpen, setDeletePagePostsOpen] = useState(false)
  const [autoShareOpen, setAutoShareOpen] = useState(false)
  const [changeInfoOpen, setChangeInfoOpen] = useState(false)
  const [importProxyOpen, setImportProxyOpen] = useState(false)
  const [importUseragentOpen, setImportUseragentOpen] = useState(false)
  const [watchLiveOpen, setWatchLiveOpen] = useState(false)
  const [arrangeMenuOpen, setArrangeMenuOpen] = useState(false)
  const arrangeMenuRef = useRef<HTMLDivElement>(null)

  // Docked (normal document flow) vs floating (position: fixed, draggable by
  // the grip handle) — both persisted so the choice survives a restart.
  const [docked, setDocked] = useState(loadDocked)
  const [floatPos, setFloatPos] = useState<FloatPos>(loadFloatPos)
  const dragState = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(
    null
  )
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(TOOLBAR_DOCKED_KEY, String(docked))
    } catch {
      /* ignore */
    }
  }, [docked])

  const beginDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    dragState.current = { startX: e.clientX, startY: e.clientY, originX: floatPos.x, originY: floatPos.y }
    setIsDragging(true)
    // Grabbing the handle while docked immediately detaches the toolbar into
    // a floating panel at its current on-screen position, so the drag feels
    // continuous rather than needing a separate "undock" step first.
    if (docked) {
      setDocked(false)
    }
  }

  useEffect(() => {
    if (!isDragging) return
    const onMove = (e: MouseEvent): void => {
      const state = dragState.current
      if (!state) return
      const nextX = Math.max(0, state.originX + (e.clientX - state.startX))
      const nextY = Math.max(0, state.originY + (e.clientY - state.startY))
      setFloatPos({ x: nextX, y: nextY })
    }
    const onUp = (): void => {
      dragState.current = null
      setIsDragging(false)
      setFloatPos((pos) => {
        try {
          localStorage.setItem(TOOLBAR_POS_KEY, JSON.stringify(pos))
        } catch {
          /* ignore */
        }
        return pos
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isDragging])

  const dockToolbar = (): void => setDocked(true)

  const closeBrowsers = async (): Promise<void> => {
    showToast('Closing all browsers…')
    const res = await window.api.automation.closeAllBrowsers()
    showToast(`Closed ${res.closed} browser(s)`)
    await refresh()
  }

  // Click-outside closes the Arrange Browsers dropdown, same pattern as any
  // other transient popover in this toolbar.
  useEffect(() => {
    if (!arrangeMenuOpen) return
    const onDocClick = (e: MouseEvent): void => {
      if (arrangeMenuRef.current && !arrangeMenuRef.current.contains(e.target as Node)) {
        setArrangeMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [arrangeMenuOpen])

  const arrangeWindows = async (layout: ArrangeLayout): Promise<void> => {
    setArrangeMenuOpen(false)
    const res = await window.api.automation.arrangeWindows(layout)
    if (res.total === 0) {
      showToast('No open browser windows to arrange')
    } else {
      showToast(`Arranged ${res.arranged}/${res.total} window(s)`)
    }
  }

  const randomize = (): void => {
    const n = selectedIds().length
    shuffleDisplayOrder()
    showToast(n > 0 ? `Shuffled ${n} selected row(s)` : 'Shuffled display order')
  }

  const actionHandlers: Record<string, () => void> = {
    'Auto Post': () => setAutoPostOpen(true),
    'Delete Post in Page': () => setDeletePagePostsOpen(true),
    'Auto Share': () => setAutoShareOpen(true),
    'Watch Live': () => setWatchLiveOpen(true),
    'Change Info': () => setChangeInfoOpen(true),
    'Import Useragent': () => setImportUseragentOpen(true),
    'Import Proxy': () => setImportProxyOpen(true),
    'Export Accounts': openExportModal,
    Randomize: randomize,
    'Close Browsers': () => void closeBrowsers()
  }

  const selectedCount = selectedIds().length

  return (
    <div
      className={
        docked
          ? 'border-b border-slate-300 bg-mc-ribbon'
          : 'fixed z-40 rounded border border-slate-400 bg-mc-ribbon shadow-lg'
      }
      style={docked ? undefined : { left: floatPos.x, top: floatPos.y, width: 'min(1200px, calc(100vw - 32px))' }}
    >
      {/* Grip handle — drag to detach into a floating panel and reposition
          it anywhere on screen; click Dock to snap back into the normal
          layout. Both the floating/docked state and the last floating
          position persist across restarts. */}
      <div
        className={`flex items-center justify-between gap-2 px-2 py-1 text-[11px] text-slate-500 ${
          docked ? 'border-b border-slate-200' : 'cursor-move border-b border-slate-300 bg-slate-100'
        }`}
        onMouseDown={docked ? undefined : beginDrag}
      >
        <div
          className="flex flex-1 cursor-move items-center gap-1.5"
          onMouseDown={beginDrag}
          title="Drag to move this toolbar"
        >
          <GripVertical size={13} className="text-slate-400" />
          <span>{docked ? 'Toolbar (drag to detach)' : 'Toolbar (floating — drag to move)'}</span>
        </div>
        {!docked && (
          <button
            className="win-btn h-[22px] px-2 py-0 text-[11px]"
            onClick={dockToolbar}
            title="Dock this toolbar back into place"
          >
            <PinOff size={11} />
            Dock
          </button>
        )}
      </div>

      {/* ---- Row 1: run controls, threads/scenario/search/folder fieldsets, Import pushed far right ----
          flex-nowrap + overflow-x-auto: below the window's minWidth this
          row would otherwise wrap Import Accounts down into an unwanted 3rd
          row — it now scrolls horizontally within Row 1 instead, keeping
          Import pinned at the far right via ml-auto and staying on exactly
      {/* ---- Row 1: controls + fieldsets + import ----
          overflow-x-auto keeps the ribbon single-line (never wraps into 3+ rows)
          on narrow displays; whitespace-nowrap ensures inputs stay in these
          two rows no matter how narrow the window gets. */}
      <div className="flex flex-nowrap items-center gap-2 overflow-x-auto px-2 py-1.5 scrollbar-none">
        {/* Action group: Start / Run + Stop */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            className="win-btn-start h-[38px] shrink-0 min-w-fit px-3.5"
            onClick={() => void runSelectedQueue()}
            disabled={queueRunning || selectedCount === 0}
            title={
              selectedCount === 0
                ? 'Select accounts in the grid first'
                : `Run Auto-Login on ${selectedCount} selected account(s)`
            }
          >
            <Play size={15} className="fill-white text-white shrink-0" />
            <span className="whitespace-nowrap font-bold">{t('startRun')}</span>
            {selectedCount > 0 && (
              <span className="ml-1.5 rounded-full bg-emerald-800 px-2 py-0.5 text-xs font-bold text-white whitespace-nowrap min-w-[20px] text-center shadow-xs">
                {selectedCount.toLocaleString()}
              </span>
            )}
          </button>
          <button
            className="win-btn-stop h-[38px] shrink-0 min-w-fit px-3"
            onClick={() => void stopQueueRun()}
            disabled={!queueRunning}
          >
            <Square size={13} className="fill-[#c81e1e] text-[#c81e1e] shrink-0" />
            <span className="whitespace-nowrap font-semibold">{t('stop')}</span>
          </button>
        </div>

        {/* Threads fieldset */}
        <fieldset className="win-fieldset flex h-[52px] items-center gap-1.5 shrink-0">
          <legend>{t('threads')}</legend>
          <input
            type="number"
            min={1}
            max={10}
            className="win-input w-14 text-center"
            value={threadCount}
            disabled={queueRunning}
            onChange={(e) => setThreadCount(Number(e.target.value))}
            title="Number of accounts to run concurrently"
          />
        </fieldset>

        {/* Scenario fieldset — chooses the warm-up pipeline Start/Run executes post-login */}
        <fieldset className="win-fieldset flex h-[52px] items-center gap-1.5 shrink-0">
          <legend>{t('scenario')}</legend>
          <select
            className="win-select min-w-[160px]"
            value={activeScenarioId ?? ''}
            disabled={queueRunning}
            onChange={(e) =>
              setActiveScenarioId(e.target.value === '' ? null : Number(e.target.value))
            }
            title="Warm-up scenario to run after a successful login"
          >
            <option value="">No scenario (login only)</option>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.steps.length})
              </option>
            ))}
          </select>
        </fieldset>

        {/* Search fieldset */}
        <fieldset className="win-fieldset flex h-[52px] items-center gap-1.5 min-w-[160px] max-w-[260px] flex-1">
          <legend>{t('search')}</legend>
          <select
            className="win-select shrink-0"
            value={searchField}
            onChange={(e) => setSearchField(e.target.value as SearchField)}
          >
            {SEARCH_FIELDS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <input
            className="win-input w-full min-w-0"
            placeholder="Search keyword..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
          />
          <button className="win-btn shrink-0" onClick={runSearch} title="Search">
            <Search size={14} className="text-[#0067c0]" />
          </button>
        </fieldset>

        {/* Folder management fieldset — firmly pinned to the right edge */}
        <fieldset className="win-fieldset flex h-[52px] items-center gap-1.5 shrink-0 ml-auto">
          <legend>{t('folderManager')}</legend>
          <select
            className="win-select min-w-[170px]"
            value={folderId}
            onChange={(e) => setFolderId(Number(e.target.value))}
          >
            <option value={ALL_FOLDERS}>--- All Folders ---</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} [{f.account_count}]
              </option>
            ))}
          </select>

          <select
            className="win-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as AccountStatus | 'All')}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s === 'All' ? t('allStatuses') : s}
              </option>
            ))}
          </select>

          <button
            className="win-btn-sq"
            title="Add folder"
            onClick={() => onFolderDialog('add')}
          >
            <Plus size={15} className="text-[#1e9e4a]" />
          </button>
          <button
            className="win-btn-sq"
            title="Rename folder"
            onClick={() => onFolderDialog('rename')}
            disabled={folderId === ALL_FOLDERS}
          >
            <Pencil size={13} className="text-[#4a6a8a]" />
          </button>
          <button
            className="win-btn-sq"
            title="Delete folder"
            onClick={() => onFolderDialog('delete')}
            disabled={folderId === ALL_FOLDERS || folderId === 1}
          >
            <Minus size={15} className="text-[#c81e1e]" />
          </button>
          <button
            className="win-btn-sq"
            title="Move selected accounts to another folder"
            onClick={() => onFolderDialog('move')}
          >
            <RefreshCw size={13} className="text-[#4a6a8a]" />
          </button>
        </fieldset>

      </div>

      {/* ---- Row 2: soft pastel action pills ---- */}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-2 py-1.5">
        {/* Import Accounts — moved here from Row 1, styled as the same
            amber/yellow accent pill it always was, just in pill shape to
            match its new row. */}
        <button
          className="action-pill font-semibold"
          style={{ backgroundColor: '#ffe9a8', borderColor: '#e8c15c', color: '#5a4300' }}
          onClick={onImport}
        >
          <Download size={14} />
          {t('importAccounts')}
        </button>
        {/* Interact — Auto Post / Auto Share / Watch Live grouped under one dropdown pill. */}
        <PillDropdown
          icon={BookOpen}
          label="Interact"
          bg="#e8f2fd"
          border="#bcdcf7"
          text="#1a5c96"
          options={[
            { key: 'autoPost', icon: BookOpen, label: t('autoPost'), onClick: () => setAutoPostOpen(true) },
            { key: 'autoShare', icon: Share2, label: t('autoShare'), onClick: () => setAutoShareOpen(true) },
            { key: 'watchLive', icon: Video, label: t('watchLive'), onClick: () => setWatchLiveOpen(true) }
          ]}
        />

        {/* Import — Import UA / Import Proxy grouped under one dropdown pill (Import Accounts stays its own standalone pill above, it's a different action). */}
        <PillDropdown
          icon={Upload}
          label="Import"
          bg="#eef0f4"
          border="#d3d8e2"
          text="#48505e"
          options={[
            { key: 'importUa', icon: Upload, label: t('importUa'), onClick: () => setImportUseragentOpen(true) },
            { key: 'importProxy', icon: Globe, label: t('importProxy'), onClick: () => setImportProxyOpen(true) }
          ]}
        />

        {ACTION_BUTTONS.map(({ icon: Icon, label, bg, border, text }) => {
          let localizedLabel = label
          if (label === 'Change Info') localizedLabel = t('changeInfo')
          else if (label === 'Export') localizedLabel = t('export')
          else if (label === 'Randomize') localizedLabel = t('randomize')

          return (
            <button
              key={label}
              className="action-pill"
              style={{ backgroundColor: bg, borderColor: border, color: text }}
              onClick={actionHandlers[ACTION_KEYS[label] ?? label]}
            >
              <Icon size={14} />
              {localizedLabel}
            </button>
          )
        })}

        {/* Arrange Windows — tiles/splits every currently-open headed
            browser window (windowArranger.ts, CDP-driven). Kept before
            Close Browsers so arranging what's open comes before closing it. */}
        <div className="relative" ref={arrangeMenuRef}>
          <button
            className="action-pill"
            style={{ backgroundColor: '#eef0f4', borderColor: '#d3d8e2', color: '#48505e' }}
            onClick={() => setArrangeMenuOpen((v) => !v)}
          >
            <LayoutGrid size={14} />
            Arrange Windows
            <ChevronDown size={12} />
          </button>
          {arrangeMenuOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 w-44 rounded border border-slate-300 bg-white py-1 shadow-lg">
              {ARRANGE_OPTIONS.map((opt) => (
                <button
                  key={opt.layout}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-slate-100"
                  onClick={() => void arrangeWindows(opt.layout)}
                  title={opt.layout === 'grid5x2' ? `${opt.label} (Recommended)` : opt.label}
                >
                  <span className="whitespace-nowrap">{opt.label}</span>
                  {opt.layout === 'grid5x2' && (
                    <span className="ml-auto shrink-0 text-[10px] font-semibold text-[#1e7d34]">★</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {ACTION_BUTTONS_AFTER_ARRANGE.map(({ icon: Icon, label, bg, border, text }) => (
          <button
            key={label}
            className="action-pill"
            style={{ backgroundColor: bg, borderColor: border, color: text }}
            onClick={actionHandlers[ACTION_KEYS[label] ?? label]}
          >
            <Icon size={14} />
            {label === 'Close Browsers' ? t('closeBrowsers') : label}
          </button>
        ))}
      </div>

      <AutoPostModal open={autoPostOpen} onClose={() => setAutoPostOpen(false)} />
      <DeletePagePostsModal
        open={deletePagePostsOpen}
        onClose={() => setDeletePagePostsOpen(false)}
      />
      <AutoShareModal open={autoShareOpen} onClose={() => setAutoShareOpen(false)} />
      <WatchLiveModal open={watchLiveOpen} onClose={() => setWatchLiveOpen(false)} />
      <ChangeInfoModal open={changeInfoOpen} onClose={() => setChangeInfoOpen(false)} />
      <ImportProxyModal open={importProxyOpen} onClose={() => setImportProxyOpen(false)} />
      <ImportUseragentModal
        open={importUseragentOpen}
        onClose={() => setImportUseragentOpen(false)}
      />
    </div>
  )
}
