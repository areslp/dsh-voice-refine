import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeEnvelope,
  encodeEnvelope,
  MAX_METADATA_BYTES,
  PROTOCOL_VERSION,
  type VoiceProcessMetadata,
} from '../src/shared/protocol.js'

const metadata: VoiceProcessMetadata = {
  protocol: PROTOCOL_VERSION,
  mimeType: 'audio/webm;codecs=opus',
  language: 'zh-CN',
  draft: 'existing',
  sessionId: 'session-1',
  messages: [{ role: 'user', content: 'DSH 是什么？' }],
}

test('voice envelope round trips UTF-8 metadata and audio bytes', () => {
  const audio = Uint8Array.of(0, 1, 2, 254, 255)
  const decoded = decodeEnvelope(encodeEnvelope(metadata, audio))
  assert.deepEqual(decoded.metadata, metadata)
  assert.deepEqual(decoded.audio, audio)
})

test('voice envelope rejects invalid magic and truncated payloads', () => {
  assert.throws(() => decodeEnvelope(Uint8Array.of(1, 2, 3)), /truncated/u)
  assert.throws(() => decodeEnvelope(new Uint8Array(8)), /magic/u)
})

test('voice envelope rejects oversized metadata', () => {
  assert.throws(
    () => encodeEnvelope({ ...metadata, draft: 'x'.repeat(MAX_METADATA_BYTES + 1) }, new Uint8Array()),
    /metadata exceeds/u,
  )
})

test('voice envelope validates metadata shape and placement', () => {
  const valid = decodeEnvelope(encodeEnvelope({ ...metadata, placement: 'append' }, Uint8Array.of(1)))
  assert.equal(valid.metadata.placement, 'append')

  const malformed = new TextEncoder().encode(JSON.stringify({ protocol: 1, mimeType: 'text/plain' }))
  const envelope = new Uint8Array(8 + malformed.byteLength + 1)
  const header = new DataView(envelope.buffer)
  header.setUint32(0, 0x44565231)
  header.setUint32(4, malformed.byteLength)
  envelope.set(malformed, 8)
  assert.throws(() => decodeEnvelope(envelope), /audio media type/u)
})
