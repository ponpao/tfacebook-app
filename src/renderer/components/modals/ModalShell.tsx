// ---------------------------------------------------------------------------
// ModalShell.tsx  — shared dialog chrome (backdrop, header with icon + title
// + close, and a footer slot) used by the Row 2 marketing automation modals
// so each one only needs to write its body content.
// ---------------------------------------------------------------------------
import { useEffect } from 'react'
import { X } from 'lucide-react'

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
        className={`flex ${height || 'h-full max-h-[88vh]'} w-full ${width} flex-col overflow-hidden rounded-xl border border-edge border-t-4 border-t-accent bg-surface`}
      >
        <div className="flex items-center justify-between border-b border-edge bg-surface-sunken px-4 py-2">
          <div className="flex items-center gap-2">
            <Icon size={16} className="text-accent" />
            <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
          </div>
          <button onClick={onClose} className="text-ink-muted hover:text-accent">
            <X size={16} />
          </button>
        </div>

        <div className={bodyClassName || 'flex-1 overflow-auto p-4'}>{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-edge bg-surface-sunken px-4 py-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
