import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { PROTOCOL_VERSION, type PublicPluginConfig, type VoiceDeliveryConfirmationRequest } from '../shared/protocol.js'
import {
  assertAudioWithinLimit,
  assertRecordingDuration,
  confirmVoiceDelivery,
  confirmVoiceDraft,
  fetchPublicPluginConfig,
  type FetchLike,
  processVoiceAudio,
  VoiceApiError,
} from './api.js'
import {
  extractInputLifecycle,
  extractUserSubmissionSnapshot,
  hasNewUserSubmission,
  shouldClearDeliveredDraftNotice,
  type UserSubmissionSnapshot,
} from './context.js'
import {
  buildVoiceProcessMetadata,
  extractSessionId,
  opaqueWorkspaceScope,
  resolveDraftDelivery,
} from './metadata.js'
import {
  actualMimeType,
  createMediaRecorder,
  fileNameForMimeType,
  type MediaRecorderConstructor,
} from './mime.js'
import {
  DEFAULT_VOICE_PREFERENCES,
  loadVoicePreferences,
  saveVoicePreferences,
  type PreferenceStorage,
  type VoicePreferences,
} from './preferences.js'
import { ensureVoiceClientStyles } from './styles.js'

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export interface VoiceInputActions {
  readonly setDraft: (text: string) => void
}

export interface SessionListSnapshot {
  readonly byId: Readonly<Record<string, { readonly cwd?: string } | undefined>>
}

export type SnapshotSelectorHook<T> = <Selection>(selector: (snapshot: T) => Selection) => Selection

export interface VoiceInputSlotProps {
  readonly sessionId: string
  readonly session: unknown
  readonly input: unknown
  readonly inputActions: VoiceInputActions
  readonly useSessions: SnapshotSelectorHook<SessionListSnapshot>
  readonly fetcher?: FetchLike
  readonly storage?: PreferenceStorage
  readonly mediaDevices?: Pick<MediaDevices, 'getUserMedia'>
  readonly mediaRecorderConstructor?: MediaRecorderConstructor
}

type CaptureState = 'idle' | 'recording' | 'processing' | 'error' | 'refine-fallback'

interface ActiveRecording {
  readonly stream: MediaStream
  readonly recorder: MediaRecorder
  readonly chunks: Blob[]
  readonly requestedMimeType: string | undefined
  readonly startedAtMs: number
  timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined
  finalized: boolean
  failure: Error | undefined
}

interface LatestContext {
  readonly config: PublicPluginConfig | null
  readonly preferences: VoicePreferences
  readonly draft: string
  readonly sessionSnapshot: unknown
  readonly userSubmission: UserSubmissionSnapshot
  readonly sessionId: string | undefined
  readonly workspacePath: string | undefined
  readonly inputActions: VoiceInputActions | undefined
  readonly fetcher: FetchLike | undefined
}

