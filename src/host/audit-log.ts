import { constants } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AuditConfig } from '../config.js'
import type { RefineTrace } from './refine.js'

const AUDIT_SCHEMA_VERSION = 1
const MAX_AUDIT_TEXT_CHARS = 16_000
const DAY_MS = 24 * 60 * 60 * 1000
const DAILY_FILE_PATTERN = /^refine-(\d{4}-\d{2}-\d{2})\.ndjson$/u
export type AuditTextField = 'rawText' | 'proposalText' | 'selectedText'

export interface RefinementAuditContext {
  readonly draftChars: number
  readonly recentMessageCount: number
  readonly recentMessageChars: number
  readonly learnedTermCount: number
}

export interface RefinementAuditInput {
  readonly eventId: string
  readonly sessionId?: string
  readonly scope?: string
  readonly rawText: string
  readonly selectedText: string
  readonly trace: RefineTrace
  readonly context: RefinementAuditContext
  readonly asrKind: string
  readonly asrModel?: string
  readonly refineKind: string
  readonly refineModel?: string
  readonly truncatedFields?: readonly AuditTextField[]
}

export type AuditDeliveryStatus = 'written' | 'not-written'

export interface DeliveryAuditInput {
  readonly eventId: string
  readonly refinement: RefinementAuditInput
  readonly status: AuditDeliveryStatus
  readonly reason: string
  readonly placement?: 'append' | 'replace'
  readonly concurrentEdit?: boolean
}

interface AuditRecordBase {
  readonly schemaVersion: typeof AUDIT_SCHEMA_VERSION
  readonly id: string
  readonly recordedAt: string
  readonly eventType: 'refinement' | 'delivery'
}

export interface RefinementAuditSnapshot {
  readonly eventId: string
  readonly sessionHash?: string
  readonly scopeHash?: string
  readonly rawText: string
  readonly proposalText?: string
  readonly selectedText: string
  readonly truncatedFields?: readonly AuditTextField[]
  readonly decision: RefineTrace['decision']
  readonly reason: RefineTrace['reason']
  readonly guardVersion: number
  readonly context: RefinementAuditContext
  readonly asrKind: string
  readonly asrModel?: string
  readonly refineKind: string
  readonly refineModel?: string
}

export interface RefinementAuditRecord extends AuditRecordBase, RefinementAuditSnapshot {
  readonly eventType: 'refinement'
}

export interface DeliveryAuditRecord extends AuditRecordBase {
  readonly eventType: 'delivery'
  readonly eventId: string
  readonly refinement: RefinementAuditSnapshot
  readonly status: AuditDeliveryStatus
  readonly reason: string
  readonly placement?: 'append' | 'replace'
  readonly concurrentEdit?: boolean
}

type AuditRecord = RefinementAuditRecord | DeliveryAuditRecord

export interface RefinementAuditSink {
  record(input: RefinementAuditInput): boolean
  recordDelivery(input: DeliveryAuditInput): boolean
}

export interface RefinementAuditLogOptions extends Required<AuditConfig> {
  readonly environment?: NodeJS.ProcessEnv
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
}

export function defaultAuditStorePath(): string {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'dsh-voice-refine', 'audit')
}

export class RefinementAuditLog implements RefinementAuditSink {
  readonly #options: RefinementAuditLogOptions
  readonly #directory: string
  readonly #identityKey: string
  readonly #now: () => number
  readonly #queue: AuditRecord[] = []
  readonly #idleWaiters: Array<() => void> = []
  #draining = false
  #lastPrunedDay = ''

  constructor(options: RefinementAuditLogOptions) {
    this.#options = options
    this.#directory = options.storePath === '' ? defaultAuditStorePath() : options.storePath
    this.#now = options.now ?? Date.now
    const key = (options.environment ?? process.env)[options.identityKeyEnv]
    if (options.enabled && (key === undefined || key.length < 32)) {
      throw new Error(`environment variable ${options.identityKeyEnv} must contain at least 32 characters when audit is enabled`)
    }
    this.#identityKey = key ?? ''
  }

  record(input: RefinementAuditInput): boolean {
    if (!this.#options.enabled) return false
    return this.#enqueue(createRefinementRecord(input, this.#now(), this.#identityKey))
  }

