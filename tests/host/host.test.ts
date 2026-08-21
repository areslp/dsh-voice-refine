import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { resolveConfig } from '../../src/config.js'
import { API_ROOT, MAX_CONTEXT_CHARS, MAX_CONTEXT_MESSAGES, MAX_DRAFT_CHARS } from '../../src/shared/protocol.js'
import { apply, directUserSubmission } from '../../src/index.js'
import { ENVELOPE_CONTENT_TYPE, encodeEnvelope } from '../../src/shared/protocol.js'
import { AsrRequestError, createAsrAdapter, readStrictText } from '../../src/host/asr.js'
import { buildRefinementContext } from '../../src/host/context.js'
import { CorrectionMemory, type CorrectionMemoryOptions } from '../../src/host/correction-memory.js'
import { CONSERVATIVE_GUARD_VERSION, createRefineAdapter } from '../../src/host/refine.js'
import type { DeliveryAuditInput, RefinementAuditInput } from '../../src/host/audit-log.js'
import { VoicePipeline } from '../../src/host/pipeline.js'
import { BodyTimeoutError, BodyTooLargeError, BusyError, ConcurrencyLimiter, assertTrustedOrigin, readBoundedBody, resolveHeaders } from '../../src/host/security.js'

test('OpenAI ASR submits multipart audio to the default endpoint', async () => {
  let requestedUrl = ''
  let request: RequestInit | undefined
  const adapter = createAsrAdapter({
    kind: 'openai-transcription', baseUrl: 'https://asr.example/v1/', model: 'whisper-1', apiKeyEnv: 'ASR_KEY',
    headersFromEnv: { 'x-tenant': 'ASR_TENANT' }, formFields: { prompt: 'names' },
  }, {
    environment: { ASR_KEY: 'secret', ASR_TENANT: 'demo' },
    fetch: async (url, init) => {
      requestedUrl = String(url)
      request = init
      return Response.json({ text: 'hello' })
    },
  })

  assert.equal(await adapter.transcribe({ bytes: new Uint8Array([1, 2]), mimeType: 'audio/webm', fileName: 'voice.webm' }), 'hello')
  assert.equal(requestedUrl, 'https://asr.example/v1/audio/transcriptions')
  assert.equal(new Headers(request?.headers).get('authorization'), 'Bearer secret')
  assert.equal(new Headers(request?.headers).get('x-tenant'), 'demo')
  assert.ok(request?.signal instanceof AbortSignal)
  assert.ok(request?.body instanceof FormData)
  assert.equal((request?.body as FormData).get('model'), 'whisper-1')
  assert.equal((request?.body as FormData).get('prompt'), 'names')
  assert.equal((request?.body as FormData).get('file') instanceof Blob, true)
})

test('OpenAI adapters resolve relative endpoints against their base URLs', async () => {
  let asrUrl = ''
  const asr = createAsrAdapter({
    kind: 'openai-transcription', baseUrl: 'https://asr.example/api/v1', endpoint: 'speech/transcribe', model: 'whisper-1',
  }, {
    fetch: async url => {
      asrUrl = String(url)
      return Response.json({ text: 'hello' })
    },
  })
  await asr.transcribe({ bytes: Uint8Array.of(1), mimeType: 'audio/webm' })
  assert.equal(asrUrl, 'https://asr.example/api/v1/speech/transcribe')

  let refineUrl = ''
  const refine = createRefineAdapter({
    kind: 'openai-chat', baseUrl: 'https://chat.example/api/v1', endpoint: 'text/refine', model: 'gpt-test',
  }, {
    fetch: async url => {
      refineUrl = String(url)
      return Response.json({ choices: [{ message: { content: '{"text":"send invoice"}' } }] })
    },
  })
  await refine.refine({ transcript: 'send invoice', draft: '', recentMessages: [], learnedTerms: [] })
  assert.equal(refineUrl, 'https://chat.example/api/v1/text/refine')
})

test('HTTP ASR supports binary requests and nested response paths', async () => {
  let request: RequestInit | undefined
  const adapter = createAsrAdapter({
    kind: 'http', endpoint: 'https://asr.example/transcribe', method: 'PUT', body: 'binary',
    headers: { 'x-mode': 'fast' }, headersFromEnv: { 'x-token': 'ASR_TOKEN' }, responseTextPath: 'result.text',
  }, {
    environment: { ASR_TOKEN: 'from-env' },
    fetch: async (_url, init) => {
      request = init
      return Response.json({ result: { text: ' done\n' } })
    },
  })
  const bytes = new Uint8Array([4, 5])
  assert.equal(await adapter.transcribe({ bytes, mimeType: 'audio/ogg' }), 'done')
  assert.equal(request?.method, 'PUT')
  assert.equal(new Headers(request?.headers).get('content-type'), 'audio/ogg')
  assert.equal(new Headers(request?.headers).get('x-token'), 'from-env')
  assert.deepEqual(new Uint8Array(request?.body as ArrayBuffer), bytes)
})

