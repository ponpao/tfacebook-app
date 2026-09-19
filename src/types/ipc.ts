// ---------------------------------------------------------------------------
// IPC contract  — the shape of the API exposed on window.api by the preload.
// Keeping this in one place lets both the preload and the renderer stay typed.
// ---------------------------------------------------------------------------
import type {
  Account,
  AccountListResult,
  AccountQuery,
  AccountStats,
  AccountUpdate,
  NewAccount
} from './account'
import type { Folder } from './folder'
import type { ImportFormat, ParseResult, ImportResult } from './parser'
import type { NewProxy, Proxy } from './proxy'
import type { Scenario, NewScenario, ScenarioStep } from './scenario'
import type {
  AutoPostRequest,
  AutoShareRequest,
  ChangeInfoRequest,
  WatchLiveRequest,
  AssignProxyRequest,
  AssignUseragentRequest,
  AssignResult,
  BatchSummary as MarketingBatchSummary,
  AddFriendsByUidListRequest,
  AddSuggestedFriendsRequest,
  UnfriendAllRequest,
  JoinGroupsByIdListRequest,
  JoinSuggestedGroupsRequest,
  LeaveGroupsRequest
} from './marketing'
import type { ExportAccountsRequest, ExportPreviewResult } from './export'
import type { AppSettings } from './settings'
import type { UidCheckResult, ProxyHealthResult, DuplicateAccountSummary } from './tools'
import type { LicenseStatus, ActivateLicenseResult } from './license'
import type { CleanMode, CleanSummary } from './profileOptimizer'
import type { BackupExportResult, BackupImportResult } from './backup'
import type { CloudPushResult, CloudPullResult } from './cloudSync'

export interface AccountsApi {
  list(query: AccountQuery): Promise<AccountListResult>
  stats(): Promise<AccountStats>
  get(id: number): Promise<Account | null>
  update(id: number, patch: AccountUpdate): Promise<Account | null>
  updateStatus(ids: number[], status: string, detail?: string): Promise<number>
  remove(ids: number[]): Promise<number>
  moveToFolder(ids: number[], targetFolderId: number): Promise<number>
  bulkAssign(
    column: 'proxy' | 'user_agent' | 'target_url',
    assignments: { id: number; value: string }[]
  ): Promise<number>
  bulkSetField(column: 'notes' | 'live_status' | 'proxy' | 'target_url', ids: number[], value: string): Promise<number>
  assignProxies(req: AssignProxyRequest): Promise<AssignResult>
  assignUseragents(req: AssignUseragentRequest): Promise<AssignResult>
  softDelete(ids: number[]): Promise<number>
  getDeleted(): Promise<Account[]>
  restore(ids: number[]): Promise<number>
  permanentDelete(ids: number[]): Promise<{ removed: number }>
  emptyRecycleBin(): Promise<{ removed: number }>
  exportAccounts(req: ExportAccountsRequest): Promise<ExportPreviewResult>
}

export interface FoldersApi {
  getAll(): Promise<Folder[]>
  create(name: string): Promise<Folder>
  rename(id: number, newName: string): Promise<boolean>
  delete(id: number, fallbackFolderId?: number): Promise<boolean>
}

export interface ScenariosApi {
  getAll(): Promise<Scenario[]>
  create(input: NewScenario): Promise<Scenario>
  update(id: number, patch: Partial<NewScenario>): Promise<Scenario | null>
  delete(id: number): Promise<boolean>
}

export interface ParserApi {
  /** Dry-run parse used to power the import preview. */
  preview(text: string, format: ImportFormat, limit?: number): Promise<ParseResult>
  /** Parse + persist. */
  import(text: string, format: ImportFormat, folderId?: number): Promise<ImportResult>
}

export interface ProxiesApi {
  list(): Promise<Proxy[]>
  add(proxies: NewProxy[]): Promise<number>
  remove(ids: number[]): Promise<number>
  count(): Promise<number>
}

export interface SettingsApi {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  all(): Promise<Record<string, string>>
  getAppSettings(): Promise<AppSettings>
  setAppSettings(settings: AppSettings): Promise<void>
}

export interface WindowApi {
  minimize(): Promise<void>
  maximize(): Promise<boolean>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  /** Opens the Browser Windows panel as a separate OS window (its own taskbar entry), or focuses it if already open. */
  openBrowserWindowsPanel(): Promise<void>
}

