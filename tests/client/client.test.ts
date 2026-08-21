import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { decodeEnvelope, MAX_CONTEXT_CHARS, MAX_CONTEXT_MESSAGES } from '../../src/shared/protocol.js'
import {
  assertAudioWithinLimit,
  assertRecordingDuration,
  confirmVoiceDelivery,
  confirmVoiceDraft,
  fetchPublicPluginConfig,
  processVoiceAudio,
  VoiceApiError,
} from '../../src/client/api.js'
import {
  extractInputLifecycle,
  extractRecentMessages,
  extractUserSubmissionSnapshot,
  hasNewUserSubmission,
  shouldClearDeliveredDraftNotice,
} from '../../src/client/context.js'
import { VoiceInput } from '../../src/client/VoiceInput.js'
import {
  apply as applyClientPlugin,
  inject as clientInject,
  registerClient,
  VOICE_INPUT_REGISTRATION,
  VOICE_INPUT_SLOT,
  type ClientSlots,
} from '../../src/client/index.js'
import {
  appendDraft,
  buildVoiceProcessMetadata,
  opaqueWorkspaceScope,
  resolveDraftDelivery,
} from '../../src/client/metadata.js'
import { selectSupportedMimeType } from '../../src/client/mime.js'
import { DEFAULT_VOICE_PREFERENCES, loadVoicePreferences, saveVoicePreferences, type PreferenceStorage } from '../../src/client/preferences.js'

test('MIME negotiation prefers webm/opus and falls back to mp4 and ogg', () => {
  assert.equal(selectSupportedMimeType(mimeType => mimeType === 'audio/webm;codecs=opus'), 'audio/webm;codecs=opus')
  assert.equal(selectSupportedMimeType(mimeType => mimeType === 'audio/mp4'), 'audio/mp4')
  assert.equal(selectSupportedMimeType(mimeType => mimeType === 'audio/ogg;codecs=opus'), 'audio/ogg;codecs=opus')
  assert.equal(selectSupportedMimeType(() => false), undefined)
})

test('recent conversation context defaults on and preserves an explicit opt-out', () => {
  assert.equal(DEFAULT_VOICE_PREFERENCES.includeRecentContext, true)
  const stored: PreferenceStorage = {
    getItem: () => JSON.stringify({ language: 'zh', append: true, includeRecentContext: false }),
    setItem() {},
  }
  assert.equal(loadVoicePreferences(stored).includeRecentContext, true)
  const optedOut: PreferenceStorage = {
    getItem: () => JSON.stringify({ version: 2, language: 'zh', append: true, includeRecentContext: false }),
    setItem() {},
  }
  assert.equal(loadVoicePreferences(optedOut).includeRecentContext, false)

  let saved = ''
  saveVoicePreferences({ language: 'zh', append: true, includeRecentContext: false }, {
    getItem: () => null,
    setItem: (_key, value) => { saved = value },
  })
  assert.deepEqual(JSON.parse(saved), { version: 2, language: 'zh', append: true, includeRecentContext: false })
})

test('context extraction handles rc.8 legacy nodes and enforces message/character budgets', () => {
  const snapshot = {
    chat: {
      legacy: {
        nodes: [
          { type: 'system', content: 'do not include' },
          { type: 'user', content: 'old user message' },
          { type: 'assistant', message: { content: 'old assistant message' } },
          { role: 'user', content: 'new user message' },
        ],
      },
    },
  }
  assert.deepEqual(extractRecentMessages(snapshot), [
    { role: 'user', content: 'old user message' },
    { role: 'assistant', content: 'old assistant message' },
    { role: 'user', content: 'new user message' },
  ])

  const large = {
    chat: { legacy: { nodes: Array.from({ length: 20 }, (_, index) => ({ role: 'user' as const, content: `${index}:${'x'.repeat(100)}` })) } },
  }
  assert.equal(MAX_CONTEXT_MESSAGES, 8)
  assert.equal(MAX_CONTEXT_CHARS, 6_000)
  const defaultBounded = extractRecentMessages(large)
  assert.equal(defaultBounded.length, MAX_CONTEXT_MESSAGES)
  assert.ok(defaultBounded.reduce((total, message) => total + message.content.length, 0) <= MAX_CONTEXT_CHARS)
  const bounded = extractRecentMessages(large, { maxMessages: 4, maxChars: 120 })
  assert.ok(bounded.length <= 4)
  assert.ok(bounded.reduce((total, message) => total + message.content.length, 0) <= 120)
  assert.match(bounded.at(-1)?.content ?? '', /19:/u)
})