test('ASR rejects empty text and static headers cannot contain credentials', async () => {
  await assert.rejects(readStrictText(Response.json({ text: ' \n ' }), 'text'), /must not be empty/u)
  await assert.rejects(readStrictText(new Response(null, { status: 422 }), 'text'), (error: unknown) => {
    return error instanceof AsrRequestError && error.status === 422
  })
  assert.throws(() => resolveHeaders({ Authorization: 'Bearer secret' }, undefined), /headersFromEnv/u)
  assert.throws(() => resolveHeaders({ Cookie: 'session=secret' }, undefined), /headersFromEnv/u)
  assert.equal(resolveHeaders(undefined, { authorization: 'ASR_KEY' }, { ASR_KEY: 'secret' }).get('authorization'), 'secret')
})

test('refinement falls back to the raw transcript when the model output is not strict JSON', async () => {
  const adapter = createRefineAdapter({ kind: 'openai-chat', baseUrl: 'https://chat.example', model: 'gpt-test' }, {
    fetch: async () => Response.json({ choices: [{ message: { content: 'helpful answer' } }] }),
  })
  const result = await adapter.refine({ transcript: 'raw text', draft: '', recentMessages: [], learnedTerms: [] })
  assert.deepEqual(result, {
    text: 'raw text',
    refined: false,
    fallback: 'refinement-unavailable',
    trace: { decision: 'unavailable', reason: 'invalid-response-json', guardVersion: CONSERVATIVE_GUARD_VERSION },
  })
})

test('refinement prompt asks small local models to apply clear repairs without weakening the guard', async () => {
  let requestBody: { messages?: Array<{ role?: string; content?: string }> } | undefined
  const adapter = createRefineAdapter({ kind: 'openai-chat', baseUrl: 'https://chat.example', model: 'small-local-model' }, {
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody
      return Response.json({ choices: [{ message: { content: '{"text":"Please test the DeepSeek harness voice input."}' } }] })
    },
  })

  assert.deepEqual(await adapter.refine({
    transcript: 'please test the deep-seek harness voice input',
    draft: '',
    recentMessages: [],
    learnedTerms: [],
  }), {
    text: 'Please test the DeepSeek harness voice input.',
    refined: true,
    trace: {
      decision: 'accepted',
      reason: 'accepted',
      guardVersion: CONSERVATIVE_GUARD_VERSION,
      proposalText: 'Please test the DeepSeek harness voice input.',
    },
  })

  const systemInstruction = requestBody?.messages?.find(message => message.role === 'system')?.content
  assert.match(systemInstruction ?? '', /standard product spelling/u)
  assert.match(systemInstruction ?? '', /preserving intent and facts, not skipping clear repairs/u)
})

test('refinement accepts spacing repairs at Latin and CJK script boundaries', async () => {
  const adapter = createRefineAdapter({ kind: 'openai-chat', baseUrl: 'https://chat.example', model: 'small-local-model' }, {
    fetch: async () => Response.json({ choices: [{ message: { content: '{"text":"Test test 测试测试"}' } }] }),
  })
  assert.deepEqual(await adapter.refine({
    transcript: 'Test test测试测试',
    draft: '',
    recentMessages: [],
    learnedTerms: [],
  }), {
    text: 'Test test 测试测试',
    refined: true,
    trace: {
      decision: 'accepted', reason: 'accepted', guardVersion: CONSERVATIVE_GUARD_VERSION, proposalText: 'Test test 测试测试',
    },
  })
})

test('refinement rejects unrelated same-length output but accepts a small overlapping repair', async () => {
  const unrelated = createRefineAdapter({ kind: 'openai-chat', baseUrl: 'https://chat.example', model: 'gpt-test' }, {
    fetch: async () => Response.json({ choices: [{ message: { content: '{"text":"make pancakes tonight"}' } }] }),
  })
  const input = { transcript: 'send the invoice today', draft: '', recentMessages: [], learnedTerms: [] }
  assert.deepEqual(await unrelated.refine(input), {
    text: input.transcript,
    refined: false,
    fallback: 'refinement-unavailable',
    trace: {
      decision: 'rejected', reason: 'guard-rejected', guardVersion: CONSERVATIVE_GUARD_VERSION, proposalText: 'make pancakes tonight',
    },
  })

  const repair = createRefineAdapter({ kind: 'openai-chat', baseUrl: 'https://chat.example', model: 'gpt-test' }, {
    fetch: async () => Response.json({ choices: [{ message: { content: '{"text":"send the invoices today"}' } }] }),
  })
  assert.deepEqual(await repair.refine(input), {
    text: 'send the invoices today',
    refined: true,
    trace: {
      decision: 'accepted', reason: 'accepted', guardVersion: CONSERVATIVE_GUARD_VERSION, proposalText: 'send the invoices today',
    },
  })
})

test('refinement falls back when protected semantics are changed', async () => {
  const transcript = 'do not delete 2 files at https://example.test/a from ./build using --dry-run'
  const adapter = createRefineAdapter({ kind: 'openai-chat', baseUrl: 'https://chat.example', model: 'gpt-test' }, {
    fetch: async () => Response.json({ choices: [{ message: { content: '{"text":"do delete 3 files at https://example.test/b from ./dist using --force"}' } }] }),
  })
  assert.deepEqual(await adapter.refine({ transcript, draft: '', recentMessages: [], learnedTerms: [] }), {
    text: transcript,
    refined: false,
    fallback: 'refinement-unavailable',
    trace: {
      decision: 'rejected',
      reason: 'guard-rejected',
      guardVersion: CONSERVATIVE_GUARD_VERSION,
      proposalText: 'do delete 3 files at https://example.test/b from ./dist using --force',
    },
  })
})