export function VoiceInput(props: VoiceInputSlotProps): JSX.Element {
  const statusId = useId()
  // rc.8's input-zone owner already supplies point-in-time session/input
  // snapshots. The framework hooks are selector hooks; useSessions is needed
  // only to derive an opaque workspace learning scope from the session row.
  const sessionSnapshot = props.session
  const inputLifecycle = extractInputLifecycle(props.input)
  const userSubmission = extractUserSubmissionSnapshot(sessionSnapshot)
  const draft = inputLifecycle.draft
  const sessionId = props.sessionId || extractSessionId(sessionSnapshot)
  const workspacePath = props.useSessions(snapshot => snapshot.byId[props.sessionId]?.cwd)

  const [config, setConfig] = useState<PublicPluginConfig | null>(null)
  const [configLoading, setConfigLoading] = useState(true)
  const [configError, setConfigError] = useState(false)
  const [preferences, setPreferences] = useState<VoicePreferences>(() => loadVoicePreferences(props.storage))
  const [state, setState] = useState<CaptureState>('idle')
  const [notice, setNotice] = useState('')

  const activeRef = useRef<ActiveRecording | null>(null)
  const processingRef = useRef(false)
  const mountedRef = useRef(true)
  const pressRef = useRef(false)
  const stopRequestedRef = useRef(false)
  const deliveredNoticeActiveRef = useRef(false)
  const deliveredNoticeSubmissionRef = useRef<UserSubmissionSnapshot>(userSubmission)
  const previousInputLifecycleRef = useRef(inputLifecycle)
  const processingGenerationRef = useRef(0)
  const latestRef = useRef<LatestContext>({
    config: null,
    preferences: DEFAULT_VOICE_PREFERENCES,
    draft: '',
    sessionSnapshot: undefined,
    userSubmission: { count: 0, lastSequence: undefined, lastIdentity: '' },
    sessionId: undefined,
    workspacePath: undefined,
    inputActions: undefined,
    fetcher: undefined,
  })
  latestRef.current = {
    config,
    preferences,
    draft,
    sessionSnapshot,
    userSubmission,
    sessionId: sessionId === '' ? undefined : sessionId,
    workspacePath,
    inputActions: props.inputActions,
    fetcher: props.fetcher,
  }

  const loadConfig = useCallback(async () => {
    setConfigLoading(true)
    setConfigError(false)
    try {
      setConfig(await fetchPublicPluginConfig(props.fetcher))
    } catch {
      setConfig(null)
      setConfigError(true)
    } finally {
      setConfigLoading(false)
    }
  }, [props.fetcher])

  useEffect(() => {
    ensureVoiceClientStyles()
    void loadConfig()
  }, [loadConfig])

  useEffect(() => {
    saveVoicePreferences(preferences, props.storage)
  }, [preferences, props.storage])

  useBrowserLayoutEffect(() => {
    const previous = previousInputLifecycleRef.current
    previousInputLifecycleRef.current = inputLifecycle
    const submissionStarted = shouldClearDeliveredDraftNotice(previous, inputLifecycle)
      || hasNewUserSubmission(deliveredNoticeSubmissionRef.current, userSubmission)
    if (!deliveredNoticeActiveRef.current || !submissionStarted) return
    deliveredNoticeActiveRef.current = false
    processingGenerationRef.current += 1
    processingRef.current = false
    setNotice('')
    setState('idle')
  }, [draft, inputLifecycle.phase, userSubmission.count, userSubmission.lastIdentity, userSubmission.lastSequence])

  const finalizeRecording = useCallback(async (active: ActiveRecording, failure?: Error): Promise<void> => {
    if (active.finalized) return
    active.finalized = true
    if (active.timeoutId !== undefined) globalThis.clearTimeout(active.timeoutId)
    stopTracks(active.stream)
    if (activeRef.current === active) activeRef.current = null

    if (failure !== undefined) {
      setState('error')
      setNotice(userFacingError(failure))
      return
    }

    const context = latestRef.current
    if (context.config === null) {
      setState('error')
      setNotice('配置不可用 / Voice configuration is unavailable')
      return
    }
    try {
      assertRecordingDuration(Date.now() - active.startedAtMs, context.config.minRecordingMs)
    } catch (error) {
      setState('error')
      setNotice(userFacingError(error))
      return
    }

    const blob = new Blob(active.chunks, { type: actualMimeType(active.recorder, active.requestedMimeType) })
    if (blob.size === 0) {
      const error = new VoiceApiError('empty-audio', 'recorded audio is empty')
      setState('error')
      setNotice(userFacingError(error))
      return
    }
    if (context.inputActions === undefined) {
      setState('error')
      setNotice('输入框不可用 / Draft input is unavailable')
      return
    }

    const processingGeneration = ++processingGenerationRef.current
    processingRef.current = true
    setState('processing')
    try {
      assertAudioWithinLimit(blob, context.config.maxAudioBytes)
      const mimeType = actualMimeType(active.recorder, active.requestedMimeType, blob.type)
      const scope = await opaqueWorkspaceScope(context.workspacePath)
      const metadata = buildVoiceProcessMetadata({
        mimeType,
        fileName: fileNameForMimeType(mimeType),
        language: context.preferences.language,
        append: context.preferences.append,
        draft: context.draft,
        sessionId: context.sessionId,
        scope,
        snapshot: context.sessionSnapshot,
        includeRecentContext: context.preferences.includeRecentContext,
      })
      const result = await processVoiceAudio({ metadata, audio: blob }, context.fetcher)
      const placement = context.preferences.append ? 'append' as const : 'replace' as const
      if (!mountedRef.current) {
        void acknowledgeDelivery(result.auditReceipt, {
          status: 'not-written', reason: 'component-unmounted', placement,
        }, context.fetcher)
        return
      }
      const latest = latestRef.current
      const delivery = resolveDraftDelivery({
        requestedSessionId: context.sessionId,
        currentSessionId: latest.sessionId,
        draftAtRequest: context.draft,
        currentDraft: latest.draft,
        text: result.text,
        append: context.preferences.append,
      })
      if (delivery.kind === 'session-changed') {
        void acknowledgeDelivery(result.auditReceipt, {
          status: 'not-written', reason: 'session-changed', placement,
        }, latest.fetcher)
        setState('error')
        setNotice('会话已切换，未改写草稿 / Session changed; draft was not modified')
        return
      }
      if (latest.inputActions === undefined) {
        void acknowledgeDelivery(result.auditReceipt, {
          status: 'not-written', reason: 'input-unavailable', placement,
        }, latest.fetcher)
        setState('error')
        setNotice('输入框不可用 / Draft input is unavailable')
        return
      }
      try {
        latest.inputActions.setDraft(delivery.draft)
      } catch (error: unknown) {
        void acknowledgeDelivery(result.auditReceipt, {
          status: 'not-written', reason: 'set-draft-failed', placement, concurrentEdit: delivery.concurrentEdit,
        }, latest.fetcher)
        throw error
      }
      void acknowledgeDelivery(result.auditReceipt, {
        status: 'written', reason: 'draft-written', placement, concurrentEdit: delivery.concurrentEdit,
      }, latest.fetcher)
      // Arm lifecycle cleanup before awaiting the learning receipt. A fast
      // user submission can otherwise clear the draft while this promise is
      // pending and the stale success notice would be published afterwards.
      deliveredNoticeActiveRef.current = true
      deliveredNoticeSubmissionRef.current = latest.userSubmission
      let learningConfirmed = true
      if (result.learningReceipt !== undefined) {
        try {
          const confirmation = await confirmVoiceDraft({
            protocol: PROTOCOL_VERSION,
            learningReceipt: result.learningReceipt,
            draft: delivery.draft,
          }, latest.fetcher)
          learningConfirmed = confirmation.confirmed
        } catch {
          learningConfirmed = false
        }
      }
      if (!mountedRef.current
        || processingGenerationRef.current !== processingGeneration
        || !deliveredNoticeActiveRef.current) return
      if (result.refineFallback !== undefined) {
        setState('refine-fallback')
        setNotice('已加入草稿（保留原始识别） / Added to draft (raw ASR fallback)')
      } else {
        setState('idle')
        setNotice(!learningConfirmed
          ? '已加入草稿（本次未登记学习） / Added to draft (learning not registered)'
          : delivery.concurrentEdit
          ? '检测到同时编辑，语音已追加 / Concurrent edit preserved; voice appended'
          : '已加入草稿 / Added to draft')
      }
    } catch (error) {
      if (processingGenerationRef.current === processingGeneration) {
        setState('error')
        setNotice(userFacingError(error))
      }
    } finally {
      if (processingGenerationRef.current === processingGeneration) processingRef.current = false
    }
  }, [])

  const stopActiveRecording = useCallback(() => {
    stopRequestedRef.current = true
    const active = activeRef.current
    if (active === null) return
    if (active.recorder.state === 'inactive') {
      void finalizeRecording(active, active.failure)
      return
    }
    try {
      if (active.recorder.state === 'recording') active.recorder.requestData()
    } catch {
      // stop() still asks the recorder to emit its final dataavailable event.
    }
    try {
      active.recorder.stop()
    } catch (error) {
      void finalizeRecording(active, asError(error))
    }
  }, [finalizeRecording])

  const startRecording = useCallback(async () => {
    if (processingRef.current || activeRef.current !== null || !pressRef.current || config === null) return
    let stream: MediaStream | undefined
    try {
      const mediaDevices = props.mediaDevices ?? (typeof navigator === 'undefined' ? undefined : navigator.mediaDevices)
      if (mediaDevices === undefined) throw new Error('microphone access is unavailable')
      stream = await mediaDevices.getUserMedia({ audio: true })
      if (!pressRef.current || stopRequestedRef.current) {
        stopTracks(stream)
        stopRequestedRef.current = false
        setState('idle')
        return
      }

      const recorderClass = props.mediaRecorderConstructor ?? (typeof globalThis.MediaRecorder === 'undefined' ? undefined : globalThis.MediaRecorder)
      if (recorderClass === undefined) throw new Error('audio recording is unavailable')
      const created = createMediaRecorder(stream, recorderClass, config.supportedMimeTypes)
      const active: ActiveRecording = {
        stream,
        recorder: created.recorder,
        chunks: [],
        requestedMimeType: created.requestedMimeType,
        startedAtMs: Date.now(),
        timeoutId: undefined,
        finalized: false,
        failure: undefined,
      }
      activeRef.current = active
      created.recorder.ondataavailable = event => {
        if (event.data.size > 0) active.chunks.push(event.data)
      }
      created.recorder.onerror = () => {
        active.failure = new Error('audio recorder failed')
        if (created.recorder.state === 'inactive') void finalizeRecording(active, active.failure)
        else {
          try {
            created.recorder.stop()
          } catch (error) {
            void finalizeRecording(active, asError(error))
          }
        }
      }
      created.recorder.onstop = () => {
        void finalizeRecording(active, active.failure)
      }
      created.recorder.start()
      setState('recording')
      active.timeoutId = globalThis.setTimeout(stopActiveRecording, config.maxRecordingMs)
      if (!pressRef.current || stopRequestedRef.current) stopActiveRecording()
    } catch (error) {
      const active = activeRef.current
      if (active !== null) {
        await finalizeRecording(active, asError(error))
      } else {
        if (stream !== undefined) stopTracks(stream)
        setState('error')
        setNotice(userFacingError(error))
      }
    }
  }, [config, finalizeRecording, props.mediaDevices, props.mediaRecorderConstructor, stopActiveRecording])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      processingGenerationRef.current += 1
      processingRef.current = false
      deliveredNoticeActiveRef.current = false
      pressRef.current = false
      stopRequestedRef.current = true
      const active = activeRef.current
      if (active === null) return
      active.finalized = true
      if (active.timeoutId !== undefined) globalThis.clearTimeout(active.timeoutId)
      activeRef.current = null
      stopTracks(active.stream)
      if (active.recorder.state !== 'inactive') {
        try {
          active.recorder.stop()
        } catch {
          // The stream and tracks have already been released.
        }
      }
    }
  }, [])

  const beginPress = useCallback((event?: PointerEvent<HTMLButtonElement>) => {
    if (config === null || configLoading || state === 'processing' || state === 'recording' || processingRef.current || activeRef.current !== null || pressRef.current) return
    if (event !== undefined) {
      event.preventDefault()
      if (event.button !== 0) return
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Pointer capture is unavailable in a few embedded mobile browsers.
      }
    }
    pressRef.current = true
    stopRequestedRef.current = false
    deliveredNoticeActiveRef.current = false
    setNotice('')
    setState('recording')
    void startRecording()
  }, [config, configLoading, startRecording, state])

  const releasePress = useCallback((event?: PointerEvent<HTMLButtonElement>) => {
    event?.preventDefault()
    pressRef.current = false
    stopActiveRecording()
    if (event !== undefined) {
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // Pointer capture cleanup is best effort.
      }
    }
  }, [stopActiveRecording])

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    if (!event.repeat) beginPress()
  }, [beginPress])

  const handleKeyUp = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    releasePress()
  }, [releasePress])

  const buttonDisabled = configLoading || config === null || state === 'processing'
  const buttonLabel = state === 'recording'
    ? '松开结束 / Release to stop'
    : state === 'processing'
      ? '处理中 / Processing'
      : '按住录音 / Hold to record'
  const status = configLoading
    ? '加载配置中 / Loading configuration…'
    : configError
      ? '无法加载配置 / Unable to load configuration'
      : state === 'recording'
        ? '录音中 / Recording…'
        : state === 'processing'
          ? '处理中 / Processing…'
          : notice

  return (
    <div className="dsh-voice-refine" data-state={state}>
      <button
        type="button"
        className="dsh-voice-refine__button"
        disabled={buttonDisabled}
        aria-label={buttonLabel}
        aria-describedby={statusId}
        aria-pressed={state === 'recording'}
        onPointerDown={beginPress}
        onPointerUp={releasePress}
        onPointerCancel={releasePress}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onBlur={() => { if (pressRef.current) releasePress() }}
        onContextMenu={event => event.preventDefault()}
      >
        <svg className="dsh-voice-refine__icon" viewBox="0 0 24 24" aria-hidden="true">
          {state === 'recording'
            ? <circle cx="12" cy="12" r="6" fill="currentColor" />
            : <path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm6-3a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.94V22h2v-2.06A8 8 0 0 0 20 12h-2Z" />}
        </svg>
        <span className="dsh-voice-refine__sr-only">{buttonLabel}</span>
      </button>
      <span
        id={statusId}
        className="dsh-voice-refine__status"
        data-show={configLoading || configError || state !== 'idle' || notice !== ''}
        role="status"
        aria-live="polite"
      >
        {status}
        {configError ? <button type="button" className="dsh-voice-refine__retry" onClick={() => { void loadConfig() }}>重试 / Retry</button> : null}
      </span>
      <details className="dsh-voice-refine__settings">
        <summary aria-label="语音设置 / Voice settings" title="语音设置 / Voice settings">⚙</summary>
        <div className="dsh-voice-refine__settings-panel">
          <label>
            <span>语言 / Language</span>
            <input
              type="text"
              value={preferences.language}
              maxLength={32}
              placeholder="auto"
              onChange={event => setPreferences(current => ({ ...current, language: event.target.value.slice(0, 32) }))}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={preferences.append}
              onChange={event => setPreferences(current => ({ ...current, append: event.target.checked }))}
            />
            <span>追加草稿 / Append draft</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={preferences.includeRecentContext}
              onChange={event => setPreferences(current => ({ ...current, includeRecentContext: event.target.checked }))}
            />
            <span>发送近期上下文给校正模型（默认开启） / Send recent context to refinement model (on by default)</span>
          </label>
        </div>
      </details>
    </div>
  )
}

