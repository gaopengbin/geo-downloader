import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import enUS from './locales/en-US'
import zhCN from './locales/zh-CN'
import {
  detectInitialLanguage,
  normalizeLanguage,
  persistLanguage,
  type AppLanguage,
} from './language'

export async function initializeI18n() {
  if (!i18n.isInitialized) {
    const language = detectInitialLanguage(
      typeof localStorage === 'undefined' ? null : localStorage,
      typeof navigator === 'undefined' ? null : navigator.language,
    )
    await i18n.use(initReactI18next).init({
      resources: {
        'zh-CN': { translation: zhCN },
        'en-US': { translation: enUS },
      },
      lng: language,
      fallbackLng: 'zh-CN',
      supportedLngs: ['zh-CN', 'en-US'],
      interpolation: { escapeValue: false },
      returnNull: false,
    })
  }

  const applyLanguage = (language: string) => {
    const normalized = normalizeLanguage(language)
    if (typeof document !== 'undefined') document.documentElement.lang = normalized
  }
  applyLanguage(i18n.resolvedLanguage ?? i18n.language)
  i18n.on('languageChanged', applyLanguage)
  return i18n
}

export async function changeAppLanguage(language: AppLanguage) {
  persistLanguage(language, typeof localStorage === 'undefined' ? null : localStorage)
  await i18n.changeLanguage(language)
}

export { i18n }
export type { AppLanguage } from './language'