test('refinement preserves digits embedded in identifiers', async () => {
  const transcript = 'deploy api v1 to worker2'
  const adapter = createRefineAdapter({ kind: 'openai-chat', baseUrl: 'https://chat.example', model: 'gpt-test' }, {
    fetch: async () => Response.json({ choices: [{ message: { content: '{"text":"deploy api v2 to worker3"}' } }] }),
  })
  assert.deepEqual(await adapter.refine({ transcript, draft: '', recentMessages: [], learnedTerms: [] }), {
    text: transcript,
    refined: false,
    fallback: 'refinement-unavailable',
    trace: {
      decision: 'rejected', reason: 'guard-rejected', guardVersion: CONSERVATIVE_GUARD_VERSION, proposalText: 'deploy api v2 to worker3',
    },
  })
})

test('refinement preserves Chinese number words', async () => {
  const transcript = '请删除三台机器'
  const adapter = createRefineAdapter({ kind: 'openai-chat', baseUrl: 'https://chat.example', model: 'gpt-test' }, {
    fetch: async () => Response.json({ choices: [{ message: { content: '{"text":"请删除两台机器"}' } }] }),
  })
  assert.deepEqual(await adapter.refine({ transcript, draft: '', recentMessages: [], learnedTerms: [] }), {
    text: transcript,
    refined: false,
    fallback: 'refinement-unavailable',
    trace: {
      decision: 'rejected', reason: 'guard-rejected', guardVersion: CONSERVATIVE_GUARD_VERSION, proposalText: '请删除两台机器',
    },
  })
})

test('refinement preserves full-width decimal digits', async () => {
  const transcript = '请删除３台机器'
  const adapter = createRefineAdapter({ kind: 'openai-chat', baseUrl: 'https://chat.example', model: 'gpt-test' }, {
    fetch: async () => Response.json({ choices: [{ message: { content: '{"text":"请删除２台机器"}' } }] }),
  })
  assert.deepEqual(await adapter.refine({ transcript, draft: '', recentMessages: [], learnedTerms: [] }), {
    text: transcript,
    refined: false,
    fallback: 'refinement-unavailable',
    trace: {
      decision: 'rejected', reason: 'guard-rejected', guardVersion: CONSERVATIVE_GUARD_VERSION, proposalText: '请删除２台机器',
    },
  })
})

test('refinement preserves Chinese negation markers', async () => {
  const transcript = '请不要删除配置'
  const adapter = createRefineAdapter({ kind: 'openai-chat', baseUrl: 'https://chat.example', model: 'gpt-test' }, {
    fetch: async () => Response.json({ choices: [{ message: { content: '{"text":"请删除配置"}' } }] }),
  })
  assert.deepEqual(await adapter.refine({ transcript, draft: '', recentMessages: [], learnedTerms: [] }), {
    text: transcript,
    refined: false,
    fallback: 'refinement-unavailable',
    trace: {
      decision: 'rejected', reason: 'guard-rejected', guardVersion: CONSERVATIVE_GUARD_VERSION, proposalText: '请删除配置',
    },
  })
})

test('context builder preserves newest messages within protocol budgets', () => {
  const context = buildRefinementContext({
    draft: 'd'.repeat(5_000),
    messages: Array.from({ length: 20 }, (_, index) => ({ role: index % 2 === 0 ? 'user' as const : 'assistant' as const, content: `${'m'.repeat(2_000)}:${index}` })),
    learnedTerms: Array.from({ length: 120 }, (_, index) => ({ from: `from ${index}`, to: `to ${index}` })),
  })
  assert.equal(context.draft.length, MAX_DRAFT_CHARS)
  assert.ok(context.messages.length <= MAX_CONTEXT_MESSAGES)
  assert.ok(context.messages.reduce((size, message) => size + message.content.length, 0) <= MAX_CONTEXT_CHARS - context.draft.length)
  assert.equal(context.messages.at(-1)?.content.endsWith(':19'), true)
  assert.equal(context.learnedTerms.length, 100)
})

test('correction memory requires repeated safe substitutions before exposing them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-voice-memory-'))
  const storePath = join(directory, 'memory.json')
  const memory = new CorrectionMemory({ enabled: true, storePath, minOccurrences: 2, maxEntries: 20, pendingTtlMs: 1_000 })
  await memory.addPending('ship it', { sessionId: 'session-1', scope: 'scope-1' })
  const beforeFeedback = JSON.parse(await readFile(storePath, 'utf8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(beforeFeedback).sort(), ['entries', 'version'])
  assert.equal(JSON.stringify(beforeFeedback).includes('ship it'), false)
  assert.deepEqual(await memory.observeSubmittedUserMessage('session-1', 'ship eight'), { matched: true, learned: true, reason: 'recorded' })
  assert.deepEqual(await memory.learnedTerms('scope-1'), [])
  await memory.addPending('ship it', { sessionId: 'session-2', scope: 'scope-1' })
  await memory.observeSubmittedUserMessage('session-2', 'ship eight')
  assert.deepEqual(await memory.learnedTerms('scope-1'), [{ from: 'it', to: 'eight' }])
  assert.equal((await stat(storePath)).mode & 0o777, 0o600)
})

