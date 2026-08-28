// ---------------------------------------------------------------------------
// MenuBar.tsx  — classic horizontal WinForms MenuStrip.
// ---------------------------------------------------------------------------
import { Settings, FileText, Eye, Trash2, Wrench, Info } from 'lucide-react'
import { useAccountStore } from '../store/useAccountStore'
import { HEADER_HEX_PATTERN_URL } from '../assets/headerHexPattern'

interface MenuBarProps {
  onDisplayColumns: () => void
  onScenarioBuilder: () => void
  onGeneralSettings: () => void
  onToolsUtilities: () => void
  onHelpAbout: () => void
}

export function MenuBar({
  onDisplayColumns,
  onScenarioBuilder,
  onGeneralSettings,
  onToolsUtilities,
  onHelpAbout
}: MenuBarProps): React.JSX.Element {
  const openRecycleBin = useAccountStore((s) => s.openRecycleBin)

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
      className="flex items-center gap-0.5 border-b border-[#e4d8bc] bg-[#fdf9f0] px-1 py-0.5"
      style={{
        backgroundImage: HEADER_HEX_PATTERN_URL,
        backgroundSize: '56px 98px',
        backgroundRepeat: 'repeat',
        // Offset by TitleBar's own height (38px) so the hexagon grid lines
        // up across the seam between the two bars — together they read as
        // one continuous patterned header band instead of two separately
        // tiled strips.
        backgroundPosition: '0 -38px'
      }}
    >
      {ITEMS.map(({ icon: Icon, label, onClick }) => (
        <button key={label} className="menu-item" onClick={onClick}>
          <Icon size={14} className="text-[#4a6a8a]" />
          {label}
        </button>
      ))}
    </div>
  )
}
