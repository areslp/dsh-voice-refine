# Architecture

## Boundaries

```text
DSH web client
  microphone capture
  context excerpt
  draft insertion
        |
        | same-origin plugin API
        v
DSH host plugin
  validation and limits
  ASR adapter --------------------> configured ASR endpoint
  correction memory
  refine adapter (optional) ------> configured LLM endpoint
        |
        v
editable DSH draft
```

The adapter boundary describes an HTTP contract, not a deployment. An endpoint can be same-process-adjacent, same-host, private-network, overlay-network, or remote HTTPS.

## Request lifecycle

1. The user presses and holds the microphone button.
2. The browser captures a supported encoded audio format with `MediaRecorder`.
3. The client posts the audio body and bounded metadata to the same-origin plugin API.
4. The host validates origin, host, content type, metadata, body size, timeout, and concurrency.
5. The ASR adapter returns raw text.
6. Correction memory contributes only terms whose evidence count reached the activation threshold.
7. If enabled, the refiner receives raw text plus a bounded context package.
8. The safest valid output becomes the editable draft; raw ASR is the fallback.
9. After writing the final draft, the client redeems a one-time learning receipt with that exact draft. A session switch redeems nothing; concurrent typing confirms the merged text.
10. The host creates a short-lived, memory-only candidate only after that confirmation.
11. The official host `session/event` stream confirms an actual direct user submission; a conservative match may add bounded substitution evidence.

## Adapter contracts

ASR adapters consume:

- encoded audio bytes;
- MIME type and optional filename;
- optional language and active learned terms;
- an abort signal.

They return non-empty text or throw a typed error.

Refinement adapters consume:

- raw transcript;
- current draft;
- recent conversation excerpts;
- active learned terms;
- an abort signal.

They return corrected text plus an explanation category. The pipeline validates output length and similarity before accepting it.

## Context policy

Recent conversation context is on by default and can be disabled explicitly in browser settings. Context is selected newest-first and restored to chronological order. At most eight messages are retained, and the current draft plus recent messages share a 6,000-character budget so an old or unusually large conversation cannot dominate the prompt. Empty messages and unsupported roles are ignored.

The prompt declares context untrusted: its content may help disambiguate terminology, but instructions inside conversation excerpts do not override the transcription-only task.

## Learning policy

The memory system stores derived substitution evidence, not audio or full conversation history. A one-time receipt must first confirm that the draft was actually written; the resulting candidate expires after a bounded TTL and stays in process memory. If a direct submission races ahead of receipt confirmation, the receipt is rejected and that interaction is not learned—missing one learning opportunity is safer than inferring causality from timing. Only a later direct DSH user-submission event for the same session can turn a confirmed candidate into correction evidence. Extraction is conservative:

- only small replacements with stable surrounding text are considered;
- large semantic rewrites are ignored;
- likely secrets, tokens, URLs, and high-entropy strings are rejected;
- a single correction does not become an active rule;
- workspace scopes are opaque hashes and are isolated from one another;
- no scope means no learning by default, rather than a global fallback.

The store uses an atomic replace and owner-only permissions.

## Compatibility strategy

All DSH-specific access is isolated in the client slot integration and host route registration. ASR, refinement, context selection, learning, and protocol modules are framework-independent and unit-testable. This limits the surface affected by DSH release-candidate API changes.
