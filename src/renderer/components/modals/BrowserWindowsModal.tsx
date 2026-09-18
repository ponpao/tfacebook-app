// ---------------------------------------------------------------------------
// BrowserWindowsModal.tsx — grid of phone-shaped tiles, one per currently-
// open automation browser window. Rendered inside its own separate OS
// window (see windows/browserWindowsPanel.ts + App.tsx's BrowserWindowsPanelApp
// branch) — Windows itself handles that window's drag/resize/minimize/
// maximize via its native frame, so this component just fills the window's
// content area rather than drawing its own draggable/resizable panel chrome.
//
// App Mode windows (headless, no OS window — see browserContext.ts/
// playwrightManager.ts) render as a live, interactive tile: a continuous CDP
// screencast the user can click/type on directly, forwarded into the same
// page via CDP Input.dispatch* (see screencast.ts). Browser View windows
// (real headed OS windows) keep the periodic-screenshot preview tile with
// Focus/Close, since Focus still means something for those. Tiles can be
// dragged to reorder and resized (normal/large) within the grid.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react'
import { AppWindow, ArrowLeft, ArrowRight, Home, Maximize2, Minimize2, RotateCw, Smartphone, X } from 'lucide-react'
import type { TrackedWindowInfo, WindowSnapshot } from '../../../types/ipc'

