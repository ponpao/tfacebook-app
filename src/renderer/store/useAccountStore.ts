// ---------------------------------------------------------------------------
// useAccountStore.ts  — global renderer state for accounts, folders, filters
// and row selection. Thin wrapper over the window.api IPC bridge.
// ---------------------------------------------------------------------------
import { create } from 'zustand'
import type { Account, AccountStatus } from '../../types/account'
import type { Folder } from '../../types/folder'
import { ALL_FOLDERS } from '../../types/folder'
import { DEFAULT_COLUMN_VISIBILITY } from '../components/table/gridColumns'
import type { QueueProgressEvent, QueueSummary } from '../../types/ipc'
import type { Scenario } from '../../types/scenario'

const THREADS_KEY = 'automation.threadCount'
const SCENARIO_KEY = 'automation.activeScenarioId'

// Module-level guard so initQueueListeners() is safe to call from multiple
// mounts (React StrictMode double-invoke, HMR, re-renders) without stacking
// duplicate IPC subscriptions and double-firing every progress event.
let queueListenersCleanup: (() => void) | null = null

function loadThreadCount(): number {
  try {
    const raw = localStorage.getItem(THREADS_KEY)
    const n = raw ? parseInt(raw, 10) : 3
    return Number.isFinite(n) && n >= 1 && n <= 10 ? n : 3
  } catch {
    return 3
  }
}

export type SearchField = 'uid' | 'email' | 'name' | 'proxy'

const COLVIS_KEY = 'grid.columnVisibility'

/** Load persisted column visibility from localStorage, falling back to default. */
function loadColumnVisibility(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLVIS_KEY)
    if (raw) return { ...DEFAULT_COLUMN_VISIBILITY, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_COLUMN_VISIBILITY }
}

