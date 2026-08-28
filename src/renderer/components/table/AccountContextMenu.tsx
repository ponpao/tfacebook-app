// ---------------------------------------------------------------------------
// AccountContextMenu.tsx  — desktop-style right-click menu for grid rows.
// Positioned at the cursor; closes on outside-click or Escape.
// Actions that require a not-yet-built backend (Playwright / live check / IMAP)
// surface a clear "coming soon" notice; data/copy/move/delete work now.
// ---------------------------------------------------------------------------
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Globe,
  Zap,
  KeyRound,
  Mail,
  Copy,
  FolderInput,
  Pencil,
  Trash2,
  ChevronRight,
  LogIn,
  Download,
  Unlock,
  CheckSquare,
  Square,
  StickyNote,
  Eraser,
  RotateCcw,
  Sparkles,
  ImageDown
} from 'lucide-react'
import type { Account } from '../../../types/account'
import { useAccountStore } from '../../store/useAccountStore'
import { generateTOTP, secondsRemaining } from '../../utils/twoFactor'

interface Props {
  x: number
  y: number
  account: Account
  onClose: () => void
}

const MENU_W = 232

/**
 * Copy via the main process's Electron `clipboard` module (IPC) rather than
 * the renderer's `navigator.clipboard` — the renderer API can silently no-op
 * when the window doesn't have OS focus, which right after a context-menu
 * click is a real possibility, and doing it in the main process sidesteps
 * that entirely.
 */
async function copy(value: string | null | undefined, showToast: (msg: string) => void): Promise<void> {
  try {
    await window.api.system.clipboardWriteText(value ?? '')
    showToast('Copied to clipboard!')
  } catch {
    showToast('Copy failed')
  }
}

function Item({
  icon: Icon,
  label,
  onClick,
  danger,
  disabled,
  hasSubmenu,
  onMouseEnter
}: {
  icon: typeof Globe
  label: string
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  hasSubmenu?: boolean
  onMouseEnter?: () => void
}): React.JSX.Element {
  return (
    <button
      className={`flex w-full items-center gap-2 px-2.5 py-[5px] text-left text-[12px] ${
        disabled
          ? 'cursor-default text-slate-400'
          : danger
            ? 'text-[#c81e1e] hover:bg-[#fde8e8]'
            : 'text-slate-800 hover:bg-[#e5f1fb]'
      }`}
      onClick={
        disabled
          ? undefined
          : (e) => {
              // Stop this click from bubbling to the document-level
              // mousedown/outside-click listener or any grid-row handler
              // underneath — without this, a click that closes the menu can
              // also register as a click on whatever was beneath the
              // cursor, which is what made actions feel like they "stuck"
              // (double-fired or hit the wrong target) right after closing.
              e.stopPropagation()
              onClick?.()
            }
      }
      onMouseEnter={onMouseEnter}
    >
      <Icon size={14} className={danger ? 'text-[#c81e1e]' : 'text-[#4a6a8a]'} />
      <span className="flex-1">{label}</span>
      {hasSubmenu && <ChevronRight size={13} className="text-slate-400" />}
    </button>
  )
}

const Sep = (): React.JSX.Element => <div className="my-1 h-px bg-slate-200" />

const SUBMENU_CLOSE_DELAY_MS = 150

/**
 * A submenu item: hovering the parent row opens it, and it stays open while
 * the pointer is over either the parent row or the submenu panel itself —
 * moving from one to the other (even diagonally, briefly leaving both) is
 * covered by a short close delay so it doesn't flicker shut mid-transition.
 * Position is measured after render (useLayoutEffect) against the parent
 * item's own bounding box, and flips to the left (`right-full` equivalent)
 * if it would overflow the right edge of the viewport, instead of the old
 * hardcoded pixel offsets that only worked for one specific menu length.
 */