test('delivered draft notices clear only when the official submission lifecycle starts', () => {
  const delivered = extractInputLifecycle({ draft: 'voice text', phase: 'plain' })
  const adjudicating = extractInputLifecycle({ draft: 'voice text', phase: 'adjudicating' })
  const submitting = extractInputLifecycle({ draft: 'voice text', phase: 'submitting' })
  const manuallyCleared = extractInputLifecycle({ draft: '', phase: 'plain' })

  assert.equal(shouldClearDeliveredDraftNotice(undefined, delivered), false)
  assert.equal(shouldClearDeliveredDraftNotice(delivered, adjudicating), true)
  assert.equal(shouldClearDeliveredDraftNotice(delivered, submitting), true)
  assert.equal(shouldClearDeliveredDraftNotice(delivered, manuallyCleared), false)
  assert.equal(shouldClearDeliveredDraftNotice(delivered, { ...delivered, draft: 'voice text edited' }), false)
})

test('accepted user-message snapshots provide a batched-submission fallback', () => {
  const baseline = extractUserSubmissionSnapshot({ nodes: [
    { kind: 'user', seq: 10, content: 'earlier' },
    { kind: 'assistant', seq: 11, content: 'reply' },
  ] })
  const unchanged = extractUserSubmissionSnapshot({ nodes: [
    { kind: 'user', seq: 10, content: 'earlier' },
    { kind: 'assistant', seq: 12, content: 'new reply' },
  ] })
  const submitted = extractUserSubmissionSnapshot({ nodes: [
    { kind: 'user', seq: 10, content: 'earlier' },
    { kind: 'assistant', seq: 12, content: 'new reply' },
    { kind: 'user', seq: 13, content: 'voice text' },
  ] })
  const steering = extractUserSubmissionSnapshot({ nodes: [
    { kind: 'user', seq: 10, content: 'earlier' },
    { kind: 'steering', seq: 14, messageId: 'follow-up', content: 'voice follow-up' },
  ] })

  assert.equal(hasNewUserSubmission(baseline, unchanged), false)
  assert.equal(hasNewUserSubmission(baseline, submitted), true)
  assert.equal(hasNewUserSubmission(baseline, steering), true)
})

test('metadata carries placement and keeps draft/context within protocol budgets', () => {
  const metadata = buildVoiceProcessMetadata({
    mimeType: 'audio/mp4',
    draft: 'draft',
    append: true,
    sessionId: 'session-1',
    includeRecentContext: true,
    snapshot: { chat: { legacy: { nodes: [{ role: 'assistant', content: 'context' }] } } },
  })
  assert.equal(metadata.placement, 'append')
  assert.equal(metadata.sessionId, 'session-1')
  assert.deepEqual(metadata.messages, [{ role: 'assistant', content: 'context' }])

  const replacement = buildVoiceProcessMetadata({ mimeType: 'audio/webm', append: false, draft: 'draft' })
  assert.equal(replacement.placement, 'replace')
  assert.equal(replacement.messages, undefined)
})

test('workspace scope is a path-free digest and disappears without a digest provider', async () => {
  const scope = await opaqueWorkspaceScope('/private/workspace', async (_algorithm, bytes) => {
    assert.equal(new TextDecoder().decode(bytes), 'dsh-voice-refine\0/private/workspace')
    return Uint8Array.from({ length: 32 }, () => 0xab).buffer
  })
  assert.equal(scope, `workspace-sha256:${'ab'.repeat(32)}`)
  assert.equal(scope?.includes('/private/workspace'), false)
  assert.equal(await opaqueWorkspaceScope('/private/workspace', null), undefined)
})

