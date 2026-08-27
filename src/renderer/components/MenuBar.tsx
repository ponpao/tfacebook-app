// ---------------------------------------------------------------------------
// MenuBar.tsx  — classic horizontal WinForms MenuStrip.
// ---------------------------------------------------------------------------
import { Settings, FileText, Eye, Trash2, Wrench, Info } from 'lucide-react'
import { useAccountStore } from '../store/useAccountStore'

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
    <div className="flex items-center gap-0.5 border-b border-[#d0d0d0] bg-[#f8f8f8] px-1 py-0.5">
      {ITEMS.map(({ icon: Icon, label, onClick }) => (
        <button key={label} className="menu-item" onClick={onClick}>
          <Icon size={14} className="text-[#4a6a8a]" />
          {label}
        </button>
      ))}
    </div>
  )
}