function Submenu({
  label,
  icon: Icon,
  width = 200,
  children,
  registerPortalNode
}: {
  label: string
  icon: typeof Globe
  width?: number
  children: React.ReactNode
  /**
   * The submenu panel is rendered via createPortal directly onto
   * document.body — it is NOT a DOM descendant of the root menu's own
   * ref, so the root menu's outside-click listener (`ref.current.contains
   * (e.target)`) treats every click inside a submenu as "outside" and
   * closes the whole menu on mousedown, before the clicked Item's own
   * onClick ever fires on the later click event. This callback registers
   * the portal node with the parent so its outside-click check can
   * special-case it. See AccountContextMenu's `portalNodesRef`.
   */
  registerPortalNode: (el: HTMLDivElement | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const parentRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [panelPos, setPanelPos] = useState<{ left: number; top: number } | null>(null)

  const cancelClose = (): void => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), SUBMENU_CLOSE_DELAY_MS)
  }
  useEffect(() => () => cancelClose(), [])

  useLayoutEffect(() => {
    if (!open) return
    const parent = parentRef.current
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    const overflowsRight = rect.right + width > window.innerWidth
    const left = overflowsRight ? rect.left - width : rect.right
    const maxTop = window.innerHeight - (panelRef.current?.offsetHeight ?? 0) - 6
    setPanelPos({ left: Math.max(4, left), top: Math.min(rect.top, Math.max(4, maxTop)) })
  }, [open, width])

  return (
    <div
      ref={parentRef}
      className="relative"
      onMouseEnter={() => {
        cancelClose()
        setOpen(true)
      }}
      onMouseLeave={scheduleClose}
    >
      <Item icon={Icon} label={label} hasSubmenu />
      {open &&
        panelPos &&
        createPortal(
          <div
            ref={(el) => {
              panelRef.current = el
              registerPortalNode(el)
            }}
            className="fixed z-50 max-h-64 overflow-auto rounded border border-slate-400 bg-white py-1 shadow-2xl"
            style={{ left: panelPos.left, top: panelPos.top, width }}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          >
            {children}
          </div>,
          document.body
        )}
    </div>
  )
}

