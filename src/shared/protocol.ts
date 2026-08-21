export const API_ROOT = '/dsh-voice-refine/v1'
export const PROTOCOL_VERSION = 1
export const DEFAULT_MIN_RECORDING_MS = 800

export const MAX_CONTEXT_MESSAGES = 8
export const MAX_CONTEXT_CHARS = 6_000
export const MAX_DRAFT_CHARS = 4_000
export const MAX_CONFIRM_DRAFT_CHARS = 16_000
export const MAX_METADATA_BYTES = 32 * 1024
export const ENVELOPE_CONTENT_TYPE = 'application/vnd.dsh-voice-refine; version=1'
export const SUPPORTED_RECORDING_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/webm',
] as const

const ENVELOPE_HEADER_BYTES = 8
const ENVELOPE_MAGIC = 0x44565231

export type ConversationRole = 'user' | 'assistant'

export interface ConversationExcerpt {
  readonly role: ConversationRole
  readonly content: string
}

export interface VoiceProcessMetadata {
  readonly protocol: typeof PROTOCOL_VERSION
  readonly mimeType: string
  readonly fileName?: string
  readonly language?: string
  readonly draft?: string
  readonly placement?: 'append' | 'replace'
  readonly sessionId?: string
  readonly scope?: string
  readonly messages?: readonly ConversationExcerpt[]
}

export interface VoiceProcessResult {
  readonly ok: true
  readonly protocol: typeof PROTOCOL_VERSION
  readonly rawText: string
  readonly text: string
  readonly refined: boolean
  readonly refineFallback?: string
  readonly learningReceipt?: string
  readonly auditReceipt?: string
}

export interface VoiceDraftConfirmationRequest {
  readonly protocol: typeof PROTOCOL_VERSION
  readonly learningReceipt: string
  readonly draft: string
}

export interface VoiceDraftConfirmationResult {
  readonly ok: true
  readonly confirmed: boolean
  readonly reason: string
}

export type VoiceDeliveryReason = 'draft-written' | 'session-changed' | 'component-unmounted' | 'input-unavailable' | 'set-draft-failed'

export interface VoiceDeliveryConfirmationRequest {
  readonly protocol: typeof PROTOCOL_VERSION
  readonly auditReceipt: string
  readonly status: 'written' | 'not-written'
  readonly reason: VoiceDeliveryReason
  readonly placement?: 'append' | 'replace'
  readonly concurrentEdit?: boolean
}

export interface VoiceDeliveryConfirmationResult {
  readonly ok: true
  readonly confirmed: boolean
  readonly reason: string
}

export interface PublicPluginConfig {
  readonly protocol: typeof PROTOCOL_VERSION
  readonly maxAudioBytes: number
  readonly maxRecordingMs: number
  readonly minRecordingMs: number
  readonly refineEnabled: boolean
  readonly learningEnabled: boolean
  readonly supportedMimeTypes: readonly string[]
}

export interface ApiErrorBody {
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

export function encodeEnvelope(metadata: VoiceProcessMetadata, audio: Uint8Array): Uint8Array {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata))
  if (metadataBytes.byteLength > MAX_METADATA_BYTES) {
    throw new Error(`voice metadata exceeds ${MAX_METADATA_BYTES} bytes`)
  }
  const envelope = new Uint8Array(ENVELOPE_HEADER_BYTES + metadataBytes.byteLength + audio.byteLength)
  const header = new DataView(envelope.buffer, envelope.byteOffset, ENVELOPE_HEADER_BYTES)
  header.setUint32(0, ENVELOPE_MAGIC)
  header.setUint32(4, metadataBytes.byteLength)
  envelope.set(metadataBytes, ENVELOPE_HEADER_BYTES)
  envelope.set(audio, ENVELOPE_HEADER_BYTES + metadataBytes.byteLength)
  return envelope
}

export function decodeEnvelope(envelope: Uint8Array): { metadata: VoiceProcessMetadata; audio: Uint8Array } {
  if (envelope.byteLength < ENVELOPE_HEADER_BYTES) throw new Error('voice envelope is truncated')
  const header = new DataView(envelope.buffer, envelope.byteOffset, ENVELOPE_HEADER_BYTES)
  if (header.getUint32(0) !== ENVELOPE_MAGIC) throw new Error('voice envelope magic is invalid')
  const metadataLength = header.getUint32(4)
  if (metadataLength > MAX_METADATA_BYTES) throw new Error('voice metadata is too large')
  const audioOffset = ENVELOPE_HEADER_BYTES + metadataLength
  if (audioOffset > envelope.byteLength) throw new Error('voice envelope metadata is truncated')
  const metadataBytes = envelope.subarray(ENVELOPE_HEADER_BYTES, audioOffset)
  const metadata = validateProcessMetadata(JSON.parse(new TextDecoder().decode(metadataBytes)) as unknown)
  return { metadata, audio: envelope.subarray(audioOffset) }
}

export function validateProcessMetadata(value: unknown): VoiceProcessMetadata {
  if (!isRecord(value)) throw new Error('voice metadata must be an object')
  if (value.protocol !== PROTOCOL_VERSION) throw new Error('unsupported voice protocol version')
  if (!boundedString(value.mimeType, 1, 160) || !value.mimeType.toLowerCase().startsWith('audio/') || /[\r\n]/u.test(value.mimeType)) {
    throw new Error('voice metadata mimeType must be a valid audio media type')
  }
  optionalBoundedString(value.fileName, 'fileName', 160)
  optionalBoundedString(value.language, 'language', 64)
  optionalBoundedString(value.draft, 'draft', MAX_DRAFT_CHARS)
  if (value.placement !== undefined && value.placement !== 'append' && value.placement !== 'replace') {
    throw new Error('voice metadata placement must be append or replace')
  }
  optionalBoundedString(value.sessionId, 'sessionId', 256)
  optionalBoundedString(value.scope, 'scope', 256)
  if (value.messages !== undefined) {
    if (!Array.isArray(value.messages) || value.messages.length > MAX_CONTEXT_MESSAGES) {
      throw new Error(`voice metadata messages must contain at most ${MAX_CONTEXT_MESSAGES} entries`)
    }
    let characters = 0
    for (const message of value.messages) {
      if (!isRecord(message) || (message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') {
        throw new Error('voice metadata messages must contain user/assistant text')
      }
      characters += message.content.length
      if (characters > MAX_CONTEXT_CHARS) throw new Error('voice metadata message context is too large')
    }
  }
  return value as unknown as VoiceProcessMetadata
}

function optionalBoundedString(value: unknown, name: string, maxLength: number): void {
  if (value !== undefined && !boundedString(value, 0, maxLength)) {
    throw new Error(`voice metadata ${name} must be a string of at most ${maxLength} characters`)
  }
}

function boundedString(value: unknown, minLength: number, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= minLength && value.length <= maxLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