export interface OpenProfileResult {
  ok: boolean
  detail: string
}
export interface LiveDieResult {
  accountId?: number
  uid?: string | null
  status: 'Live' | 'Checkpoint' | 'Die' | 'Changed Pass' | 'Unknown'
  detail: string
}
export type OtpErrorCode =
  | 'AUTH_FAILED'
  | 'TIMEOUT'
  | 'CONNECTION'
  | 'NO_CODE'
  | 'EMPTY'
  | 'INPUT'

export interface MailOtpResult {
  success: boolean
  code?: string
  subject?: string
  from?: string
  date?: string
  /** Folder the code was found in (INBOX / Spam / …). */
  folder?: string
  error?: string
  errorCode?: OtpErrorCode
}
export interface AutoLoginResult {
  success: boolean
  status: LiveDieResult['status']
  detail: string
  cookie?: string
  token?: string
}

export type ProgressStage =
  | 'Queued'
  | 'Opening Chrome...'
  | 'Checking session...'
  | 'Logging in...'
  | 'Entering 2FA...'
  | 'Fetching Mail OTP...'
  | 'Verifying...'
  | 'Warm-up'
  | 'Live'
  | 'Checkpoint'
  | 'Die'
  | 'Changed Pass'
  | 'Unknown'
  | 'Cancelled'
  | 'Error'

export interface QueueProgressEvent {
  accountId: number
  uid: string | null
  /** Login-queue runs use ProgressStage; marketing batches use free-text labels. */
  stage: ProgressStage | string
  detail?: string
  index: number
  total: number
}

export interface QueueSummary {
  total: number
  succeeded: number
  failed: number
  cancelled: boolean
}

/**
 * Window arrangement layouts for the "Arrange Browsers" toolbar action —
 * see windowArranger.ts (main process) for the actual bounds math.
 *   grid8x3 / grid7x3 / grid6x2 / grid5x2 / grid4x2 — tile every open headed
 *     window across the work area in an 8x3 (24/screen, Browser View default),
 *     7x3, 6x2 (12/screen, App View default), 5x2 (10/screen), or 4x2
 *     (8/screen) grid; windows beyond capacity wrap back onto slot 0, 1, 2…
 *   leftHalf / rightHalf — same tiling, confined to one half of the screen
 *     (split view), e.g. to leave the other half for another app.
 *   maximized — every window fills the whole work area.
 *   restore — back to each window's normal launch-time tile size/position.
 */
export type ArrangeLayout =
  | 'grid8x3'
  | 'grid7x3'
  | 'grid6x2'
  | 'grid5x2'
  | 'grid4x2'
  | 'leftHalf'
  | 'rightHalf'
  | 'maximized'
  | 'restore'

/** One row in the Browser Windows panel — see browserContext.ts's listTrackedWindows(). */
export interface TrackedWindowInfo {
  key: string
  accountName: string
  rowNumber?: number
  uid?: string
  /** 'app' = headless + live interactive tile (no OS window exists); 'browser' = real headed window, screenshot-preview tile with Focus/Close. */
  viewMode?: 'browser' | 'app'
}

/** One tile's live capture in the Browser Windows panel — see windowManager.ts's screenshotAllTrackedWindows(). */
export interface WindowSnapshot {
  dataUrl: string
  url: string
}

