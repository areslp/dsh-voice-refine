import { MAX_CONTEXT_CHARS, MAX_CONTEXT_MESSAGES } from '../shared/protocol.js'
import type { ConversationExcerpt, ConversationRole } from '../shared/protocol.js'

export interface ContextExtractionOptions {
  readonly maxMessages?: number
  readonly maxChars?: number
}

export type InputLifecyclePhase = 'plain' | 'adjudicating' | 'claimed' | 'submitting'

export interface InputLifecycleSnapshot {
  readonly draft: string
  readonly phase: InputLifecyclePhase | undefined
}

export interface UserSubmissionSnapshot {
  readonly count: number
  readonly lastSequence: number | undefined
  readonly lastIdentity: string
}

const INPUT_LIFECYCLE_PHASES = new Set<InputLifecyclePhase>([
  'plain',
  'adjudicating',
  'claimed',
  'submitting',
])

const MESSAGE_PATHS: readonly (readonly string[])[] = [
  ['snapshot', 'chat', 'legacy', 'nodes'],
  ['chat', 'legacy', 'nodes'],
  ['session', 'chat', 'nodes'],
  ['session', 'chat', 'messages'],
  ['session', 'chat', 'items'],
  ['session', 'messages'],
  ['session', 'nodes'],
  ['chat', 'nodes'],
  ['chat', 'messages'],
  ['chat', 'items'],
  ['messages'],
  ['nodes'],
  ['history'],
  ['turns'],
]

const NESTED_CONTAINER_KEYS = new Set([
  'session',
  'sessionSnapshot',
  'snapshot',
  'conversation',
  'chat',
  'legacy',
  'messages',
  'nodes',
  'history',
  'turns',
  'items',
  'entries',
  'data',
  'value',
])

export function extractRecentMessages(
  snapshot: unknown,
  options: ContextExtractionOptions = {},
): ConversationExcerpt[] {
  const maxMessages = normalizeBudget(options.maxMessages, MAX_CONTEXT_MESSAGES)
  const maxChars = normalizeBudget(options.maxChars, MAX_CONTEXT_CHARS)
  if (maxMessages === 0 || maxChars === 0) return []

  const candidate = findMessageArray(snapshot)
  if (candidate === undefined) return []
  const messages = candidate.map(parseConversationMessage).filter(isConversationExcerpt)
  return trimMessagesToBudget(messages, maxMessages, maxChars)
}

export function extractDraft(input: unknown): string {
  if (typeof input === 'string') return input
  const record = asRecord(input)
  if (record === undefined) return ''
  for (const key of ['draft', 'text', 'value', 'content']) {
    const text = extractText(record[key])
    if (text !== '') return text
  }
  return ''
}

export function extractInputLifecycle(input: unknown): InputLifecycleSnapshot {
  const record = asRecord(input)
  const phase = typeof record?.phase === 'string' && INPUT_LIFECYCLE_PHASES.has(record.phase as InputLifecyclePhase)
    ? record.phase as InputLifecyclePhase
    : undefined
  return { draft: extractDraft(input), phase }
}

export function extractUserSubmissionSnapshot(snapshot: unknown): UserSubmissionSnapshot {
  const candidate = findMessageArray(snapshot)
  if (candidate === undefined) return { count: 0, lastSequence: undefined, lastIdentity: '' }
  let count = 0
  let lastSequence: number | undefined
  let lastIdentity = ''
  for (const item of candidate) {
    const parsed = parseConversationMessage(item)
    if (parsed?.role !== 'user') continue
    count += 1
    const record = asRecord(item)
    const sources = [record, asRecord(record?.message), asRecord(record?.data), asRecord(record?.payload)]
      .filter((source): source is Record<string, unknown> => source !== undefined)
    const sequence = sources.map(source => source.seq).find((value): value is number => typeof value === 'number' && Number.isSafeInteger(value))
    if (sequence !== undefined) lastSequence = sequence
    const identity = sources
      .flatMap(source => ['id', 'messageId', 'message_id'].map(key => source[key]))
      .find((value): value is string | number => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)))
    lastIdentity = identity === undefined ? `${parsed.content.length}:${parsed.content}` : String(identity)
  }
  return { count, lastSequence, lastIdentity }
}

export function hasNewUserSubmission(previous: UserSubmissionSnapshot, current: UserSubmissionSnapshot): boolean {
  if (previous.lastSequence !== undefined && current.lastSequence !== undefined) {
    return current.lastSequence > previous.lastSequence
  }
  if (current.count !== previous.count) return current.count > previous.count
  return current.count > 0 && current.lastIdentity !== previous.lastIdentity
}

