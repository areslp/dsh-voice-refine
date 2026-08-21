import {
  API_ROOT,
  DEFAULT_MIN_RECORDING_MS,
  ENVELOPE_CONTENT_TYPE,
  PROTOCOL_VERSION,
  encodeEnvelope,
} from '../shared/protocol.js'
import type {
  ApiErrorBody,
  PublicPluginConfig,
  VoiceDeliveryConfirmationRequest,
  VoiceDeliveryConfirmationResult,
  VoiceDraftConfirmationRequest,
  VoiceDraftConfirmationResult,
  VoiceProcessMetadata,
  VoiceProcessResult,
} from '../shared/protocol.js'

export const CONFIG_ENDPOINT = `${API_ROOT}/config`
export const PROCESS_ENDPOINT = `${API_ROOT}/process`
export const CONFIRM_DRAFT_ENDPOINT = `${API_ROOT}/confirm-draft`
export const CONFIRM_DELIVERY_ENDPOINT = `${API_ROOT}/confirm-delivery`
export const DEFAULT_MAX_RECORDING_MS = 90_000

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class VoiceApiError extends Error {
  readonly code: string
  readonly status: number | undefined

  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = 'VoiceApiError'
    this.code = code
    this.status = status
  }
}

export function parsePublicPluginConfig(value: unknown): PublicPluginConfig {
  const record = asRecord(value)
  if (record === undefined) throw new VoiceApiError('invalid-config', 'voice configuration response is invalid')
  if (record.protocol !== undefined && record.protocol !== PROTOCOL_VERSION) {
    throw new VoiceApiError('unsupported-protocol', 'voice configuration protocol is unsupported')
  }
  const maxRecordingMs = positiveInteger(record.maxRecordingMs, DEFAULT_MAX_RECORDING_MS)
  const minRecordingMs = positiveInteger(record.minRecordingMs, DEFAULT_MIN_RECORDING_MS)
  const maxAudioBytes = positiveInteger(record.maxAudioBytes, 16 * 1024 * 1024)
  const supportedMimeTypes = Array.isArray(record.supportedMimeTypes)
    ? record.supportedMimeTypes.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
    : []
  return {
    protocol: PROTOCOL_VERSION,
    maxAudioBytes,
    maxRecordingMs,
    minRecordingMs: Math.min(minRecordingMs, Math.max(1, maxRecordingMs - 1)),
    refineEnabled: record.refineEnabled === true,
    learningEnabled: record.learningEnabled === true,
    supportedMimeTypes,
  }
}

export async function fetchPublicPluginConfig(fetcher?: FetchLike): Promise<PublicPluginConfig> {
  const response = await resolveFetch(fetcher)(CONFIG_ENDPOINT, {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  })
  const body = await readJson(response)
  if (!response.ok) throw apiErrorFromResponse(response, body)
  return parsePublicPluginConfig(body)
}

export interface ProcessVoiceAudioInput {
  readonly metadata: VoiceProcessMetadata
  readonly audio: Blob | Uint8Array
}

export function assertAudioWithinLimit(audio: Blob | Uint8Array, maxAudioBytes: number): void {
  const size = audio instanceof Blob ? audio.size : audio.byteLength
  if (!Number.isSafeInteger(maxAudioBytes) || maxAudioBytes <= 0 || size > maxAudioBytes) {
    throw new VoiceApiError('audio-too-large', 'recorded audio exceeds the configured size limit')
  }
}

export function assertRecordingDuration(elapsedMs: number, minRecordingMs: number): void {
  if (!Number.isFinite(elapsedMs) || elapsedMs < minRecordingMs) {
    throw new VoiceApiError('recording-too-short', 'recording is too short')
  }
}

export async function processVoiceAudio(
  input: ProcessVoiceAudioInput,
  fetcher?: FetchLike,
): Promise<VoiceProcessResult> {
  const audio = input.audio instanceof Blob
    ? new Uint8Array(await input.audio.arrayBuffer())
    : new Uint8Array(input.audio)
  if (audio.byteLength === 0) throw new VoiceApiError('empty-audio', 'recorded audio is empty')

  const envelope = encodeEnvelope(input.metadata, audio)
  const response = await resolveFetch(fetcher)(PROCESS_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': ENVELOPE_CONTENT_TYPE },
    body: envelope as unknown as BodyInit,
    credentials: 'same-origin',
  })
  const body = await readJson(response)
  if (!response.ok) throw apiErrorFromResponse(response, body)
  return parseVoiceProcessResult(body)
}

