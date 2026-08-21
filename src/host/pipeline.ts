import { randomUUID } from 'node:crypto'
import type { ResolvedPluginConfig } from '../config.js'
import { MAX_CONFIRM_DRAFT_CHARS, PROTOCOL_VERSION } from '../shared/protocol.js'
import type {
  VoiceDeliveryConfirmationRequest,
  VoiceDeliveryConfirmationResult,
  VoiceDraftConfirmationRequest,
  VoiceDraftConfirmationResult,
  VoiceProcessResult,
} from '../shared/protocol.js'
import { createAsrAdapter, type AsrAdapter, type AdapterDependencies } from './asr.js'
import { buildRefinementContext } from './context.js'
import { CorrectionMemory, type CorrectionMemoryOptions } from './correction-memory.js'
import {
  RefinementAuditLog,
  sanitizeRefinementAuditInput,
  type RefinementAuditInput,
  type RefinementAuditSink,
} from './audit-log.js'
import { createRefineAdapter, type RefineAdapter, type RefineDependencies } from './refine.js'
import { ConcurrencyLimiter, assertEnvelopeContentType, readVoiceEnvelope, type BodySource } from './security.js'

export interface VoicePipelineDependencies extends AdapterDependencies, RefineDependencies {
  readonly memory?: CorrectionMemory
  readonly audit?: RefinementAuditSink
  readonly onAuditError?: (error: unknown) => void
}

export interface ProcessVoiceInput {
  readonly body: BodySource
  readonly contentType: string | null | undefined
  readonly signal?: AbortSignal
  readonly bodyTimeoutMs?: number
}

const AUDIT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000
const DELIVERY_REASONS = new Set(['draft-written', 'session-changed', 'component-unmounted', 'input-unavailable', 'set-draft-failed'])

