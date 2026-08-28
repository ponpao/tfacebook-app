// ---------------------------------------------------------------------------
// registerHandlers.ts  — registers every ipcMain.handle used by the app.
// Each handler is a thin adapter over the repositories / parser; all business
// logic lives in those modules so it stays testable.
// ---------------------------------------------------------------------------
import { ipcMain, BrowserWindow, dialog } from 'electron'
import { rm, writeFile } from 'fs/promises'
import { IPC } from './channels'
import { registerSystemIpcHandlers } from './systemIpc'
import { registerLicenseIpcHandlers } from './licenseIpc'
import { registerBackupIpcHandlers } from './backupIpc'
import { registerCloudSyncIpcHandlers } from './cloudSyncIpc'
import { registerAvatarIpcHandlers } from './avatarIpc'
import * as accounts from '../db/accountsRepo'
import * as folders from '../db/foldersRepo'
import * as proxies from '../db/proxiesRepo'
import * as settings from '../db/settingsRepo'
import * as scenarios from '../db/scenariosRepo'
import { parseText, parseForImport } from '../utils/accountParser'
import { parseSpinSyntax } from '../utils/spinSyntax'
import { distributeValues } from '../utils/bulkAssign'
import {
  openProfile,
  checkLiveDie,
  closeAllBrowsers,
  autoLogin
} from '../automation/playwrightManager'
import { fetchFacebookOtp } from '../automation/imapWorker'
import { runQueue, stopQueue, isQueueRunning } from '../automation/queueRunner'
import { runBatch } from '../automation/batchRunner'
import { postToFeedOrGroups } from '../automation/postActions'
import { sharePostOrVideo } from '../automation/shareActions'
import { batchChangeInfo } from '../automation/changeInfo'
import { watchLive } from '../automation/watchLive'
import { runUnlock282 } from '../automation/unlock282'
import { loginWithCookieBatch } from '../services/browserAutomation'
import {
  runAddFriendsByUidList,
  runAddSuggestedFriends,
  runUnfriendAll,
  runJoinGroupsByIdList,
  runJoinSuggestedGroups,
  runLeaveGroups
} from '../automation/friendsGroups'
import { resolveProfileDir } from '../automation/browserContext'
import { cleanProfiles } from '../automation/profileOptimizer'
import { buildExportLines } from '../utils/exportAccounts'
import { checkUidsLive, checkProxiesHealth } from '../automation/toolsUtilities'
import type { AccountQuery, AccountUpdate } from '../../types/account'
import type { ImportFormat } from '../../types/parser'
import type { NewProxy } from '../../types/proxy'
import type { NewScenario, ScenarioStep } from '../../types/scenario'
import type { ExportAccountsRequest } from '../../types/export'
import type { AppSettings } from '../../types/settings'
import type { CleanMode } from '../../types/profileOptimizer'
import type {
  AutoPostRequest,
  AutoShareRequest,
  ChangeInfoRequest,
  WatchLiveRequest,
  AssignProxyRequest,
  AssignUseragentRequest,
  AddFriendsByUidListRequest,
  AddSuggestedFriendsRequest,
  UnfriendAllRequest,
  JoinGroupsByIdListRequest,
  JoinSuggestedGroupsRequest,
  LeaveGroupsRequest
} from '../../types/marketing'

/** Best-effort recursive removal of each account's saved browser profile folder. */
async function cleanupProfileDirs(uids: (string | null)[]): Promise<void> {
  for (const uid of uids) {
    const dir = resolveProfileDir(uid)
    await rm(dir, { recursive: true, force: true }).catch(() => void 0)
  }
}

