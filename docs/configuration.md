# Configuration

## OpenAI-compatible transcription

```yaml
asr:
  kind: openai-transcription
  baseUrl: https://asr.example/v1
  endpoint: audio/transcriptions
  model: whisper-1
  apiKeyEnv: DSH_VOICE_ASR_API_KEY
  language: zh
  timeoutMs: 120000
  formFields:
    response_format: json
```

`endpoint` defaults to `audio/transcriptions` relative to `baseUrl`. A leading slash is an origin-rooted URL path and therefore discards the path component of `baseUrl`. `baseUrl` may point to any implementation that accepts an OpenAI-compatible transcription request.

ASR requests default to a 120-second timeout when `timeoutMs` is omitted.

## Generic HTTP ASR

Multipart request:

```yaml
asr:
  kind: http
  endpoint: https://asr.example/transcribe
  method: POST
  body: multipart
  audioField: audio
  responseTextPath: result.transcript
  headersFromEnv:
    Authorization: DSH_VOICE_ASR_AUTHORIZATION
  formFields:
    language: zh
```

Raw binary request:

```yaml
asr:
  kind: http
  endpoint: http://asr.service.internal/transcribe
  body: binary
  responseTextPath: text
```

`headersFromEnv` maps an HTTP header name to the name of a server environment variable. The variable should contain the complete header value, such as `Bearer ...`.

## Refinement

Disabled:

```yaml
refine:
  kind: disabled
```

OpenAI-compatible chat completion:

```yaml
refine:
  kind: openai-chat
  baseUrl: https://llm.example/v1
  endpoint: chat/completions
  model: small-instruct
  apiKeyEnv: DSH_VOICE_REFINE_API_KEY
  temperature: 0
  maxOutputTokens: 800
  timeoutMs: 30000
```

The refinement endpoint sees transcript text, bounded context, and active terminology, but never audio.
Refinement requests default to a 30-second timeout when `timeoutMs` is omitted.

## Local refinement audit

Disabled by default:

```yaml
audit:
  enabled: true
  storePath: ''
  retentionDays: 30
  maxPendingEntries: 100
  identityKeyEnv: DSH_VOICE_AUDIT_KEY
```

`identityKeyEnv` must name a server environment variable containing at least 32 characters. It keys stable, deployment-local HMAC identifiers for session and opaque workspace scope; the key itself is never written to the audit. Generate a dedicated random value rather than reusing an ASR, LLM, or DSH credential.

An empty `storePath` selects `<platform user-data>/dsh-voice-refine/audit`. The host writes one owner-readable `refine-YYYY-MM-DD.ndjson` file per UTC day and removes valid dated files older than `retentionDays` on the next write. It rejects symbolic-link storage paths and assumes one DSH host process writes the directory. It never stores microphone audio, merged drafts, or conversation-context text.

Each refinement record contains the raw transcript, model proposal when available, selected voice text, `decision`, `reason`, guard version, adapter/model identifiers, HMAC identifiers, and context size counters. A correlated delivery record says whether the browser wrote the selected text, why it did not, the append/replace mode, and whether concurrent typing was preserved. Missing delivery records remain explicitly unknown rather than being treated as success.

Credential-like values are always redacted on a best-effort basis, and each text field is limited to 16,000 characters with truncation recorded. Redaction is not a guarantee that arbitrary sensitive dictated text cannot appear, so keep the directory private and choose a suitable retention period. Writes use a bounded background queue sized by `maxPendingEntries`; queue overflow, permission failure, or disk failure emits a server warning and drops the affected audit record without delaying voice input.

## Learning and limits

```yaml
learning:
  enabled: true
  storePath: ''
  minOccurrences: 2
  maxEntries: 500
  pendingTtlMs: 86400000
  requireScope: true
audit:
  enabled: false
  storePath: ''
  retentionDays: 30
  maxPendingEntries: 100
  identityKeyEnv: DSH_VOICE_AUDIT_KEY
maxAudioBytes: 16777216
maxRecordingMs: 90000
minRecordingMs: 800
maxConcurrentRequests: 2
bodyTimeoutMs: 30000
publicOrigin: https://your-dsh.example
allowedOrigins: []
```

An empty `storePath` selects the platform user-data default. With `requireScope: true`, a browser that cannot derive an opaque workspace scope gets transcription and refinement but does not add or consume correction memory.

`minRecordingMs` rejects accidental taps before audio is sent to ASR. The browser also asks `MediaRecorder` to flush its current chunk before stopping; upstream decode/no-speech responses are returned as a retryable, user-facing recognition error.

Set `publicOrigin` to the exact browser-facing origin when HTTPS terminates at a trusted reverse proxy and the DSH socket itself receives HTTP. This explicitly models the front door without trusting client-controlled forwarding headers. Direct same-origin requests are accepted automatically.

`allowedOrigins` contains exact additional cross-origin frontends such as `https://voice-console.example`; paths, wildcards, and bare hostnames are rejected. These checks reduce cross-site request forgery risk and do not replace DSH authentication or network access controls. The plugin does not trust `X-Forwarded-Proto` when deriving the request origin.

Adapter URLs must use HTTP(S). URL userinfo and credential-like query parameters are rejected; put credentials in named server environment variables through `apiKeyEnv` or `headersFromEnv`.
