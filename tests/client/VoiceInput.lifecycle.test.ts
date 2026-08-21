import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { VoiceInputSlotProps } from '../../src/client/VoiceInput.js'
import type { FetchLike } from '../../src/client/api.js'
import type { MediaRecorderConstructor } from '../../src/client/mime.js'

const globalWithWindow = globalThis as unknown as Record<string, unknown>
const previousWindow = globalWithWindow.window
globalWithWindow.window = {}
const { VoiceInput } = await import('../../src/client/VoiceInput.js')
if (previousWindow === undefined) delete globalWithWindow.window
else globalWithWindow.window = previousWindow

class FakeMediaRecorder {
  static isTypeSupported = (_mimeType: string): boolean => true

  readonly mimeType = 'audio/webm'
  state: RecordingState = 'inactive'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onstop: ((event: Event) => void) | null = null

  start(): void {
    this.state = 'recording'
  }

  requestData(): void {
    this.ondataavailable?.({ data: new Blob([Uint8Array.of(1)], { type: this.mimeType }) } as BlobEvent)
  }

  stop(): void {
    this.state = 'inactive'
    this.onstop?.(new Event('stop'))
  }
}

const recorderConstructor = FakeMediaRecorder as unknown as MediaRecorderConstructor
const stream = {
  getTracks: () => [{ stop() {} }],
} as unknown as MediaStream
const mediaDevices = {
  getUserMedia: async () => stream,
} as unknown as Pick<MediaDevices, 'getUserMedia'>
const storage = {
  getItem: () => null,
  setItem() {},
}
const useSessions: VoiceInputSlotProps['useSessions'] = selector => selector({
  byId: { 'session-1': { cwd: '/workspace' } },
})

test('voice success notice survives manual edits and clears when DSH starts submission', async () => {
  const delivery = deferred<void>()
  let deliveredDraft = ''
  const fetcher = voiceFetcher()
  const render = (input: unknown) => createElement(VoiceInput, voiceProps(input, fetcher, value => {
    deliveredDraft = value
    delivery.resolve(undefined)
  }))
  const originalNow = Date.now
  let now = 1_000
  Date.now = () => now++
  let renderer: ReactTestRenderer | undefined
  try {
    await act(async () => {
      renderer = create(render({ draft: '', phase: 'plain' }))
      await flushTasks()
    })
    now = 1_010
    await recordOnce(renderer, delivery.promise)
    assert.equal(deliveredDraft, 'voice text', statusText(renderer))
    assert.match(statusText(renderer), /已加入草稿/u)

    await act(async () => {
      renderer?.update(render({ draft: 'voice text', phase: 'plain' }))
    })
    assert.match(statusText(renderer), /已加入草稿/u)

    await act(async () => {
      renderer?.update(render({ draft: '', phase: 'plain' }))
    })
    assert.match(statusText(renderer), /已加入草稿/u)

    await act(async () => {
      renderer?.update(render({ draft: 'edited voice text', phase: 'plain' }))
    })
    assert.match(statusText(renderer), /已加入草稿/u)

    await act(async () => {
      renderer?.update(render({ draft: 'edited voice text', phase: 'submitting' }))
    })
    assert.equal(statusText(renderer), '')
  } finally {
    Date.now = originalNow
    renderer?.unmount()
  }
})

test('accepted user message clears the notice when an intermediate submission phase is batched away', async () => {
  const delivery = deferred<void>()
  const fetcher = voiceFetcher()
  const render = (input: unknown, nodes: readonly unknown[] = []) => createElement(
    VoiceInput,
    voiceProps(input, fetcher, () => { delivery.resolve(undefined) }, nodes),
  )
  const originalNow = Date.now
  let now = 1_500
  Date.now = () => now++
  let renderer: ReactTestRenderer | undefined
  try {
    await act(async () => {
      renderer = create(render({ draft: '', phase: 'plain' }))
      await flushTasks()
    })
    now = 1_510
    await recordOnce(renderer, delivery.promise)
    assert.match(statusText(renderer), /已加入草稿/u)

    await act(async () => {
      renderer?.update(render(
        { draft: '', phase: 'plain' },
        [{ kind: 'user', seq: 1, content: 'voice text' }],
      ))
    })
    assert.equal(statusText(renderer), '')
    assert.equal(rootState(renderer), 'idle')
  } finally {
    Date.now = originalNow
    renderer?.unmount()
  }
})

test('accepted steering follow-up clears the notice when an intermediate submission phase is batched away', async () => {
  const delivery = deferred<void>()
  const fetcher = voiceFetcher()
  const render = (input: unknown, nodes: readonly unknown[] = []) => createElement(
    VoiceInput,
    voiceProps(input, fetcher, () => { delivery.resolve(undefined) }, nodes),
  )
  const originalNow = Date.now
  let now = 1_750
  Date.now = () => now++
  let renderer: ReactTestRenderer | undefined
  try {
    await act(async () => {
      renderer = create(render(
        { draft: '', phase: 'plain' },
        [{ kind: 'user', seq: 1, content: 'earlier message' }],
      ))
      await flushTasks()
    })
    now = 1_760
    await recordOnce(renderer, delivery.promise)
    assert.match(statusText(renderer), /已加入草稿/u)

    await act(async () => {
      renderer?.update(render(
        { draft: '', phase: 'plain' },
        [
          { kind: 'user', seq: 1, content: 'earlier message' },
          { kind: 'steering', seq: 2, messageId: 'follow-up', content: 'voice text' },
        ],
      ))
    })
    assert.equal(statusText(renderer), '')
    assert.equal(rootState(renderer), 'idle')
  } finally {
    Date.now = originalNow
    renderer?.unmount()
  }
})