export function registerIpcHandlers(): void {
  registerSystemIpcHandlers()
  registerLicenseIpcHandlers()
  registerBackupIpcHandlers()
  registerCloudSyncIpcHandlers()
  registerAvatarIpcHandlers()

  // ---- accounts -----------------------------------------------------------
  ipcMain.handle(IPC.accounts.list, (_e, query: AccountQuery) =>
    accounts.listAccounts(query)
  )
  ipcMain.handle(IPC.accounts.stats, () => accounts.getStats())
  ipcMain.handle(IPC.accounts.get, (_e, id: number) => accounts.getAccount(id))
  ipcMain.handle(IPC.accounts.update, (_e, id: number, patch: AccountUpdate) =>
    accounts.updateAccount(id, patch)
  )
  ipcMain.handle(
    IPC.accounts.updateStatus,
    (_e, ids: number[], status: string, detail?: string) =>
      accounts.updateStatus(ids, status, detail)
  )
  // "Remove" is a soft delete — accounts move to the Recycle Bin, not gone.
  ipcMain.handle(IPC.accounts.remove, (_e, ids: number[]) =>
    accounts.softDeleteAccounts(ids)
  )
  ipcMain.handle(
    IPC.accounts.moveToFolder,
    (_e, ids: number[], targetFolderId: number) =>
      folders.moveAccountsToFolder(ids, targetFolderId)
  )
  ipcMain.handle(
    IPC.accounts.bulkAssign,
    (_e, column: 'proxy' | 'user_agent', assignments: { id: number; value: string }[]) =>
      accounts.bulkAssignField(column, assignments)
  )
  ipcMain.handle(
    IPC.accounts.bulkSetField,
    (_e, column: 'notes' | 'live_status', ids: number[], value: string) =>
      accounts.bulkSetField(column, ids, value)
  )
  ipcMain.handle(IPC.accounts.assignProxies, (_e, req: AssignProxyRequest) => {
    const assignments = distributeValues(req.accountIds, req.proxies, req.mode, req.sharePerN)
    return { assigned: accounts.bulkAssignField('proxy', assignments) }
  })
  ipcMain.handle(IPC.accounts.assignUseragents, (_e, req: AssignUseragentRequest) => {
    const assignments = distributeValues(req.accountIds, req.userAgents, req.mode, req.sharePerN)
    return { assigned: accounts.bulkAssignField('user_agent', assignments) }
  })

  // ---- Recycle Bin (soft delete) -------------------------------------------
  ipcMain.handle(IPC.accounts.softDelete, (_e, ids: number[]) =>
    accounts.softDeleteAccounts(ids)
  )
  ipcMain.handle(IPC.accounts.getDeleted, () => accounts.getDeletedAccounts())
  ipcMain.handle(IPC.accounts.restore, (_e, ids: number[]) => accounts.restoreAccounts(ids))
  ipcMain.handle(IPC.accounts.permanentDelete, async (_e, ids: number[]) => {
    const { removed, uids } = accounts.permanentDeleteAccounts(ids)
    await cleanupProfileDirs(uids)
    return { removed }
  })
  ipcMain.handle(IPC.accounts.emptyRecycleBin, async () => {
    const { removed, uids } = accounts.emptyRecycleBin()
    await cleanupProfileDirs(uids)
    return { removed }
  })

  // ---- export ---------------------------------------------------------------
  ipcMain.handle(IPC.accounts.exportAccounts, (_e, req: ExportAccountsRequest) => {
    const lines = buildExportLines(req)
    return { lines, total: lines.length }
  })

  // ---- folders ------------------------------------------------------------
  ipcMain.handle(IPC.folders.getAll, () => folders.getAllFolders())
  ipcMain.handle(IPC.folders.create, (_e, name: string) => folders.createFolder(name))
  ipcMain.handle(IPC.folders.rename, (_e, id: number, newName: string) => {
    folders.renameFolder(id, newName)
    return true
  })
  ipcMain.handle(
    IPC.folders.delete,
    (_e, id: number, fallbackFolderId?: number) =>
      folders.deleteFolder(id, fallbackFolderId)
  )

  // ---- scenarios (warm-up pipelines) ---------------------------------------
  ipcMain.handle(IPC.scenarios.getAll, () => scenarios.getAllScenarios())
  ipcMain.handle(IPC.scenarios.create, (_e, input: NewScenario) =>
    scenarios.createScenario(input)
  )
  ipcMain.handle(
    IPC.scenarios.update,
    (_e, id: number, patch: { name?: string; steps?: ScenarioStep[] }) =>
      scenarios.updateScenario(id, patch)
  )
  ipcMain.handle(IPC.scenarios.delete, (_e, id: number) => scenarios.deleteScenario(id))

  // ---- parser / import ----------------------------------------------------
  ipcMain.handle(
    IPC.parser.preview,
    (_e, text: string, format: ImportFormat, limit?: number) =>
      parseText(text, format, limit ?? 200)
  )
  ipcMain.handle(
    IPC.parser.import,
    (_e, text: string, format: ImportFormat, folderId?: number) => {
      const { accounts: parsed, errors } = parseForImport(text, format, folderId)
      const inserted = accounts.insertAccounts(parsed)
      return {
        inserted,
        skipped: parsed.length - inserted,
        errors
      }
    }
  )

  // ---- proxies ------------------------------------------------------------
  ipcMain.handle(IPC.proxies.list, () => proxies.listProxies())
  ipcMain.handle(IPC.proxies.add, (_e, list: NewProxy[]) => proxies.addProxies(list))
  ipcMain.handle(IPC.proxies.remove, (_e, ids: number[]) =>
    proxies.deleteProxies(ids)
  )
  ipcMain.handle(IPC.proxies.count, () => proxies.countProxies())

  // ---- settings -----------------------------------------------------------
  ipcMain.handle(IPC.settings.get, (_e, key: string) => settings.getSetting(key))
  ipcMain.handle(IPC.settings.set, (_e, key: string, value: string) =>
    settings.setSetting(key, value)
  )
  ipcMain.handle(IPC.settings.all, () => settings.getAllSettings())
  ipcMain.handle(IPC.settings.getAppSettings, () => settings.getAppSettings())
  ipcMain.handle(IPC.settings.setAppSettings, (_e, next: AppSettings) =>
    settings.setAppSettings(next)
  )

  // ---- automation (Playwright + IMAP) -------------------------------------
  ipcMain.handle(IPC.automation.openProfile, async (_e, accountId: number, slotIndex?: number) => {
    const acc = accounts.getAccount(accountId)
    if (!acc) return { ok: false, detail: 'Account not found' }
    try {
      const res = await openProfile(acc, slotIndex)
      accounts.updateAccount(accountId, { live_status: res.detail })
      return res
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      accounts.updateAccount(accountId, { live_status: `Browser error: ${detail}` })
      return { ok: false, detail }
    }
  })

  ipcMain.handle(IPC.automation.checkLive, async (_e, accountId: number) => {
    const acc = accounts.getAccount(accountId)
    if (!acc) return { status: 'Unknown', detail: 'Account not found' }
    accounts.updateAccount(accountId, { live_status: 'Checking…' })
    const res = await checkLiveDie(acc)
    accounts.updateAccount(accountId, {
      status: res.status,
      status_detail: res.detail,
      live_status: res.status,
      last_active: new Date().toISOString().slice(0, 19).replace('T', ' '),
      // Only set on a confirmed-Live result (see checkLiveDie's doc
      // comment) — keeps the DB's cookie current for the next Cloud Sync
      // push even when the account was never re-logged-in, just checked.
      ...(res.cookie ? { cookie: res.cookie } : {}),
      ...(res.token ? { token: res.token } : {})
    })
    return res
  })

  ipcMain.handle(IPC.automation.getMailOtp, async (_e, accountId: number) => {
    const acc = accounts.getAccount(accountId)
    if (!acc) return { success: false, error: 'Account not found' }
    if (!acc.email || !acc.email_pass) {
      return { success: false, error: 'Account has no email / mail password' }
    }
    accounts.updateAccount(accountId, { live_status: 'Fetching OTP…' })
    const res = await fetchFacebookOtp(acc.email, acc.email_pass, {
      mailServer: acc.mail_server ?? undefined,
      withinMinutes: 1440 // scan the last 24 hours
    })
    // Keep the grid's Activity Status column concise; full text goes to toast.
    const SHORT: Record<string, string> = {
      AUTH_FAILED: 'OTP: Auth failed',
      TIMEOUT: 'OTP: Timeout',
      NO_CODE: 'OTP: No code found',
      CONNECTION: 'OTP: Connection error',
      INPUT: 'OTP: Missing email/pass'
    }
    const shortStatus = res.success
      ? `Mail OTP: ${res.code}${res.folder && res.folder !== 'INBOX' ? ` (${res.folder})` : ''}`
      : (res.errorCode && SHORT[res.errorCode]) || 'OTP failed'
    accounts.updateAccount(accountId, { live_status: shortStatus })
    return res
  })

  ipcMain.handle(IPC.automation.autoLogin, async (_e, accountId: number) => {
    const acc = accounts.getAccount(accountId)
    if (!acc) return { success: false, status: 'Unknown', detail: 'Account not found' }
    accounts.updateAccount(accountId, { live_status: 'Logging in…' })
    const res = await autoLogin(acc)
    accounts.updateAccount(accountId, {
      status: res.status,
      status_detail: res.detail,
      live_status: res.status === 'Live' ? 'Login Success' : res.detail,
      ...(res.cookie ? { cookie: res.cookie } : {}),
      ...(res.token ? { token: res.token } : {}),
      ...(res.name ? { name: res.name } : {}),
      ...(res.friendsCount != null ? { friends_count: res.friendsCount } : {}),
      ...(res.groupsCount != null ? { groups_count: res.groupsCount } : {}),
      ...(res.location ? { location: res.location } : {}),
      ...(res.createdDate ? { created_date: res.createdDate } : {}),
      ...(res.notes ? { notes: res.notes } : {}),
      last_active: new Date().toISOString().slice(0, 19).replace('T', ' ')
    })
    return res
  })

  ipcMain.handle(IPC.automation.closeAllBrowsers, async () => {
    const closed = await closeAllBrowsers()
    return { closed }
  })

  // ---- multi-thread queue runner -------------------------------------------
  ipcMain.handle(
    IPC.automation.runQueue,
    async (_e, accountIds: number[], concurrency: number, scenarioId?: number) => {
      // Mark everything as queued immediately so the grid reflects the batch
      // even before the first worker picks a row up.
      for (const id of accountIds) {
        accounts.updateAccount(id, { live_status: 'Queued' })
      }
      return runQueue(accountIds, concurrency, scenarioId)
    }
  )
  ipcMain.handle(IPC.automation.stopQueue, () => {
    stopQueue()
    return true
  })
  ipcMain.handle(IPC.automation.isQueueRunning, () => isQueueRunning())

  // ---- Row 2 marketing automation (Auto Post / Auto Share / Change Info) --
  ipcMain.handle(IPC.automation.runAutoPost, async (_e, req: AutoPostRequest) => {
    for (const id of req.accountIds) accounts.updateAccount(id, { live_status: 'Queued' })
    return runBatch(req.accountIds, req.concurrency, async (account, emit, signal) => {
      const res = await postToFeedOrGroups(account, {
        destination: req.destination,
        contentTemplate: req.contentTemplate,
        imagePaths: req.imagePaths,
        groupCount: req.groupCount,
        delayMinSeconds: req.delayMinSeconds,
        delayMaxSeconds: req.delayMaxSeconds,
        signal,
        onProgress: emit
      })
      return { success: res.success, detail: res.detail }
    })
  })

  ipcMain.handle(IPC.automation.runAutoShare, async (_e, req: AutoShareRequest) => {
    for (const id of req.accountIds) accounts.updateAccount(id, { live_status: 'Queued' })
    return runBatch(req.accountIds, req.concurrency, async (account, emit, signal) => {
      const res = await sharePostOrVideo(account, {
        targetUrl: req.targetUrl,
        destination: req.destination,
        captionTemplate: req.captionTemplate,
        groupCount: req.groupCount,
        delayMinSeconds: req.delayMinSeconds,
        delayMaxSeconds: req.delayMaxSeconds,
        signal,
        onProgress: emit
      })
      return { success: res.success, detail: res.detail }
    })
  })

  ipcMain.handle(IPC.automation.runChangeInfo, async (_e, req: ChangeInfoRequest) => {
    for (const id of req.accountIds) accounts.updateAccount(id, { live_status: 'Queued' })
    return runBatch(req.accountIds, req.concurrency, async (account, emit, signal) => {
      const res = await batchChangeInfo(account, {
        changePassword: req.changePassword,
        updateAbout: req.updateAbout,
        changeAvatar: req.changeAvatar,
        changeCover: req.changeCover,
        enable2FA: req.enable2FA,
        signal,
        onProgress: emit
      })
      const patch: Record<string, unknown> = {}
      if (res.newPassword) patch.password = res.newPassword
      if (res.newAvatarPath) patch.avatar = res.newAvatarPath
      if (res.new2FASecret) patch.two_fa = res.new2FASecret
      // notes surfaces exactly what happened: the specific per-action error
      // messages (e.g. "Bio Failed: Save button not found") take priority
      // over a silent generic "Error", since those are what an operator
      // needs to see to fix a broken selector — falls back to a summary of
      // the applied About-field changes only when everything succeeded.
      const appliedAbout = [res.newBio, res.newWork, res.newCurrentCity, res.newHometown, res.newHighSchool]
        .filter(Boolean)
        .join(' | ')
      if (res.errors.length > 0) patch.notes = res.errors.join(' | ')
      else if (appliedAbout) patch.notes = appliedAbout
      return { success: res.success, detail: res.detail, patch }
    })
  })

  ipcMain.handle(IPC.automation.runWatchLive, async (_e, req: WatchLiveRequest) => {
    for (const id of req.accountIds) accounts.updateAccount(id, { live_status: 'Queued' })
    return runBatch(req.accountIds, req.concurrency, async (account, emit, signal) => {
      const res = await watchLive(account, {
        liveUrl: req.liveUrl,
        watchSeconds: req.watchSeconds,
        comments: req.comments,
        signal,
        onProgress: emit
      })
      return { success: res.success, detail: res.detail }
    })
  })

  ipcMain.handle(IPC.automation.unlock282, async (_e, accountIds: number[]) => {
    for (const id of accountIds) accounts.updateAccount(id, { live_status: 'Queued' })
    const appSettings = settings.getAppSettings()
    return runBatch(accountIds, Math.min(3, accountIds.length), async (account, emit) => {
      const res = await runUnlock282(account, appSettings, (detail) => emit('Verifying...', detail))
      return {
        success: res.success,
        detail: res.notes,
        patch: { status: res.status, notes: res.notes, live_status: res.notes }
      }
    })
  })

  // ---- Login with Cookie (batch, headed, no credential re-entry) -----------
  ipcMain.handle(
    IPC.automation.loginWithCookieBatch,
    (_e, accountIds: number[], concurrency: number) => loginWithCookieBatch(accountIds, concurrency)
  )

  // ---- Friends & Groups automation ------------------------------------------
  // Broadcasts a per-target (not per-account) success/failure the instant it
  // resolves — AddFriendsModal/JoinGroupsModal's "remove from list once
  // used" checkbox listens on this to strip a line the moment ANY selected
  // account succeeds on it, rather than waiting for the whole batch summary.
  function broadcastItemProgress(targetId: string, outcome: { success: boolean; detail: string }): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.automation.onFriendsGroupsItemProgress, { targetId, ...outcome })
    }
  }

  ipcMain.handle(IPC.automation.addFriendsByUidList, async (_e, req: AddFriendsByUidListRequest) => {
    for (const id of req.accountIds) accounts.updateAccount(id, { live_status: 'Queued' })
    return runBatch(req.accountIds, req.concurrency, async (account, emit, signal) => {
      const res = await runAddFriendsByUidList(account, req.targetUids, {
        signal,
        onProgress: (detail) => emit('Adding Friends...', detail),
        onItemDone: broadcastItemProgress
      })
      return { success: res.success, detail: res.detail, patch: { notes: res.detail } }
    })
  })

  ipcMain.handle(IPC.automation.addSuggestedFriends, async (_e, req: AddSuggestedFriendsRequest) => {
    for (const id of req.accountIds) accounts.updateAccount(id, { live_status: 'Queued' })
    return runBatch(req.accountIds, req.concurrency, async (account, emit, signal) => {
      const res = await runAddSuggestedFriends(account, {
        maxCount: req.maxCount,
        signal,
        onProgress: (detail) => emit('Adding Suggested Friends...', detail)
      })
      return { success: res.success, detail: res.detail, patch: { notes: res.detail } }
    })
  })

  ipcMain.handle(IPC.automation.unfriendAll, async (_e, req: UnfriendAllRequest) => {
    for (const id of req.accountIds) accounts.updateAccount(id, { live_status: 'Queued' })
    return runBatch(req.accountIds, req.concurrency, async (account, emit, signal) => {
      const res = await runUnfriendAll(account, {
        maxCount: req.maxCount,
        signal,
        onProgress: (detail) => emit('Unfriending...', detail)
      })
      return { success: res.success, detail: res.detail, patch: { notes: res.detail } }
    })
  })

  ipcMain.handle(IPC.automation.joinGroupsByIdList, async (_e, req: JoinGroupsByIdListRequest) => {
    for (const id of req.accountIds) accounts.updateAccount(id, { live_status: 'Queued' })
    return runBatch(req.accountIds, req.concurrency, async (account, emit, signal) => {
      const res = await runJoinGroupsByIdList(account, req.targetGroups, {
        signal,
        onProgress: (detail) => emit('Joining Groups...', detail),
        onItemDone: broadcastItemProgress
      })
      return { success: res.success, detail: res.detail, patch: { notes: res.detail } }
    })
  })

  ipcMain.handle(IPC.automation.joinSuggestedGroups, async (_e, req: JoinSuggestedGroupsRequest) => {
    for (const id of req.accountIds) accounts.updateAccount(id, { live_status: 'Queued' })
    return runBatch(req.accountIds, req.concurrency, async (account, emit, signal) => {
      const res = await runJoinSuggestedGroups(account, {
        maxCount: req.maxCount,
        signal,
        onProgress: (detail) => emit('Joining Suggested Groups...', detail)
      })
      return { success: res.success, detail: res.detail, patch: { notes: res.detail } }
    })
  })

  ipcMain.handle(IPC.automation.leaveGroups, async (_e, req: LeaveGroupsRequest) => {
    for (const id of req.accountIds) accounts.updateAccount(id, { live_status: 'Queued' })
    return runBatch(req.accountIds, req.concurrency, async (account, emit, signal) => {
      const res = await runLeaveGroups(account, {
        maxCount: req.maxCount,
        signal,
        onProgress: (detail) => emit('Leaving Groups...', detail)
      })
      return { success: res.success, detail: res.detail, patch: { notes: res.detail } }
    })
  })

  // ---- Profile Optimizer (Clean Profile Storage) ---------------------------
  ipcMain.handle(IPC.profiles.clean, (_e, accountIds: number[], mode: CleanMode) => {
    const uids = accountIds.map((id) => accounts.getAccount(id)?.uid ?? null)
    return cleanProfiles(uids, mode)
  })

  // ---- Tools & Utilities ----------------------------------------------------
  ipcMain.handle(IPC.tools.checkUidsLive, (e, accountIds: number[]) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return checkUidsLive(accountIds, (result, index, total) => {
      win?.webContents.send(IPC.tools.onUidCheckProgress, { result, index, total })
      const status = result.status === 'Unknown' ? undefined : result.status
      accounts.updateAccount(result.accountId, {
        live_status: `UID Check: ${result.status} — ${result.detail}`,
        ...(status ? { status, status_detail: result.detail } : {})
      })
    })
  })
  ipcMain.handle(IPC.tools.checkProxiesHealth, (e, proxyList: string[]) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return checkProxiesHealth(proxyList, (result, index, total) => {
      win?.webContents.send(IPC.tools.onProxyCheckProgress, { result, index, total })
    })
  })
  ipcMain.handle(IPC.tools.findDuplicateAccounts, () =>
    accounts
      .findDuplicateAccounts()
      .map((a) => ({ accountId: a.id, uid: a.uid, email: a.email, name: a.name }))
  )
  ipcMain.handle(IPC.tools.removeDuplicateAccounts, () => {
    const removed = accounts.removeDuplicateAccounts()
    return { removed }
  })

  // ---- utils (spin syntax preview, file/folder pickers) --------------------
  ipcMain.handle(IPC.utils.parseSpinSyntax, (_e, text: string) => parseSpinSyntax(text))

  ipcMain.handle(IPC.utils.selectImages, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Select image(s)',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }]
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(IPC.utils.selectFolder, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Select image folder',
      properties: ['openDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.utils.selectChromiumExecutable, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Select Chromium/Chrome executable',
      properties: ['openFile'],
      filters: [{ name: 'Executable', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.utils.selectProfileDirectory, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Select Chrome Profile Storage folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.utils.selectAvatarDirectory, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Select Avatar Download folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(
    IPC.utils.saveTextFile,
    async (e, content: string, defaultName: string, kind: 'txt' | 'csv') => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
      const filters =
        kind === 'csv'
          ? [{ name: 'CSV / Excel', extensions: ['csv'] }]
          : [{ name: 'Text File', extensions: ['txt'] }]
      const result = await dialog.showSaveDialog(win as BrowserWindow, {
        title: kind === 'csv' ? 'Save as CSV' : 'Save as Text',
        defaultPath: defaultName,
        filters
      })
      if (result.canceled || !result.filePath) return { ok: false }
      // Excel expects a BOM to render UTF-8 (Vietnamese/accented text) correctly.
      const data = kind === 'csv' ? '﻿' + content : content
      await writeFile(result.filePath, data, 'utf8')
      return { ok: true, filePath: result.filePath }
    }
  )

  // ---- window controls (frameless title bar) ------------------------------
  const winFromEvent = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender)

  ipcMain.handle(IPC.window.minimize, (e) => {
    winFromEvent(e)?.minimize()
  })
  ipcMain.handle(IPC.window.maximize, (e) => {
    const w = winFromEvent(e)
    if (!w) return false
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
    return w.isMaximized()
  })
  ipcMain.handle(IPC.window.close, (e) => {
    winFromEvent(e)?.close()
  })
  ipcMain.handle(IPC.window.isMaximized, (e) => winFromEvent(e)?.isMaximized() ?? false)
}
