// ---------------------------------------------------------------------------
// channels.ts  — single source of truth for IPC channel names.
// Shared by main (handlers) and preload (invokers) to avoid typos.
// ---------------------------------------------------------------------------
export const IPC = {
  system: {
    clipboardWriteText: 'clipboard:writeText',
    getAppVersion: 'system:getAppVersion',
    onNetworkStatus: 'system:onNetworkStatus',
    scheduleShutdown: 'system:scheduleShutdown',
    cancelShutdown: 'system:cancelShutdown'
  },
  accounts: {
    list: 'accounts:list',
    stats: 'accounts:stats',
    get: 'accounts:get',
    update: 'accounts:update',
    updateStatus: 'accounts:updateStatus',
    remove: 'accounts:remove',
    moveToFolder: 'accounts:moveToFolder',
    bulkAssign: 'accounts:bulkAssign',
    bulkSetField: 'accounts:bulkSetField',
    assignProxies: 'accounts:assignProxies',
    assignUseragents: 'accounts:assignUseragents',
    softDelete: 'accounts:softDelete',
    getDeleted: 'accounts:getDeleted',
    restore: 'accounts:restore',
    permanentDelete: 'accounts:permanentDelete',
    emptyRecycleBin: 'accounts:emptyRecycleBin',
    exportAccounts: 'accounts:exportAccounts'
  },
  folders: {
    getAll: 'folders:getAll',
    create: 'folders:create',
    rename: 'folders:rename',
    delete: 'folders:delete'
  },
  scenarios: {
    getAll: 'scenarios:getAll',
    create: 'scenarios:create',
    update: 'scenarios:update',
    delete: 'scenarios:delete'
  },
  parser: {
    preview: 'parser:preview',
    import: 'parser:import'
  },
  proxies: {
    list: 'proxies:list',
    add: 'proxies:add',
    remove: 'proxies:remove',
    count: 'proxies:count'
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
    all: 'settings:all',
    getAppSettings: 'settings:getAppSettings',
    setAppSettings: 'settings:setAppSettings'
  },
  window: {
    minimize: 'window:minimize',
    maximize: 'window:maximize',
    close: 'window:close',
    isMaximized: 'window:isMaximized'
  },
  automation: {
    openProfile: 'automation:openProfile',
    checkLive: 'automation:checkLive',
    getMailOtp: 'automation:getMailOtp',
    autoLogin: 'automation:autoLogin',
    closeAllBrowsers: 'automation:closeAllBrowsers',
    runQueue: 'automation:runQueue',
    stopQueue: 'automation:stopQueue',
    isQueueRunning: 'automation:isQueueRunning',
    onProgress: 'automation:onProgress',
    onQueueDone: 'automation:onQueueDone',
    runAutoPost: 'automation:runAutoPost',
    runAutoShare: 'automation:runAutoShare',
    runChangeInfo: 'automation:runChangeInfo',
    runWatchLive: 'automation:runWatchLive',
    unlock282: 'automation:unlock282'
  },
  utils: {
    parseSpinSyntax: 'utils:parseSpinSyntax',
    selectImages: 'utils:selectImages',
    selectFolder: 'utils:selectFolder',
    saveTextFile: 'utils:saveTextFile',
    selectChromiumExecutable: 'utils:selectChromiumExecutable',
    selectProfileDirectory: 'utils:selectProfileDirectory'
  },
  tools: {
    checkUidsLive: 'tools:checkUidsLive',
    checkProxiesHealth: 'tools:checkProxiesHealth',
    findDuplicateAccounts: 'tools:findDuplicateAccounts',
    removeDuplicateAccounts: 'tools:removeDuplicateAccounts',
    onUidCheckProgress: 'tools:uidCheckProgress',
    onProxyCheckProgress: 'tools:proxyCheckProgress'
  },
  updater: {
    check: 'updater:check',
    startDownload: 'updater:startDownload',
    quitAndInstall: 'updater:quitAndInstall',
    onUpdateAvailable: 'updater:onUpdateAvailable',
    onUpdateNotAvailable: 'updater:onUpdateNotAvailable',
    onDownloadProgress: 'updater:onDownloadProgress',
    onUpdateDownloaded: 'updater:onUpdateDownloaded',
    onError: 'updater:onError'
  },
  license: {
    getStatus: 'license:getStatus',
    activate: 'license:activate',
    deactivate: 'license:deactivate'
  },
  profiles: {
    clean: 'profiles:clean'
  },
  backup: {
    export: 'backup:export',
    import: 'backup:import',
    onImported: 'backup:onImported'
  },
  cloudSync: {
    getMachineId: 'cloudSync:getMachineId',
    push: 'cloudSync:push',
    pull: 'cloudSync:pull',
    onPulled: 'cloudSync:onPulled'
  }
} as const
