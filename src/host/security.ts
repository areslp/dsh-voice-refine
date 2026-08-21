import { ENVELOPE_CONTENT_TYPE, MAX_METADATA_BYTES, decodeEnvelope } from '../shared/protocol.js'
import type { VoiceProcessMetadata } from '../shared/protocol.js'

export type BodySource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>

export async function readBoundedBody(source: BodySource, maxBytes: number, signal?: AbortSignal, timeoutMs?: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive integer')
  const deadline = bodyReadSignal(signal, timeoutMs)

  const chunks: Uint8Array[] = []
  let length = 0
  const append = (chunk: Uint8Array): void => {
    length += chunk.byteLength
    if (length > maxBytes) throw new BodyTooLargeError(maxBytes)
    chunks.push(chunk)
  }

  try {
    if (Symbol.asyncIterator in source) {
      const iterator = (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
      try {
        while (true) {
          const next = await abortable(iterator.next(), deadline.signal)
          if (next.done) break
          append(next.value)
        }
      } catch (error) {
        void iterator.return?.().catch(() => undefined)
        throw error
      }
    } else {
      const reader = (source as ReadableStream<Uint8Array>).getReader()
      try {
        while (true) {
          const next = await abortable(reader.read(), deadline.signal)
          if (next.done) break
          append(next.value)
        }
      } catch (error) {
        void reader.cancel(error).catch(() => undefined)
        throw error
      } finally {
        reader.releaseLock()
      }
    }

    const result = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  } finally {
    deadline.dispose()
  }
}

function bodyReadSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): { signal: AbortSignal | undefined; dispose: () => void } {
  if (timeoutMs === undefined) return { signal, dispose: () => undefined }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs must be a positive integer')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    },
  }
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) throw new BodyTimeoutError()
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new BodyTimeoutError())
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

export class BodyTooLargeError extends Error {
  readonly maxBytes: number

  constructor(maxBytes: number) {
    super(`request body exceeds the ${maxBytes}-byte limit`)
    this.name = 'BodyTooLargeError'
    this.maxBytes = maxBytes
  }
}

export class BodyTimeoutError extends Error {
  constructor() {
    super('request body timed out')
    this.name = 'BodyTimeoutError'
  }
}

export interface DecodedVoiceEnvelope {
  readonly metadata: VoiceProcessMetadata
  readonly audio: Uint8Array
}

export function assertEnvelopeContentType(contentType: string | null | undefined): void {
  if (normalizeContentType(contentType) !== normalizeContentType(ENVELOPE_CONTENT_TYPE)) {
    throw new Error(`expected Content-Type ${ENVELOPE_CONTENT_TYPE}`)
  }
}

function normalizeContentType(contentType: string | null | undefined): string | undefined {
  return contentType?.split(';').map(part => part.trim().toLowerCase()).join(';')
}

export async function readVoiceEnvelope(source: BodySource, maxAudioBytes: number, signal?: AbortSignal, timeoutMs?: number): Promise<DecodedVoiceEnvelope> {
  if (!Number.isSafeInteger(maxAudioBytes) || maxAudioBytes < 1) throw new Error('maxAudioBytes must be a positive integer')
  // The protocol's fixed framing header is deliberately private. Sixteen bytes is
  // a small, forward-compatible allowance; decodeEnvelope validates the frame.
  const envelope = await readBoundedBody(source, maxAudioBytes + MAX_METADATA_BYTES + 16, signal, timeoutMs)
  const decoded = decodeEnvelope(envelope)
  if (decoded.audio.byteLength > maxAudioBytes) throw new BodyTooLargeError(maxAudioBytes)
  return decoded
}

export class ConcurrencyLimiter {
  readonly #limit: number
  readonly #maxQueued: number
  #active = 0
  readonly #waiting: Array<() => void> = []

  constructor(limit: number, maxQueued = limit * 2) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 0) throw new Error('maxQueued must be a non-negative integer')
    this.#limit = limit
    this.#maxQueued = maxQueued
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.#acquire()
    try {
      return await operation()
    } finally {
      this.#release()
    }
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#limit) {
      this.#active += 1
      return
    }
    if (this.#waiting.length >= this.#maxQueued) throw new BusyError(this.#limit, this.#maxQueued)
    await new Promise<void>(resolve => this.#waiting.push(resolve))
  }

  #release(): void {
    this.#active -= 1
    const next = this.#waiting.shift()
    if (next !== undefined) {
      this.#active += 1
      next()
    }
  }
}

export class BusyError extends Error {
  readonly limit: number
  readonly maxQueued: number

  constructor(limit: number, maxQueued: number) {
    super('voice processing is busy')
    this.name = 'BusyError'
    this.limit = limit
    this.maxQueued = maxQueued
  }
}

export function assertTrustedOrigin(
  origin: string | null | undefined,
  requestUrl: string | URL,
  allowedOrigins: readonly string[],
  publicOrigin?: string,
): void {
  if (origin === undefined || origin === null || origin === '') throw new Error('missing Origin header')
  const request = new URL(requestUrl)
  const candidate = new URL(origin)
  if (candidate.origin === request.origin || candidate.origin === publicOrigin || allowedOrigins.includes(candidate.origin)) return
  throw new Error(`untrusted request origin: ${candidate.origin}`)
}

export function resolveHeaders(
  staticHeaders: Readonly<Record<string, string>> | undefined,
  headersFromEnv: Readonly<Record<string, string>> | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(staticHeaders ?? {})) {
    if (isSecretBearingHeader(name)) throw new Error(`static header ${name} is not allowed; use headersFromEnv instead`)
    setSafeHeader(headers, name, value)
  }
  for (const [name, environmentName] of Object.entries(headersFromEnv ?? {})) {
    const value = environment[environmentName]
    if (value === undefined || value === '') throw new Error(`environment variable ${environmentName} is required for header ${name}`)
    setSafeHeader(headers, name, value)
  }
  return headers
}

function isSecretBearingHeader(name: string): boolean {
  return ['authorization', 'cookie', 'proxy-authorization'].includes(name.trim().toLowerCase())
}

export function setSafeHeader(headers: Headers, name: string, value: string): void {
  if (/\r|\n/u.test(name) || /\r|\n/u.test(value)) throw new Error('header names and values must not contain line breaks')
  headers.set(name, value)
}