test('append behavior matches the host correction candidate text', () => {
  assert.equal(appendDraft('existing  ', 'refined', true), 'existing refined')
  assert.equal(appendDraft('existing', 'refined', false), 'refined')
  assert.equal(appendDraft('', 'refined', true), 'refined')
  assert.equal(appendDraft('existing', '', true), 'existing')
})

test('draft delivery preserves concurrent typing and refuses cross-session writes', () => {
  assert.deepEqual(resolveDraftDelivery({
    requestedSessionId: 's1', currentSessionId: 's1', draftAtRequest: 'old', currentDraft: 'old', text: 'voice', append: false,
  }), { kind: 'write', draft: 'voice', concurrentEdit: false })
  assert.deepEqual(resolveDraftDelivery({
    requestedSessionId: 's1', currentSessionId: 's1', draftAtRequest: 'old', currentDraft: 'user typed', text: 'voice', append: false,
  }), { kind: 'write', draft: 'user typed voice', concurrentEdit: true })
  assert.deepEqual(resolveDraftDelivery({
    requestedSessionId: 's1', currentSessionId: 's2', draftAtRequest: 'old', currentDraft: 'other', text: 'voice', append: true,
  }), { kind: 'session-changed' })
})

test('rc.8 input-zone snapshots and selector-style useSessions render without guessed hooks', () => {
  const html = renderToStaticMarkup(createElement(VoiceInput, {
    sessionId: 'session-1',
    session: { sessionId: 'session-1', chat: { legacy: { nodes: [] } } },
    input: { draft: 'existing' },
    inputActions: { setDraft() {} },
    useSessions: selector => selector({ byId: { 'session-1': { cwd: '/workspace' } } }),
  }))
  assert.match(html, /dsh-voice-refine/u)
})

test('client loader registers the named slot and preserves its disposer through ctx.effect', () => {
  assert.deepEqual(clientInject, ['slots'])
  let injectedName = ''
  let registeredOptions: Readonly<Record<string, unknown>> | undefined
  const disposer = Symbol('slot-disposer')
  const slots: ClientSlots = {
    inject(name, factory) {
      injectedName = name
      factory()
      return disposer
    },
    register(options) {
      registeredOptions = options
      return Symbol('component-registration')
    },
  }
  assert.equal(registerClient({ slots }), disposer)
  assert.equal(injectedName, VOICE_INPUT_SLOT)
  assert.deepEqual(registeredOptions, VOICE_INPUT_REGISTRATION)

  let effectResult: unknown
  applyClientPlugin({
    slots,
    effect(callback) {
      effectResult = callback()
      return 'effect-disposer'
    },
  })
  assert.equal(effectResult, disposer)
})

test('process API sends an encoded envelope and validates the response', async () => {
  let requestedUrl = ''
  let requestedInit: RequestInit | undefined
  const result = await processVoiceAudio({
    metadata: {
      protocol: 1,
      mimeType: 'audio/webm',
      fileName: 'voice.webm',
      draft: 'draft',
      placement: 'append',
    },
    audio: new Uint8Array([1, 2, 3]),
  }, async (url, init) => {
    requestedUrl = String(url)
    requestedInit = init
    return Response.json({
      ok: true,
      protocol: 1,
      rawText: 'raw',
      text: 'refined',
      refined: true,
      learningReceipt: 'receipt-1',
      auditReceipt: 'audit-receipt-1',
    })
  })

  assert.equal(requestedUrl, '/dsh-voice-refine/v1/process')
  assert.equal(new Headers(requestedInit?.headers).get('content-type'), 'application/vnd.dsh-voice-refine; version=1')
  const envelope = await requestBodyBytes(requestedInit?.body)
  assert.deepEqual(decodeEnvelope(envelope), {
    metadata: {
      protocol: 1,
      mimeType: 'audio/webm',
      fileName: 'voice.webm',
      draft: 'draft',
      placement: 'append',
    },
    audio: new Uint8Array([1, 2, 3]),
  })
  assert.equal(result.text, 'refined')
  assert.equal(result.learningReceipt, 'receipt-1')
  assert.equal(result.auditReceipt, 'audit-receipt-1')
})

