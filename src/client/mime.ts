export const DEFAULT_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
] as const

export type MimeSupportCheck = (mimeType: string) => boolean

export interface MediaRecorderConstructor {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder
  readonly isTypeSupported?: MimeSupportCheck
}

export interface CreatedMediaRecorder {
  readonly recorder: MediaRecorder
  readonly requestedMimeType: string | undefined
}

export function selectSupportedMimeType(
  isSupported: MimeSupportCheck | undefined,
  allowedMimeTypes: readonly string[] = DEFAULT_MIME_TYPES,
): string | undefined {
  const candidates = preferredMimeTypes(allowedMimeTypes)
  for (const candidate of candidates) {
    if (isSupported === undefined || safeIsSupported(isSupported, candidate)) return candidate
  }
  return undefined
}

export function createMediaRecorder(
  stream: MediaStream,
  MediaRecorderClass: MediaRecorderConstructor,
  allowedMimeTypes: readonly string[] = DEFAULT_MIME_TYPES,
): CreatedMediaRecorder {
  const candidates = preferredMimeTypes(allowedMimeTypes)
  const selected = selectSupportedMimeType(MediaRecorderClass.isTypeSupported, allowedMimeTypes)
  const attempts = selected === undefined ? candidates : [selected, ...candidates.filter(candidate => candidate !== selected)]

  for (const candidate of attempts) {
    if (MediaRecorderClass.isTypeSupported !== undefined && !safeIsSupported(MediaRecorderClass.isTypeSupported, candidate)) continue
    try {
      return { recorder: new MediaRecorderClass(stream, { mimeType: candidate }), requestedMimeType: candidate }
    } catch {
      // Some mobile browsers report support but reject the constructor option.
    }
  }

  try {
    return { recorder: new MediaRecorderClass(stream), requestedMimeType: undefined }
  } catch {
    throw new Error('this browser does not support a compatible audio recorder')
  }
}

export function actualMimeType(recorder: MediaRecorder, requestedMimeType: string | undefined, blobMimeType = ''): string {
  const actual = recorder.mimeType.trim() || blobMimeType.trim() || requestedMimeType?.trim()
  return actual === undefined || actual === '' ? 'audio/webm' : actual
}

export function fileNameForMimeType(mimeType: string): string {
  const baseType = mimeType.toLowerCase().split(';', 1)[0]?.trim()
  if (baseType === 'audio/mp4') return 'voice.mp4'
  if (baseType === 'audio/ogg') return 'voice.ogg'
  if (baseType === 'audio/webm') return 'voice.webm'
  return 'voice.audio'
}

function preferredMimeTypes(allowedMimeTypes: readonly string[]): string[] {
  const allowed = allowedMimeTypes.map(value => value.trim().toLowerCase()).filter(value => value !== '')
  return DEFAULT_MIME_TYPES.filter(candidate => allowed.length === 0 || allowed.some(value => sameMimeFamily(candidate, value)))
}

function sameMimeFamily(candidate: string, allowed: string): boolean {
  if (candidate.toLowerCase() === allowed) return true
  return candidate.split(';', 1)[0]?.trim().toLowerCase() === allowed.split(';', 1)[0]?.trim().toLowerCase()
}

function safeIsSupported(check: MimeSupportCheck, mimeType: string): boolean {
  try {
    return check(mimeType)
  } catch {
    return false
  }
}