export class VoicePipeline {
  readonly #asr: AsrAdapter
  readonly #refine: RefineAdapter
  readonly #memory: CorrectionMemory
  readonly #audit: RefinementAuditSink
  readonly #onAuditError: ((error: unknown) => void) | undefined
  readonly #limiter: ConcurrencyLimiter
  readonly #config: ResolvedPluginConfig
  readonly #learningReceipts = new Map<string, {
    readonly sessionId: string
    readonly scope?: string
    readonly createdAt: number
    readonly expiresAt: number
  }>()
  readonly #auditReceipts = new Map<string, { readonly refinement: RefinementAuditInput; readonly expiresAt: number }>()
  readonly #redeemingReceipts = new Set<string>()
  readonly #lastSubmissionAt = new Map<string, number>()

  constructor(config: ResolvedPluginConfig, dependencies: VoicePipelineDependencies = {}) {
    this.#config = config
    this.#asr = createAsrAdapter(config.asr, dependencies)
    this.#refine = createRefineAdapter(config.refine, dependencies)
    this.#memory = dependencies.memory ?? new CorrectionMemory(config.learning as CorrectionMemoryOptions)
    this.#audit = dependencies.audit ?? new RefinementAuditLog({
      ...config.audit,
      ...(dependencies.environment === undefined ? {} : { environment: dependencies.environment }),
      ...(dependencies.onAuditError === undefined ? {} : { onError: dependencies.onAuditError }),
    })
    this.#onAuditError = dependencies.onAuditError
    this.#limiter = new ConcurrencyLimiter(config.maxConcurrentRequests)
  }

  async process(input: ProcessVoiceInput): Promise<VoiceProcessResult> {
    return this.#limiter.run(async () => {
      assertEnvelopeContentType(input.contentType)
      const { metadata, audio } = await readVoiceEnvelope(input.body, this.#config.maxAudioBytes, input.signal, input.bodyTimeoutMs)
      if (metadata.protocol !== PROTOCOL_VERSION) throw new Error('unsupported voice protocol version')
      const rawText = await this.#asr.transcribe({
        bytes: audio,
        mimeType: metadata.mimeType,
        ...(metadata.fileName === undefined ? {} : { fileName: metadata.fileName }),
        ...(metadata.language === undefined ? {} : { language: metadata.language }),
      })
      const context = buildRefinementContext({
        ...(metadata.draft === undefined ? {} : { draft: metadata.draft }),
        ...(metadata.messages === undefined ? {} : { messages: metadata.messages }),
        learnedTerms: await this.#memory.learnedTerms(metadata.scope),
      })
      const refined = await this.#refine.refine({
        transcript: rawText,
        draft: context.draft,
        recentMessages: context.messages,
        learnedTerms: context.learnedTerms,
      })
      const auditEventId = randomUUID()
      const auditInput = sanitizeRefinementAuditInput({
        eventId: auditEventId,
        ...(metadata.sessionId === undefined ? {} : { sessionId: metadata.sessionId }),
        ...(metadata.scope === undefined ? {} : { scope: metadata.scope }),
        rawText,
        selectedText: refined.text,
        trace: refined.trace,
        context: {
          draftChars: context.draft.length,
          recentMessageCount: context.messages.length,
          recentMessageChars: context.messages.reduce((total, message) => total + message.content.length, 0),
          learnedTermCount: context.learnedTerms.length,
        },
        asrKind: this.#config.asr.kind,
        ...(this.#config.asr.kind === 'openai-transcription' ? { asrModel: this.#config.asr.model } : {}),
        refineKind: this.#config.refine.kind,
        ...(this.#config.refine.kind === 'openai-chat' ? { refineModel: this.#config.refine.model } : {}),
      })
      let auditQueued = false
      try {
        auditQueued = this.#audit.record(auditInput)
      } catch (error: unknown) {
        this.#notifyAuditError(error)
      }
      const learningReceipt = this.#createLearningReceipt(metadata.sessionId, metadata.scope)
      const auditReceipt = auditQueued ? this.#createAuditReceipt(auditInput) : undefined
      return {
        ok: true,
        protocol: PROTOCOL_VERSION,
        rawText,
        text: refined.text,
        refined: refined.refined,
        ...(refined.fallback === undefined ? {} : { refineFallback: refined.fallback }),
        ...(learningReceipt === undefined ? {} : { learningReceipt }),
        ...(auditReceipt === undefined ? {} : { auditReceipt }),
      }
    })
  }

  async confirmDelivery(request: VoiceDeliveryConfirmationRequest): Promise<VoiceDeliveryConfirmationResult> {
    if (request.protocol !== PROTOCOL_VERSION) throw new Error('unsupported voice delivery confirmation protocol version')
    if (typeof request.auditReceipt !== 'string' || request.auditReceipt.length < 1 || request.auditReceipt.length > 128) {
      throw new Error('voice delivery confirmation auditReceipt is invalid')
    }
    if (!['written', 'not-written'].includes(request.status)) throw new Error('voice delivery confirmation status is invalid')
    if (typeof request.reason !== 'string' || !DELIVERY_REASONS.has(request.reason)) {
      throw new Error('voice delivery confirmation reason is invalid')
    }
    if (request.placement !== undefined && !['append', 'replace'].includes(request.placement)) {
      throw new Error('voice delivery confirmation placement is invalid')
    }
    if (request.concurrentEdit !== undefined && typeof request.concurrentEdit !== 'boolean') {
      throw new Error('voice delivery confirmation concurrentEdit is invalid')
    }
    this.#pruneAuditReceipts()
    const receipt = this.#auditReceipts.get(request.auditReceipt)
    if (receipt === undefined) return { ok: true, confirmed: false, reason: 'receipt-not-found' }
    this.#auditReceipts.delete(request.auditReceipt)
    let queued = false
    try {
      queued = this.#audit.recordDelivery({
        eventId: receipt.refinement.eventId,
        refinement: receipt.refinement,
        status: request.status,
        reason: request.reason,
        ...(request.placement === undefined ? {} : { placement: request.placement }),
        ...(request.concurrentEdit === undefined ? {} : { concurrentEdit: request.concurrentEdit }),
      })
    } catch (error: unknown) {
      this.#notifyAuditError(error)
    }
    return queued
      ? { ok: true, confirmed: true, reason: 'delivery-queued' }
      : { ok: true, confirmed: false, reason: 'audit-queue-full' }
  }

  async confirmDraft(request: VoiceDraftConfirmationRequest): Promise<VoiceDraftConfirmationResult> {
    if (request.protocol !== PROTOCOL_VERSION) throw new Error('unsupported voice confirmation protocol version')
    if (typeof request.learningReceipt !== 'string' || request.learningReceipt.length < 1 || request.learningReceipt.length > 128) {
      throw new Error('voice confirmation learningReceipt is invalid')
    }
    if (typeof request.draft !== 'string' || request.draft.trim() === '' || request.draft.length > MAX_CONFIRM_DRAFT_CHARS) {
      throw new Error(`voice confirmation draft must contain at most ${MAX_CONFIRM_DRAFT_CHARS} characters`)
    }
    this.#pruneLearningReceipts()
    const receipt = this.#learningReceipts.get(request.learningReceipt)
    if (receipt === undefined) return { ok: true, confirmed: false, reason: 'receipt-not-found' }
    if (this.#redeemingReceipts.has(request.learningReceipt)) {
      return { ok: true, confirmed: false, reason: 'receipt-in-use' }
    }
    this.#redeemingReceipts.add(request.learningReceipt)
    try {
      const lastSubmissionAt = this.#lastSubmissionAt.get(receipt.sessionId)
      if (lastSubmissionAt !== undefined && lastSubmissionAt >= receipt.createdAt) {
        this.#learningReceipts.delete(request.learningReceipt)
        return { ok: true, confirmed: false, reason: 'submission-raced-confirmation' }
      }
      await this.#memory.addPending(request.draft, {
        sessionId: receipt.sessionId,
        ...(receipt.scope === undefined ? {} : { scope: receipt.scope }),
      })
      this.#learningReceipts.delete(request.learningReceipt)
      return { ok: true, confirmed: true, reason: 'draft-confirmed' }
    } finally {
      // A failed persistence attempt keeps the receipt available for a later
      // retry, but no two requests may redeem it at the same time.
      this.#redeemingReceipts.delete(request.learningReceipt)
    }
  }

  async observeSubmittedUserMessage(sessionId: string, submittedText: string): Promise<{ matched: boolean, learned: boolean, reason: string }> {
    this.#pruneLearningReceipts()
    while (this.#lastSubmissionAt.size >= this.#config.learning.maxEntries && !this.#lastSubmissionAt.has(sessionId)) {
      const oldest = this.#lastSubmissionAt.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.#lastSubmissionAt.delete(oldest)
    }
    this.#lastSubmissionAt.set(sessionId, Date.now())
    return this.#memory.observeSubmittedUserMessage(sessionId, submittedText)
  }

  async listCorrections(scope?: string) {
    return this.#memory.list(scope)
  }

  async deleteCorrection(from: string, to: string, scope?: string): Promise<boolean> {
    return this.#memory.delete(from, to, scope)
  }

  #createLearningReceipt(sessionId: string | undefined, scope: string | undefined): string | undefined {
    if (!this.#config.learning.enabled || sessionId === undefined
      || (this.#config.learning.requireScope && scope === undefined)) return undefined
    this.#pruneLearningReceipts()
    while (this.#learningReceipts.size >= this.#config.learning.maxEntries) {
      const oldest = this.#learningReceipts.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.#learningReceipts.delete(oldest)
    }
    const id = randomUUID()
    this.#learningReceipts.set(id, {
      sessionId,
      ...(scope === undefined ? {} : { scope }),
      createdAt: Date.now(),
      expiresAt: Date.now() + this.#config.learning.pendingTtlMs,
    })
    return id
  }

  #createAuditReceipt(refinement: RefinementAuditInput): string | undefined {
    if (!this.#config.audit.enabled) return undefined
    this.#pruneAuditReceipts()
    while (this.#auditReceipts.size >= this.#config.audit.maxPendingEntries) {
      const oldest = this.#auditReceipts.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.#auditReceipts.delete(oldest)
    }
    const id = randomUUID()
    this.#auditReceipts.set(id, { refinement, expiresAt: Date.now() + AUDIT_RECEIPT_TTL_MS })
    return id
  }

  #pruneAuditReceipts(): void {
    const now = Date.now()
    for (const [id, receipt] of this.#auditReceipts) {
      if (receipt.expiresAt <= now) this.#auditReceipts.delete(id)
    }
  }

  #notifyAuditError(error: unknown): void {
    try {
      this.#onAuditError?.(error)
    } catch {
      // Observability must never alter the voice request path.
    }
  }

  #pruneLearningReceipts(): void {
    const now = Date.now()
    for (const [id, receipt] of this.#learningReceipts) {
      if (receipt.expiresAt <= now) this.#learningReceipts.delete(id)
    }
    for (const [sessionId, submittedAt] of this.#lastSubmissionAt) {
      if (submittedAt + this.#config.learning.pendingTtlMs <= now) this.#lastSubmissionAt.delete(sessionId)
    }
  }
}