test('delivery confirmation reports only delivery metadata and uses keepalive', async () => {
  let requestedUrl = ''
  let requestedInit: RequestInit | undefined
  const result = await confirmVoiceDelivery({
    protocol: 1,
    auditReceipt: 'audit-receipt-1',
    status: 'written',
    reason: 'draft-written',
    placement: 'append',
    concurrentEdit: true,
  }, async (url, init) => {
    requestedUrl = String(url)
    requestedInit = init
    return Response.json({ ok: true, confirmed: true, reason: 'delivery-queued' })
  })
  assert.equal(requestedUrl, '/dsh-voice-refine/v1/confirm-delivery')
  assert.equal(requestedInit?.keepalive, true)
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
    protocol: 1,
    auditReceipt: 'audit-receipt-1',
    status: 'written',
    reason: 'draft-written',
    placement: 'append',
    concurrentEdit: true,
  })
  assert.deepEqual(result, { ok: true, confirmed: true, reason: 'delivery-queued' })

  await assert.rejects(confirmVoiceDelivery({
    protocol: 1,
    auditReceipt: 'audit-receipt-timeout',
    status: 'not-written',
    reason: 'session-changed',
  }, async (_url, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  }), 5), (error: unknown) => error instanceof DOMException && error.name === 'AbortError')
})

test('draft confirmation sends the exact delivered draft after concurrent edits', async () => {
  let requestedUrl = ''
  let requestedBody = ''
  const delivery = resolveDraftDelivery({
    requestedSessionId: 's1',
    currentSessionId: 's1',
    draftAtRequest: 'old',
    currentDraft: 'user typed',
    text: 'voice',
    append: false,
  })
  assert.equal(delivery.kind, 'write')
  if (delivery.kind !== 'write') throw new Error('expected writable delivery')
  const result = await confirmVoiceDraft({
    protocol: 1,
    learningReceipt: 'receipt-1',
    draft: delivery.draft,
  }, async (url, init) => {
    requestedUrl = String(url)
    requestedBody = String(init?.body)
    return Response.json({ ok: true, confirmed: true, reason: 'draft-confirmed' })
  })
  assert.equal(requestedUrl, '/dsh-voice-refine/v1/confirm-draft')
  assert.deepEqual(JSON.parse(requestedBody), {
    protocol: 1,
    learningReceipt: 'receipt-1',
    draft: 'user typed voice',
  })
  assert.deepEqual(result, { ok: true, confirmed: true, reason: 'draft-confirmed' })
})

test('API errors and configured audio limits are surfaced without sending oversized audio', async () => {
  assert.throws(() => assertAudioWithinLimit(new Uint8Array([1, 2, 3]), 2), (error: unknown) => {
    return error instanceof VoiceApiError && error.code === 'audio-too-large'
  })
  assert.doesNotThrow(() => assertAudioWithinLimit(new Uint8Array([1, 2, 3]), 3))
  assert.throws(() => assertRecordingDuration(799, 800), (error: unknown) => {
    return error instanceof VoiceApiError && error.code === 'recording-too-short'
  })
  assert.doesNotThrow(() => assertRecordingDuration(800, 800))

  const config = await fetchPublicPluginConfig(async () => Response.json({
    protocol: 1,
    maxAudioBytes: 3,
    maxRecordingMs: 1_500,
    minRecordingMs: 750,
    refineEnabled: false,
    learningEnabled: false,
    supportedMimeTypes: ['audio/mp4'],
  }))
  assert.equal(config.maxAudioBytes, 3)
  assert.equal(config.maxRecordingMs, 1_500)
  assert.equal(config.minRecordingMs, 750)

  await assert.rejects(
    processVoiceAudio({ metadata: { protocol: 1, mimeType: 'audio/webm' }, audio: new Uint8Array([1]) }, async () => {
      return Response.json({ ok: false, error: { code: 'too-large', message: 'too large' } }, { status: 413 })
    }),
    (error: unknown) => error instanceof VoiceApiError && error.code === 'too-large' && error.status === 413,
  )
})

async function requestBodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return new Uint8Array(body)
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  throw new Error('test request body is not binary')
}