function persistColumnVisibility(v: Record<string, boolean>): void {
  try {
    localStorage.setItem(COLVIS_KEY, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

interface AccountState {
  accounts: Account[]
  total: number
  folders: Folder[]
  loading: boolean

  // filters
  search: string
  searchField: SearchField
  statusFilter: AccountStatus | 'All'
  folderId: number // ALL_FOLDERS (-1) => all

  // selection (row id -> selected)
  rowSelection: Record<string, boolean>

  // column visibility (column key -> visible)
  columnVisibility: Record<string, boolean>

  // transient status-bar toast message
  toast: string | null

  // multi-thread queue runner
  threadCount: number
  queueRunning: boolean
  queueProgress: Record<number, QueueProgressEvent> // accountId -> latest event

  // scenario builder / warm-up
  scenarios: Scenario[]
  activeScenarioId: number | null // null => "No scenario" (login only)

  // Export Accounts modal — opened from the ribbon/menu or the row context
  // menu; when opened from a row, the scope defaults to "selected".
  exportModalOpen: boolean

  // Recycle Bin modal
  recycleBinOpen: boolean

  // Edit Account Info modal — opened from the row context menu; carries the
  // account being edited so the modal doesn't need its own fetch round-trip.
  editAccountTarget: Account | null

  // Set Notes (Batch) modal — opened from the row context menu; carries the
  // target account ids (selection at the time it was opened).
  setNotesTargetIds: number[] | null

  // Clean Profile Storage modal — opened from the row context menu; carries
  // the target account ids (selection at the time it was opened).
  cleanProfileTargetIds: number[] | null

  // actions
  showToast: (msg: string, ttlMs?: number) => void
  setThreadCount: (n: number) => void
  setActiveScenarioId: (id: number | null) => void
  refreshScenarios: () => Promise<void>
  openExportModal: () => void
  closeExportModal: () => void
  openRecycleBin: () => void
  closeRecycleBin: () => void
  openEditAccount: (account: Account) => void
  closeEditAccount: () => void
  openSetNotes: (ids: number[]) => void
  closeSetNotes: () => void
  openCleanProfile: (ids: number[]) => void
  closeCleanProfile: () => void
  applyAccountUpdate: (account: Account) => void
  runSelectedQueue: () => Promise<void>
  stopQueueRun: () => Promise<void>
  runSingleLogin: (accountId: number) => Promise<void>
  initQueueListeners: () => () => void
  setSearch: (s: string) => void
  setSearchField: (f: SearchField) => void
  runSearch: () => void
  setStatusFilter: (s: AccountStatus | 'All') => void
  setFolderId: (id: number) => void
  setRowSelection: (v: Record<string, boolean>) => void
  toggleRow: (id: number, checked: boolean) => void
  toggleAll: (checked: boolean) => void
  setColumnVisibility: (v: Record<string, boolean>) => void
  toggleColumn: (key: string) => void
  /** Shuffle display order — the selected rows if any are checked, otherwise the whole grid. */
  shuffleDisplayOrder: () => void

  refresh: () => Promise<void>
  refreshFolders: () => Promise<void>
  updateStatus: (ids: number[], status: string, detail?: string) => Promise<void>
  remove: (ids: number[]) => Promise<void>
  moveToFolder: (ids: number[], targetFolderId: number) => Promise<void>

  selectedIds: () => number[]
}

export const useAccountStore = create<AccountState>((set, get) => ({
  accounts: [],
  total: 0,
  folders: [],
  loading: false,

  search: '',
  searchField: 'uid',
  statusFilter: 'All',
  folderId: ALL_FOLDERS,

  rowSelection: {},
  columnVisibility: loadColumnVisibility(),
  toast: null,

  threadCount: loadThreadCount(),
  queueRunning: false,
  queueProgress: {},

  scenarios: [],
  activeScenarioId: (() => {
    try {
      const raw = localStorage.getItem(SCENARIO_KEY)
      return raw ? Number(raw) : null
    } catch {
      return null
    }
  })(),

  exportModalOpen: false,
  recycleBinOpen: false,
  editAccountTarget: null,
  setNotesTargetIds: null,
  cleanProfileTargetIds: null,

  openExportModal: () => set({ exportModalOpen: true }),
  closeExportModal: () => set({ exportModalOpen: false }),
  openRecycleBin: () => set({ recycleBinOpen: true }),
  closeRecycleBin: () => set({ recycleBinOpen: false }),
  openEditAccount: (account) => set({ editAccountTarget: account }),
  closeEditAccount: () => set({ editAccountTarget: null }),
  openSetNotes: (ids) => set({ setNotesTargetIds: ids }),
  closeSetNotes: () => set({ setNotesTargetIds: null }),
  openCleanProfile: (ids) => set({ cleanProfileTargetIds: ids }),
  closeCleanProfile: () => set({ cleanProfileTargetIds: null }),
  applyAccountUpdate: (account) =>
    set((state) => ({
      accounts: state.accounts.map((a) => (a.id === account.id ? account : a))
    })),

  showToast: (msg, ttlMs = 4000) => {
    set({ toast: msg })
    const current = msg
    setTimeout(() => {
      // Only clear if this toast is still the one showing.
      if (get().toast === current) set({ toast: null })
    }, ttlMs)
  },
  setThreadCount: (n) => {
    const clamped = Math.max(1, Math.min(10, Math.floor(n) || 1))
    try {
      localStorage.setItem(THREADS_KEY, String(clamped))
    } catch {
      /* ignore */
    }
    set({ threadCount: clamped })
  },

  setActiveScenarioId: (id) => {
    try {
      if (id == null) localStorage.removeItem(SCENARIO_KEY)
      else localStorage.setItem(SCENARIO_KEY, String(id))
    } catch {
      /* ignore — localStorage is just the fast synchronous initial-load path; SQLite below is the durable source of truth */
    }
    set({ activeScenarioId: id })
    // Persist to the SQLite-backed app settings too — localStorage under a
    // packaged app's file:// renderer origin has been observed to not
    // reliably survive every restart, which is what caused the Scenario
    // dropdown to silently revert to Default Warm-up. SQLite via
    // settings:getAppSettings/setAppSettings always survives. Read-modify-
    // write against the current settings rather than a partial patch, since
    // setAppSettings replaces the whole stored blob.
    void window.api.settings
      .getAppSettings()
      .then((current) => window.api.settings.setAppSettings({ ...current, lastActiveScenarioId: id }))
      .catch(() => void 0)
  },

  refreshScenarios: async () => {
    const scenarios = await window.api.scenarios.getAll()
    set((state) => {
      // Prefer whatever's already in state (set synchronously from
      // localStorage at store-init, or by a user pick this session) if it's
      // still a valid scenario id.
      if (
        state.activeScenarioId != null &&
        scenarios.some((s) => s.id === state.activeScenarioId)
      ) {
        return { scenarios }
      }
      const fallback = scenarios.find((s) => s.is_default) ?? scenarios[0] ?? null
      return { scenarios, activeScenarioId: fallback ? fallback.id : null }
    })

    // Cross-check against the durable SQLite-backed value in case
    // localStorage came back empty this launch (the actual bug this is
    // fixing) — only overrides if SQLite has an explicit last-picked value
    // that differs from what's currently showing, so a genuine in-session
    // user pick is never clobbered by a stale read racing in late.
    try {
      const appSettings = await window.api.settings.getAppSettings()
      if (appSettings.lastActiveScenarioId === undefined) return
      const stillCurrent = get().activeScenarioId
      const persisted = appSettings.lastActiveScenarioId
      const persistedIsValid = persisted == null || scenarios.some((s) => s.id === persisted)
      if (persistedIsValid && persisted !== stillCurrent) {
        set({ activeScenarioId: persisted })
        try {
          if (persisted == null) localStorage.removeItem(SCENARIO_KEY)
          else localStorage.setItem(SCENARIO_KEY, String(persisted))
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* settings IPC failed — keep whatever localStorage/default resolved to above */
    }
  },

  runSelectedQueue: async () => {
    const ids = get().selectedIds()
    if (ids.length === 0) {
      get().showToast('Select at least one account to run.')
      return
    }
    if (get().queueRunning) {
      get().showToast('A queue is already running.')
      return
    }
    set({ queueRunning: true, queueProgress: {} })
    const scenarioId = get().activeScenarioId ?? undefined
    const scenarioName = scenarioId
      ? (get().scenarios.find((s) => s.id === scenarioId)?.name ?? 'scenario')
      : null
    get().showToast(
      `Running ${ids.length} account(s) with ${get().threadCount} thread(s)` +
        (scenarioName ? ` + "${scenarioName}" warm-up…` : '…')
    )
    try {
      const summary = await window.api.automation.runQueue(ids, get().threadCount, scenarioId)
      const { total, succeeded, failed, cancelled } = summary
      get().showToast(
        cancelled
          ? `Stopped. ${succeeded}/${total} succeeded before cancellation.`
          : `Done: ${succeeded}/${total} succeeded, ${failed} failed.`,
        6000
      )
    } finally {
      set({ queueRunning: false })
      await get().refresh()
    }
  },

  stopQueueRun: async () => {
    await window.api.automation.stopQueue()
    get().showToast('Stopping queue and closing browsers…')
  },

  runSingleLogin: async (accountId) => {
    get().showToast('Running Auto Login…')
    const res = await window.api.automation.autoLogin(accountId)
    get().showToast(`Auto Login: ${res.status} — ${res.detail}`, 6000)
    await get().refresh()
  },

  initQueueListeners: () => {
    // Already subscribed (e.g. StrictMode's mount→cleanup→mount, or a second
    // component instance) — tear down the old subscription first so we never
    // end up with two listeners double-firing every event.
    queueListenersCleanup?.()

    const offProgress = window.api.automation.onProgress((event: QueueProgressEvent) => {
      set((state) => {
        // Patch the row's live_status (and status, on terminal stages) in place
        // for instant grid feedback without a full refresh() round-trip.
        const terminal = ['Live', 'Checkpoint', 'Die', 'Changed Pass'].includes(event.stage)
        const accounts = state.accounts.map((a) =>
          a.id === event.accountId
            ? {
                ...a,
                live_status: event.detail ? `${event.stage} — ${event.detail}` : event.stage,
                ...(terminal ? { status: event.stage, status_detail: event.detail ?? event.stage } : {})
              }
            : a
        )
        return {
          accounts,
          queueProgress: { ...state.queueProgress, [event.accountId]: event }
        }
      })
    })
    const offDone = window.api.automation.onQueueDone((_summary: QueueSummary) => {
      set({ queueRunning: false })
    })

    const cleanup = (): void => {
      offProgress()
      offDone()
      if (queueListenersCleanup === cleanup) queueListenersCleanup = null
    }
    queueListenersCleanup = cleanup
    return cleanup
  },
  setSearch: (s) => set({ search: s }),
  setSearchField: (f) => set({ searchField: f }),
  runSearch: () => void get().refresh(),
  setStatusFilter: (s) => {
    set({ statusFilter: s })
    void get().refresh()
  },
  setFolderId: (id) => {
    set({ folderId: id, rowSelection: {} })
    void get().refresh()
  },
  setRowSelection: (v) => set({ rowSelection: v }),
  toggleRow: (id, checked) =>
    set((state) => ({ rowSelection: { ...state.rowSelection, [id]: checked } })),
  toggleAll: (checked) =>
    set((state) => {
      if (!checked) return { rowSelection: {} }
      const next: Record<string, boolean> = {}
      for (const a of state.accounts) next[a.id] = true
      return { rowSelection: next }
    }),
  shuffleDisplayOrder: () =>
    set((state) => {
      const selected = new Set(
        Object.keys(state.rowSelection)
          .filter((k) => state.rowSelection[k])
          .map(Number)
      )
      const shuffle = <T,>(arr: T[]): T[] => {
        const copy = [...arr]
        for (let i = copy.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[copy[i], copy[j]] = [copy[j], copy[i]]
        }
        return copy
      }

      if (selected.size === 0) {
        // No selection — shuffle the whole grid.
        return { accounts: shuffle(state.accounts) }
      }

      // Shuffle only the selected rows in place, keeping unselected rows at
      // their original positions.
      const positions: number[] = []
      const selectedAccounts: typeof state.accounts = []
      state.accounts.forEach((a, i) => {
        if (selected.has(a.id)) {
          positions.push(i)
          selectedAccounts.push(a)
        }
      })
      const shuffled = shuffle(selectedAccounts)
      const next = [...state.accounts]
      positions.forEach((pos, i) => {
        next[pos] = shuffled[i]
      })
      return { accounts: next }
    }),
  setColumnVisibility: (v) => {
    persistColumnVisibility(v)
    set({ columnVisibility: v })
  },
  toggleColumn: (key) =>
    set((state) => {
      const next = { ...state.columnVisibility, [key]: !state.columnVisibility[key] }
      persistColumnVisibility(next)
      return { columnVisibility: next }
    }),

  refresh: async () => {
    set({ loading: true })
    try {
      const { search, searchField, statusFilter, folderId } = get()
      const res = await window.api.accounts.list({
        search,
        searchField,
        status: statusFilter,
        folderId,
        limit: 10000
      })
      set({ accounts: res.rows, total: res.total })
    } finally {
      set({ loading: false })
    }
  },

  refreshFolders: async () => {
    const folders = await window.api.folders.getAll()
    set({ folders })
  },

  updateStatus: async (ids, status, detail) => {
    await window.api.accounts.updateStatus(ids, status, detail)
    await get().refresh()
    await get().refreshFolders()
  },

  remove: async (ids) => {
    await window.api.accounts.remove(ids)
    set({ rowSelection: {} })
    await get().refresh()
    await get().refreshFolders()
  },

  moveToFolder: async (ids, targetFolderId) => {
    await window.api.accounts.moveToFolder(ids, targetFolderId)
    set({ rowSelection: {} })
    await get().refresh()
    await get().refreshFolders()
  },

  selectedIds: () => {
    const sel = get().rowSelection
    return Object.keys(sel)
      .filter((k) => sel[k])
      .map(Number)
  }
}))
