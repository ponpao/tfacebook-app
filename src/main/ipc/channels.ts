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
    cancelShutdown: 'system:cancelShutdown',
    checkFont: 'system:checkFont',
    installFont: 'system:installFont'
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
    isMaximized: 'window:isMaximized',
    openBrowserWindowsPanel: 'window:openBrowserWindowsPanel'
  },
  automation: {
    openProfile: 'automation:openProfile',
    checkLive: 'automation:checkLive',
    getMailOtp: 'automation:getMailOtp',
    autoLogin: 'automation:autoLogin',
    closeAllBrowsers: 'automation:closeAllBrowsers',
    arrangeWindows: 'automation:arrangeWindows',
    listWindows: 'automation:listWindows',
    focusWindow: 'automation:focusWindow',
    closeWindow: 'automation:closeWindow',
    reloadWindow: 'automation:reloadWindow',
    goBackWindow: 'automation:goBackWindow',
    goHomeWindow: 'automation:goHomeWindow',
    screenshotWindows: 'automation:screenshotWindows',
    startScreencast: 'automation:startScreencast',
    stopScreencast: 'automation:stopScreencast',
    dispatchTap: 'automation:dispatchTap',
    dispatchScroll: 'automation:dispatchScroll',
    dispatchKey: 'automation:dispatchKey',
    onScreencastFrame: 'automation:onScreencastFrame',
    runQueue: 'automation:runQueue',
    stopQueue: 'automation:stopQueue',
    isQueueRunning: 'automation:isQueueRunning',
    onProgress: 'automation:onProgress',
    onAccountUpdated: 'automation:onAccountUpdated',
    onQueueDone: 'automation:onQueueDone',
    runAutoPost: 'automation:runAutoPost',
    runAutoShare: 'automation:runAutoShare',
    runChangeInfo: 'automation:runChangeInfo',
    runWatchLive: 'automation:runWatchLive',
    unlock282: 'automation:unlock282',
    loginWithCookieBatch: 'automation:loginWithCookieBatch',
    onCookieLoginProgress: 'automation:onCookieLoginProgress',
    addFriendsByUidList: 'automation:addFriendsByUidList',
    addSuggestedFriends: 'automation:addSuggestedFriends',
    unfriendAll: 'automation:unfriendAll',
    joinGroupsByIdList: 'automation:joinGroupsByIdList',
    joinSuggestedGroups: 'automation:joinSuggestedGroups',
    leaveGroups: 'automation:leaveGroups',
    onFriendsGroupsItemProgress: 'automation:onFriendsGroupsItemProgress'
  },
  utils: {
    parseSpinSyntax: 'utils:parseSpinSyntax',
    selectImages: 'utils:selectImages',
    selectMedia: 'utils:selectMedia',
    selectFolder: 'utils:selectFolder',
    saveTextFile: 'utils:saveTextFile',
    selectChromiumExecutable: 'utils:selectChromiumExecutable',
    selectProfileDirectory: 'utils:selectProfileDirectory',
    selectAvatarDirectory: 'utils:selectAvatarDirectory'
  },
  tools: {
    checkUidsLive: 'tools:checkUidsLive',
    checkProxiesHealth: 'tools:checkProxiesHealth',
    findDuplicateAccounts: 'tools:findDuplicateAccounts',
    removeDuplicateAccounts: 'tools:removeDuplicateAccounts',
    onUidCheckProgress: 'tools:uidCheckProgress',
    onProxyCheckProgress: 'tools:proxyCheckProgress'
  },
  pages: {
    getManagedPages: 'pages:getManagedPages',
    batchScanPages: 'pages:batchScanPages',
    clearPageData: 'pages:clearPageData',
    fetchPosts: 'pages:fetchPosts',
    deletePosts: 'pages:deletePosts',
    stopOperation: 'pages:stopOperation',
    onFetchProgress: 'pages:onFetchProgress',
    onDeleteProgress: 'pages:onDeleteProgress',
    onBatchScanProgress: 'pages:onBatchScanProgress',
    extractPagesV2: 'pages:extractPagesV2',
    stopExtractV2: 'pages:stopExtractV2',
    onExtractV2Progress: 'pages:onExtractV2Progress',
    fetchPostsV2: 'pages:fetchPostsV2',
    deletePostsV2: 'pages:deletePostsV2',
    stopDeleteV2: 'pages:stopDeleteV2',
    onFetchV2Progress: 'pages:onFetchV2Progress',
    onDeleteV2Progress: 'pages:onDeleteV2Progress'
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
  avatars: {
    downloadBatch: 'avatars:download-batch',
    getLocalPath: 'avatars:get-local-path',
    onProgress: 'avatars:onProgress'
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
