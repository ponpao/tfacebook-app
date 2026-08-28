// ---------------------------------------------------------------------------
// TitleBar.tsx  — custom frameless title bar.
// White bar, draggable, app brand on the left, and the standard window
// controls (minimize / maximize / close) on the far right.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react'
import { Minus, Square, X, Copy } from 'lucide-react'
import { AppLogo } from './AppLogo'
import { HEADER_HEX_PATTERN_URL } from '../assets/headerHexPattern'

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