test('observer conservatively learns a short CJK substitution but rejects whole-sentence rewrites', async () => {
  const memory = await temporaryMemory({ minOccurrences: 1, maxEntries: 20, pendingTtlMs: 1_000 })
  await memory.addPending('请把会议改到明天下午', { sessionId: 'cjk-1', scope: 'scope-1' })
  assert.deepEqual(await memory.observeSubmittedUserMessage('cjk-1', '请把会议改到明天上午'), { matched: true, learned: true, reason: 'recorded' })
  assert.deepEqual(await memory.learnedTerms('scope-1'), [{ from: '下午', to: '上午' }])

  await memory.addPending('我今天要去北京参加会议', { sessionId: 'cjk-2', scope: 'scope-1' })
  assert.deepEqual(await memory.observeSubmittedUserMessage('cjk-2', '请帮我安排明天的午餐和酒店'), {
    matched: false, learned: false, reason: 'candidate-text-mismatch',
  })
})

test('correction memory rejects secret-like and high-entropy substitutions', async () => {
  const memory = await temporaryMemory({ minOccurrences: 1, maxEntries: 20, pendingTtlMs: 1_000 })
  await memory.addPending('the api key is old', { sessionId: 'secret', scope: 'scope-1' })
  assert.equal((await memory.observeSubmittedUserMessage('secret', 'the api_key=sk_abcdefghijklmnopqrstuvwxyz0123456789 is old')).learned, false)
  await memory.addPending('replace code', { sessionId: 'entropy', scope: 'scope-1' })
  assert.equal((await memory.observeSubmittedUserMessage('entropy', 'replace A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6')).learned, false)
})

test('expired pending candidates cannot be learned', async () => {
  let now = 100
  const memory = await temporaryMemory({ minOccurrences: 1, maxEntries: 20, pendingTtlMs: 50, now: () => now })
  await memory.addPending('heard word', { sessionId: 'expired', scope: 'scope-1' })
  now = 150
  assert.deepEqual(await memory.observeSubmittedUserMessage('expired', 'heard words'), { matched: false, learned: false, reason: 'candidate-not-found' })
})

test('correction memory requires a scope by default and never exposes another scope', async () => {
  const memory = await temporaryMemory({ minOccurrences: 1, maxEntries: 20, pendingTtlMs: 1_000 })
  await memory.addPending('call alice', { sessionId: 'missing-scope' })
  assert.deepEqual(await memory.observeSubmittedUserMessage('missing-scope', 'call alicia'), {
    matched: false, learned: false, reason: 'candidate-not-found',
  })
  await memory.addPending('call alice', { sessionId: 'scope-a', scope: 'scope-a' })
  await memory.observeSubmittedUserMessage('scope-a', 'call alicia')
  assert.deepEqual(await memory.learnedTerms(), [])
  assert.deepEqual(await memory.learnedTerms('scope-b'), [])
  assert.deepEqual(await memory.learnedTerms('scope-a'), [{ from: 'alice', to: 'alicia' }])
})

test('a direct submission consumes all session candidates even when the newest does not match', async () => {
  let now = 100
  const memory = await temporaryMemory({ minOccurrences: 1, maxEntries: 20, pendingTtlMs: 1_000, now: () => now })
  await memory.addPending('please send build', { sessionId: 'session-1', scope: 'scope-1' })
  await memory.addPending('call alice today', { sessionId: 'session-1', scope: 'scope-1' })
  assert.deepEqual(await memory.observeSubmittedUserMessage('session-1', 'please send built'), {
    matched: false, learned: false, reason: 'candidate-text-mismatch',
  })
  assert.deepEqual(await memory.observeSubmittedUserMessage('session-1', 'call alicia today'), {
    matched: false, learned: false, reason: 'candidate-not-found',
  })
  assert.deepEqual(await memory.list('scope-1'), [])
})

test('pipeline decodes the browser envelope and forwards only audio to binary ASR', async () => {
  let outbound: RequestInit | undefined
  const pipeline = new VoicePipeline(resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe', body: 'binary' },
    learning: { enabled: false },
  }), {
    fetch: async (_url, request) => {
      outbound = request
      return Response.json({ text: 'transcript' })
    },
  })
  const audio = new Uint8Array([7, 8, 9])
  const envelope = encodeEnvelope({ protocol: 1, mimeType: 'audio/webm', sessionId: 'session-1', scope: 'scope-1' }, audio)
  const result = await pipeline.process({ body: byteStream(envelope), contentType: ENVELOPE_CONTENT_TYPE })
  assert.equal(result.rawText, 'transcript')
  assert.equal(result.learningReceipt, undefined)
  assert.deepEqual(new Uint8Array(outbound?.body as ArrayBuffer), audio)
  await assert.rejects(pipeline.process({ body: byteStream(envelope), contentType: 'application/json' }), /expected Content-Type/u)
})

