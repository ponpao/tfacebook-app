import { useState, useRef, useEffect } from 'react'
import { Settings, FileText, Eye, Trash2, Wrench, Info, Layers, ChevronDown } from 'lucide-react'
import { useAccountStore } from '../store/useAccountStore'
import { HEADER_HEX_PATTERN_URL } from '../assets/headerHexPattern'

interface MenuBarProps {
  onDisplayColumns: () => void
  onScenarioBuilder: () => void
  onGeneralSettings: () => void
  onToolsUtilities: () => void
  onHelpAbout: () => void
  onOpenPageManager: () => void
}

export function MenuBar({
  onDisplayColumns,
  onScenarioBuilder,
  onGeneralSettings,
  onToolsUtilities,
  onHelpAbout,
  onOpenPageManager
}: MenuBarProps): React.JSX.Element {
  const openRecycleBin = useAccountStore((s) => s.openRecycleBin)
  const [pageMenuOpen, setPageMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setPageMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const ITEMS = [
    { icon: Settings, label: 'General Settings', onClick: onGeneralSettings },
    { icon: FileText, label: 'Scenario Builder', onClick: onScenarioBuilder },
    { icon: Eye, label: 'Display Columns', onClick: onDisplayColumns },
    { icon: Trash2, label: 'Recycle Bin', onClick: openRecycleBin },
    { icon: Wrench, label: 'Tools & Utilities', onClick: onToolsUtilities },
    { icon: Info, label: 'Help & About', onClick: onHelpAbout }
  ]

  return (
    <div
      className="flex items-center gap-0.5 border-b border-[#e4d8bc] bg-[#fdf9f0] px-1 py-0.5 relative"
      style={{
        backgroundImage: HEADER_HEX_PATTERN_URL,
        backgroundSize: '56px 98px',
        backgroundRepeat: 'repeat',
        backgroundPosition: '0 -38px'
      }}
    >
      {/* Page Dropdown Menu */}
      <div className="relative" ref={menuRef}>
        <button
          className={`menu-item flex items-center gap-1 font-semibold ${
            pageMenuOpen ? 'bg-amber-100 border border-amber-300' : ''
          }`}
          onClick={() => setPageMenuOpen((o) => !o)}
        >
          <Layers size={14} className="text-[#1a5c96]" />
          <span>Page</span>
          <ChevronDown size={12} className="text-slate-500" />
        </button>

        {pageMenuOpen && (
          <div className="absolute left-0 top-full mt-1 z-50 min-w-[200px] rounded-md border border-slate-300 bg-white py-1 shadow-lg animate-in fade-in-50 zoom-in-95">
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-xs text-slate-700 hover:bg-rose-50 hover:text-rose-700 text-left transition-colors"
              onClick={() => {
                setPageMenuOpen(false)
                onOpenPageManager()
              }}
            >
              <Trash2 size={14} className="text-rose-600" />
              <span>Delete Post in Page</span>
            </button>
          </div>
        )}
      </div>

      {ITEMS.map(({ icon: Icon, label, onClick }) => (
        <button key={label} className="menu-item" onClick={onClick}>
          <Icon size={14} className="text-[#4a6a8a]" />
          {label}
        </button>
      ))}
    </div>
  )
}
