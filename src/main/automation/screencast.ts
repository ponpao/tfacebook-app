// ---------------------------------------------------------------------------
// screencast.ts — live interactive view for App Mode tiles in the Browser
// Windows panel: streams the tracked window's page as a continuous CDP
// screencast (replacing periodic page.screenshot() polling) and forwards
// the tile's own pointer/keyboard events back into the same page via CDP
// Input.dispatch*, so the user can click/type directly on the tile as if it
// were the phone screen itself.
//
// One CDP session per tracked key, shared between the screencast stream and
// every input-dispatch call for that key — opening a fresh session per
// input event would be wasteful and (per CDP semantics) unnecessary, since
// a session stays valid for the page's lifetime once attached.
// ---------------------------------------------------------------------------
import type { CDPSession } from 'playwright'
import { getTrackedContext } from './browserContext'
import { reloadTrackedWindow } from './windowManager'

interface StreamHandle {
  cdp: CDPSession
  onFrame: (dataUrl: string) => void
}

const activeStreams = new Map<string, StreamHandle>()

/**
 * Opens (or reuses) the shared CDP session for a tracked key. Reused by both
 * startScreencast and every dispatch* function below, so input keeps working
 * against the exact same session the screencast is running on.
 */
async function getOrCreateSession(key: string): Promise<CDPSession | null> {
  const existing = activeStreams.get(key)
  if (existing) return existing.cdp

  const context = getTrackedContext(key)
  const page = context?.pages()[0]
  if (!page) return null

  const cdp = await context!.newCDPSession(page)
  activeStreams.set(key, { cdp, onFrame: () => {} })
  // If the underlying context closes while we still hold a session, drop it
  // — a stale session would otherwise leak and any future dispatch call
  // would try (and fail) to talk to a session Chromium has already torn down.
  context!.once('close', () => activeStreams.delete(key))
  return cdp
}

/**
 * Starts a live screencast for a tracked window — `onFrame` is called with a
 * fresh JPEG data URL every time the page's content changes (Chromium only
 * sends a new frame when something actually changed, not on a fixed
 * interval, so this is both more responsive and cheaper than the old
 * poll-a-screenshot-every-4s approach it replaces for App Mode tiles).
 *
 * Idempotent — a second call for a key already streaming just swaps the
 * frame callback (used when a tile remounts, e.g. after a drag-reorder)
 * rather than opening a duplicate CDP session/screencast.
 *
 * Returns a stop function; the caller (the tile's own effect cleanup) MUST
 * call it when done, or the screencast + its CDP session keeps running
 * (and Chromium keeps encoding/sending frames) after nothing is listening.
 */
export async function startScreencast(
  key: string,
  onFrame: (dataUrl: string) => void
): Promise<(() => Promise<void>) | null> {
  const existing = activeStreams.get(key)
  if (existing) {
    existing.onFrame = onFrame
    return () => stopScreencast(key)
  }

  const cdp = await getOrCreateSession(key)
  if (!cdp) return null

  const handle: StreamHandle = { cdp, onFrame }
  activeStreams.set(key, handle)

  let gotFirstFrame = false
  cdp.on('Page.screencastFrame', (event) => {
    // Chromium requires the ack before it sends another frame — missing
    // this is not a cosmetic bug, the stream silently stalls after exactly
    // one frame otherwise. Ack even if the tile's onFrame callback has
    // since been swapped/removed (checked via activeStreams, not a stale
    // closure over the original `onFrame` param) so a still-open session
    // never grinds to a halt just because a re-render replaced the handler.
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => void 0)
    gotFirstFrame = true
    const current = activeStreams.get(key)
    current?.onFrame(`data:image/jpeg;base64,${event.data}`)
  })

  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 50, everyNthFrame: 1 })

  // Rarely, a session attached right as the page is mid-paint never gets its
  // first frame at all (Chromium only pushes a NEW frame on a compositor
  // change — if nothing changes after the stream starts, nothing arrives).
  // One retry via reloadTrackedWindow covers this: a fresh navigation always
  // repaints, guaranteeing at least one frame. Only fires if truly nothing
  // arrived in the window — a slow-but-eventually-arriving first frame is
  // left alone.
  setTimeout(() => {
    if (!gotFirstFrame && activeStreams.get(key) === handle) {
      void reloadTrackedWindow(key)
    }
  }, 4000)

  return () => stopScreencast(key)
}

/** Stops a tracked window's screencast and detaches its CDP session. Safe to call even if nothing is streaming for that key. */
export async function stopScreencast(key: string): Promise<void> {
  const handle = activeStreams.get(key)
  if (!handle) return
  activeStreams.delete(key)
  try {
    await handle.cdp.send('Page.stopScreencast')
  } catch {
    /* session may already be gone if the window closed */
  }
  await handle.cdp.detach().catch(() => void 0)
}

/**
 * Simulates a tap/click at (x, y) — CSS pixels in the page's own viewport
 * coordinate space (the renderer is responsible for scaling from the tile's
 * rendered size up to this before calling). Touch events are used rather
 * than mouse events because every App Mode device preset reports
 * isMobile/hasTouch: true (see browserContext.ts's MOBILE_DEVICE_NAMES) —
 * real Android Chrome's own UI (and Facebook's mobile site) listens for
 * touch, not synthetic mouse clicks, so a mouse-only dispatch would miss or
 * misbehave on touch-only interaction patterns real phones actually use.
 */
export async function dispatchTap(key: string, x: number, y: number): Promise<void> {
  const cdp = await getOrCreateSession(key)
  if (!cdp) return
  const point = { x, y, radiusX: 5, radiusY: 5, force: 1 }
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } catch {
    /* best-effort — the page may have navigated/closed mid-dispatch */
  }
}

/** Forwards a scroll/wheel gesture at (x, y) — same viewport coordinate space as dispatchTap. */
export async function dispatchScroll(
  key: string,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number
): Promise<void> {
  const cdp = await getOrCreateSession(key)
  if (!cdp) return
  try {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY })
  } catch {
    /* best-effort */
  }
}

/**
 * Forwards one keyboard event. `text` (the character actually produced,
 * accounting for shift/layout) is required for 'char' events and ignored
 * for keyDown/keyUp, matching CDP's own Input.dispatchKeyEvent contract.
 */
export async function dispatchKey(
  key: string,
  event: { type: 'keyDown' | 'keyUp' | 'char'; key: string; code: string; text?: string }
): Promise<void> {
  const cdp = await getOrCreateSession(key)
  if (!cdp) return
  try {
    await cdp.send('Input.dispatchKeyEvent', {
      type: event.type,
      key: event.key,
      code: event.code,
      text: event.type === 'char' ? event.text : undefined
    })
  } catch {
    /* best-effort */
  }
}