test('pipeline records refinement proposals and isolates audit write failures', async () => {
  const records: RefinementAuditInput[] = []
  const config = resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    refine: { kind: 'openai-chat', baseUrl: 'https://refine.example/v1', model: 'qwen-small' },
    learning: { enabled: false },
  })
  const envelope = encodeEnvelope({
    protocol: 1,
    mimeType: 'audio/webm',
    sessionId: 'session-audit',
    scope: 'opaque-scope',
    draft: 'draft',
    messages: [{ role: 'user', content: 'recent' }],
  }, Uint8Array.of(1))
  const fetch = async (url: string | URL | Request) => String(url).includes('refine.example')
    ? Response.json({ choices: [{ message: { content: '{"text":"make pancakes tonight"}' } }] })
    : Response.json({ text: 'send the invoice today' })
  const pipeline = new VoicePipeline(config, {
    fetch,
    audit: { record: record => { records.push(record); return true }, recordDelivery: () => true },
  })
  const result = await pipeline.process({ body: byteStream(envelope), contentType: ENVELOPE_CONTENT_TYPE })
  assert.equal(result.text, 'send the invoice today')
  assert.equal(result.refined, false)
  assert.equal(records.length, 1)
  assert.deepEqual(records[0]?.trace, {
    decision: 'rejected',
    reason: 'guard-rejected',
    guardVersion: CONSERVATIVE_GUARD_VERSION,
    proposalText: 'make pancakes tonight',
  })
  assert.deepEqual(records[0]?.context, {
    draftChars: 5,
    recentMessageCount: 1,
    recentMessageChars: 6,
    learnedTermCount: 0,
  })

  let auditErrors = 0
  const failingAuditPipeline = new VoicePipeline(config, {
    fetch,
    audit: { record: () => { throw new Error('disk full') }, recordDelivery: () => true },
    onAuditError: () => { auditErrors += 1 },
  })
  const fallback = await failingAuditPipeline.process({ body: byteStream(envelope), contentType: ENVELOPE_CONTENT_TYPE })
  assert.equal(fallback.text, 'send the invoice today')
  assert.equal(auditErrors, 1)
})

test('audit delivery receipts work independently of correction learning and are one-time', async () => {
  const refinements: RefinementAuditInput[] = []
  const deliveries: DeliveryAuditInput[] = []
  const sensitiveTranscript = `AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ${'x'.repeat(17_000)}`
  const pipeline = new VoicePipeline(resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    learning: { enabled: false },
    audit: { enabled: true, identityKeyEnv: 'AUDIT_KEY' },
  }), {
    fetch: async () => Response.json({ text: sensitiveTranscript }),
    audit: {
      record: record => { refinements.push(record); return true },
      recordDelivery: record => { deliveries.push(record); return true },
    },
  })
  const envelope = encodeEnvelope({ protocol: 1, mimeType: 'audio/webm', sessionId: 'audit-session' }, Uint8Array.of(1))
  const result = await pipeline.process({ body: byteStream(envelope), contentType: ENVELOPE_CONTENT_TYPE })
  assert.equal(result.rawText, sensitiveTranscript)
  assert.equal(result.learningReceipt, undefined)
  assert.equal(typeof result.auditReceipt, 'string')
  assert.equal(refinements.length, 1)
  assert.equal(refinements[0]?.rawText.includes('wJalrXUtnFEMI'), false)
  assert.ok((refinements[0]?.rawText.length ?? Infinity) <= 16_000)
  assert.deepEqual(refinements[0]?.truncatedFields, ['rawText', 'selectedText'])

  const confirmation = {
    protocol: 1 as const,
    auditReceipt: result.auditReceipt ?? '',
    status: 'written' as const,
    reason: 'draft-written' as const,
    placement: 'append' as const,
    concurrentEdit: true,
  }
  assert.deepEqual(await pipeline.confirmDelivery(confirmation), { ok: true, confirmed: true, reason: 'delivery-queued' })
  assert.deepEqual(deliveries.map(({ refinement: _refinement, ...delivery }) => delivery), [{
    eventId: refinements[0]?.eventId,
    status: 'written',
    reason: 'draft-written',
    placement: 'append',
    concurrentEdit: true,
  }])
  assert.equal(deliveries[0]?.refinement, refinements[0])
  assert.equal(deliveries[0]?.refinement.rawText.includes('wJalrXUtnFEMI'), false)
  assert.deepEqual(await pipeline.confirmDelivery(confirmation), { ok: true, confirmed: false, reason: 'receipt-not-found' })
})

test('pipeline exposes correction review and deletion delegates', async () => {
  const memory = await temporaryMemory({ minOccurrences: 1, maxEntries: 20, pendingTtlMs: 1_000 })
  await memory.addPending('call alice', { sessionId: 'review', scope: 'review-scope' })
  await memory.observeSubmittedUserMessage('review', 'call alicia')
  const pipeline = new VoicePipeline(resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    learning: { enabled: false },
  }), { memory })
  assert.equal((await pipeline.listCorrections('review-scope')).length, 1)
  assert.equal(await pipeline.deleteCorrection('alice', 'alicia', 'review-scope'), true)
  assert.deepEqual(await pipeline.listCorrections('review-scope'), [])
})

