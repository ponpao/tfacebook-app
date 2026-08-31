import { create } from 'zustand'
import { TRANSLATIONS, type Language, type TranslationKey } from '../i18n/translations'

const LANG_STORAGE_KEY = 'tfacebook_lang'

interface LanguageState {
  language: Language
  setLanguage: (lang: Language) => void
  t: (key: TranslationKey) => string
}

function getSavedLanguage(): Language {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY)
    if (saved === 'km' || saved === 'en') return saved
  } catch {
    /* ignore storage access error */
  }
  return 'en'
}

export const useLanguageStore = create<LanguageState>((set, get) => ({
  language: getSavedLanguage(),
  setLanguage: (lang: Language) => {
    try {
      localStorage.setItem(LANG_STORAGE_KEY, lang)
    } catch {
      /* ignore */
    }
    document.documentElement.lang = lang
    set({ language: lang })
  },
  t: (key: TranslationKey) => {
    const lang = get().language
    return TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS.en[key] ?? key
  }
}))
