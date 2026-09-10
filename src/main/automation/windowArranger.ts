// ---------------------------------------------------------------------------
// windowArranger.ts — repositions/resizes every currently-open headed
// browser window (tracked Playwright contexts, see browserContext.ts's
// getAllTrackedContexts()) into a tiled or split-screen layout on demand.
//
// This is UI/window-placement logic only — it never touches login, cookie,
// stealth-injection, or DB code. Each browser window is moved via the
// Chrome DevTools Protocol's Browser.setWindowBounds, the standard way to
// reposition an already-launched Chromium window (Playwright's own
// --window-position/--window-size launch args only set the INITIAL
// position; there's no post-launch move via Playwright's own API surface,
// hence going through CDP directly here).
// ---------------------------------------------------------------------------
import { screen } from 'electron'
import { getAllTrackedContexts } from './browserContext'

export type ArrangeLayout =
  | 'grid5x2'
  | 'grid4x2'
  | 'leftHalf'
  | 'rightHalf'
  | 'maximized'
  | 'restore'

interface Bounds {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Compute bounds for window index `i` in a `cols x rows` grid confined to
 * the horizontal span [xOffset, xOffset + spanW) of the work area — used
 * directly for the two full-width grids (xOffset 0, spanW = full screen).
 *
 * Strict modulo wrap-around: once every slot (0 .. cols*rows - 1) is filled,
 * the next window loops back and lands on EXACTLY the same bounds as the
 * window already occupying that slot — no staggered offset. E.g. for a 4x2
 * grid (capacity 8), window index 8 (the 9th window) computes `8 % 8 = 0`
 * and gets identical bounds to window index 0; window 16 (the 17th) also
 * lands back on slot 0. Same for 5x2 (capacity 10): index 10 (11th window)
 * and index 20 (21st window) both land on slot 0.
 */
function gridBounds(i: number, cols: number, rows: number, xOffset: number, spanW: number, screenH: number): Bounds {
  const totalSlots = cols * rows
  const slot = i % totalSlots
  const colIndex = slot % cols
  const rowIndex = Math.floor(slot / cols)

  const winW = Math.floor(spanW / cols)
  const winH = Math.floor(screenH / rows)

  return {
    left: xOffset + colIndex * winW,
    top: rowIndex * winH,
    width: winW,
    height: winH
  }
}

function computeBoundsForLayout(layout: ArrangeLayout, index: number): Bounds {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workArea
  const { x: screenX, y: screenY } = screen.getPrimaryDisplay().workArea

  switch (layout) {
    case 'grid5x2': {
      const b = gridBounds(index, 5, 2, 0, screenW, screenH)
      return { ...b, left: b.left + screenX, top: b.top + screenY }
    }
    case 'grid4x2': {
      const b = gridBounds(index, 4, 2, 0, screenW, screenH)
      return { ...b, left: b.left + screenX, top: b.top + screenY }
    }
    case 'leftHalf': {
      // Full-half stack (not a mini-tile grid): every window gets the exact
      // same bounds — the whole left half, full workArea height — and they
      // stack directly on top of one another. Whichever one is focused
      // (taskbar icon, clicking its account row) simply comes to the front;
      // there's no sub-division to compute per index.
      const halfW = Math.floor(screenW / 2)
      return { left: screenX, top: screenY, width: halfW, height: screenH }
    }
    case 'rightHalf': {
      const halfW = Math.floor(screenW / 2)
      return { left: screenX + halfW, top: screenY, width: halfW, height: screenH }
    }
    case 'maximized': {
      return { left: screenX, top: screenY, width: screenW, height: screenH }
    }
    case 'restore': {
      // "Original Size" is the same 5x2 grid every headed window launches
      // into by default (see browserContext.ts's tilePosition) — restoring
      // just puts windows back into that default instead of a bespoke
      // single fixed size, so this is identical to the grid5x2 case.
      const b = gridBounds(index, 5, 2, 0, screenW, screenH)
      return { ...b, left: b.left + screenX, top: b.top + screenY }
    }
  }
}

/**
 * Arrange every currently-open headed browser window into `layout`.
 * Best-effort per window — a context that closes mid-arrange, or one whose
 * CDP session can't be opened (e.g. it has no page yet), is skipped rather
 * than aborting the whole batch.
 */
export async function arrangeBrowserWindows(
  layout: ArrangeLayout
): Promise<{ arranged: number; total: number }> {
  const contexts = getAllTrackedContexts()
  let arranged = 0

  for (let i = 0; i < contexts.length; i++) {
    const context = contexts[i]
    const page = context.pages()[0]
    if (!page) continue

    try {
      const bounds = computeBoundsForLayout(layout, i)
      const cdp = await context.newCDPSession(page)
      // Explicit targetId — omitting it asks for "the window of whatever
      // target this client is currently attached to", which is normally
      // this page, but under CDP that resolution can be timing-sensitive
      // when several separate Chromium processes are all being queried in
      // a tight loop. Playwright's Page has no direct targetId getter, so
      // fetch it via the CDP session itself (Target.getTargetInfo with no
      // args also resolves to "this session's own target") before using it
      // explicitly in Browser.getWindowForTarget below, removing any
      // ambiguity about which window that call can resolve to.
      const { targetInfo } = await cdp.send('Target.getTargetInfo')
      const { windowId } = await cdp.send('Browser.getWindowForTarget', {
        targetId: targetInfo.targetId
      })

      // Chromium refuses to apply left/top/width/height while a window is
      // still in a non-'normal' state (e.g. left maximized from a previous
      // "Maximized" arrange) — clear windowState first, and let that resize
      // actually land (a same-tick follow-up call can race the window
      // manager's state transition and get silently dropped, which is what
      // produced the inconsistent/clipped bounds seen across a batch) before
      // sending the real target bounds.
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal' }
      })
      await new Promise((resolve) => setTimeout(resolve, 60))

      if (layout === 'maximized') {
        await cdp.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'maximized' }
        })
      } else {
        await cdp.send('Browser.setWindowBounds', {
          windowId,
          bounds: {
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
            windowState: 'normal'
          }
        })
      }
      await cdp.detach().catch(() => void 0)
      arranged += 1
    } catch {
      /* skip windows that can't be resized (closed mid-loop, no CDP target, etc.) */
    }
  }

  return { arranged, total: contexts.length }
}