test('append placement matches the final submitted draft before learning', async () => {
  const memory = await temporaryMemory({ minOccurrences: 1, maxEntries: 20, pendingTtlMs: 1_000 })
  const pipeline = new VoicePipeline(resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    learning: { enabled: true },
  }), {
    memory,
    fetch: async () => Response.json({ text: 'call alice' }),
  })
  const envelope = encodeEnvelope({
    protocol: 1,
    mimeType: 'audio/webm',
    draft: 'intro',
    placement: 'append',
    sessionId: 'session-append',
    scope: 'append-scope',
  }, Uint8Array.of(1))
  const result = await pipeline.process({ body: byteStream(envelope), contentType: ENVELOPE_CONTENT_TYPE })
  assert.equal(typeof result.learningReceipt, 'string')
  assert.deepEqual(await pipeline.confirmDraft({
    protocol: 1,
    learningReceipt: result.learningReceipt ?? '',
    draft: 'intro call alice',
  }), { ok: true, confirmed: true, reason: 'draft-confirmed' })
  assert.deepEqual(await pipeline.observeSubmittedUserMessage('session-append', 'intro call alicia'), {
    matched: true,
    learned: true,
    reason: 'recorded',
  })
  assert.deepEqual(await memory.learnedTerms('append-scope'), [{ from: 'alice', to: 'alicia' }])
})

test('learning confirmation records the exact concurrently edited final draft only', async () => {
  const memory = await temporaryMemory({ minOccurrences: 1, maxEntries: 20, pendingTtlMs: 1_000 })
  const pipeline = new VoicePipeline(resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    learning: { enabled: true },
  }), {
    memory,
    fetch: async () => Response.json({ text: 'call alice' }),
  })
  const envelope = encodeEnvelope({
    protocol: 1,
    mimeType: 'audio/webm',
    draft: 'old',
    placement: 'replace',
    sessionId: 'session-concurrent',
    scope: 'scope-concurrent',
  }, Uint8Array.of(1))
  const result = await pipeline.process({ body: byteStream(envelope), contentType: ENVELOPE_CONTENT_TYPE })
  const finalDraft = 'user typed call alice'
  assert.deepEqual(await pipeline.confirmDraft({
    protocol: 1,
    learningReceipt: result.learningReceipt ?? '',
    draft: finalDraft,
  }), { ok: true, confirmed: true, reason: 'draft-confirmed' })
  assert.deepEqual(await pipeline.confirmDraft({
    protocol: 1,
    learningReceipt: result.learningReceipt ?? '',
    draft: finalDraft,
  }), { ok: true, confirmed: false, reason: 'receipt-not-found' })
  assert.deepEqual(await pipeline.observeSubmittedUserMessage('session-concurrent', 'user typed call alicia'), {
    matched: true,
    learned: true,
    reason: 'recorded',
  })
  assert.deepEqual(await memory.learnedTerms('scope-concurrent'), [{ from: 'alice', to: 'alicia' }])
})

test('a failed pending write keeps its one-time receipt retryable', async () => {
  let attempts = 0
  const memory = {
    learnedTerms: async () => [],
    addPending: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('fixture persistence failure')
    },
    observeSubmittedUserMessage: async () => ({ matched: false, learned: false, reason: 'candidate-not-found' }),
    list: async () => [],
    delete: async () => false,
  } as unknown as CorrectionMemory
  const pipeline = new VoicePipeline(resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    learning: { enabled: true },
  }), {
    memory,
    fetch: async () => Response.json({ text: 'call alice' }),
  })
  const envelope = encodeEnvelope({
    protocol: 1,
    mimeType: 'audio/webm',
    sessionId: 'session-retry',
    scope: 'scope-retry',
  }, Uint8Array.of(1))
  const result = await pipeline.process({ body: byteStream(envelope), contentType: ENVELOPE_CONTENT_TYPE })
  const confirmation = { protocol: 1 as const, learningReceipt: result.learningReceipt ?? '', draft: 'call alice' }
  await assert.rejects(pipeline.confirmDraft(confirmation), /fixture persistence failure/u)
  assert.deepEqual(await pipeline.confirmDraft(confirmation), { ok: true, confirmed: true, reason: 'draft-confirmed' })
  assert.equal(attempts, 2)
})

test('concurrent draft confirmations redeem a learning receipt only once', async () => {
  let attempts = 0
  let releasePendingWrite: (() => void) | undefined
  const pendingWrite = new Promise<void>(resolve => { releasePendingWrite = resolve })
  const memory = {
    learnedTerms: async () => [],
    addPending: async () => {
      attempts += 1
      await pendingWrite
    },
    observeSubmittedUserMessage: async () => ({ matched: false, learned: false, reason: 'candidate-not-found' }),
    list: async () => [],
    delete: async () => false,
  } as unknown as CorrectionMemory
  const pipeline = new VoicePipeline(resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    learning: { enabled: true },
  }), {
    memory,
    fetch: async () => Response.json({ text: 'call alice' }),
  })
  const envelope = encodeEnvelope({
    protocol: 1,
    mimeType: 'audio/webm',
    sessionId: 'session-once',
    scope: 'scope-once',
  }, Uint8Array.of(1))
  const result = await pipeline.process({ body: byteStream(envelope), contentType: ENVELOPE_CONTENT_TYPE })
  const confirmation = { protocol: 1 as const, learningReceipt: result.learningReceipt ?? '', draft: 'call alice' }
  const first = pipeline.confirmDraft(confirmation)
  await Promise.resolve()
  assert.deepEqual(await pipeline.confirmDraft(confirmation), { ok: true, confirmed: false, reason: 'receipt-in-use' })
  releasePendingWrite?.()
  assert.deepEqual(await first, { ok: true, confirmed: true, reason: 'draft-confirmed' })
  assert.equal(attempts, 1)
  assert.deepEqual(await pipeline.confirmDraft(confirmation), { ok: true, confirmed: false, reason: 'receipt-not-found' })
})