async function acknowledgeDelivery(
  auditReceipt: string | undefined,
  delivery: Omit<VoiceDeliveryConfirmationRequest, 'protocol' | 'auditReceipt'>,
  fetcher: FetchLike | undefined,
): Promise<void> {
  if (auditReceipt === undefined) return
  try {
    await confirmVoiceDelivery({ protocol: PROTOCOL_VERSION, auditReceipt, ...delivery }, fetcher)
  } catch {
    // A missing delivery receipt leaves the audit event explicitly unconfirmed.
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      // Continue releasing the remaining tracks.
    }
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('audio recording failed')
}

function userFacingError(value: unknown): string {
  if (value instanceof VoiceApiError && value.code === 'recording-too-short') return '录音太短，请按住说完整后再松开 / Recording is too short; hold while speaking'
  if (value instanceof VoiceApiError && value.code === 'empty-audio') return '没有捕获到音频 / No audio was captured'
  if (value instanceof VoiceApiError && value.code === 'audio-unreadable') return '未识别到有效语音，请按住说完整后重试 / No valid speech recognized; please try again'
  if (value instanceof VoiceApiError && value.code === 'audio-too-large') return '录音过大 / Recording is too large'
  if (value instanceof DOMException && value.name === 'NotAllowedError') return '麦克风权限被拒绝 / Microphone permission was denied'
  if (value instanceof DOMException && value.name === 'NotFoundError') return '未找到麦克风 / No microphone was found'
  return '录音或处理失败 / Recording or processing failed'
}