export interface AutomationApi {
  /**
   * slotIndex positions this account's headed window in the MaxCare-style
   * tiling grid (see browserContext.ts's tilePosition()) — pass an
   * incrementing index (0, 1, 2, ...) when opening several profiles in a
   * batch so their windows tile neatly instead of stacking on top of each
   * other at the same default position. Omit for a single ad-hoc open.
   */
  /** `rowNumber` is the account's 1-based position in the grid as the user currently sees it (filtered/sorted view) — used only for the Chrome window title, distinct from `slotIndex`, which is the position within this launch batch and drives window tiling. `targetUrl` overrides the default Facebook feed landing page (falls back to the account's own saved `target_url` when omitted) — see the row context menu's "🚀 Open Browser with URL" action. */
  openProfile(accountId: number, slotIndex?: number, rowNumber?: number, targetUrl?: string): Promise<OpenProfileResult>
  checkLive(target: number | number[]): Promise<LiveDieResult | LiveDieResult[]>
  getMailOtp(accountId: number): Promise<MailOtpResult>
  autoLogin(accountId: number): Promise<AutoLoginResult>
  closeAllBrowsers(): Promise<{ closed: number }>
  /** Tiles/splits every currently-open headed browser window into the given layout — see ArrangeLayout. */
  arrangeWindows(layout: ArrangeLayout): Promise<{ arranged: number; total: number }>
  /** Every currently-open, trackContext()-keyed browser window with its display metadata, for the Browser Windows panel. */
  listWindows(): Promise<TrackedWindowInfo[]>
  /** Brings one tracked window's page to the front. */
  focusWindow(key: string): Promise<{ ok: boolean }>
  /** Closes one tracked window by its trackContext() key. */
  closeWindow(key: string): Promise<{ ok: boolean }>
  /** Reloads one tracked window's current page. */
  reloadWindow(key: string): Promise<{ ok: boolean }>
  /** Browser back-navigation for one tracked window. */
  goBackWindow(key: string): Promise<{ ok: boolean }>
  /** Navigates one tracked window back to the Facebook feed. */
  goHomeWindow(key: string): Promise<{ ok: boolean }>
  /** Low-quality JPEG screenshot + current URL for every currently-tracked window's page, keyed by trackContext() key — omits any window whose capture failed. */
  screenshotWindows(): Promise<Record<string, WindowSnapshot>>
  /** Starts a live CDP screencast for one tracked window (App Mode tiles) — frames arrive via onScreencastFrame. Idempotent. `viewport` is the page's real CSS-pixel size, needed to scale a tile click back to real page coordinates. */
  startScreencast(key: string): Promise<{ ok: boolean; viewport: { width: number; height: number } | null }>
  /** Stops a tracked window's screencast. Safe to call even if nothing is streaming. */
  stopScreencast(key: string): Promise<{ ok: boolean }>
  /** Simulates a tap at (x, y) in the tracked window's own viewport CSS-pixel coordinates (renderer scales from the tile's rendered size before calling). */
  dispatchTap(key: string, x: number, y: number): Promise<void>
  /** Forwards a scroll/wheel gesture at (x, y), same coordinate space as dispatchTap. */
  dispatchScroll(key: string, x: number, y: number, deltaX: number, deltaY: number): Promise<void>
  /** Forwards one keyboard event to the tracked window. */
  dispatchKey(key: string, event: { type: 'keyDown' | 'keyUp' | 'char'; key: string; code: string; text?: string }): Promise<void>
  /** Fires with each new screencast frame for a streaming key — filter by `key` client-side, since this is one shared channel for every tile. */
  onScreencastFrame(cb: (payload: { key: string; dataUrl: string }) => void): () => void
  runQueue(accountIds: number[], concurrency: number, scenarioId?: number): Promise<QueueSummary>
  stopQueue(): Promise<boolean>
  isQueueRunning(): Promise<boolean>
  onProgress(cb: (event: QueueProgressEvent) => void): () => void
  /** Fires with the full, freshly-re-read account row the instant one account's queue run finishes (success or failure) — lets the grid patch Friends/Groups/Followers/Pages/Cookie/Token/Avatar/locations/Created Date/Status in place per row, without waiting for the whole batch or a manual refresh. */
  onAccountUpdated(cb: (account: Account) => void): () => void
  onQueueDone(cb: (summary: QueueSummary) => void): () => void
  runAutoPost(req: AutoPostRequest): Promise<MarketingBatchSummary>
  runAutoShare(req: AutoShareRequest): Promise<MarketingBatchSummary>
  runChangeInfo(req: ChangeInfoRequest): Promise<MarketingBatchSummary>
  runWatchLive(req: WatchLiveRequest): Promise<MarketingBatchSummary>
  unlock282(accountIds: number[]): Promise<MarketingBatchSummary>
  /** Opens a headed, cookie-authenticated browser per account (no password/2FA re-entry) — concurrency is the current Threads setting, same convention as runQueue. */
  loginWithCookieBatch(accountIds: number[], concurrency: number, rowNumbers?: Record<number, number>): Promise<CookieLoginSummary>
  onCookieLoginProgress(cb: (event: CookieLoginEvent) => void): () => void
  addFriendsByUidList(req: AddFriendsByUidListRequest): Promise<MarketingBatchSummary>
  addSuggestedFriends(req: AddSuggestedFriendsRequest): Promise<MarketingBatchSummary>
  unfriendAll(req: UnfriendAllRequest): Promise<MarketingBatchSummary>
  joinGroupsByIdList(req: JoinGroupsByIdListRequest): Promise<MarketingBatchSummary>
  joinSuggestedGroups(req: JoinSuggestedGroupsRequest): Promise<MarketingBatchSummary>
  leaveGroups(req: LeaveGroupsRequest): Promise<MarketingBatchSummary>
  /** Fires the instant any one target UID/Group ID resolves (success or failure), across any account in the running batch — used to strip a used entry from a saved list live. */
  onFriendsGroupsItemProgress(cb: (event: FriendsGroupsItemProgressEvent) => void): () => void
}

export interface FriendsGroupsItemProgressEvent {
  targetId: string
  success: boolean
  detail: string
}