/** "https://web.facebook.com/profile.php?id=..." -> "web.facebook.com" for the tile's compact fake address bar. */
function displayHost(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

const LIST_POLL_MS = 2000
// Slower than the list poll — a screenshot round-trip is far heavier per
// tick than the plain metadata list, and a stale-by-a-couple-seconds
// thumbnail is a fine tradeoff for not hammering every open Browser View
// window's page. App Mode tiles don't use this at all — they get a
// continuous CDP screencast instead (see InteractiveTile below).
const SCREENSHOT_POLL_MS = 4000

/** Maps a single-character key produced by a keydown event to the CDP `code` field DOM convention roughly enough for typing in a text field — good enough for the App Mode tile's use case (filling login/2FA forms), not a full keyboard-layout emulation. */
function keyToCode(key: string): string {
  if (key.length === 1 && /[a-zA-Z]/.test(key)) return `Key${key.toUpperCase()}`
  if (key.length === 1 && /[0-9]/.test(key)) return `Digit${key}`
  const named: Record<string, string> = {
    Enter: 'Enter',
    Backspace: 'Backspace',
    Tab: 'Tab',
    ' ': 'Space',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    Delete: 'Delete',
    Escape: 'Escape'
  }
  return named[key] ?? key
}

function TileFrame({
  chromeStrip,
  rowNumber,
  accountName,
  large,
  busy,
  onToggleSize,
  onGoBack,
  onGoHome,
  onReload,
  onClose,
  dragHandleProps,
  children
}: {
  chromeStrip: React.ReactNode
  rowNumber: number | undefined
  accountName: string
  large: boolean
  busy: boolean
  onToggleSize: () => void
  onGoBack: () => void
  onGoHome: () => void
  onReload: () => void
  onClose: () => void
  dragHandleProps: React.HTMLAttributes<HTMLDivElement>
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className="flex flex-col overflow-hidden rounded-2xl border border-edge bg-surface-sunken"
      style={large ? { gridColumn: 'span 2', gridRow: 'span 2' } : undefined}
    >
      <div {...dragHandleProps} className="flex cursor-move items-center gap-1 border-b border-edge bg-surface px-1.5 py-1">
        {chromeStrip}
      </div>
      <div className="relative w-full flex-1 overflow-hidden bg-black" style={{ aspectRatio: large ? undefined : '9 / 19' }}>
        {children}
        <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white">
          {rowNumber ?? '—'}
        </span>
      </div>
      <div className="flex flex-col gap-1 p-1.5">
        <span className="truncate text-[11px] text-ink" title={accountName}>
          {accountName}
        </span>
        {/* Android-style nav row (Back/Home) — matches the reference
            screen-mirroring tool's phone chrome. Recent-apps is omitted:
            there's no real equivalent for a single Chrome tab showing a
            website. */}
        <div className="flex gap-1">
          <button
            className="win-btn h-[22px] flex-1 justify-center px-1 text-[10px]"
            onClick={onGoBack}
            disabled={busy}
            title="Back"
          >
            <ArrowLeft size={11} className="text-ink-muted" />
          </button>
          <button
            className="win-btn h-[22px] flex-1 justify-center px-1 text-[10px]"
            onClick={onGoHome}
            disabled={busy}
            title="Home (Facebook feed)"
          >
            <Home size={11} className="text-ink-muted" />
          </button>
        </div>
        <div className="flex gap-1">
          <button
            className="win-btn h-[22px] flex-1 justify-center px-1 text-[10px]"
            onClick={onReload}
            disabled={busy}
            title="Reload this phone's page — use this if a tile is stuck or blank"
          >
            <RotateCw size={11} className="text-accent" />
          </button>
          <button
            className="win-btn h-[22px] flex-1 justify-center px-1 text-[10px]"
            onClick={onToggleSize}
            title={large ? 'Shrink tile' : 'Enlarge tile'}
          >
            {large ? <Minimize2 size={11} className="text-accent" /> : <Maximize2 size={11} className="text-accent" />}
          </button>
          <button
            className="win-btn h-[22px] flex-1 justify-center px-1 text-[10px]"
            onClick={onClose}
            title="Close this window"
          >
            <X size={11} className="text-[#c81e1e]" />
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * A Browser View window — real headed OS window, so the tile is a
 * periodic-screenshot preview (SCREENSHOT_POLL_MS) with a decorative
 * address-bar strip; Focus is meaningful here (brings the real window
 * forward), unlike an App Mode tile which has no OS window to focus.
 */
function PreviewTile(props: {
  w: TrackedWindowInfo
  snapshot: WindowSnapshot | undefined
  large: boolean
  busy: boolean
  onToggleSize: () => void
  onGoBack: () => void
  onGoHome: () => void
  onReload: () => void
  onFocus: () => void
  onClose: () => void
  dragHandleProps: React.HTMLAttributes<HTMLDivElement>
}): React.JSX.Element {
  const { w, snapshot, large, busy, onToggleSize, onGoBack, onGoHome, onReload, onFocus, onClose, dragHandleProps } =
    props
  return (
    <TileFrame
      rowNumber={w.rowNumber}
      accountName={w.accountName}
      large={large}
      busy={busy}
      onToggleSize={onToggleSize}
      onGoBack={onGoBack}
      onGoHome={onGoHome}
      onReload={onReload}
      onClose={onClose}
      dragHandleProps={dragHandleProps}
      chromeStrip={
        <>
          <ArrowLeft size={10} className="shrink-0 text-ink-muted" />
          <ArrowRight size={10} className="shrink-0 text-ink-muted" />
          <span className="ml-0.5 truncate rounded-full bg-surface-sunken px-1.5 py-0.5 text-[9px] text-ink-muted">
            {snapshot ? displayHost(snapshot.url) : '—'}
          </span>
          <button
            className="ml-auto shrink-0 text-[9px] text-accent hover:underline"
            onClick={(e) => {
              e.stopPropagation()
              onFocus()
            }}
            disabled={busy}
            title="Bring this window to the front"
          >
            Focus
          </button>
        </>
      }
    >
      {snapshot ? (
        <img src={snapshot.dataUrl} alt="" className="h-full w-full object-cover object-top" />
      ) : (
        <div className="flex h-full items-center justify-center text-ink-muted">
          <Smartphone size={28} />
        </div>
      )}
    </TileFrame>
  )
}

/**
 * An App Mode window — headless, no OS window at all. Streams a live CDP
 * screencast into an <img> and forwards the tile's own pointer/keyboard
 * events into the same page (see screencast.ts's dispatchTap/dispatchKey/
 * dispatchScroll), so the tile behaves as a genuine embedded remote control
 * for that phone screen rather than a read-only preview.
 */
function InteractiveTile({
  w,
  large,
  busy,
  onToggleSize,
  onGoBack,
  onGoHome,
  onReload,
  onClose,
  dragHandleProps
}: {
  w: TrackedWindowInfo
  large: boolean
  busy: boolean
  onToggleSize: () => void
  onGoBack: () => void
  onGoHome: () => void
  onReload: () => void
  onClose: () => void
  dragHandleProps: React.HTMLAttributes<HTMLDivElement>
}): React.JSX.Element {
  const [frame, setFrame] = useState<string | null>(null)
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.automation.startScreencast(w.key).then((res) => {
      if (!cancelled) setViewport(res.viewport)
    })
    const unsubscribe = window.api.automation.onScreencastFrame(({ key, dataUrl }) => {
      if (key === w.key) setFrame(dataUrl)
    })
    return () => {
      cancelled = true
      unsubscribe()
      void window.api.automation.stopScreencast(w.key)
    }
    // Deliberately excludes w.key changing mid-lifetime — a tile's key is
    // stable for its whole mount (React's `key` prop on the parent already
    // forces a remount if it ever changed), so this effect only needs to
    // run once per mount/unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Scales a click's position within the rendered <img> up to the page's real viewport CSS-pixel coordinates. */
  const scalePoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = imgRef.current
    if (!el || !viewport) return null
    const rect = el.getBoundingClientRect()
    const relX = (clientX - rect.left) / rect.width
    const relY = (clientY - rect.top) / rect.height
    if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return null
    return { x: relX * viewport.width, y: relY * viewport.height }
  }

  const handleClick = (e: React.MouseEvent<HTMLImageElement>): void => {
    const point = scalePoint(e.clientX, e.clientY)
    if (point) void window.api.automation.dispatchTap(w.key, point.x, point.y)
  }

  const handleWheel = (e: React.WheelEvent<HTMLImageElement>): void => {
    // Without this, the wheel event also bubbles up and scrolls the panel's
    // own tile grid underneath at the same time — scrolling a phone tile
    // must stay scoped to that tile's page, not the surrounding UI.
    e.preventDefault()
    e.stopPropagation()
    const point = scalePoint(e.clientX, e.clientY)
    if (point) void window.api.automation.dispatchScroll(w.key, point.x, point.y, e.deltaX, e.deltaY)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // Let modal-level shortcuts (Escape-to-close, Tab-to-next-field-in-the-
    // MODAL-itself) pass through untouched — only forward keys a phone
    // keyboard would actually produce.
    if (e.key === 'Escape') return
    e.preventDefault()
    const code = keyToCode(e.key)
    void window.api.automation.dispatchKey(w.key, { type: 'keyDown', key: e.key, code })
    if (e.key.length === 1) {
      void window.api.automation.dispatchKey(w.key, { type: 'char', key: e.key, code, text: e.key })
    }
  }

  const handleKeyUp = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') return
    void window.api.automation.dispatchKey(w.key, { type: 'keyUp', key: e.key, code: keyToCode(e.key) })
  }

  return (
    <TileFrame
      rowNumber={w.rowNumber}
      accountName={w.accountName}
      large={large}
      busy={busy}
      onToggleSize={onToggleSize}
      onGoBack={onGoBack}
      onGoHome={onGoHome}
      onReload={() => {
        // Clear the stale frame immediately so the tile visibly shows it's
        // reloading rather than appearing to do nothing until the first
        // post-reload screencast frame arrives.
        setFrame(null)
        onReload()
      }}
      onClose={onClose}
      dragHandleProps={dragHandleProps}
      chromeStrip={
        <span className="flex items-center gap-1 text-[9px] font-semibold text-accent">
          <Smartphone size={10} />
          App Mode — live
        </span>
      }
    >
      {frame ? (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
        <img
          ref={imgRef}
          src={frame}
          alt=""
          tabIndex={0}
          className="h-full w-full cursor-pointer object-cover object-top outline-none"
          style={{ touchAction: 'none' }}
          onClick={handleClick}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          title="Click to focus, then click/type to control this phone directly"
        />
      ) : (
        <div className="flex h-full items-center justify-center text-ink-muted">
          <Smartphone size={28} className="animate-pulse" />
        </div>
      )}
    </TileFrame>
  )
}

export function BrowserWindowsModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const [windows, setWindows] = useState<TrackedWindowInfo[]>([])
  const [snapshots, setSnapshots] = useState<Record<string, WindowSnapshot>>({})
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [order, setOrder] = useState<string[]>([])
  const [largeKeys, setLargeKeys] = useState<Record<string, boolean>>({})
  const dragKeyRef = useRef<string | null>(null)
  // Local inline status line — this component runs inside its own separate
  // BrowserWindow/renderer process (see windows/browserWindowsPanel.ts), so
  // the main window's useAccountStore/ToastStack aren't available here; a
  // fresh Zustand instance in this process would just be an unseen no-op.
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const showStatus = (msg: string): void => {
    setStatusMessage(msg)
    setTimeout(() => setStatusMessage((cur) => (cur === msg ? null : cur)), 4000)
  }

  const load = async (): Promise<void> => {
    const rows = await window.api.automation.listWindows()
    setWindows(rows)
    // Append any newly-opened window's key to the end of the drag order,
    // and drop keys for windows that have since closed — preserves the
    // user's manual drag arrangement across poll ticks instead of
    // resetting to sorted-by-row-number every 2s.
    setOrder((prev) => {
      const known = new Set(rows.map((r) => r.key))
      const kept = prev.filter((k) => known.has(k))
      const missing = rows.map((r) => r.key).filter((k) => !kept.includes(k))
      return [...kept, ...missing]
    })
  }

  useEffect(() => {
    if (!open) return
    void load()
    // Polls so a window closed by the user directly (its own X button, or
    // Alt+F4) disappears from this grid without needing a manual refresh —
    // this app has no main-process "window closed" push event wired to the
    // renderer for these separate Chromium processes.
    const timer = setInterval(() => void load(), LIST_POLL_MS)
    return () => clearInterval(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const loadSnapshots = async (): Promise<void> => {
      const shots = await window.api.automation.screenshotWindows()
      setSnapshots(shots)
    }
    void loadSnapshots()
    const timer = setInterval(() => void loadSnapshots(), SCREENSHOT_POLL_MS)
    return () => clearInterval(timer)
  }, [open])

  const focus = async (w: TrackedWindowInfo): Promise<void> => {
    setBusyKey(w.key)
    try {
      const res = await window.api.automation.focusWindow(w.key)
      if (!res.ok) showStatus(`Could not focus "${w.accountName}" — it may have just closed.`)
    } finally {
      setBusyKey(null)
    }
  }

  const closeWindow = async (w: TrackedWindowInfo): Promise<void> => {
    setBusyKey(w.key)
    try {
      const res = await window.api.automation.closeWindow(w.key)
      if (res.ok) {
        // Optimistic removal — don't wait for the next poll tick.
        setWindows((prev) => prev.filter((x) => x.key !== w.key))
        setOrder((prev) => prev.filter((k) => k !== w.key))
      } else {
        showStatus(`Could not close "${w.accountName}" — it may have already closed.`)
      }
    } finally {
      setBusyKey(null)
    }
  }

  const reloadWindow = async (w: TrackedWindowInfo): Promise<void> => {
    setBusyKey(w.key)
    try {
      const res = await window.api.automation.reloadWindow(w.key)
      if (!res.ok) showStatus(`Could not reload "${w.accountName}" — it may have closed.`)
    } finally {
      setBusyKey(null)
    }
  }

  const goBackWindow = async (w: TrackedWindowInfo): Promise<void> => {
    setBusyKey(w.key)
    try {
      const res = await window.api.automation.goBackWindow(w.key)
      if (!res.ok) showStatus(`Could not go back on "${w.accountName}".`)
    } finally {
      setBusyKey(null)
    }
  }

  const goHomeWindow = async (w: TrackedWindowInfo): Promise<void> => {
    setBusyKey(w.key)
    try {
      const res = await window.api.automation.goHomeWindow(w.key)
      if (!res.ok) showStatus(`Could not go home on "${w.accountName}".`)
    } finally {
      setBusyKey(null)
    }
  }

  const toggleSize = (key: string): void => {
    setLargeKeys((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const byKey = new Map(windows.map((w) => [w.key, w]))
  const sorted = order.map((k) => byKey.get(k)).filter((w): w is TrackedWindowInfo => w !== undefined)

  const dragHandlePropsFor = (key: string): React.HTMLAttributes<HTMLDivElement> => ({
    draggable: true,
    onDragStart: () => {
      dragKeyRef.current = key
    },
    onDragOver: (e) => e.preventDefault(),
    onDrop: (e) => {
      e.preventDefault()
      const draggedKey = dragKeyRef.current
      dragKeyRef.current = null
      if (!draggedKey || draggedKey === key) return
      setOrder((prev) => {
        const next = prev.filter((k) => k !== draggedKey)
        const dropIndex = next.indexOf(key)
        next.splice(dropIndex, 0, draggedKey)
        return next
      })
    }
  })

  if (!open) return null

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-edge bg-surface-sunken px-3 py-2">
        <div className="flex items-center gap-2">
          <AppWindow size={16} className="text-accent" />
          <h2 className="text-[13px] font-semibold text-ink">Browser Windows</h2>
        </div>
        {statusMessage && <span className="truncate text-[11px] text-ink-muted">{statusMessage}</span>}
      </div>

      <div className="flex-1 overflow-hidden">
        {sorted.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-ink-muted">
            No browser windows are currently open.
          </div>
        ) : (
          <div
            className="grid h-full gap-3 overflow-y-auto p-3"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gridAutoRows: 'min-content' }}
          >
            {sorted.map((w) =>
              w.viewMode === 'app' ? (
                <InteractiveTile
                  key={w.key}
                  w={w}
                  large={!!largeKeys[w.key]}
                  busy={busyKey === w.key}
                  onToggleSize={() => toggleSize(w.key)}
                  onGoBack={() => void goBackWindow(w)}
                  onGoHome={() => void goHomeWindow(w)}
                  onReload={() => void reloadWindow(w)}
                  onClose={() => void closeWindow(w)}
                  dragHandleProps={dragHandlePropsFor(w.key)}
                />
              ) : (
                <PreviewTile
                  key={w.key}
                  w={w}
                  snapshot={snapshots[w.key]}
                  large={!!largeKeys[w.key]}
                  busy={busyKey === w.key}
                  onToggleSize={() => toggleSize(w.key)}
                  onGoBack={() => void goBackWindow(w)}
                  onGoHome={() => void goHomeWindow(w)}
                  onReload={() => void reloadWindow(w)}
                  onFocus={() => void focus(w)}
                  onClose={() => void closeWindow(w)}
                  dragHandleProps={dragHandlePropsFor(w.key)}
                />
              )
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-edge bg-surface-sunken px-3 py-1.5">
        <span className="text-[11px] text-ink-muted">{windows.length} window(s) open</span>
        <button className="win-btn h-[24px] px-2 py-0 text-[11px]" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
