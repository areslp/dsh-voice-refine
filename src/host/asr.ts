import type { AsrConfig, HttpAsrConfig, OpenAITranscriptionConfig } from '../config.js'
import { resolveHeaders, setSafeHeader } from './security.js'

export const DEFAULT_ASR_TIMEOUT_MS = 120_000

export class AsrRequestError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`ASR request failed with HTTP ${status}`)
    this.name = 'AsrRequestError'
    this.status = status
  }
}

export interface AudioForTranscription {
  readonly bytes: Uint8Array
  readonly mimeType: string
  readonly fileName?: string
  readonly language?: string
}

export interface AsrAdapter {
  transcribe(audio: AudioForTranscription): Promise<string>
}

export interface AdapterDependencies {
  readonly fetch?: typeof fetch
  readonly environment?: NodeJS.ProcessEnv
}

export function createAsrAdapter(config: AsrConfig, dependencies: AdapterDependencies = {}): AsrAdapter {
  const fetcher = dependencies.fetch ?? fetch
  const environment = dependencies.environment ?? process.env
  return config.kind === 'openai-transcription'
    ? new OpenAITranscriptionAdapter(config, fetcher, environment)
    : new HttpAsrAdapter(config, fetcher, environment)
}

class OpenAITranscriptionAdapter implements AsrAdapter {
  readonly #config: OpenAITranscriptionConfig
  readonly #fetch: typeof fetch
  readonly #environment: NodeJS.ProcessEnv

  constructor(
    config: OpenAITranscriptionConfig,
    fetcher: typeof fetch,
    environment: NodeJS.ProcessEnv,
  ) {
    this.#config = config
    this.#fetch = fetcher
    this.#environment = environment
  }

  async transcribe(audio: AudioForTranscription): Promise<string> {
    const headers = resolveHeaders(undefined, this.#config.headersFromEnv, this.#environment)
    if (this.#config.apiKeyEnv !== undefined) {
      const apiKey = this.#environment[this.#config.apiKeyEnv]
      if (apiKey === undefined || apiKey === '') throw new Error(`environment variable ${this.#config.apiKeyEnv} is required`)
      setSafeHeader(headers, 'authorization', `Bearer ${apiKey}`)
    }
    const form = new FormData()
    form.set('model', this.#config.model)
    if (this.#config.language ?? audio.language) form.set('language', this.#config.language ?? audio.language ?? '')
    for (const [name, value] of Object.entries(this.#config.formFields ?? {})) form.set(name, value)
    form.set('file', new Blob([copyAudioBytes(audio.bytes)], { type: audio.mimeType }), audio.fileName ?? 'recording.webm')

    const signal = timeoutSignal(this.#config.timeoutMs ?? DEFAULT_ASR_TIMEOUT_MS)
    const response = await this.#fetch(endpointForOpenAi(this.#config), {
      method: 'POST',
      headers,
      body: form,
      ...(signal === undefined ? {} : { signal }),
    })
    return readStrictText(response, 'text')
  }
}

class HttpAsrAdapter implements AsrAdapter {
  readonly #config: HttpAsrConfig
  readonly #fetch: typeof fetch
  readonly #environment: NodeJS.ProcessEnv

  constructor(
    config: HttpAsrConfig,
    fetcher: typeof fetch,
    environment: NodeJS.ProcessEnv,
  ) {
    this.#config = config
    this.#fetch = fetcher
    this.#environment = environment
  }

  async transcribe(audio: AudioForTranscription): Promise<string> {
    const headers = resolveHeaders(this.#config.headers, this.#config.headersFromEnv, this.#environment)
    let body: BodyInit
    if ((this.#config.body ?? 'binary') === 'multipart') {
      const form = new FormData()
      for (const [name, value] of Object.entries(this.#config.formFields ?? {})) form.set(name, value)
      form.set(this.#config.audioField ?? 'file', new Blob([copyAudioBytes(audio.bytes)], { type: audio.mimeType }), audio.fileName ?? 'recording.webm')
      body = form
    } else {
      if (!headers.has('content-type')) headers.set('content-type', audio.mimeType)
      body = copyAudioBytes(audio.bytes)
    }
    const signal = timeoutSignal(this.#config.timeoutMs ?? DEFAULT_ASR_TIMEOUT_MS)
    const response = await this.#fetch(this.#config.endpoint, {
      method: this.#config.method ?? 'POST',
      headers,
      body,
      ...(signal === undefined ? {} : { signal }),
    })
    return readStrictText(response, this.#config.responseTextPath ?? 'text')
  }
}

function endpointForOpenAi(config: OpenAITranscriptionConfig): string {
  return endpointFromBaseUrl(config.baseUrl, config.endpoint, 'audio/transcriptions')
}

export function endpointFromBaseUrl(baseUrl: string, endpoint: string | undefined, defaultPath: string): string {
  const base = new URL(baseUrl)
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  return new URL(endpoint ?? defaultPath, base).toString()
}

export function timeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  return timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
}

function copyAudioBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export async function readStrictText(response: Response, responseTextPath: string): Promise<string> {
  if (!response.ok) throw new AsrRequestError(response.status)
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('ASR response must be JSON')
  }
  const text = valueAtPath(payload, responseTextPath)
  if (typeof text !== 'string') throw new Error(`ASR response field ${responseTextPath} must be a string`)
  const trimmed = text.trim()
  if (trimmed === '') throw new Error(`ASR response field ${responseTextPath} must not be empty`)
  return trimmed
}

export function valueAtPath(value: unknown, path: string): unknown {
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(path)) throw new Error('responseTextPath must be dot-separated object keys')
  let current: unknown = value
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
