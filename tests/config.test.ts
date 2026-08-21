import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig } from '../src/config.js'

test('config defaults remain deployment-neutral', () => {
  const config = resolveConfig({
    asr: {
      kind: 'http',
      endpoint: 'https://asr.example/transcribe',
    },
  })
  assert.equal(config.asr.kind, 'http')
  assert.equal(config.refine.kind, 'disabled')
  assert.equal(config.learning.enabled, true)
  assert.equal(config.learning.requireScope, true)
  assert.equal(config.audit.enabled, false)
  assert.equal(config.audit.retentionDays, 30)
  assert.equal(config.audit.maxPendingEntries, 100)
  assert.equal(config.audit.identityKeyEnv, 'DSH_VOICE_AUDIT_KEY')
  assert.equal(config.maxConcurrentRequests, 2)
  assert.equal(config.bodyTimeoutMs, 30_000)
  assert.equal(config.minRecordingMs, 800)
})

test('config rejects unsafe or accidental limit values', () => {
  assert.throws(() => resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    maxConcurrentRequests: 0,
  }), /between 1 and 32/u)
  assert.throws(() => resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    minRecordingMs: 1_000,
    maxRecordingMs: 1_000,
  }), /less than maxRecordingMs/u)
  assert.throws(() => resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    audit: { retentionDays: 0 },
  }), /between 1 and 3650/u)
})

test('config resolves explicit local audit settings', () => {
  const config = resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    audit: { enabled: true, storePath: '/var/lib/voice-audit', retentionDays: 14, maxPendingEntries: 50, identityKeyEnv: 'AUDIT_KEY' },
  })
  assert.deepEqual(config.audit, {
    enabled: true,
    storePath: '/var/lib/voice-audit',
    retentionDays: 14,
    maxPendingEntries: 50,
    identityKeyEnv: 'AUDIT_KEY',
  })
})

test('config accepts exact allowed origins and rejects paths or relative values', () => {
  const config = resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    allowedOrigins: ['https://console.example'],
    publicOrigin: 'https://dsh.example',
    bodyTimeoutMs: 25,
  })
  assert.deepEqual(config.allowedOrigins, ['https://console.example'])
  assert.equal(config.publicOrigin, 'https://dsh.example')
  assert.equal(config.bodyTimeoutMs, 25)
  assert.throws(() => resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    allowedOrigins: ['https://console.example/voice'],
  }), /allowedOrigins/u)
  assert.throws(() => resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    allowedOrigins: ['console.example'],
  }), /allowedOrigins/u)
  assert.throws(() => resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe' },
    publicOrigin: 'https://dsh.example/path',
  }), /publicOrigin/u)
})

test('config rejects endpoint credentials and credential query parameters', () => {
  assert.throws(() => resolveConfig({
    asr: { kind: 'http', endpoint: 'https://user:password@asr.example/transcribe' },
  }), /URL credentials/u)
  assert.throws(() => resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe?api_key=secret' },
  }), /credential query/u)
  for (const name of ['key', 'sig', 'jwt']) {
    assert.throws(() => resolveConfig({
      asr: { kind: 'http', endpoint: `https://asr.example/transcribe?${name}=secret` },
    }), /credential query/u)
  }
  assert.throws(() => resolveConfig({
    asr: { kind: 'openai-transcription', baseUrl: 'https://asr.example/v1?token=secret', model: 'whisper-1' },
  }), /credential query/u)
  assert.throws(() => resolveConfig({
    asr: { kind: 'http', endpoint: 'file:///tmp/asr' },
  }), /HTTP\(S\)/u)
  assert.doesNotThrow(() => resolveConfig({
    asr: { kind: 'http', endpoint: 'https://asr.example/transcribe?language=zh' },
  }))
})
