export const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US'] as const

export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export const LANGUAGE_STORAGE_KEY = 'geod-language'

export function normalizeLanguage(language?: string | null): AppLanguage {
  return language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

export function detectInitialLanguage(
  storage?: Pick<Storage, 'getItem'> | null,
  systemLanguage?: string | null,
): AppLanguage {
  try {
    const stored = storage?.getItem(LANGUAGE_STORAGE_KEY)
    if (stored && SUPPORTED_LANGUAGES.includes(stored as AppLanguage)) {
      return stored as AppLanguage
    }
  } catch {
    // Storage can be unavailable in restricted WebViews.
  }
  return normalizeLanguage(systemLanguage)
}

export function persistLanguage(
  language: AppLanguage,
  storage?: Pick<Storage, 'setItem'> | null,
) {
  try {
    storage?.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    // Language switching still works for the current session.
  }
}
