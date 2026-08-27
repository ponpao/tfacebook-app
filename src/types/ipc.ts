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
  BatchSummary as MarketingBatchSummary
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
    column: 'proxy' | 'user_agent',
    assignments: { id: number; value: string }[]
  ): Promise<number>
  bulkSetField(column: 'notes' | 'live_status', ids: number[], value: string): Promise<number>
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
  update(id: number, patch: { name?: string; steps?: ScenarioStep[] }): Promise<Scenario | null>
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
}

export interface OpenProfileResult {
  ok: boolean
  detail: string
}
export interface LiveDieResult {
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

export interface AutomationApi {
  /**
   * slotIndex positions this account's headed window in the MaxCare-style
   * tiling grid (see browserContext.ts's tilePosition()) — pass an
   * incrementing index (0, 1, 2, ...) when opening several profiles in a
   * batch so their windows tile neatly instead of stacking on top of each
   * other at the same default position. Omit for a single ad-hoc open.
   */
  openProfile(accountId: number, slotIndex?: number): Promise<OpenProfileResult>
  checkLive(accountId: number): Promise<LiveDieResult>
  getMailOtp(accountId: number): Promise<MailOtpResult>
  autoLogin(accountId: number): Promise<AutoLoginResult>
  closeAllBrowsers(): Promise<{ closed: number }>
  runQueue(accountIds: number[], concurrency: number, scenarioId?: number): Promise<QueueSummary>
  stopQueue(): Promise<boolean>
  isQueueRunning(): Promise<boolean>
  onProgress(cb: (event: QueueProgressEvent) => void): () => void
  onQueueDone(cb: (summary: QueueSummary) => void): () => void
  runAutoPost(req: AutoPostRequest): Promise<MarketingBatchSummary>
  runAutoShare(req: AutoShareRequest): Promise<MarketingBatchSummary>
  runChangeInfo(req: ChangeInfoRequest): Promise<MarketingBatchSummary>
  runWatchLive(req: WatchLiveRequest): Promise<MarketingBatchSummary>
  unlock282(accountIds: number[]): Promise<MarketingBatchSummary>
}

export interface UtilsApi {
  parseSpinSyntax(text: string): Promise<string>
  selectImages(): Promise<string[]>
  selectFolder(): Promise<string | null>
  saveTextFile(
    content: string,
    defaultName: string,
    kind: 'txt' | 'csv'
  ): Promise<{ ok: boolean; filePath?: string }>
  selectChromiumExecutable(): Promise<string | null>
  selectProfileDirectory(): Promise<string | null>
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

export interface LicenseApi {
  getStatus(): Promise<LicenseStatus>
  activate(licenseKey: string): Promise<ActivateLicenseResult>
  deactivate(): Promise<{ ok: boolean }>
}

export interface BackupApi {
  /** Prompts a native save dialog, then packs the given accounts (DB records + folder names + Chrome profile folders) into a .zip. */
  export(accountIds: number[]): Promise<BackupExportResult>
  /** Prompts a native open dialog, then restores accounts/folders/profiles from the selected .zip into the "Receive Account" folder. */
  import(): Promise<BackupImportResult>
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
  utils: UtilsApi
  updater: UpdaterApi
  tools: ToolsApi
  license: LicenseApi
  profiles: ProfilesApi
  backup: BackupApi
  cloudSync: CloudSyncApi
}

// Convenience re-exports so callers can import everything from '@types'
export type { NewAccount }