export function AccountContextMenu({ x, y, account, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Portaled submenu panels live outside `ref`'s DOM subtree (they're
  // appended directly to document.body), so the outside-click check below
  // needs its own registry of currently-mounted portal nodes to recognize a
  // click inside one as "inside the menu" rather than closing it.
  const portalNodesRef = useRef<Set<HTMLDivElement>>(new Set())
  const registerPortalNode = (el: HTMLDivElement | null): void => {
    // The same Submenu instance's ref callback fires with the outgoing node
    // as `null` isn't guaranteed to run before the new one mounts, so track
    // by the node itself rather than by submenu identity.
    if (el) portalNodesRef.current.add(el)
    else {
      // Prune any nodes no longer attached to the document (React 18 doesn't
      // reliably call the ref callback with the exact stale node on cleanup
      // when a portal target unmounts via a conditional).
      for (const node of portalNodesRef.current) {
        if (!node.isConnected) portalNodesRef.current.delete(node)
      }
    }
  }

  const folders = useAccountStore((s) => s.folders)
  const selectedIds = useAccountStore((s) => s.selectedIds)
  const allAccounts = useAccountStore((s) => s.accounts)
  const remove = useAccountStore((s) => s.remove)
  const moveToFolder = useAccountStore((s) => s.moveToFolder)
  const showToast = useAccountStore((s) => s.showToast)
  const refresh = useAccountStore((s) => s.refresh)
  const runSingleLogin = useAccountStore((s) => s.runSingleLogin)
  const openExportModal = useAccountStore((s) => s.openExportModal)
  const openEditAccount = useAccountStore((s) => s.openEditAccount)
  const openSetNotes = useAccountStore((s) => s.openSetNotes)
  const openCleanProfile = useAccountStore((s) => s.openCleanProfile)
  const rowSelection = useAccountStore((s) => s.rowSelection)
  const setRowSelection = useAccountStore((s) => s.setRowSelection)

  const ids = (): number[] => {
    const sel = selectedIds()
    return sel.length ? sel : [account.id]
  }

  // If multiple rows are checked/selected, every action below (Open Chrome
  // Profile(s), Copy Data, Move to Folder...) targets all of them — not just
  // the row that was right-clicked. Falls back to just the right-clicked
  // account when nothing else is checked, same as ids() above but resolved
  // to full Account records (not just ids) since Copy Data needs the fields.
  const selected = selectedIds()
  const targetAccounts = selected.length > 0
    ? allAccounts.filter((a) => selected.includes(a.id))
    : [account]
  const targetIds = targetAccounts.map((a) => a.id)
  const targetCount = targetAccounts.length

  /**
   * Single account: generate the live 6-digit TOTP from its 2FA secret and
   * copy just the code. Multiple selected accounts: there's no single "the"
   * code to generate (each account's TOTP is time-synced independently and
   * would go stale by the time it's pasted elsewhere anyway) — copy the raw
   * secrets instead, one per line, same as the other batch Copy Data fields.
   */
  const copy2FACode = async (): Promise<void> => {
    if (targetAccounts.length > 1) {
      const text = targetAccounts.map((a) => a.two_fa || '').join('\n')
      await copy(text, showToast)
      showToast(`Copied ${targetAccounts.length} item(s) to clipboard!`)
      return
    }
    if (!account.two_fa) {
      showToast('No 2FA secret set for this account')
      return
    }
    const code = await generateTOTP(account.two_fa)
    if (!code) {
      showToast('Invalid 2FA secret — could not generate code')
      return
    }
    await window.api.system.clipboardWriteText(code).catch(() => void 0)
    showToast(`Copied 2FA Code: ${code} (Valid for ~${secondsRemaining()}s)`)
  }

  // Close on outside-click / Escape. A click inside a portaled submenu panel
  // must NOT count as "outside" — those panels render via createPortal onto
  // document.body and are not DOM descendants of `ref`, so without the
  // portalNodesRef check every submenu click (Copy Data, Move to Folder...)
  // was closing the whole menu on mousedown before the Item's own onClick
  // (which fires later, on the click event) ever ran.
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      for (const node of portalNodesRef.current) {
        if (node.contains(target)) return
      }
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let nx = x
    let ny = y
    if (x + rect.width > window.innerWidth) nx = window.innerWidth - rect.width - 6
    if (y + rect.height > window.innerHeight) ny = window.innerHeight - rect.height - 6
    setPos({ x: Math.max(4, nx), y: Math.max(4, ny) })
  }, [x, y])

  // ---- automation actions (main-process Playwright / IMAP) ----------------
  /**
   * Opens one headed browser per target account, sequentially, each assigned
   * an incrementing slotIndex so the windows tile across the screen (see
   * browserContext.ts's tilePosition()) instead of stacking at the same
   * default position. Single-account right-click still goes through this —
   * targetAccounts is just [account] in that case, slotIndex 0.
   */
  const openChromeProfile = async (): Promise<void> => {
    const accountsToOpen = targetAccounts
    showToast(
      accountsToOpen.length > 1
        ? `Opening ${accountsToOpen.length} Chrome profile(s)…`
        : `Launching browser for ${accountsToOpen[0]?.uid ?? accountsToOpen[0]?.email}…`
    )
    let succeeded = 0
    let failed = 0
    for (let i = 0; i < accountsToOpen.length; i++) {
      const res = await window.api.automation.openProfile(accountsToOpen[i].id, i)
      if (res.ok) succeeded += 1
      else failed += 1
    }
    showToast(
      accountsToOpen.length > 1
        ? `Opened ${succeeded}/${accountsToOpen.length} Chrome profile(s)${failed ? `, ${failed} failed` : ''}.`
        : succeeded
          ? 'Browser Active'
          : 'Browser failed to open'
    )
    await refresh()
  }

  const checkLiveDie = async (): Promise<void> => {
    showToast('Checking Live / Die status…')
    const res = await window.api.automation.checkLive(account.id)
    showToast(`Status: ${res.status}${res.detail ? ` — ${res.detail}` : ''}`)
    await refresh()
  }

  const unlock282 = async (): Promise<void> => {
    showToast(`Unlocking Checkpoint 282 for ${account.uid ?? account.email}…`)
    const summary = await window.api.automation.unlock282(ids())
    showToast(
      `Unlock 282: ${summary.succeeded}/${summary.total} resolved to Live, ${summary.failed} still Checkpoint.`,
      6000
    )
    await refresh()
  }

  const downloadAvatarFast = async (): Promise<void> => {
    const targets = ids()
    showToast(`Downloading ${targets.length} avatar(s) (fast, no browser)…`)
    const summary = await window.api.avatars.downloadBatch(targets)
    showToast(
      `Avatars: ${summary.succeeded}/${summary.total} downloaded${summary.failed ? `, ${summary.failed} failed` : ''}.`,
      6000
    )
    await refresh()
  }

  const getMailOtp = async (): Promise<void> => {
    showToast('Fetching Mail OTP (Inbox + Spam)…', 8000)
    const res = await window.api.automation.getMailOtp(account.id)
    if (res.success && res.code) {
      await window.api.system.clipboardWriteText(res.code).catch(() => void 0)
      const where = res.folder && res.folder !== 'INBOX' ? ` (found in ${res.folder})` : ''
      showToast(`Mail OTP: ${res.code} copied to clipboard!${where}`)
    } else {
      // Show the full, actionable diagnostic longer so it can be read.
      showToast(res.error ?? 'Mail OTP failed: unknown error', 9000)
    }
    await refresh()
  }

  const run = (fn: () => void | Promise<void>): (() => void) => {
    return () => {
      void fn()
      onClose()
    }
  }

  /**
   * Explicitly check/uncheck exactly the rows currently highlighted (drag-
   * selected or checkbox-selected — `ids()` returns whichever is active),
   * leaving every other row's checked state untouched. Distinct from
   * "select just this row" (right-click on an unselected row) or "select
   * all" — this always targets the full highlighted set.
   */
  const checkSelected = (): void => {
    const targets = ids()
    const next = { ...rowSelection }
    for (const id of targets) next[id] = true
    setRowSelection(next)
  }
  const uncheckSelected = (): void => {
    const targets = ids()
    const next = { ...rowSelection }
    for (const id of targets) next[id] = false
    setRowSelection(next)
  }

  const clearNotes = async (): Promise<void> => {
    const targets = ids()
    const n = await window.api.accounts.bulkSetField('notes', targets, '')
    showToast(`Cleared notes on ${n} account(s).`)
    await refresh()
  }

  const clearActivityStatus = async (): Promise<void> => {
    const targets = ids()
    const n = await window.api.accounts.bulkSetField('live_status', targets, '')
    showToast(`Cleared activity status on ${n} account(s).`)
    await refresh()
  }

  /** Joins one field across all target accounts with newlines, copies, and toasts the item count. */
  const copyField = async (pick: (a: Account) => string | null | undefined): Promise<void> => {
    const text = targetAccounts.map((a) => pick(a) ?? '').join('\n')
    try {
      await window.api.system.clipboardWriteText(text)
      showToast(`Copied ${targetCount} item(s) to clipboard!`)
    } catch {
      showToast('Copy failed')
    }
  }

  const fullLineFor = (a: Account): string =>
    [a.uid, a.password, a.two_fa, a.email, a.email_pass, a.cookie, a.proxy]
      .map((v) => v ?? '')
      .join('|')

  return (
    <div
      ref={ref}
      className="fixed z-50 select-none rounded border border-slate-400 bg-white py-1 shadow-2xl"
      style={{ left: pos.x, top: pos.y, width: MENU_W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Item
        icon={LogIn}
        label="Run Auto Login (Single)"
        onClick={run(() => runSingleLogin(account.id))}
      />
      <Item
        icon={Globe}
        label={targetCount > 1 ? `Open Chrome Profiles (${targetCount})` : 'Open Chrome Profile'}
        onClick={run(openChromeProfile)}
      />
      <Item
        icon={Zap}
        label="Check Live / Die Status"
        onClick={run(checkLiveDie)}
      />
      <Item
        icon={ImageDown}
        label="Download Avatar (Fast / No Browser)"
        onClick={run(downloadAvatarFast)}
      />
      {/* Always shown regardless of the account's current status — a
          checkpoint isn't always reflected accurately in status_detail (a
          stale/manual status edit, or a check that hasn't run since it
          happened), so gating this on status === 'Checkpoint' could hide it
          exactly when it's needed. Facebook itself decides whether there's
          actually anything to resolve when the account is opened. */}
      <Submenu
        label="Unlock / Checkpoint Tools"
        icon={Unlock}
        width={260}
        registerPortalNode={registerPortalNode}
      >
        <Item
          icon={Unlock}
          label="Unlock Checkpoint 282 (Auto)"
          onClick={run(unlock282)}
        />
        <Item
          icon={Globe}
          label="Resolve Checkpoint 282 (Open Browser / Manual)"
          onClick={run(openChromeProfile)}
        />
      </Submenu>
      <Item
        icon={KeyRound}
        label="Get 2FA Code (Copy)"
        onClick={run(copy2FACode)}
      />
      <Item icon={Mail} label="Get Mail OTP (IMAP)" onClick={run(getMailOtp)} />

      <Sep />

      {/* Copy Data submenu — every entry maps over targetAccounts (the full
          checked/selected set, or just the right-clicked row if nothing else
          is checked) and joins with newlines, so copying with multiple rows
          selected pastes one value per line in row order. */}
      <Submenu label="Copy Data" icon={Copy} width={168} registerPortalNode={registerPortalNode}>
        <Item icon={Copy} label="Copy UID" onClick={run(() => copyField((a) => a.uid))} />
        <Item icon={Copy} label="Copy Pass" onClick={run(() => copyField((a) => a.password))} />
        <Item icon={Copy} label="Copy 2FA Code" onClick={run(copy2FACode)} />
        <Item icon={Copy} label="Copy Email" onClick={run(() => copyField((a) => a.email))} />
        <Item
          icon={Copy}
          label="Copy Full Line"
          onClick={run(() => copyField((a) => fullLineFor(a)))}
        />
      </Submenu>

      {/* Move to Folder submenu */}
      <Submenu
        label="Move to Folder..."
        icon={FolderInput}
        width={200}
        registerPortalNode={registerPortalNode}
      >
        {folders.length === 0 && (
          <div className="px-2.5 py-1.5 text-[12px] text-slate-400">No folders</div>
        )}
        {folders.map((f) => (
          <Item
            key={f.id}
            icon={FolderInput}
            label={`${f.name} [${f.account_count}]`}
            onClick={run(async () => {
              await moveToFolder(targetIds, f.id)
              showToast(`Moved ${targetIds.length} account(s) to ${f.name}`)
            })}
          />
        ))}
      </Submenu>

      <Sep />

      <Item
        icon={Download}
        label="Export Accounts..."
        onClick={run(openExportModal)}
      />
      <Item
        icon={Pencil}
        label="Edit Account Info"
        onClick={run(() => openEditAccount(account))}
      />
      <Item
        icon={Sparkles}
        label="🧹 Clean Profile Storage..."
        onClick={run(() => openCleanProfile(targetIds))}
      />

      <Sep />

      <Item
        icon={CheckSquare}
        label="Check Selected Rows (from Highlight)"
        onClick={run(checkSelected)}
      />
      <Item
        icon={Square}
        label="Uncheck Selected Rows (from Highlight)"
        onClick={run(uncheckSelected)}
      />
      <Item
        icon={StickyNote}
        label="Set Notes (Batch)"
        onClick={run(() => openSetNotes(ids()))}
      />
      <Item icon={Eraser} label="Clear Notes (Batch)" onClick={run(clearNotes)} />
      <Item
        icon={RotateCcw}
        label="Clear Activity Status (Batch)"
        onClick={run(clearActivityStatus)}
      />

      <Sep />

      <Item
        icon={Trash2}
        label={`Move to Recycle Bin (${ids().length})`}
        danger
        onClick={run(() => {
          const targets = ids()
          if (confirm(`Move ${targets.length} account(s) to the Recycle Bin?`)) {
            return remove(targets)
          }
        })}
      />
    </div>
  )
}