test('fast submission cannot republish the notice after learning confirmation settles', async () => {
  const confirmation = deferred<Response>()
  const delivery = deferred<void>()
  let deliveredDraft = ''
  const fetcher = voiceFetcher(confirmation.promise)
  const render = (input: unknown) => createElement(VoiceInput, voiceProps(input, fetcher, value => {
    deliveredDraft = value
    delivery.resolve(undefined)
  }))
  const originalNow = Date.now
  let now = 2_000
  Date.now = () => now++
  let renderer: ReactTestRenderer | undefined
  try {
    await act(async () => {
      renderer = create(render({ draft: '', phase: 'plain' }))
      await flushTasks()
    })
    now = 2_010
    await recordOnce(renderer, delivery.promise)
    assert.equal(deliveredDraft, 'voice text', statusText(renderer))

    await act(async () => {
      renderer?.update(render({ draft: 'voice text', phase: 'submitting' }))
    })
    assert.equal(statusText(renderer), '')
    assert.equal(rootState(renderer), 'idle')

    await beginRecording(renderer)
    assert.equal(rootState(renderer), 'recording')

    await act(async () => {
      confirmation.resolve(Response.json({ ok: true, confirmed: true, reason: 'draft-confirmed' }))
      await flushTasks()
    })
    assert.equal(rootState(renderer), 'recording')
    assert.match(statusText(renderer), /录音中/u)
  } finally {
    Date.now = originalNow
    confirmation.resolve(Response.json({ ok: true, confirmed: true, reason: 'draft-confirmed' }))
    renderer?.unmount()
  }
})

test('unmount owns and suppresses a late learning confirmation', async () => {
  const confirmation = deferred<Response>()
  const delivery = deferred<void>()
  const fetcher = voiceFetcher(confirmation.promise)
  const render = () => createElement(
    VoiceInput,
    voiceProps({ draft: '', phase: 'plain' }, fetcher, () => { delivery.resolve(undefined) }),
  )
  const originalNow = Date.now
  let now = 3_000
  Date.now = () => now++
  let renderer: ReactTestRenderer | undefined
  try {
    await act(async () => {
      renderer = create(render())
      await flushTasks()
    })
    now = 3_010
    await recordOnce(renderer, delivery.promise)
    await act(async () => {
      renderer?.unmount()
      confirmation.resolve(Response.json({ ok: true, confirmed: true, reason: 'draft-confirmed' }))
      await flushTasks()
    })
  } finally {
    Date.now = originalNow
    confirmation.resolve(Response.json({ ok: true, confirmed: true, reason: 'draft-confirmed' }))
    renderer?.unmount()
  }
})

function voiceProps(
  input: unknown,
  fetcher: FetchLike,
  setDraft: (value: string) => void,
  nodes: readonly unknown[] = [],
): VoiceInputSlotProps {
  return {
    sessionId: 'session-1',
    session: { sessionId: 'session-1', chat: { legacy: { nodes } } },
    input,
    inputActions: { setDraft },
    useSessions,
    fetcher,
    storage,
    mediaDevices,
    mediaRecorderConstructor: recorderConstructor,
  }
}

function voiceFetcher(confirmation?: Promise<Response>): FetchLike {
  return async (input) => {
    const url = String(input)
    if (url.endsWith('/config')) {
      return Response.json({
        protocol: 1,
        maxAudioBytes: 1_024,
        maxRecordingMs: 1_000,
        minRecordingMs: 1,
        refineEnabled: true,
        learningEnabled: confirmation !== undefined,
        supportedMimeTypes: ['audio/webm'],
      })
    }
    if (url.endsWith('/process')) {
      return Response.json({
        ok: true,
        protocol: 1,
        rawText: 'voice text',
        text: 'voice text',
        refined: false,
        ...(confirmation === undefined ? {} : { learningReceipt: 'learning-receipt' }),
      })
    }
    if (url.endsWith('/confirm-draft')) {
      if (confirmation === undefined) throw new Error('unexpected learning confirmation')
      return confirmation
    }
    throw new Error(`unexpected request: ${url}`)
  }
}

async function recordOnce(
  renderer: ReactTestRenderer | undefined,
  delivery: Promise<void>,
): Promise<void> {
  await beginRecording(renderer)
  if (renderer === undefined) throw new Error('renderer was not created')
  const button = renderer.root.findByProps({ className: 'dsh-voice-refine__button' })
  await act(async () => {
    button.props.onKeyUp({ key: ' ', preventDefault() {} })
    await waitForDelivery(delivery)
    await flushTasks()
  })
}

async function waitForDelivery(delivery: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      delivery,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('voice draft was not delivered within two seconds')), 2_000)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

async function beginRecording(renderer: ReactTestRenderer | undefined): Promise<void> {
  if (renderer === undefined) throw new Error('renderer was not created')
  const button = renderer.root.findByProps({ className: 'dsh-voice-refine__button' })
  await act(async () => {
    button.props.onKeyDown({ key: ' ', repeat: false, preventDefault() {} })
    await flushTasks()
  })
}

function statusText(renderer: ReactTestRenderer | undefined): string {
  if (renderer === undefined) throw new Error('renderer was not created')
  return renderer.root.findByProps({ className: 'dsh-voice-refine__status' }).children
    .filter((child): child is string => typeof child === 'string')
    .join('')
}

function rootState(renderer: ReactTestRenderer | undefined): unknown {
  if (renderer === undefined) throw new Error('renderer was not created')
  return renderer.root.findByProps({ className: 'dsh-voice-refine' }).props['data-state']
}

async function flushTasks(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>(resolve => { resolvePromise = resolve })
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value)
      resolvePromise = undefined
    },
  }
}
