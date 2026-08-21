import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolveConfig, type PluginConfig } from './config.js'
import { AsrRequestError, BusyError, BodyTimeoutError, BodyTooLargeError, VoicePipeline, assertTrustedOrigin, readBoundedBody } from './host/index.js'
import {
  API_ROOT,
  MAX_CONFIRM_DRAFT_CHARS,
  MAX_METADATA_BYTES,
  PROTOCOL_VERSION,
  SUPPORTED_RECORDING_MIME_TYPES,
  type ApiErrorBody,
  type PublicPluginConfig,
  type VoiceDeliveryConfirmationRequest,
  type VoiceDraftConfirmationRequest,
} from './shared/protocol.js'

export * from './config.js'
export * from './host/index.js'
export * from './shared/protocol.js'

export const name = 'dsh-voice-refine'
export const inject = ['webServer']

interface WebRoute {
  readonly kind: 'prefix'
  readonly path: string
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

interface HostServices {
  readonly webServer: {
    register(route: WebRoute): () => void
  }
}

interface SessionEventContext {
  on(name: 'session/event', listener: (session: unknown, event: unknown) => void): () => boolean
}

export function apply(ctx: Context, rawConfig: PluginConfig): void {
  const host = ctx as Context & HostServices
  const config = resolveConfig(rawConfig)
  const logger = ctx.logger(name)
  const pipeline = new VoicePipeline(config, {
    onAuditError: (error: unknown) => {
      logger.warn('refinement audit write failed: %s', error instanceof Error ? error.message : String(error))
    },
  })

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = requestUrl(request)
      const suffix = url.pathname.slice(API_ROOT.length)
      rejectCrossSite(request)

      if (request.method === 'GET' && suffix === '/config') {
        const publicConfig: PublicPluginConfig = {
          protocol: PROTOCOL_VERSION,
          maxAudioBytes: config.maxAudioBytes,
          maxRecordingMs: config.maxRecordingMs,
          minRecordingMs: config.minRecordingMs,
          refineEnabled: config.refine.kind !== 'disabled',
          learningEnabled: config.learning.enabled,
          supportedMimeTypes: SUPPORTED_RECORDING_MIME_TYPES,
        }
        sendJson(response, 200, publicConfig)
        return
      }

      if (request.method === 'POST' && suffix === '/process') {
        assertMutationOrigin(request, url, config.allowedOrigins, config.publicOrigin)
        assertContentLength(request, config.maxAudioBytes + MAX_METADATA_BYTES + 8)
        const result = await pipeline.process({
          body: request,
          contentType: header(request, 'content-type'),
          bodyTimeoutMs: config.bodyTimeoutMs,
        })
        sendJson(response, 200, result)
        return
      }

      if (request.method === 'POST' && suffix === '/confirm-draft') {
        assertMutationOrigin(request, url, config.allowedOrigins, config.publicOrigin)
        const confirmation = await readJson<VoiceDraftConfirmationRequest>(
          request,
          MAX_CONFIRM_DRAFT_CHARS * 4 + 1024,
          config.bodyTimeoutMs,
        )
        const result = await pipeline.confirmDraft(confirmation)
        sendJson(response, 200, result)
        return
      }

      if (request.method === 'POST' && suffix === '/confirm-delivery') {
        assertMutationOrigin(request, url, config.allowedOrigins, config.publicOrigin)
        const confirmation = await readJson<VoiceDeliveryConfirmationRequest>(request, 2 * 1024, config.bodyTimeoutMs)
        const result = await pipeline.confirmDelivery(confirmation)
        sendJson(response, 200, result)
        return
      }

      if (request.method === 'GET' && suffix === '/memory') {
        sendJson(response, 200, {
          ok: true,
          entries: await pipeline.listCorrections(url.searchParams.get('scope') ?? undefined),
        })
        return
      }

      if (request.method === 'DELETE' && suffix === '/memory') {
        assertMutationOrigin(request, url, config.allowedOrigins, config.publicOrigin)
        const body = await readJson<{ from?: unknown; to?: unknown; scope?: unknown }>(request, 8 * 1024, config.bodyTimeoutMs)
        if (typeof body.from !== 'string' || typeof body.to !== 'string'
          || (body.scope !== undefined && typeof body.scope !== 'string')) {
          throw new RequestError(400, 'invalid-memory-deletion', 'from, to, and optional scope must be strings')
        }
        const deleted = await pipeline.deleteCorrection(body.from, body.to, body.scope)
        sendJson(response, 200, { ok: true, deleted })
        return
      }

      sendError(response, 404, 'not-found', 'unknown dsh-voice-refine endpoint')
    } catch (error: unknown) {
      const mapped = mapError(error)
      if (mapped.status >= 500) logger.warn('voice request failed: %s', error instanceof Error ? error.message : String(error))
      if (mapped.retryAfter !== undefined) response.setHeader('retry-after', String(mapped.retryAfter))
      sendError(response, mapped.status, mapped.code, mapped.message)
    }
  }

  ctx.effect(
    () => host.webServer.register({ kind: 'prefix', path: API_ROOT, handler: route }),
    'dsh-voice-refine: host API',
  )

  ;(ctx as unknown as SessionEventContext).on('session/event', (session, event) => {
    const submitted = directUserSubmission(session, event)
    if (submitted === undefined) return
    void pipeline.observeSubmittedUserMessage(submitted.sessionId, submitted.text).catch((error: unknown) => {
      logger.warn('correction learning failed: %s', error instanceof Error ? error.message : String(error))
    })
  })

  logger.info('loaded protocol v%s; ASR=%s refine=%s audit=%s', PROTOCOL_VERSION, config.asr.kind, config.refine.kind, config.audit.enabled)
}

class RequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'RequestError'
    this.status = status
    this.code = code
  }
}

function requestUrl(request: IncomingMessage): URL {
  const host = header(request, 'host')
  if (host === undefined || host === '' || /[\r\n/\\]/u.test(host)) throw new RequestError(400, 'invalid-host', 'request Host header is invalid')
  const protocol = (request.socket as { encrypted?: boolean }).encrypted === true ? 'https' : 'http'
  return new URL(request.url ?? '/', `${protocol}://${host}`)
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function rejectCrossSite(request: IncomingMessage): void {
  if (header(request, 'sec-fetch-site') === 'cross-site') {
    throw new RequestError(403, 'forbidden', 'cross-site requests are not allowed')
  }
}

function assertMutationOrigin(
  request: IncomingMessage,
  url: URL,
  allowedOrigins: readonly string[],
  publicOrigin: string | undefined,
): void {
  try {
    assertTrustedOrigin(header(request, 'origin'), url, allowedOrigins, publicOrigin)
  } catch {
    throw new RequestError(403, 'forbidden', 'request origin is not trusted')
  }
}

function assertContentLength(request: IncomingMessage, maxBytes: number): void {
  const raw = header(request, 'content-length')
  if (raw === undefined) return
  if (!/^\d+$/u.test(raw)) throw new RequestError(400, 'invalid-length', 'Content-Length must be a non-negative integer')
  if (Number(raw) > maxBytes) throw new BodyTooLargeError(maxBytes)
}

async function readJson<T>(request: IncomingMessage, maxBytes: number, bodyTimeoutMs: number): Promise<T> {
  assertContentLength(request, maxBytes)
  const contentType = header(request, 'content-type')?.split(';')[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new RequestError(415, 'unsupported-media-type', 'expected application/json')
  const bytes = await readBoundedBody(request, maxBytes, undefined, bodyTimeoutMs)
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch {
    throw new RequestError(400, 'invalid-json', 'request body must be valid JSON')
  }
}

export function directUserSubmission(session: unknown, event: unknown): { sessionId: string; text: string } | undefined {
  if (!isRecord(session) || typeof session.id !== 'string' || !isRecord(event) || event.type !== 'user/message' || !isRecord(event.data)) return undefined
  const source = event.data.source
  if (!isRecord(source) || source.kind !== 'user' || !Array.isArray(event.data.content)) return undefined
  const text = event.data.content
    .filter((block): block is { type: 'text'; text: string } => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
    .trim()
  return text === '' ? undefined : { sessionId: session.id, text }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mapError(error: unknown): { status: number; code: string; message: string; retryAfter?: number } {
  if (error instanceof RequestError) return { status: error.status, code: error.code, message: error.message }
  if (error instanceof BodyTimeoutError) return { status: 408, code: 'body-timeout', message: error.message }
  if (error instanceof BodyTooLargeError) return { status: 413, code: 'body-too-large', message: error.message }
  if (error instanceof BusyError) return { status: 429, code: 'busy', message: 'voice processing is busy; retry shortly', retryAfter: 2 }
  if (error instanceof AsrRequestError && (error.status === 400 || error.status === 422)) {
    return { status: 422, code: 'audio-unreadable', message: 'audio could not be decoded or no speech was recognized' }
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/Content-Type|metadata|envelope|protocol|audio media type|ASR response field|voice (?:delivery )?confirmation/u.test(message)) {
    return { status: 400, code: 'invalid-request', message }
  }
  return { status: 502, code: 'processing-failed', message: 'voice processing failed' }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  const body: ApiErrorBody = { ok: false, error: { code, message } }
  sendJson(response, status, body)
}