test('a submission racing ahead of draft confirmation conservatively disables learning', async () => {
  const memory = await temporaryMemory({ minOccurrences: 1, maxEntries: 20, pendingTtlMs: 1_000 })
  const pipeline = new VoicePipeline(resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    learning: { enabled: true },
  }), {
    memory,
    fetch: async () => Response.json({ text: 'call alice' }),
  })
  const envelope = encodeEnvelope({
    protocol: 1,
    mimeType: 'audio/webm',
    sessionId: 'session-race',
    scope: 'scope-race',
  }, Uint8Array.of(1))
  const result = await pipeline.process({ body: byteStream(envelope), contentType: ENVELOPE_CONTENT_TYPE })
  assert.deepEqual(await pipeline.observeSubmittedUserMessage('session-race', 'call alicia'), {
    matched: false,
    learned: false,
    reason: 'candidate-not-found',
  })
  assert.deepEqual(await pipeline.confirmDraft({
    protocol: 1,
    learningReceipt: result.learningReceipt ?? '',
    draft: 'call alice',
  }), { ok: true, confirmed: false, reason: 'submission-raced-confirmation' })
  assert.deepEqual(await memory.learnedTerms('scope-race'), [])
  assert.deepEqual(await pipeline.observeSubmittedUserMessage('session-race', 'call alicia'), {
    matched: false,
    learned: false,
    reason: 'candidate-not-found',
  })
})

test('correction memory rolls back in-memory candidates when persistence fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-voice-memory-readonly-'))
  const memory = new CorrectionMemory({
    enabled: true,
    storePath: join(directory, 'memory.json'),
    minOccurrences: 1,
    maxEntries: 20,
    pendingTtlMs: 1_000,
  })
  await memory.list('scope-1')
  await chmod(directory, 0o500)
  try {
    await assert.rejects(memory.addPending('call alice', { sessionId: 'rollback', scope: 'scope-1' }))
  } finally {
    await chmod(directory, 0o700)
  }
  assert.deepEqual(await memory.observeSubmittedUserMessage('rollback', 'call alicia'), {
    matched: false,
    learned: false,
    reason: 'candidate-not-found',
  })
})

test('concurrency limiter and bounded body enforce their limits', async () => {
  const limiter = new ConcurrencyLimiter(2)
  let active = 0
  let maximum = 0
  const tasks = Array.from({ length: 6 }, () => limiter.run(async () => {
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active -= 1
  }))
  await Promise.all(tasks)
  assert.equal(maximum, 2)

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]))
      controller.enqueue(new Uint8Array([3, 4]))
      controller.close()
    },
  })
  await assert.rejects(readBoundedBody(stream, 3), BodyTooLargeError)
})

test('concurrency limiter bounds its waiting queue', async () => {
  const limiter = new ConcurrencyLimiter(1, 1)
  let release!: () => void
  let started!: () => void
  const running = limiter.run(() => new Promise<void>(resolve => {
    release = resolve
    started()
  }))
  await new Promise<void>(resolve => { started = resolve })
  const queued = limiter.run(async () => undefined)
  await assert.rejects(limiter.run(async () => undefined), BusyError)
  release()
  await Promise.all([running, queued])
})

test('origin trust accepts same-origin and configured hosts only', () => {
  assert.doesNotThrow(() => assertTrustedOrigin('https://dsh.example', 'https://dsh.example/api', []))
  assert.doesNotThrow(() => assertTrustedOrigin('https://console.example', 'https://dsh.example/api', ['https://console.example']))
  assert.throws(() => assertTrustedOrigin('https://console.example', 'https://dsh.example/api', ['console.example']))
  assert.throws(() => assertTrustedOrigin('https://untrusted.example', 'https://dsh.example/api', ['https://console.example']))
})

test('origin matching ignores X-Forwarded-Proto and accepts exact allowed origins', async () => {
  const route = registeredRoute({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    allowedOrigins: ['https://console.example'],
  })
  const request = Object.assign(Readable.from([]), {
    method: 'POST',
    url: `${API_ROOT}/process`,
    headers: {
      host: 'dsh.example',
      origin: 'https://dsh.example',
      'x-forwarded-proto': 'https',
      'content-type': ENVELOPE_CONTENT_TYPE,
    },
    socket: { encrypted: false },
  }) as unknown as IncomingMessage
  const response = responseCapture()
  await route(request, response.value)
  assert.equal(response.status, 403)
})

test('publicOrigin explicitly supports TLS termination without trusting proxy headers', async () => {
  const route = registeredRoute({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    publicOrigin: 'https://dsh.example',
  })
  const body = JSON.stringify({ protocol: 1, learningReceipt: 'unknown-receipt', draft: 'voice draft' })
  const request = Object.assign(Readable.from([Buffer.from(body)]), {
    method: 'POST',
    url: `${API_ROOT}/confirm-draft`,
    headers: {
      host: 'dsh.example',
      origin: 'https://dsh.example',
      'x-forwarded-proto': 'https',
      'content-type': 'application/json',
    },
    socket: { encrypted: false },
  }) as unknown as IncomingMessage
  const response = responseCapture()
  await route(request, response.value)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, confirmed: false, reason: 'receipt-not-found' })
})

