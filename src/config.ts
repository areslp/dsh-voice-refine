export interface OpenAITranscriptionConfig {
  readonly kind: 'openai-transcription'
  readonly baseUrl: string
  readonly model: string
  readonly apiKeyEnv?: string
  readonly endpoint?: string
  readonly language?: string
  readonly timeoutMs?: number
  readonly headersFromEnv?: Readonly<Record<string, string>>
  readonly formFields?: Readonly<Record<string, string>>
}

export interface HttpAsrConfig {
  readonly kind: 'http'
  readonly endpoint: string
  readonly method?: 'POST' | 'PUT'
  readonly body?: 'binary' | 'multipart'
  readonly audioField?: string
  readonly timeoutMs?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly headersFromEnv?: Readonly<Record<string, string>>
  readonly formFields?: Readonly<Record<string, string>>
  readonly responseTextPath?: string
}

export type AsrConfig = OpenAITranscriptionConfig | HttpAsrConfig

export interface DisabledRefineConfig {
  readonly kind: 'disabled'
}

export interface OpenAIChatRefineConfig {
  readonly kind: 'openai-chat'
  readonly baseUrl: string
  readonly model: string
  readonly apiKeyEnv?: string
  readonly endpoint?: string
  readonly timeoutMs?: number
  readonly temperature?: number
  readonly maxOutputTokens?: number
  readonly headersFromEnv?: Readonly<Record<string, string>>
}

export type RefineConfig = DisabledRefineConfig | OpenAIChatRefineConfig

export interface LearningConfig {
  readonly enabled?: boolean
  readonly storePath?: string
  readonly minOccurrences?: number
  readonly maxEntries?: number
  readonly pendingTtlMs?: number
  readonly requireScope?: boolean
}

export interface AuditConfig {
  readonly enabled?: boolean
  readonly storePath?: string
  readonly retentionDays?: number
  readonly maxPendingEntries?: number
  readonly identityKeyEnv?: string
}

export interface PluginConfig {
  readonly asr: AsrConfig
  readonly refine?: RefineConfig
  readonly learning?: LearningConfig
  readonly audit?: AuditConfig
  readonly allowedOrigins?: readonly string[]
  readonly publicOrigin?: string
  readonly maxAudioBytes?: number
  readonly maxRecordingMs?: number
  readonly minRecordingMs?: number
  readonly maxConcurrentRequests?: number
  readonly bodyTimeoutMs?: number
}

export interface ResolvedPluginConfig {
  readonly asr: AsrConfig
  readonly refine: RefineConfig
  readonly learning: Required<LearningConfig>
  readonly audit: Required<AuditConfig>
  readonly allowedOrigins: readonly string[]
  readonly publicOrigin: string | undefined
  readonly maxAudioBytes: number
  readonly maxRecordingMs: number
  readonly minRecordingMs: number
  readonly maxConcurrentRequests: number
  readonly bodyTimeoutMs: number
}

const MEBIBYTE = 1024 * 1024

export function resolveConfig(config: PluginConfig): ResolvedPluginConfig {
  if (config?.asr === undefined) throw new Error('config.asr is required')
  validateAdapterUrls(config.asr, config.refine)
  const maxRecordingMs = boundedInteger(config.maxRecordingMs, 90_000, 1_000, 10 * 60_000)
  const minRecordingMs = boundedInteger(config.minRecordingMs, 800, 250, 5_000)
  if (minRecordingMs >= maxRecordingMs) throw new Error('minRecordingMs must be less than maxRecordingMs')
  return {
    asr: config.asr,
    refine: config.refine ?? { kind: 'disabled' },
    learning: {
      enabled: config.learning?.enabled ?? true,
      storePath: config.learning?.storePath ?? '',
      minOccurrences: boundedInteger(config.learning?.minOccurrences, 2, 1, 20),
      maxEntries: boundedInteger(config.learning?.maxEntries, 500, 10, 10_000),
      pendingTtlMs: boundedInteger(config.learning?.pendingTtlMs, 24 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000),
      requireScope: config.learning?.requireScope ?? true,
    },
    audit: {
      enabled: config.audit?.enabled ?? false,
      storePath: config.audit?.storePath ?? '',
      retentionDays: boundedInteger(config.audit?.retentionDays, 30, 1, 3650),
      maxPendingEntries: boundedInteger(config.audit?.maxPendingEntries, 100, 1, 10_000),
      identityKeyEnv: config.audit?.identityKeyEnv ?? 'DSH_VOICE_AUDIT_KEY',
    },
    allowedOrigins: resolveAllowedOrigins(config.allowedOrigins),
    publicOrigin: config.publicOrigin === undefined ? undefined : resolveOrigin(config.publicOrigin, 'publicOrigin'),
    maxAudioBytes: boundedInteger(config.maxAudioBytes, 16 * MEBIBYTE, 64 * 1024, 64 * MEBIBYTE),
    maxRecordingMs,
    minRecordingMs,
    maxConcurrentRequests: boundedInteger(config.maxConcurrentRequests, 2, 1, 32),
    bodyTimeoutMs: boundedInteger(config.bodyTimeoutMs, 30_000, 1, 10 * 60_000),
  }
}

function resolveAllowedOrigins(origins: readonly string[] | undefined): readonly string[] {
  return (origins ?? []).map(origin => resolveOrigin(origin, 'allowedOrigins entries'))
}

function resolveOrigin(origin: string, field: string): string {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error(`${field} must contain absolute origins, received ${JSON.stringify(origin)}`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin === 'null'
    || parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/'
    || parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`${field} must contain absolute origins, received ${JSON.stringify(origin)}`)
  }
  return parsed.origin
}

function validateAdapterUrls(asr: AsrConfig, refine: RefineConfig | undefined): void {
  if (asr.kind === 'http') {
    assertSafeHttpUrl(asr.endpoint, 'asr.endpoint')
  } else {
    assertSafeResolvedUrl(asr.baseUrl, asr.endpoint, 'audio/transcriptions', 'asr')
  }
  if (refine?.kind === 'openai-chat') {
    assertSafeResolvedUrl(refine.baseUrl, refine.endpoint, 'chat/completions', 'refine')
  }
}

function assertSafeResolvedUrl(baseUrl: string, endpoint: string | undefined, defaultPath: string, field: string): void {
  const base = assertSafeHttpUrl(baseUrl, `${field}.baseUrl`)
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  assertSafeUrl(new URL(endpoint ?? defaultPath, base), `${field}.endpoint`)
}

function assertSafeHttpUrl(value: string, field: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${field} must be an absolute HTTP(S) URL`)
  }
  assertSafeUrl(parsed, field)
  return parsed
}

function assertSafeUrl(url: URL, field: string): void {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${field} must use HTTP(S)`)
  if (url.username !== '' || url.password !== '') throw new Error(`${field} must not contain URL credentials`)
  for (const name of url.searchParams.keys()) {
    if (/(?:api[-_]?key|token|secret|password|authorization|auth|signature|credential)/iu.test(name)
      || /(?:^|[-_])(?:key|sig|jwt)(?:$|[-_])/iu.test(name)) {
      throw new Error(`${field} must not contain credential query parameters`)
    }
  }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const candidate = value ?? fallback
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw new Error(`expected an integer between ${min} and ${max}, received ${String(candidate)}`)
  }
  return candidate
}
