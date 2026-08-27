// ---------------------------------------------------------------------------
// Preload — exposes a minimal, typed, safe API on window.api via contextBridge.
// No Node primitives leak to the renderer; everything goes through ipcRenderer
// .invoke with the channel names shared from the main process.
// ---------------------------------------------------------------------------
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../main/ipc/channels'
import type { AppApi, QueueProgressEvent, QueueSummary } from '../types/ipc'
import type { AccountQuery, AccountUpdate } from '../types/account'
import type { ImportFormat } from '../types/parser'
import type { NewProxy } from '../types/proxy'
import type { NewScenario, ScenarioStep } from '../types/scenario'
import type {
  AutoPostRequest,
  AutoShareRequest,
  ChangeInfoRequest,
  WatchLiveRequest,
  AssignProxyRequest,
  AssignUseragentRequest
} from '../types/marketing'
import type { ExportAccountsRequest } from '../types/export'
import type { AppSettings } from '../types/settings'
import type { CleanMode } from '../types/profileOptimizer'

const api: AppApi = {
  system: {
    clipboardWriteText: (text: string) => ipcRenderer.invoke(IPC.system.clipboardWriteText, text)
  },
  accounts: {
    list: (query: AccountQuery) => ipcRenderer.invoke(IPC.accounts.list, query),
    stats: () => ipcRenderer.invoke(IPC.accounts.stats),
    get: (id) => ipcRenderer.invoke(IPC.accounts.get, id),
    update: (id, patch: AccountUpdate) =>
      ipcRenderer.invoke(IPC.accounts.update, id, patch),
    updateStatus: (ids, status, detail) =>
      ipcRenderer.invoke(IPC.accounts.updateStatus, ids, status, detail),
    remove: (ids) => ipcRenderer.invoke(IPC.accounts.remove, ids),
    moveToFolder: (ids, targetFolderId) =>
      ipcRenderer.invoke(IPC.accounts.moveToFolder, ids, targetFolderId),
    bulkAssign: (column, assignments) =>
      ipcRenderer.invoke(IPC.accounts.bulkAssign, column, assignments),
    bulkSetField: (column, ids, value) =>
      ipcRenderer.invoke(IPC.accounts.bulkSetField, column, ids, value),
    assignProxies: (req: AssignProxyRequest) =>
      ipcRenderer.invoke(IPC.accounts.assignProxies, req),
    assignUseragents: (req: AssignUseragentRequest) =>
      ipcRenderer.invoke(IPC.accounts.assignUseragents, req),
    softDelete: (ids) => ipcRenderer.invoke(IPC.accounts.softDelete, ids),
    getDeleted: () => ipcRenderer.invoke(IPC.accounts.getDeleted),
    restore: (ids) => ipcRenderer.invoke(IPC.accounts.restore, ids),
    permanentDelete: (ids) => ipcRenderer.invoke(IPC.accounts.permanentDelete, ids),
    emptyRecycleBin: () => ipcRenderer.invoke(IPC.accounts.emptyRecycleBin),
    exportAccounts: (req: ExportAccountsRequest) =>
      ipcRenderer.invoke(IPC.accounts.exportAccounts, req)
  },
  folders: {
    getAll: () => ipcRenderer.invoke(IPC.folders.getAll),
    create: (name) => ipcRenderer.invoke(IPC.folders.create, name),
    rename: (id, newName) => ipcRenderer.invoke(IPC.folders.rename, id, newName),
    delete: (id, fallbackFolderId) =>
      ipcRenderer.invoke(IPC.folders.delete, id, fallbackFolderId)
  },
  scenarios: {
    getAll: () => ipcRenderer.invoke(IPC.scenarios.getAll),
    create: (input: NewScenario) => ipcRenderer.invoke(IPC.scenarios.create, input),
    update: (id, patch: { name?: string; steps?: ScenarioStep[] }) =>
      ipcRenderer.invoke(IPC.scenarios.update, id, patch),
    delete: (id) => ipcRenderer.invoke(IPC.scenarios.delete, id)
  },
  parser: {
    preview: (text, format: ImportFormat, limit) =>
      ipcRenderer.invoke(IPC.parser.preview, text, format, limit),
    import: (text, format: ImportFormat, folderId?: number) =>
      ipcRenderer.invoke(IPC.parser.import, text, format, folderId)
  },
  proxies: {
    list: () => ipcRenderer.invoke(IPC.proxies.list),
    add: (list: NewProxy[]) => ipcRenderer.invoke(IPC.proxies.add, list),
    remove: (ids) => ipcRenderer.invoke(IPC.proxies.remove, ids),
    count: () => ipcRenderer.invoke(IPC.proxies.count)
  },
  settings: {
    get: (key) => ipcRenderer.invoke(IPC.settings.get, key),
    set: (key, value) => ipcRenderer.invoke(IPC.settings.set, key, value),
    all: () => ipcRenderer.invoke(IPC.settings.all),
    getAppSettings: () => ipcRenderer.invoke(IPC.settings.getAppSettings),
    setAppSettings: (settings: AppSettings) =>
      ipcRenderer.invoke(IPC.settings.setAppSettings, settings)
  },
  window: {
    minimize: () => ipcRenderer.invoke(IPC.window.minimize),
    maximize: () => ipcRenderer.invoke(IPC.window.maximize),
    close: () => ipcRenderer.invoke(IPC.window.close),
    isMaximized: () => ipcRenderer.invoke(IPC.window.isMaximized)
  },
  automation: {
    openProfile: (accountId, slotIndex) =>
      ipcRenderer.invoke(IPC.automation.openProfile, accountId, slotIndex),
    checkLive: (accountId) => ipcRenderer.invoke(IPC.automation.checkLive, accountId),
    getMailOtp: (accountId) => ipcRenderer.invoke(IPC.automation.getMailOtp, accountId),
    autoLogin: (accountId) => ipcRenderer.invoke(IPC.automation.autoLogin, accountId),
    closeAllBrowsers: () => ipcRenderer.invoke(IPC.automation.closeAllBrowsers),
    runQueue: (accountIds, concurrency, scenarioId) =>
      ipcRenderer.invoke(IPC.automation.runQueue, accountIds, concurrency, scenarioId),
    stopQueue: () => ipcRenderer.invoke(IPC.automation.stopQueue),
    isQueueRunning: () => ipcRenderer.invoke(IPC.automation.isQueueRunning),
    onProgress: (cb: (event: QueueProgressEvent) => void) => {
      const listener = (_e: unknown, payload: QueueProgressEvent): void => cb(payload)
      ipcRenderer.on(IPC.automation.onProgress, listener)
      return () => ipcRenderer.removeListener(IPC.automation.onProgress, listener)
    },
    onQueueDone: (cb: (summary: QueueSummary) => void) => {
      const listener = (_e: unknown, payload: QueueSummary): void => cb(payload)
      ipcRenderer.on(IPC.automation.onQueueDone, listener)
      return () => ipcRenderer.removeListener(IPC.automation.onQueueDone, listener)
    },
    runAutoPost: (req: AutoPostRequest) => ipcRenderer.invoke(IPC.automation.runAutoPost, req),
    runAutoShare: (req: AutoShareRequest) =>
      ipcRenderer.invoke(IPC.automation.runAutoShare, req),
    runChangeInfo: (req: ChangeInfoRequest) =>
      ipcRenderer.invoke(IPC.automation.runChangeInfo, req),
    runWatchLive: (req: WatchLiveRequest) =>
      ipcRenderer.invoke(IPC.automation.runWatchLive, req),
    unlock282: (accountIds: number[]) => ipcRenderer.invoke(IPC.automation.unlock282, accountIds)
  },
  utils: {
    parseSpinSyntax: (text: string) => ipcRenderer.invoke(IPC.utils.parseSpinSyntax, text),
    selectImages: () => ipcRenderer.invoke(IPC.utils.selectImages),
    selectFolder: () => ipcRenderer.invoke(IPC.utils.selectFolder),
    saveTextFile: (content, defaultName, kind) =>
      ipcRenderer.invoke(IPC.utils.saveTextFile, content, defaultName, kind),
    selectChromiumExecutable: () => ipcRenderer.invoke(IPC.utils.selectChromiumExecutable),
    selectProfileDirectory: () => ipcRenderer.invoke(IPC.utils.selectProfileDirectory)
  },
  tools: {
    checkUidsLive: (accountIds: number[]) =>
      ipcRenderer.invoke(IPC.tools.checkUidsLive, accountIds),
    checkProxiesHealth: (proxies: string[]) =>
      ipcRenderer.invoke(IPC.tools.checkProxiesHealth, proxies),
    findDuplicateAccounts: () => ipcRenderer.invoke(IPC.tools.findDuplicateAccounts),
    removeDuplicateAccounts: () => ipcRenderer.invoke(IPC.tools.removeDuplicateAccounts),
    onUidCheckProgress: (cb) => {
      const listener = (_e: unknown, payload: unknown): void =>
        cb(payload as Parameters<typeof cb>[0])
      ipcRenderer.on(IPC.tools.onUidCheckProgress, listener)
      return () => ipcRenderer.removeListener(IPC.tools.onUidCheckProgress, listener)
    },
    onProxyCheckProgress: (cb) => {
      const listener = (_e: unknown, payload: unknown): void =>
        cb(payload as Parameters<typeof cb>[0])
      ipcRenderer.on(IPC.tools.onProxyCheckProgress, listener)
      return () => ipcRenderer.removeListener(IPC.tools.onProxyCheckProgress, listener)
    }
  },
  updater: {
    check: () => ipcRenderer.invoke(IPC.updater.check),
    startDownload: () => ipcRenderer.invoke(IPC.updater.startDownload),
    quitAndInstall: () => ipcRenderer.invoke(IPC.updater.quitAndInstall),
    onUpdateAvailable: (cb) => {
      const listener = (_e: unknown, payload: unknown): void =>
        cb(payload as Parameters<typeof cb>[0])
      ipcRenderer.on(IPC.updater.onUpdateAvailable, listener)
      return () => ipcRenderer.removeListener(IPC.updater.onUpdateAvailable, listener)
    },
    onUpdateNotAvailable: (cb) => {
      const listener = (_e: unknown, payload: unknown): void =>
        cb(payload as Parameters<typeof cb>[0])
      ipcRenderer.on(IPC.updater.onUpdateNotAvailable, listener)
      return () => ipcRenderer.removeListener(IPC.updater.onUpdateNotAvailable, listener)
    },
    onDownloadProgress: (cb) => {
      const listener = (_e: unknown, payload: unknown): void =>
        cb(payload as Parameters<typeof cb>[0])
      ipcRenderer.on(IPC.updater.onDownloadProgress, listener)
      return () => ipcRenderer.removeListener(IPC.updater.onDownloadProgress, listener)
    },
    onUpdateDownloaded: (cb) => {
      const listener = (_e: unknown, payload: unknown): void =>
        cb(payload as Parameters<typeof cb>[0])
      ipcRenderer.on(IPC.updater.onUpdateDownloaded, listener)
      return () => ipcRenderer.removeListener(IPC.updater.onUpdateDownloaded, listener)
    },
    onError: (cb) => {
      const listener = (_e: unknown, payload: unknown): void =>
        cb(payload as Parameters<typeof cb>[0])
      ipcRenderer.on(IPC.updater.onError, listener)
      return () => ipcRenderer.removeListener(IPC.updater.onError, listener)
    }
  },
  license: {
    getStatus: () => ipcRenderer.invoke(IPC.license.getStatus),
    activate: (licenseKey: string) => ipcRenderer.invoke(IPC.license.activate, licenseKey),
    deactivate: () => ipcRenderer.invoke(IPC.license.deactivate)
  },
  profiles: {
    clean: (accountIds: number[], mode: CleanMode) =>
      ipcRenderer.invoke(IPC.profiles.clean, accountIds, mode)
  },
  backup: {
    export: (accountIds: number[]) => ipcRenderer.invoke(IPC.backup.export, accountIds),
    import: () => ipcRenderer.invoke(IPC.backup.import),
    onImported: (cb) => {
      const listener = (_e: unknown, payload: unknown): void => cb(payload as Parameters<typeof cb>[0])
      ipcRenderer.on(IPC.backup.onImported, listener)
      return () => ipcRenderer.removeListener(IPC.backup.onImported, listener)
    }
  },
  cloudSync: {
    getMachineId: () => ipcRenderer.invoke(IPC.cloudSync.getMachineId),
    push: (targetMachineId: string, accountIds: number[]) =>
      ipcRenderer.invoke(IPC.cloudSync.push, targetMachineId, accountIds),
    pull: (machineId: string) => ipcRenderer.invoke(IPC.cloudSync.pull, machineId),
    onPulled: (cb) => {
      const listener = (_e: unknown, payload: unknown): void => cb(payload as Parameters<typeof cb>[0])
      ipcRenderer.on(IPC.cloudSync.onPulled, listener)
      return () => ipcRenderer.removeListener(IPC.cloudSync.onPulled, listener)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore — fallback for non-isolated contexts (dev only)
  window.api = api
}