export interface CookieLoginEvent {
  accountId: number
  uid: string | null
  index: number
  total: number
  ok: boolean
  detail: string
}

export interface CookieLoginSummary {
  total: number
  succeeded: number
  failed: number
}

export interface UtilsApi {
  parseSpinSyntax(text: string): Promise<string>
  selectImages(): Promise<string[]>
  selectMedia(): Promise<string[]>
  selectFolder(): Promise<string | null>
  saveTextFile(
    content: string,
    defaultName: string,
    kind: 'txt' | 'csv'
  ): Promise<{ ok: boolean; filePath?: string }>
  selectChromiumExecutable(): Promise<string | null>
  selectProfileDirectory(): Promise<string | null>
  selectAvatarDirectory(): Promise<string | null>
}

export interface ToolsApi {
  checkUidsLive(accountIds: number[]): Promise<UidCheckResult[]>
  checkProxiesHealth(proxies: string[]): Promise<ProxyHealthResult[]>
  findDuplicateAccounts(): Promise<DuplicateAccountSummary[]>
  removeDuplicateAccounts(): Promise<{ removed: number }>
  onUidCheckProgress(
    cb: (payload: { result: UidCheckResult; index: number; total: number }) => void
  ): () => void
  onProxyCheckProgress(
    cb: (payload: { result: ProxyHealthResult; index: number; total: number }) => void
  ): () => void
}

export interface SystemApi {
  clipboardWriteText(text: string): Promise<boolean>
  /** Electron's app.getVersion() — reads the packaged app's package.json, so the UI never needs its own hardcoded version string. */
  getAppVersion(): Promise<string>
  /** Fires whenever the connectivity heartbeat (networkWatchdog.ts) detects an online<->offline transition — used to surface a "network lost, run halted" banner/toast. */
  onNetworkStatus(cb: (status: { online: boolean }) => void): () => void
  /** Schedules a real OS shutdown in `seconds` (Windows' `shutdown /s /t <seconds>`) — the countdown/cancel UI lives in the renderer. */
  scheduleShutdown(seconds: number): Promise<{ ok: boolean; message?: string }>
  /** Cancels a previously scheduled shutdown (`shutdown /a`). */
  cancelShutdown(): Promise<{ ok: boolean }>
  /** Checks if Kantumruy Pro font is installed in the system. */
  checkFont(): Promise<{ installed: boolean }>
  /** Installs Kantumruy Pro font to the OS system fonts directory. */
  installFont(): Promise<{ ok: boolean; message: string }>
}

export interface UpdateAvailableInfo {
  version: string
  releaseNotes: string | null
  releaseDate: string
}
export interface UpdateNotAvailableInfo {
  version: string
}
export interface DownloadProgressInfo {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}
export interface UpdateDownloadedInfo {
  version: string
}
export interface UpdaterErrorInfo {
  message: string
}

export interface UpdaterApi {
  check(): Promise<{ ok: boolean; error?: string }>
  startDownload(): Promise<{ ok: boolean; error?: string }>
  quitAndInstall(): Promise<{ ok: boolean }>
  onUpdateAvailable(cb: (info: UpdateAvailableInfo) => void): () => void
  onUpdateNotAvailable(cb: (info: UpdateNotAvailableInfo) => void): () => void
  onDownloadProgress(cb: (info: DownloadProgressInfo) => void): () => void
  onUpdateDownloaded(cb: (info: UpdateDownloadedInfo) => void): () => void
  onError(cb: (info: UpdaterErrorInfo) => void): () => void
}

export interface ProfilesApi {
  /** accountIds are this app's numeric account primary keys — resolved to their uid/profile-dir on the main-process side. */
  clean(accountIds: number[], mode: CleanMode): Promise<CleanSummary>
}

export interface AvatarDownloadEvent {
  accountId: number
  uid: string | null
  index: number
  total: number
  ok: boolean
  detail?: string
}

export interface AvatarDownloadSummary {
  total: number
  succeeded: number
  failed: number
}

export interface AvatarsApi {
  /** High-speed direct (no browser) avatar downloader — Facebook's public Graph picture endpoint, resized/compressed via sharp, saved as {avatarStoragePath}/{uid}.jpg. */
  downloadBatch(accountIds: number[]): Promise<AvatarDownloadSummary>
  /** The local file path an account's avatar would be saved to/read from, without triggering a download. */
  getLocalPath(uid: string): Promise<string>
  onProgress(cb: (event: AvatarDownloadEvent) => void): () => void
}

