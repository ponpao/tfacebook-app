import { useState, useRef, useEffect } from 'react'
import {
  Settings,
  FileText,
  Eye,
  Trash2,
  Wrench,
  Info,
  Layers,
  ChevronDown,
  Globe
} from 'lucide-react'
import { useAccountStore } from '../store/useAccountStore'
import { useLanguageStore } from '../store/useLanguageStore'
import { HEADER_HEX_PATTERN_URL } from '../assets/headerHexPattern'
import { CambodiaFlag, UKFlag } from './icons/CountryFlags'

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
  const language = useLanguageStore((s) => s.language)
  const setLanguage = useLanguageStore((s) => s.setLanguage)
  const t = useLanguageStore((s) => s.t)

  const [pageMenuOpen, setPageMenuOpen] = useState(false)
  const [langMenuOpen, setLangMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const langRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current && !menuRef.current.contains(target)) {
        setPageMenuOpen(false)
      }
      if (langRef.current && !langRef.current.contains(target)) {
        setLangMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div
      className="flex items-center justify-between border-b border-[#e4d8bc] bg-[#fdf9f0] px-1 py-0.5 relative select-none"
      style={{
        backgroundImage: HEADER_HEX_PATTERN_URL,
        backgroundSize: '56px 98px',
        backgroundRepeat: 'repeat',
        backgroundPosition: '0 -38px'
      }}
    >
      {/* Left items */}
      <div className="flex items-center gap-0.5">
        {/* 1. General Settings */}
        <button className="menu-item font-medium" onClick={onGeneralSettings}>
          <Settings size={14} className="text-[#4a6a8a]" />
          <span>{t('generalSettings')}</span>
        </button>

        {/* 2. Pages Dropdown — repositioned directly after General Settings */}
        <div className="relative" ref={menuRef}>
          <button
            className={`menu-item flex items-center gap-1 font-medium ${
              pageMenuOpen ? 'bg-amber-100 border border-amber-300' : ''
            }`}
            onClick={() => setPageMenuOpen((o) => !o)}
          >
            <Layers size={14} className="text-[#1a5c96]" />
            <span>{t('pages')}</span>
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
                <span>{t('deletePostInPage')}</span>
              </button>
            </div>
          )}
        </div>

        {/* 3. Scenario Builder */}
        <button className="menu-item font-medium" onClick={onScenarioBuilder}>
          <FileText size={14} className="text-[#4a6a8a]" />
          <span>{t('scenarioBuilder')}</span>
        </button>

        {/* 4. Display Columns */}
        <button className="menu-item font-medium" onClick={onDisplayColumns}>
          <Eye size={14} className="text-[#4a6a8a]" />
          <span>{t('displayColumns')}</span>
        </button>

        {/* 5. Recycle Bin */}
        <button className="menu-item font-medium" onClick={openRecycleBin}>
          <Trash2 size={14} className="text-[#4a6a8a]" />
          <span>{t('recycleBin')}</span>
        </button>

        {/* 6. Tools & Utilities */}
        <button className="menu-item font-medium" onClick={onToolsUtilities}>
          <Wrench size={14} className="text-[#4a6a8a]" />
          <span>{t('toolsUtilities')}</span>
        </button>

        {/* 7. Help & About */}
        <button className="menu-item font-medium" onClick={onHelpAbout}>
          <Info size={14} className="text-[#4a6a8a]" />
          <span>{t('helpAbout')}</span>
        </button>
      </div>

      {/* Right side: Language Switcher Dropdown (Khmer 🇰🇭 & English 🇬🇧) */}
      <div className="relative mr-1.5 shrink-0" ref={langRef}>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border border-slate-300 bg-white/95 px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-2xs hover:bg-white hover:border-slate-400 hover:shadow-xs transition-all cursor-pointer"
          onClick={() => setLangMenuOpen((o) => !o)}
          title="Switch Language / ប្តូរភាសា"
        >
          {language === 'km' ? <CambodiaFlag size={18} /> : <UKFlag size={18} />}
          <span className="font-semibold text-[11px] text-slate-800">
            {language === 'km' ? 'ភាសាខ្មែរ' : 'English'}
          </span>
          <ChevronDown size={11} className="text-slate-400 ml-0.5" />
        </button>

        {langMenuOpen && (
          <div className="absolute right-0 top-full mt-1 z-50 min-w-[155px] rounded-lg border border-slate-300 bg-white py-1 shadow-lg animate-in fade-in-50 zoom-in-95">
            <button
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs text-left transition-colors cursor-pointer ${
                language === 'km'
                  ? 'bg-blue-50/80 font-bold text-blue-900'
                  : 'text-slate-700 hover:bg-slate-50'
              }`}
              onClick={() => {
                setLanguage('km')
                setLangMenuOpen(false)
              }}
            >
              <CambodiaFlag size={20} />
              <span className="font-medium">ភាសាខ្មែរ (Khmer)</span>
            </button>
            <button
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs text-left transition-colors cursor-pointer ${
                language === 'en'
                  ? 'bg-blue-50/80 font-bold text-blue-900'
                  : 'text-slate-700 hover:bg-slate-50'
              }`}
              onClick={() => {
                setLanguage('en')
                setLangMenuOpen(false)
              }}
            >
              <UKFlag size={20} />
              <span className="font-medium">English (UK/US)</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
