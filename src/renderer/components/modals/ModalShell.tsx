// ---------------------------------------------------------------------------
// ModalShell.tsx  — shared WinForms-style dialog chrome (backdrop, header
// with icon + title + close, and a footer slot) used by the Row 2 marketing
// automation modals so each one only needs to write its body content.
// ---------------------------------------------------------------------------
import { useEffect } from 'react'
import { X } from 'lucide-react'
import { HEADER_HEX_PATTERN_URL } from '../../assets/headerHexPattern'

export function ModalShell({
  open,
  onClose,
  title,
  icon: Icon,
  width = 'max-w-2xl',
  height,
  bodyClassName,
  footer,
  children
}: {
  open: boolean
  onClose: () => void
  title: string
  icon: typeof X
  width?: string
  height?: string
  bodyClassName?: string
  footer?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`flex ${height || 'h-full max-h-[88vh]'} w-full ${width} flex-col overflow-hidden rounded border border-slate-400 border-t-4 border-t-indigo-600 bg-[#f0f2f5] shadow-2xl`}
      >
        <div
          className="flex items-center justify-between border-b border-[#e4d8bc] bg-[#fdf9f0] px-4 py-2"
          style={{
            backgroundImage: HEADER_HEX_PATTERN_URL,
            backgroundSize: '56px 98px',
            backgroundRepeat: 'repeat'
          }}
        >
          <div className="flex items-center gap-2">
            <Icon size={16} className="text-[#0067c0]" />
            <h2 className="text-[13px] font-semibold text-slate-900">{title}</h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-[#e81123]">
            <X size={16} />
          </button>
        </div>

        <div className={bodyClassName || 'flex-1 overflow-auto p-4'}>{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-slate-300 bg-[#f6f6f6] px-4 py-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