test('delivery confirmation route validates and returns unknown one-time receipts safely', async () => {
  const route = registeredRoute({ asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' } })
  const body = JSON.stringify({
    protocol: 1,
    auditReceipt: 'unknown-audit-receipt',
    status: 'not-written',
    reason: 'session-changed',
    placement: 'replace',
  })
  const request = Object.assign(Readable.from([Buffer.from(body)]), {
    method: 'POST',
    url: `${API_ROOT}/confirm-delivery`,
    headers: {
      host: 'dsh.example',
      origin: 'https://dsh.example',
      'content-type': 'application/json',
    },
    socket: { encrypted: true },
  }) as unknown as IncomingMessage
  const response = responseCapture()
  await route(request, response.value)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, confirmed: false, reason: 'receipt-not-found' })

  const invalidRequest = Object.assign(Readable.from([Buffer.from(JSON.stringify({
    protocol: 1,
    auditReceipt: 'unknown-audit-receipt',
    status: 'invalid',
    reason: 'session-changed',
  }))]), {
    method: 'POST',
    url: `${API_ROOT}/confirm-delivery`,
    headers: {
      host: 'dsh.example',
      origin: 'https://dsh.example',
      'content-type': 'application/json',
    },
    socket: { encrypted: true },
  }) as unknown as IncomingMessage
  const invalidResponse = responseCapture()
  await route(invalidRequest, invalidResponse.value)
  assert.equal(invalidResponse.status, 400)
  assert.equal(JSON.parse(invalidResponse.body).error.code, 'invalid-request')
})

test('directUserSubmission extracts only official direct user text events', () => {
  const session = { id: 'session-1' }
  assert.deepEqual(directUserSubmission(session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: ' first ' }, { type: 'image' }, { type: 'text', text: 'second ' }] },
  }), { sessionId: 'session-1', text: 'first second' })
  assert.equal(directUserSubmission(session, {
    type: 'assistant/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'ignored' }] },
  }), undefined)
  assert.equal(directUserSubmission(session, {
    type: 'user/message',
    data: { source: { kind: 'assistant' }, content: [{ type: 'text', text: 'ignored' }] },
  }), undefined)
})

test('slow process bodies time out and the route returns 408', async () => {
  const route = registeredRoute({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    bodyTimeoutMs: 5,
  })
  const request = Object.assign(new Readable({ read() {} }), {
    method: 'POST',
    url: `${API_ROOT}/process`,
    headers: {
      host: 'dsh.example',
      origin: 'https://dsh.example',
      'content-type': ENVELOPE_CONTENT_TYPE,
    },
    socket: { encrypted: true },
  }) as unknown as IncomingMessage
  const response = responseCapture()
  await route(request, response.value)
  assert.equal(response.status, 408)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: { code: 'body-timeout', message: 'request body timed out' } })
})

test('bounded body rejects an aborted slow stream', async () => {
  const stream = new ReadableStream<Uint8Array>({ start() {} })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5)
  try {
    await assert.rejects(readBoundedBody(stream, 16, controller.signal), BodyTimeoutError)
  } finally {
    clearTimeout(timeout)
  }
})

test('disabled learning does not retain candidates or expose corrections', async () => {
  const memory = new CorrectionMemory({ enabled: false, storePath: '', minOccurrences: 1, maxEntries: 20, pendingTtlMs: 1_000 })
  await memory.addPending('call alice', { sessionId: 'disabled', scope: 'scope-1' })
  assert.deepEqual(await memory.observeSubmittedUserMessage('disabled', 'call alicia'), {
    matched: false,
    learned: false,
    reason: 'learning-disabled',
  })
  assert.deepEqual(await memory.learnedTerms('scope-1'), [])
  assert.equal(await memory.delete('alice', 'alicia', 'scope-1'), false)
})

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function temporaryMemory(options: Omit<CorrectionMemoryOptions, 'enabled' | 'storePath'>): Promise<CorrectionMemory> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-voice-memory-'))
  return new CorrectionMemory({ enabled: true, storePath: join(directory, 'memory.json'), ...options })
}

function registeredRoute(config: Parameters<typeof apply>[1]): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  let route: ((request: IncomingMessage, response: ServerResponse) => void | Promise<void>) | undefined
  const context = {
    logger: () => ({ info: () => undefined, warn: () => undefined }),
    effect: (operation: () => unknown) => operation(),
    webServer: {
      register: (registered: { handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void> }) => {
        route = registered.handler
        return () => undefined
      },
    },
    on: () => () => true,
  }
  apply(context as never, config)
  if (route === undefined) throw new Error('route was not registered')
  const handler = route
  return async (request, response) => { await handler(request, response) }
}

function responseCapture(): { value: ServerResponse; status: number | undefined; body: string } {
  let status: number | undefined
  let body = ''
  const value = {
    headersSent: false,
    setHeader: () => undefined,
    writeHead: (nextStatus: number) => { status = nextStatus },
    end: (chunk?: string | Buffer) => { body += chunk?.toString() ?? '' },
  } as unknown as ServerResponse
  return {
    value,
    get status() { return status },
    get body() { return body },
  }
}
