export const PREFERENCES_STORAGE_KEY = 'dsh-voice-refine.preferences'
const PREFERENCES_VERSION = 2

export interface VoicePreferences {
  readonly language: string
  readonly append: boolean
  readonly includeRecentContext: boolean
}

export interface PreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  language: '',
  append: true,
  includeRecentContext: true,
}

export function loadVoicePreferences(storage: PreferenceStorage | undefined = safeLocalStorage()): VoicePreferences {
  if (storage === undefined) return DEFAULT_VOICE_PREFERENCES
  try {
    const value = storage.getItem(PREFERENCES_STORAGE_KEY)
    if (value === null) return DEFAULT_VOICE_PREFERENCES
    const record = JSON.parse(value) as unknown
    if (!isRecord(record)) return DEFAULT_VOICE_PREFERENCES
    const language = typeof record.language === 'string' ? record.language.trim().slice(0, 32) : ''
    const isCurrentVersion = record.version === PREFERENCES_VERSION
    return {
      language,
      append: record.append !== false,
      includeRecentContext: isCurrentVersion && typeof record.includeRecentContext === 'boolean'
        ? record.includeRecentContext
        : DEFAULT_VOICE_PREFERENCES.includeRecentContext,
    }
  } catch {
    return DEFAULT_VOICE_PREFERENCES
  }
}

export function saveVoicePreferences(preferences: VoicePreferences, storage: PreferenceStorage | undefined = safeLocalStorage()): void {
  if (storage === undefined) return
  try {
    storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: PREFERENCES_VERSION,
      language: preferences.language.trim().slice(0, 32),
      append: preferences.append,
      includeRecentContext: preferences.includeRecentContext,
    }))
  } catch {
    // Private browsing and restricted storage should not break recording.
  }
}

function safeLocalStorage(): PreferenceStorage | undefined {
  if (typeof globalThis.localStorage === 'undefined') return undefined
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
