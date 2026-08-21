import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { LearningConfig } from '../config.js'
import type { LearnedTerm } from './context.js'

const STORE_VERSION = 1
const MAX_PHRASE_TOKENS = 4
const MAX_PHRASE_CHARS = 48
const MAX_CJK_PHRASE_CODEPOINTS = 8

export interface CorrectionMemoryOptions extends Omit<Required<LearningConfig>, 'requireScope'> {
  readonly requireScope?: boolean
  readonly now?: () => number
}

export interface CorrectionEntry extends LearnedTerm {
  readonly scope?: string
  readonly occurrences: number
  readonly updatedAt: number
}

interface PendingCandidate {
  readonly text: string
  readonly scope?: string
  readonly sessionId?: string
  readonly expiresAt: number
}

export interface PendingCandidateContext {
  readonly scope?: string
  readonly sessionId?: string
}

export interface ObservedMessageResult {
  readonly matched: boolean
  readonly learned: boolean
  readonly reason: string
}

interface StoredState {
  readonly version: typeof STORE_VERSION
  entries: CorrectionEntry[]
}

export function defaultCorrectionStorePath(): string {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'dsh-voice-refine', 'corrections.json')
}

export class CorrectionMemory {
  readonly #options: Required<CorrectionMemoryOptions>
  readonly #path: string
  readonly #now: () => number
  #state: StoredState = { version: STORE_VERSION, entries: [] }
  #pending: PendingCandidate[] = []
  #loaded = false
  #serial: Promise<void> = Promise.resolve()

  constructor(options: CorrectionMemoryOptions) {
    this.#options = { ...options, requireScope: options.requireScope ?? true, now: options.now ?? Date.now }
    this.#path = options.storePath === '' ? defaultCorrectionStorePath() : options.storePath
    this.#now = this.#options.now
  }