/**
 * Once DSH starts adjudicating or submitting, the user has acted on the
 * draft and the earlier delivery notice is no longer useful. Draft text alone
 * is deliberately not evidence: a user can edit or clear it without sending.
 */
export function shouldClearDeliveredDraftNotice(
  previous: InputLifecycleSnapshot | undefined,
  current: InputLifecycleSnapshot,
): boolean {
  if (previous === undefined) return false
  if ((current.phase === 'adjudicating' || current.phase === 'submitting') && current.phase !== previous.phase) return true
  return false
}

function findMessageArray(snapshot: unknown): readonly unknown[] | undefined {
  if (Array.isArray(snapshot)) return snapshot
  for (const path of MESSAGE_PATHS) {
    const candidate = valueAtPath(snapshot, path)
    if (Array.isArray(candidate) && candidate.some(item => parseConversationMessage(item) !== undefined)) return candidate
  }
  return findNestedMessageArray(snapshot, new Set<object>(), 0)
}

function findNestedMessageArray(value: unknown, visited: Set<object>, depth: number): readonly unknown[] | undefined {
  if (depth > 6) return undefined
  if (Array.isArray(value)) {
    if (value.some(item => parseConversationMessage(item) !== undefined)) return value
    for (const item of value) {
      const nested = findNestedMessageArray(item, visited, depth + 1)
      if (nested !== undefined) return nested
    }
    return undefined
  }
  const record = asRecord(value)
  if (record === undefined || visited.has(record)) return undefined
  visited.add(record)
  for (const [key, child] of Object.entries(record)) {
    if (!NESTED_CONTAINER_KEYS.has(key)) continue
    const nested = findNestedMessageArray(child, visited, depth + 1)
    if (nested !== undefined) return nested
  }
  return undefined
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    const record = asRecord(current)
    if (record === undefined) return undefined
    current = record[key]
  }
  return current
}

function parseConversationMessage(value: unknown): ConversationExcerpt | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const sources = [record, asRecord(record.message), asRecord(record.data), asRecord(record.payload)]
    .filter((source): source is Record<string, unknown> => source !== undefined)
  const role = sources.map(readRole).find((candidate): candidate is ConversationRole => candidate !== undefined)
  if (role === undefined) return undefined
  const content = sources
    .map(source => extractTextFromRecord(source))
    .find(candidate => candidate !== '')
  if (content === undefined || content === '') return undefined
  return { role, content }
}

function readRole(source: Record<string, unknown>): ConversationRole | undefined {
  for (const key of ['role', 'author', 'sender', 'type', 'kind']) {
    const value = source[key]
    const nestedRole = asRecord(value)?.role
    const candidate = typeof value === 'string' ? value : typeof nestedRole === 'string' ? nestedRole : undefined
    const role = normalizeRole(candidate)
    if (role !== undefined) return role
  }
  return undefined
}

function normalizeRole(value: string | undefined): ConversationRole | undefined {
  switch (value?.trim().toLowerCase()) {
    case 'user':
    case 'human':
    case 'input':
    case 'steering':
      return 'user'
    case 'assistant':
    case 'ai':
    case 'model':
    case 'output':
      return 'assistant'
    default:
      return undefined
  }
}

function extractTextFromRecord(record: Record<string, unknown>): string {
  for (const key of ['content', 'text', 'parts', 'value', 'body']) {
    const text = extractText(record[key])
    if (text !== '') return text
  }
  return ''
}

function extractText(value: unknown, depth = 0, visited = new Set<object>()): string {
  if (depth > 5) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value.map(item => extractText(item, depth + 1, visited)).filter(text => text !== '').join('\n').trim()
  }
  const record = asRecord(value)
  if (record === undefined || visited.has(record)) return ''
  visited.add(record)
  for (const key of ['text', 'content', 'parts', 'value', 'body', 'message']) {
    const text = extractText(record[key], depth + 1, visited)
    if (text !== '') return text
  }
  return ''
}

function trimMessagesToBudget(
  messages: readonly ConversationExcerpt[],
  maxMessages: number,
  maxChars: number,
): ConversationExcerpt[] {
  const recent = messages.slice(-maxMessages)
  const kept: ConversationExcerpt[] = []
  let remaining = maxChars
  for (let index = recent.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = recent[index]
    if (message === undefined) continue
    const content = trimToLast(message.content, remaining)
    if (content === '') continue
    kept.push({ role: message.role, content })
    remaining -= content.length
  }
  return kept.reverse()
}

function trimToLast(value: string, maximum: number): string {
  if (maximum <= 0) return ''
  return value.length <= maximum ? value : value.slice(value.length - maximum)
}

function normalizeBudget(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value)) return fallback
  return Math.max(0, value)
}

function isConversationExcerpt(value: ConversationExcerpt | undefined): value is ConversationExcerpt {
  return value !== undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
