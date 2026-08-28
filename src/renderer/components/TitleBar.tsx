// ---------------------------------------------------------------------------
// TitleBar.tsx  — custom frameless title bar.
// White bar, draggable, app brand on the left, and the standard window
// controls (minimize / maximize / close) on the far right.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react'
import { Minus, Square, X, Copy, Timer } from 'lucide-react'
import { AppLogo } from './AppLogo'
import { HEADER_HEX_PATTERN_URL } from '../assets/headerHexPattern'
import { useAccountStore } from '../store/useAccountStore'

function formatElapsed(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

/**
 * Live Execution Timer — ticks up while a login-queue run is active
 * (queueRunning in the store, set true by runSelectedQueue and cleared in
 * its finally block on both normal completion and Stop), resets to
 * 00:00:00 the moment a new run starts. Purely a display of elapsed
 * wall-clock time — doesn't drive or gate any automation logic itself.
 */
function ExecutionTimer(): React.JSX.Element {
  const queueRunning = useAccountStore((s) => s.queueRunning)
  const [elapsed, setElapsed] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (queueRunning) {
      setElapsed(0)
      intervalRef.current = setInterval(() => setElapsed((e) => e + 1), 1000)
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [queueRunning])

  return (
    <span
      className="no-drag inline-flex items-center gap-1 rounded border border-slate-300 bg-slate-800/10 px-2.5 py-1 font-mono text-xs font-semibold text-slate-700"
      title={queueRunning ? 'Run in progress' : 'Elapsed time of the last run'}
    >
      <Timer size={12} className={queueRunning ? 'text-[#1e9e4a]' : 'text-slate-500'} />
      {formatElapsed(elapsed)}
    </span>
  )
}

export function TitleBar(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api.window.isMaximized().then(setMaximized)
  }, [])

  const onMinimize = (): void => void window.api.window.minimize()
  const onMaximize = async (): Promise<void> => {
    const isMax = await window.api.window.maximize()
    setMaximized(isMax)
  }
  const onClose = (): void => void window.api.window.close()

  return (
    <div
      className="drag relative flex h-[38px] items-center justify-between border-b border-[#e4d8bc] bg-[#fdf9f0] pl-2 pr-0"
      style={{
        backgroundImage: HEADER_HEX_PATTERN_URL,
        backgroundSize: '56px 98px',
        backgroundRepeat: 'repeat'
      }}
    >
      {/* Left: logo + app brand */}
      <div className="flex items-center gap-2 overflow-hidden">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-[6px]">
          <AppLogo size={24} />
        </div>
        <span
          className="truncate text-[13px] font-extrabold tracking-wide"
          style={{
            // Matches AppLogo.tsx's brand gradient (pink -> purple -> blue) so the
            // wordmark ties visually to the logo, and stands out cleanly against
            // the pale patterned background rather than blending into it the way
            // a plain dark title color would. (No text-shadow here: it renders
            // invisibly on gradient-clipped/transparent-color text in Chromium —
            // the shadow is drawn from the text's own fill color, which is
            // `transparent` once background-clip: text is applied.)
            backgroundImage: 'linear-gradient(90deg, #EC2D8A 0%, #9B3DC4 50%, #2E2E9E 100%)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent'
          }}
        >
          TFACEBOOK
        </span>
        <ExecutionTimer />
      </div>

      {/* Far right: window controls */}
      <div className="no-drag flex h-full items-stretch">
        <button
          onClick={onMinimize}
          title="Minimize"
          className="flex w-[46px] items-center justify-center text-[#333] hover:bg-[#e5e5e5]"
        >
          <Minus size={16} />
        </button>
        <button
          onClick={onMaximize}
          title={maximized ? 'Restore' : 'Maximize'}
          className="flex w-[46px] items-center justify-center text-[#333] hover:bg-[#e5e5e5]"
        >
          {maximized ? <Copy size={13} /> : <Square size={13} />}
        </button>
        <button
          onClick={onClose}
          title="Close"
          className="flex w-[46px] items-center justify-center text-[#333] hover:bg-[#e81123] hover:text-white"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