  async addPending(text: string, context: PendingCandidateContext = {}): Promise<void> {
    if (!this.#options.enabled) return
    return this.#change(() => {
      const scope = context.scope === undefined ? undefined : boundedScope(context.scope)
      const sessionId = context.sessionId === undefined ? undefined : boundedSessionId(context.sessionId)
      if (sessionId === undefined || (this.#options.requireScope && scope === undefined)) return
      this.#pending.push({
        text: boundedText(text),
        ...(scope === undefined ? {} : { scope }),
        sessionId,
        expiresAt: this.#now() + this.#options.pendingTtlMs,
      })
    })
  }

  async observeSubmittedUserMessage(sessionId: string, submittedText: string): Promise<ObservedMessageResult> {
    const boundedSession = boundedSessionId(sessionId)
    if (!this.#options.enabled) return { matched: false, learned: false, reason: 'learning-disabled' }
    return this.#change(() => {
      const candidate = this.#pending
        .filter(item => item.sessionId === boundedSession)
        .at(-1)
      if (candidate === undefined) return { matched: false, learned: false, reason: 'candidate-not-found' }
      // A direct submission consumes every outstanding candidate for this
      // session. The newest confirmed draft already contains earlier voice
      // insertions; retaining older or mismatched candidates risks learning
      // from an unrelated future message.
      this.#pending = this.#pending.filter(item => item.sessionId !== boundedSession)
      if (!isConservativeMessageMatch(candidate.text, submittedText)) {
        return { matched: false, learned: false, reason: 'candidate-text-mismatch' }
      }
      const result = this.#learnCandidate(candidate, submittedText)
      return { matched: true, ...result }
    })
  }

  async list(scope?: string): Promise<readonly CorrectionEntry[]> {
    if (!this.#options.enabled) return []
    await this.#load()
    this.#pruneExpired()
    return this.#state.entries
      .filter(entry => entry.scope === scope)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(entry => ({ ...entry }))
  }

  async learnedTerms(scope?: string): Promise<readonly LearnedTerm[]> {
    const entries = await this.list(scope)
    return entries
      .filter(entry => entry.occurrences >= this.#options.minOccurrences)
      .map(({ from, to }) => ({ from, to }))
  }

  async delete(from: string, to: string, scope?: string): Promise<boolean> {
    if (!this.#options.enabled) return false
    return this.#change(() => {
      const index = this.#state.entries.findIndex(entry => entry.from === from && entry.to === to && entry.scope === scope)
      if (index < 0) return false
      this.#state.entries.splice(index, 1)
      return true
    })
  }

  async #change<T>(operation: () => T): Promise<T> {
    let result!: T
    const next = this.#serial.then(async () => {
      await this.#load()
      this.#pruneExpired()
      const previousState: StoredState = {
        version: STORE_VERSION,
        entries: this.#state.entries.map(entry => ({ ...entry })),
      }
      const previousPending = this.#pending.map(candidate => ({ ...candidate }))
      try {
        result = operation()
        if (this.#options.enabled) await this.#persist()
      } catch (error) {
        this.#state = previousState
        this.#pending = previousPending
        throw error
      }
    })
    this.#serial = next.catch(() => undefined)
    await next
    return result
  }

  async #load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    if (!this.#options.enabled) return
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8')) as Partial<StoredState>
      if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.entries)) throw new Error('unsupported correction memory file')
      this.#state = {
        version: STORE_VERSION,
        entries: parsed.entries.filter(isCorrectionEntry),
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.#pruneExpired()
  }

  #pruneExpired(): void {
    const now = this.#now()
    this.#pending = this.#pending.filter(candidate => candidate.expiresAt > now)
  }

  #record(from: string, to: string, scope: string | undefined): void {
    const index = this.#state.entries.findIndex(entry => entry.from === from && entry.to === to && entry.scope === scope)
    if (index >= 0) {
      const existing = this.#state.entries[index]
      if (existing === undefined) throw new Error('correction memory entry disappeared')
      this.#state.entries[index] = { ...existing, occurrences: existing.occurrences + 1, updatedAt: this.#now() }
      return
    }
    this.#state.entries.push({ from, to, ...(scope === undefined ? {} : { scope }), occurrences: 1, updatedAt: this.#now() })
    this.#state.entries.sort((left, right) => right.updatedAt - left.updatedAt)
    this.#state.entries.length = Math.min(this.#state.entries.length, this.#options.maxEntries)
  }

  #learnCandidate(candidate: PendingCandidate, submittedText: string): { learned: boolean, reason: string } {
    const substitutions = deriveSubstitutions(candidate.text, submittedText)
    if (substitutions.length === 0) return { learned: false, reason: 'no-safe-substitution' }
    for (const substitution of substitutions) this.#record(substitution.from, substitution.to, candidate.scope)
    return { learned: true, reason: 'recorded' }
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
    const temporary = `${this.#path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(this.#state), { encoding: 'utf8', mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.#path)
    await chmod(this.#path, 0o600)
  }
}

function deriveSubstitutions(before: string, after: string): Array<Pick<LearnedTerm, 'from' | 'to'>> {
  const source = tokenize(before)
  const submitted = tokenize(after)
  const substitutions: Array<Pick<LearnedTerm, 'from' | 'to'>> = []
  let prefix = 0
  while (prefix < source.length && prefix < submitted.length && source[prefix] === submitted[prefix]) prefix += 1
  let sourceEnd = source.length
  let submittedEnd = submitted.length
  while (sourceEnd > prefix && submittedEnd > prefix && source[sourceEnd - 1] === submitted[submittedEnd - 1]) {
    sourceEnd -= 1
    submittedEnd -= 1
  }
  const from = phraseFromTokens(source.slice(prefix, sourceEnd))
  const to = phraseFromTokens(submitted.slice(prefix, submittedEnd))
  if (isSafePhrase(from) && isSafePhrase(to)) substitutions.push({ from, to })
  return substitutions
}

function tokenize(value: string): string[] {
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : undefined
  if (segmenter !== undefined) {
    return Array.from(segmenter.segment(value), segment => segment.isWordLike ? segment.segment : '').filter(Boolean)
  }
  const tokens: string[] = []
  let word = ''
  const flushWord = (): void => {
    if (word !== '') tokens.push(word)
    word = ''
  }
  for (const character of value) {
    if (isCjkCharacter(character)) {
      flushWord()
      tokens.push(character)
    } else if (/[\p{L}\p{N}]/u.test(character)) {
      word += character
    } else {
      flushWord()
    }
  }
  flushWord()
  return tokens
}

function isSafePhrase(value: string): boolean {
  const tokens = tokenize(value)
  if (tokens.length === 0 || tokens.length > MAX_PHRASE_TOKENS || Array.from(value).length > MAX_PHRASE_CHARS) return false
  if (containsCjk(value) && Array.from(value).filter(isCjkCharacter).length > MAX_CJK_PHRASE_CODEPOINTS) return false
  if (/(?:api[_-]?key|password|secret|authorization|bearer|token)\s*[:=]/iu.test(value)) return false
  if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./u.test(value)) return false
  return !tokens.some(isHighEntropyToken)
}

function phraseFromTokens(tokens: readonly string[]): string {
  return tokens.every(token => containsCjk(token)) ? tokens.join('') : tokens.join(' ')
}

function containsCjk(value: string): boolean {
  return Array.from(value).some(isCjkCharacter)
}

function isCjkCharacter(character: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f]/u.test(character)
}

function isHighEntropyToken(token: string): boolean {
  if (token.length < 20) return false
  const categories = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^A-Za-z0-9]/u].filter(pattern => pattern.test(token)).length
  return categories >= 3 || /^[A-Za-z0-9_-]{28,}$/u.test(token)
}

function boundedText(value: string): string {
  return value.slice(0, 16_000)
}

function boundedScope(value: string): string {
  if (value.length > 256) throw new Error('scope must be at most 256 characters')
  return value
}

function boundedSessionId(value: string): string {
  if (value === '' || value.length > 256) throw new Error('sessionId must contain at most 256 characters')
  return value
}

function isCorrectionEntry(value: unknown): value is CorrectionEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Partial<CorrectionEntry>
  return typeof entry.from === 'string' && typeof entry.to === 'string'
    && typeof entry.occurrences === 'number' && typeof entry.updatedAt === 'number'
    && (entry.scope === undefined || typeof entry.scope === 'string')
}

function isConservativeMessageMatch(candidate: string, submitted: string): boolean {
  const candidateTokens = comparableTokens(candidate)
  const submittedTokens = comparableTokens(submitted)
  if (candidateTokens.length === 0 || submittedTokens.length === 0) return false
  if (candidateTokens.join(' ') === submittedTokens.join(' ')) return true
  const shorter = Math.min(candidateTokens.length, submittedTokens.length)
  const longer = Math.max(candidateTokens.length, submittedTokens.length)
  const common = longestCommonSubsequenceLength(candidateTokens, submittedTokens)
  if (shorter === 1) return false
  if (shorter === 2) {
    return longer === 2 && common === 1 && candidateTokens.some(token => token.length >= 4 && submittedTokens.includes(token))
  }
  return common >= shorter - 1 && common / longer >= 0.6
}

function comparableTokens(value: string): string[] {
  return tokenize(value).map(token => token.toLocaleLowerCase())
}

function longestCommonSubsequenceLength(left: readonly string[], right: readonly string[]): number {
  let previous = new Array<number>(right.length + 1).fill(0)
  for (const leftValue of left) {
    const current = [0]
    for (let index = 1; index <= right.length; index += 1) {
      const rightValue = right[index - 1]
      current[index] = leftValue === rightValue
        ? (previous[index - 1] ?? 0) + 1
        : Math.max(previous[index] ?? 0, current[index - 1] ?? 0)
    }
    previous = current
  }
  return previous[right.length] ?? 0
}