  recordDelivery(input: DeliveryAuditInput): boolean {
    if (!this.#options.enabled) return false
    return this.#enqueue(createDeliveryRecord(input, this.#now(), this.#identityKey))
  }

  async flush(): Promise<void> {
    if (!this.#draining && this.#queue.length === 0) return
    await new Promise<void>(resolve => { this.#idleWaiters.push(resolve) })
  }

  #enqueue(record: AuditRecord): boolean {
    if (this.#queue.length >= this.#options.maxPendingEntries) {
      this.#notifyError(new Error('refinement audit queue is full; record dropped'))
      return false
    }
    this.#queue.push(record)
    if (!this.#draining) {
      this.#draining = true
      void this.#drain()
    }
    return true
  }

  async #drain(): Promise<void> {
    try {
      while (this.#queue.length > 0) {
        const record = this.#queue.shift()
        if (record === undefined) continue
        try {
          await this.#write(record)
        } catch (error: unknown) {
          this.#notifyError(error)
        }
      }
    } finally {
      this.#draining = false
      for (const resolve of this.#idleWaiters.splice(0)) resolve()
      if (this.#queue.length > 0) {
        this.#draining = true
        void this.#drain()
      }
    }
  }

  async #write(record: AuditRecord): Promise<void> {
    const now = Date.parse(record.recordedAt)
    const day = record.recordedAt.slice(0, 10)
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    const directoryInfo = await lstat(this.#directory)
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('refinement audit storePath must be a real directory')
    await chmodDirectory(this.#directory)
    if (this.#lastPrunedDay !== day) {
      await this.#pruneExpired(now)
      this.#lastPrunedDay = day
    }
    const path = join(this.#directory, `refine-${day}.ndjson`)
    const handle = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new Error('refinement audit target must be a regular file')
      await handle.chmod(0o600)
      await handle.appendFile(`${JSON.stringify(record)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
  }

  async #pruneExpired(now: number): Promise<void> {
    const currentDay = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`)
    const oldestDay = currentDay - (this.#options.retentionDays - 1) * DAY_MS
    for (const entry of await readdir(this.#directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const match = DAILY_FILE_PATTERN.exec(entry.name)
      if (match === null) continue
      const day = match[1]
      if (day === undefined) continue
      const entryDay = Date.parse(`${day}T00:00:00.000Z`)
      if (!Number.isFinite(entryDay) || entryDay >= oldestDay) continue
      await unlink(join(this.#directory, entry.name))
    }
  }

  #notifyError(error: unknown): void {
    try {
      this.#options.onError?.(error)
    } catch {
      // Observability must never break voice input or the audit worker.
    }
  }
}

async function chmodDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    await handle.chmod(0o700)
  } finally {
    await handle.close()
  }
}

function createRefinementRecord(input: RefinementAuditInput, now: number, identityKey: string): RefinementAuditRecord {
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    id: randomUUID(),
    recordedAt: new Date(now).toISOString(),
    eventType: 'refinement',
    ...createRefinementSnapshot(input, identityKey),
  }
}

function createRefinementSnapshot(input: RefinementAuditInput, identityKey: string): RefinementAuditSnapshot {
  const sanitized = sanitizeRefinementAuditInput(input)
  return {
    eventId: sanitized.eventId,
    ...(sanitized.sessionId === undefined ? {} : { sessionHash: hashIdentifier(sanitized.sessionId, identityKey) }),
    ...(sanitized.scope === undefined ? {} : { scopeHash: hashIdentifier(sanitized.scope, identityKey) }),
    rawText: sanitized.rawText,
    ...(sanitized.trace.proposalText === undefined ? {} : { proposalText: sanitized.trace.proposalText }),
    selectedText: sanitized.selectedText,
    ...(sanitized.truncatedFields === undefined ? {} : { truncatedFields: sanitized.truncatedFields }),
    decision: sanitized.trace.decision,
    reason: sanitized.trace.reason,
    guardVersion: sanitized.trace.guardVersion,
    context: sanitized.context,
    asrKind: sanitized.asrKind,
    ...(sanitized.asrModel === undefined ? {} : { asrModel: sanitized.asrModel }),
    refineKind: sanitized.refineKind,
    ...(sanitized.refineModel === undefined ? {} : { refineModel: sanitized.refineModel }),
  }
}

function createDeliveryRecord(input: DeliveryAuditInput, now: number, identityKey: string): DeliveryAuditRecord {
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    id: randomUUID(),
    recordedAt: new Date(now).toISOString(),
    eventType: 'delivery',
    eventId: input.eventId,
    refinement: createRefinementSnapshot(input.refinement, identityKey),
    status: input.status,
    reason: input.reason,
    ...(input.placement === undefined ? {} : { placement: input.placement }),
    ...(input.concurrentEdit === undefined ? {} : { concurrentEdit: input.concurrentEdit }),
  }
}

function hashIdentifier(value: string, key: string): string {
  return createHmac('sha256', key).update(value).digest('hex').slice(0, 24)
}

function protectedText(value: string): { text: string; truncated: boolean } {
  const truncated = value.length > MAX_AUDIT_TEXT_CHARS
  return { text: redactSensitiveText(value).slice(0, MAX_AUDIT_TEXT_CHARS), truncated }
}

export function sanitizeRefinementAuditInput(input: RefinementAuditInput): RefinementAuditInput {
  const raw = protectedText(input.rawText)
  const proposal = input.trace.proposalText === undefined ? undefined : protectedText(input.trace.proposalText)
  const selected = protectedText(input.selectedText)
  const truncatedFields = new Set<AuditTextField>(input.truncatedFields ?? [])
  if (raw.truncated) truncatedFields.add('rawText')
  if (proposal?.truncated === true) truncatedFields.add('proposalText')
  if (selected.truncated) truncatedFields.add('selectedText')
  return {
    ...input,
    rawText: raw.text,
    selectedText: selected.text,
    trace: proposal === undefined ? input.trace : { ...input.trace, proposalText: proposal.text },
    ...(truncatedFields.size === 0 ? {} : { truncatedFields: Array.from(truncatedFields) }),
  }
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|secret|token|password|authorization|access[_-]?key)(?:[_-][A-Za-z0-9]+)*)\s*[:=]\s*[^\r\n,;]+/giu, '$1=[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, '[REDACTED_JWT]')
    .replace(/\b(?:sk|glpat)-[A-Za-z0-9_-]{12,}\b/giu, '[REDACTED_KEY]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/giu, '[REDACTED_KEY]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/giu, '[REDACTED_KEY]')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, '[REDACTED_KEY]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/gu, '[REDACTED_KEY]')
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/giu, '[REDACTED_KEY]')
    .replace(/\b(?:npm|hf)_[A-Za-z0-9_-]{20,}\b/giu, '[REDACTED_KEY]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, token => isHighEntropyToken(token) ? '[REDACTED_TOKEN]' : token)
}

function isHighEntropyToken(token: string): boolean {
  return /[A-Za-z]/u.test(token) && /\d/u.test(token)
}
