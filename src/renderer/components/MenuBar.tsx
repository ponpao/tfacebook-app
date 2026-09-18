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
  Globe,
  Sparkles,
  Sun,
  Moon
} from 'lucide-react'
import { useAccountStore } from '../store/useAccountStore'
import { useLanguageStore } from '../store/useLanguageStore'
import { useThemeStore } from '../store/useThemeStore'
import { CambodiaFlag, UKFlag } from './icons/CountryFlags'

interface MenuBarProps {
  onDisplayColumns: () => void
  onScenarioBuilder: () => void
  onGeneralSettings: () => void
  onToolsUtilities: () => void
  onHelpAbout: () => void
  onOpenPageManager: () => void
  onOpenPageManagerV2: () => void
  onOpenGetPageInfo: () => void
  onOpenPostToPage: () => void
}

export function MenuBar({
  onDisplayColumns,
  onScenarioBuilder,
  onGeneralSettings,
  onToolsUtilities,
  onHelpAbout,
  onOpenPageManager,
  onOpenPageManagerV2,
  onOpenGetPageInfo,
  onOpenPostToPage
}: MenuBarProps): React.JSX.Element {
  const openRecycleBin = useAccountStore((s) => s.openRecycleBin)
  const language = useLanguageStore((s) => s.language)
  const setLanguage = useLanguageStore((s) => s.setLanguage)
  const t = useLanguageStore((s) => s.t)
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)

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
    <div className="flex items-center justify-between border-b border-edge bg-surface px-1 py-0.5 relative select-none">
      {/* Left items */}
      <div className="flex items-center gap-0.5">
        {/* 1. General Settings */}
        <button className="menu-item font-medium" onClick={onGeneralSettings}>
          <Settings size={14} className="text-ink-muted" />
          <span>{t('generalSettings')}</span>
        </button>

        {/* 2. Pages Dropdown — repositioned directly after General Settings */}
        <div className="relative" ref={menuRef}>
          <button
            className={`menu-item flex items-center gap-1 font-medium ${
              pageMenuOpen ? 'bg-accent/10 border border-accent/30' : ''
            }`}
            onClick={() => setPageMenuOpen((o) => !o)}
          >
            <Layers size={14} className="text-ink-muted" />
            <span>{t('pages')}</span>
            <ChevronDown size={12} className="text-ink-muted" />
          </button>

          {pageMenuOpen && (
            <div className="absolute left-0 top-full mt-1 z-50 min-w-[200px] rounded-lg border border-edge bg-surface py-1 animate-in fade-in-50 zoom-in-95">
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-ink hover:bg-surface-sunken text-left transition-colors"
                onClick={() => {
                  setPageMenuOpen(false)
                  onOpenGetPageInfo()
                }}
              >
                <Layers size={14} className="text-accent" />
                <span>{t('getPageInfo')}</span>
              </button>
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-ink hover:bg-surface-sunken text-left transition-colors"
                onClick={() => {
                  setPageMenuOpen(false)
                  onOpenPostToPage()
                }}
              >
                <Sparkles size={14} className="text-accent" />
                <span>{t('postToPage')}</span>
              </button>
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-ink hover:bg-surface-sunken text-left transition-colors"
                onClick={() => {
                  setPageMenuOpen(false)
                  onOpenPageManager()
                }}
              >
                <Trash2 size={14} className="text-accent" />
                <span>លុប Post (Meta Suite V1)</span>
              </button>
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-ink hover:bg-surface-sunken text-left transition-colors border-t border-edge"
                onClick={() => {
                  setPageMenuOpen(false)
                  onOpenPageManagerV2()
                }}
              >
                <Sparkles size={14} className="text-accent" />
                <span className="font-semibold text-ink">លុប Post (GraphQL API V2)</span>
              </button>
            </div>
          )}
        </div>

        {/* 3. Scenario Builder */}
        <button className="menu-item font-medium" onClick={onScenarioBuilder}>
          <FileText size={14} className="text-ink-muted" />
          <span>{t('scenarioBuilder')}</span>
        </button>

        {/* 4. Display Columns */}
        <button className="menu-item font-medium" onClick={onDisplayColumns}>
          <Eye size={14} className="text-ink-muted" />
          <span>{t('displayColumns')}</span>
        </button>

        {/* 5. Recycle Bin */}
        <button className="menu-item font-medium" onClick={openRecycleBin}>
          <Trash2 size={14} className="text-ink-muted" />
          <span>{t('recycleBin')}</span>
        </button>

        {/* 6. Tools & Utilities */}
        <button className="menu-item font-medium" onClick={onToolsUtilities}>
          <Wrench size={14} className="text-ink-muted" />
          <span>{t('toolsUtilities')}</span>
        </button>

        {/* 7. Help & About */}
        <button className="menu-item font-medium" onClick={onHelpAbout}>
          <Info size={14} className="text-ink-muted" />
          <span>{t('helpAbout')}</span>
        </button>
      </div>

      {/* Right side: theme toggle + Language Switcher Dropdown (Khmer 🇰🇭 & English 🇬🇧) */}
      <div className="flex items-center gap-1.5 mr-1.5 shrink-0">
        <button
          type="button"
          className="flex items-center justify-center rounded-lg border border-edge bg-surface p-1.5 text-ink-muted hover:bg-surface-sunken hover:text-ink transition-colors cursor-pointer"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>

        <div className="relative" ref={langRef}>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface px-2.5 py-1 text-xs font-semibold text-ink hover:bg-surface-sunken transition-colors cursor-pointer"
            onClick={() => setLangMenuOpen((o) => !o)}
            title="Switch Language / ប្តូរភាសា"
          >
            {language === 'km' ? <CambodiaFlag size={18} /> : <UKFlag size={18} />}
            <span className="font-semibold text-[11px] text-ink">
              {language === 'km' ? 'ភាសាខ្មែរ' : 'English'}
            </span>
            <ChevronDown size={11} className="text-ink-muted ml-0.5" />
          </button>

          {langMenuOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 min-w-[155px] rounded-lg border border-edge bg-surface py-1 animate-in fade-in-50 zoom-in-95">
              <button
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs text-left transition-colors cursor-pointer ${
                  language === 'km'
                    ? 'bg-accent/10 font-bold text-accent'
                    : 'text-ink hover:bg-surface-sunken'
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
                    ? 'bg-accent/10 font-bold text-accent'
                    : 'text-ink hover:bg-surface-sunken'
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
    </div>
  )
}
