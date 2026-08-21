import {
  MAX_CONTEXT_CHARS,
  MAX_DRAFT_CHARS,
  PROTOCOL_VERSION,
} from '../shared/protocol.js'
import type { VoiceProcessMetadata } from '../shared/protocol.js'
import { extractDraft, extractRecentMessages } from './context.js'
import { fileNameForMimeType } from './mime.js'

export interface BuildVoiceMetadataInput {
  readonly mimeType: string
  readonly fileName?: string
  readonly language?: string
  readonly append?: boolean
  readonly draft?: unknown
  readonly sessionId?: unknown
  readonly scope?: unknown
  readonly snapshot?: unknown
  readonly includeRecentContext?: boolean
}

export function buildVoiceProcessMetadata(input: BuildVoiceMetadataInput): VoiceProcessMetadata {
  const mimeType = input.mimeType.trim()
  if (mimeType === '') throw new Error('recorded audio has no MIME type')

  const draft = trimToLast(extractDraft(input.draft), MAX_DRAFT_CHARS)
  const sessionId = trimToLast(readString(input.sessionId) || extractSessionId(input.snapshot), 256)
  const scope = trimToLast(readString(input.scope), 256)
  const language = trimToLast(readString(input.language), 32)
  const fileName = safeFileName(input.fileName?.trim() || fileNameForMimeType(mimeType))
  const placement = input.append === undefined ? undefined : input.append ? 'append' : 'replace'
  const messages = input.includeRecentContext === true
    ? extractRecentMessages(input.snapshot, { maxChars: Math.max(0, MAX_CONTEXT_CHARS - draft.length) })
    : []

  return {
    protocol: PROTOCOL_VERSION,
    mimeType,
    fileName,
    draft,
    ...(placement === undefined ? {} : { placement }),
    ...(language === '' ? {} : { language }),
    ...(sessionId === '' ? {} : { sessionId }),
    ...(scope === '' ? {} : { scope }),
    ...(messages.length === 0 ? {} : { messages }),
  }
}

export type DigestBytes = (algorithm: string, data: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>

/**
 * Derive a stable workspace scope without sending the browser-visible path to
 * the host plugin or its model providers. If Web Crypto is unavailable, no
 * scope is returned and scoped learning stays disabled for that request.
 */
export async function opaqueWorkspaceScope(
  workspacePath: unknown,
  digest?: DigestBytes | null,
): Promise<string | undefined> {
  const path = readString(workspacePath)
  const digestBytes = digest === null ? undefined : digest ?? defaultDigest()
  if (path === '' || digestBytes === undefined) return undefined
  const bytes = new TextEncoder().encode(`dsh-voice-refine\0${path}`)
  const hash = new Uint8Array(await digestBytes('SHA-256', bytes))
  return `workspace-sha256:${Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')}`
}

export function appendDraft(existingDraft: string, newText: string, append: boolean): string {
  const normalizedExistingDraft = existingDraft.trimEnd()
  if (!append || normalizedExistingDraft.trim() === '') return newText
  if (newText === '') return existingDraft
  return `${normalizedExistingDraft} ${newText}`
}

export interface DraftDeliveryInput {
  readonly requestedSessionId: string | undefined
  readonly currentSessionId: string | undefined
  readonly draftAtRequest: string
  readonly currentDraft: string
  readonly text: string
  readonly append: boolean
}

export type DraftDelivery =
  | { readonly kind: 'session-changed' }
  | { readonly kind: 'write'; readonly draft: string; readonly concurrentEdit: boolean }

/**
 * Never overwrite text typed while ASR/refinement was running. A replace-mode
 * result degrades to append when the draft changed, preserving both inputs.
 */
export function resolveDraftDelivery(input: DraftDeliveryInput): DraftDelivery {
  if (input.requestedSessionId !== input.currentSessionId) return { kind: 'session-changed' }
  const concurrentEdit = input.currentDraft !== input.draftAtRequest
  return {
    kind: 'write',
    draft: appendDraft(
      concurrentEdit ? input.currentDraft : input.draftAtRequest,
      input.text,
      concurrentEdit ? true : input.append,
    ),
    concurrentEdit,
  }
}

export function extractSessionId(snapshot: unknown): string {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return ''
  const record = snapshot as Record<string, unknown>
  for (const key of ['sessionId', 'session_id']) {
    if (typeof record[key] === 'string') return record[key]
  }
  const session = record.session
  if (typeof session === 'object' && session !== null && !Array.isArray(session)) {
    const nested = session as Record<string, unknown>
    for (const key of ['sessionId', 'session_id', 'id']) {
      if (typeof nested[key] === 'string') return nested[key]
    }
  }
  return ''
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function trimToLast(value: string, maximum: number): string {
  if (maximum <= 0) return ''
  return value.length <= maximum ? value : value.slice(value.length - maximum)
}

function safeFileName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/gu, '_').replace(/^\.+/u, '').slice(0, 96)
  return sanitized === '' ? 'voice.audio' : sanitized
}

function defaultDigest(): DigestBytes | undefined {
  const subtle = globalThis.crypto?.subtle
  return subtle === undefined ? undefined : subtle.digest.bind(subtle) as DigestBytes
}