export interface LicenseApi {
  getStatus(): Promise<LicenseStatus>
  activate(licenseKey: string): Promise<ActivateLicenseResult>
  deactivate(): Promise<{ ok: boolean }>
}

export interface BackupApi {
  /** Prompts a native save dialog, then packs the given accounts (DB records + folder names + Chrome profile folders) into a .zip. */
  export(accountIds: number[]): Promise<BackupExportResult>
  /** Prompts a native open dialog (or uses explicit path), then restores accounts/folders/profiles from the selected .zip into the "Receive Account" folder. */
  import(explicitPath?: string): Promise<BackupImportResult>
  /** Fires after a successful import so any open window can refresh its grid/folder list without re-deriving the summary from the invoke() return value. */
  onImported(cb: (result: BackupImportResult) => void): () => void
}

export interface CloudSyncApi {
  /** This PC's persistent Cloud Sync identifier (format `TFA` + 5 digits), generated on first use. */
  getMachineId(): Promise<string>
  /** Bundles the given accounts and uploads them to Firebase under the target Machine ID. */
  push(targetMachineId: string, accountIds: number[]): Promise<CloudPushResult>
  /** Downloads and restores whatever payload is waiting under this PC's (or a given) Machine ID, then auto-deletes it from Firebase on success. */
  pull(machineId: string): Promise<CloudPullResult>
  onPulled(cb: (result: CloudPullResult) => void): () => void
}

export interface BatchScanProgressEvent {
  index: number
  total: number
  accountId: number
  name: string
  count: number
}

export interface PagesApi {
  getManagedPages(
    accountId: number,
    forceRefresh?: boolean,
    headless?: boolean
  ): Promise<import('./account').ManagedPage[]>
  batchScanPages(accountIds: number[]): Promise<{ totalScanned: number; totalPagesFound: number }>
  clearPageData(accountIds: number[]): Promise<{ clearedCount: number }>
  fetchPosts(
    accountId: number,
    assetId: string,
    filter: import('./account').PagePostFilter,
    headless?: boolean
  ): Promise<{ posts: import('./account').PagePost[]; totalScraped: number }>
  deletePosts(
    accountId: number,
    assetId: string,
    postIds: string[],
    headless?: boolean,
    batchSize?: number
  ): Promise<{ success: boolean; deletedCount: number; detail: string }>
  stopOperation(): Promise<{ ok: boolean }>
  onFetchProgress(cb: (payload: { accountId: number; assetId: string; message: string }) => void): () => void
  onDeleteProgress(
    cb: (payload: {
      accountId: number
      assetId: string
      message: string
      deletedCount?: number
      completedIds?: string[]
    }) => void
  ): () => void
  onBatchScanProgress(cb: (payload: BatchScanProgressEvent) => void): () => void
  extractPagesV2(
    accountIds: number[],
    headless?: boolean
  ): Promise<{ totalScanned: number; totalPagesFound: number; results: Record<number, import('./account').ManagedPage[]> }>
  stopExtractV2(): Promise<{ ok: boolean }>
  onExtractV2Progress(
    cb: (payload: {
      index: number
      total: number
      accountId: number
      uid: string
      name: string
      message: string
      pagesFound: number
    }) => void
  ): () => void
  fetchPostsV2(
    accountId: number,
    pageId: string,
    filter: import('./account').PagePostFilter,
    headless?: boolean
  ): Promise<{ posts: import('./account').PagePost[]; totalScraped: number }>
  deletePostsV2(
    accountId: number,
    pageId: string,
    postItems: Array<{ id: string; type: string }>,
    headless?: boolean,
    threads?: number
  ): Promise<{ success: boolean; deletedCount: number; detail: string }>
  stopDeleteV2(): Promise<{ ok: boolean }>
  onFetchV2Progress(cb: (payload: { accountId: number; pageId: string; message: string }) => void): () => void
  onDeleteV2Progress(
    cb: (payload: {
      accountId: number
      pageId: string
      message: string
      deletedCount?: number
      completedIds?: string[]
      currentBatchIds?: string[]
    }) => void
  ): () => void
}

export interface AppApi {
  system: SystemApi
  accounts: AccountsApi
  folders: FoldersApi
  scenarios: ScenariosApi
  parser: ParserApi
  proxies: ProxiesApi
  settings: SettingsApi
  window: WindowApi
  automation: AutomationApi
  pages: PagesApi
  utils: UtilsApi
  updater: UpdaterApi
  tools: ToolsApi
  license: LicenseApi
  profiles: ProfilesApi
  backup: BackupApi
  cloudSync: CloudSyncApi
  avatars: AvatarsApi
}

// Convenience re-exports so callers can import everything from '@types'
export type { NewAccount }