export function parseVoiceProcessResult(value: unknown): VoiceProcessResult {
  const record = asRecord(value)
  if (record === undefined) throw new VoiceApiError('invalid-response', 'voice service response is invalid')
  if (record.ok === false) throw apiErrorFromBody(record, undefined)
  if (record.ok !== true || record.protocol !== PROTOCOL_VERSION) {
    throw new VoiceApiError('invalid-response', 'voice service returned an unsupported response')
  }
  const text = typeof record.text === 'string' ? record.text : ''
  const rawText = typeof record.rawText === 'string' ? record.rawText : text
  if (text.trim() === '' || rawText.trim() === '') {
    throw new VoiceApiError('invalid-response', 'voice service returned an empty result')
  }
  const result: VoiceProcessResult = {
    ok: true,
    protocol: PROTOCOL_VERSION,
    rawText,
    text,
    refined: record.refined === true,
  }
  const withFallback = typeof record.refineFallback === 'string' && record.refineFallback.trim() !== ''
    ? { ...result, refineFallback: record.refineFallback }
    : result
  let withReceipts = withFallback
  if (record.learningReceipt !== undefined) {
    if (typeof record.learningReceipt !== 'string' || record.learningReceipt.trim() === '' || record.learningReceipt.length > 128) {
      throw new VoiceApiError('invalid-response', 'voice service returned an invalid learning receipt')
    }
    withReceipts = { ...withReceipts, learningReceipt: record.learningReceipt }
  }
  if (record.auditReceipt !== undefined) {
    if (typeof record.auditReceipt !== 'string' || record.auditReceipt.trim() === '' || record.auditReceipt.length > 128) {
      throw new VoiceApiError('invalid-response', 'voice service returned an invalid audit receipt')
    }
    withReceipts = { ...withReceipts, auditReceipt: record.auditReceipt }
  }
  return withReceipts
}

export async function confirmVoiceDraft(
  request: VoiceDraftConfirmationRequest,
  fetcher?: FetchLike,
): Promise<VoiceDraftConfirmationResult> {
  const response = await resolveFetch(fetcher)(CONFIRM_DRAFT_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    credentials: 'same-origin',
  })
  const body = await readJson(response)
  if (!response.ok) throw apiErrorFromResponse(response, body)
  const record = asRecord(body)
  if (record?.ok !== true || typeof record.confirmed !== 'boolean' || typeof record.reason !== 'string') {
    throw new VoiceApiError('invalid-response', 'voice service returned an invalid draft confirmation')
  }
  return { ok: true, confirmed: record.confirmed, reason: record.reason }
}

export async function confirmVoiceDelivery(
  request: VoiceDeliveryConfirmationRequest,
  fetcher?: FetchLike,
  timeoutMs = 5_000,
): Promise<VoiceDeliveryConfirmationResult> {
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await resolveFetch(fetcher)(CONFIRM_DELIVERY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      credentials: 'same-origin',
      keepalive: true,
      signal: controller.signal,
    })
  } finally {
    globalThis.clearTimeout(timeout)
  }
  const body = await readJson(response)
  if (!response.ok) throw apiErrorFromResponse(response, body)
  const record = asRecord(body)
  if (record?.ok !== true || typeof record.confirmed !== 'boolean' || typeof record.reason !== 'string') {
    throw new VoiceApiError('invalid-response', 'voice service returned an invalid delivery confirmation')
  }
  return { ok: true, confirmed: record.confirmed, reason: record.reason }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown
  } catch {
    return undefined
  }
}

function apiErrorFromResponse(response: Response, body: unknown): VoiceApiError {
  return apiErrorFromBody(body, response.status)
}

function apiErrorFromBody(value: unknown, status: number | undefined): VoiceApiError {
  const body = asRecord(value) as Partial<ApiErrorBody> | undefined
  const nested = asRecord(body?.error)
  const code = typeof nested?.code === 'string' && nested.code !== '' ? nested.code : 'request-failed'
  const message = typeof nested?.message === 'string' && nested.message !== '' ? nested.message : 'voice request failed'
  return new VoiceApiError(code, message, status)
}

function resolveFetch(fetcher: FetchLike | undefined): FetchLike {
  if (fetcher !== undefined) return fetcher
  if (typeof globalThis.fetch !== 'function') throw new VoiceApiError('fetch-unavailable', 'browser fetch is unavailable')
  return globalThis.fetch.bind(globalThis)
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
