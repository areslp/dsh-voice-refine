# DSH Voice Refine

<p align="center">
  <img src="assets/dsh-voice-refine-icon.png" alt="DSH Voice Refine Echo Seal icon" width="220">
</p>

> Speak naturally. Keep control of what gets sent.

**DSH Voice Refine turns speech into an agent-ready draft in DeepSeek Harness—without relying on browser speech recognition and without silently sending or rewriting your words.** Press and hold to record, release to process, review the result, and send only when it says what you mean.

The browser captures audio, your chosen ASR service transcribes it, and an optional constrained LLM pass can repair punctuation, casing, homophones, and domain terms:

`browser recording -> ASR adapter -> optional LLM refinement -> DSH draft`

The browser never performs speech recognition. The host plugin forwards audio only to the ASR endpoint you configure. That endpoint may run on the same machine, another machine on a private network, or a remote service. The repository does not assume a deployment topology or bundle a model.

> Status: alpha. Automatic submission is intentionally disabled; recognized text is placed in the draft for review.

## Features

- Browser microphone capture without the Web Speech API.
- OpenAI-compatible transcription adapter for Whisper-compatible services.
- Generic HTTP ASR adapter for binary or multipart APIs.
- Optional OpenAI-compatible LLM refinement with strict “repair, do not answer” instructions.
- Context budget containing the current draft, bounded recent conversation excerpts enabled by default with an explicit browser opt-out, and workspace-scoped learned terminology.
- Correction memory that learns only after the user submits an edited transcript.
- Optional local refinement audit records for evaluating accepted and rejected model proposals.
- Server-side credentials; API keys are never returned to browser code.
- No audio persistence by default.
- Refinement audit persistence is disabled by default.
- Accidental short taps are rejected locally, and the recorder is flushed before transcription.

## Quick start

This alpha is contract-tested against DeepSeek Harness `0.1.0-rc.8`; its DSH client peer dependencies are pinned to that release candidate.

Build a package from the public source and add it to your DSH web profile:

```bash
git clone https://github.com/areslp/dsh-voice-refine.git
cd dsh-voice-refine
npm ci
npm run build
npm pack
dsh plugin --profile web add ./dsh-voice-refine-0.1.0-alpha.7.tgz
```

Merge the `insert` block from [`cordis.patch.yml`](cordis.patch.yml) into your web profile's Cordis patch, then replace the intentionally invalid ASR endpoint. The invalid default ensures that installation alone cannot send audio anywhere.

OpenAI-compatible ASR:

```yaml
asr:
  kind: openai-transcription
  baseUrl: https://your-asr.example/v1
  model: whisper-1
  apiKeyEnv: DSH_VOICE_ASR_API_KEY
refine:
  kind: disabled
```

Enable refinement through an independent endpoint:

```yaml
refine:
  kind: openai-chat
  baseUrl: https://your-llm.example/v1
  model: your-small-instruct-model
  apiKeyEnv: DSH_VOICE_REFINE_API_KEY
  temperature: 0
```

The ASR and refinement endpoints do not need to share a host, provider, credential, or network location. See [configuration](docs/configuration.md) for generic HTTP examples and all limits.

Relative OpenAI-compatible `endpoint` values are resolved against their adapter's `baseUrl`; generic HTTP ASR endpoints remain explicit absolute URLs.

Validate the composed configuration before restarting your DSH deployment:

```bash
dsh --profile web --dump-config
```

## Usage

1. Press and hold the microphone button.
2. Speak while holding it.
3. Release to run ASR and optional refinement.
4. Review or edit the text placed in the DSH draft.
5. Send it with the normal DSH send action.

The plugin never submits the draft automatically.

## How refinement uses context

The refiner receives only bounded text:

1. the raw ASR transcript;
2. the current unsent draft;
3. a bounded tail of recent user/assistant messages by default, with an explicit browser opt-out;
4. terminology learned from prior submitted corrections.

The recent-message tail is limited to eight messages, and the current draft plus those messages share a 6,000-character budget. The model is instructed to fix punctuation, segmentation, homophones, and domain terms while preserving intent. If it fails, times out, or returns an unsafe/invalid result, the raw transcript is used. It never receives audio.

## Correction learning

The process response includes a short-lived learning receipt. Only after the client successfully writes the exact final draft does it redeem that receipt; session switches therefore leave no learning candidate, and concurrent typing confirms the merged draft rather than stale request text. If the user submits before confirmation completes, learning for that interaction is skipped conservatively. When DSH later records a direct user submission in the same session, the plugin correlates it with that confirmed draft. It then extracts small substitutions, rejects likely secrets and high-entropy values, and activates a term only after the configured occurrence threshold.

Learning is workspace-scoped by default. The browser hashes the workspace path before sending metadata, so the host, correction store, ASR service, and refinement model never receive that path. If the browser cannot derive an opaque scope, learning is skipped rather than falling back to a global vocabulary.

No semantic rewrite is learned wholesale. One-off edits remain pending evidence, not automatic rules.

## Refinement audit

Deployments may opt in to a local, server-side audit trail for tuning the conservative repair guard. Each voice request records the raw ASR transcript, the model proposal when one exists, the text selected for delivery, an exact decision/reason, guard version, model identifiers, and context size counters. A separate one-time browser receipt records whether that selected text was actually written, rejected after a session switch, or otherwise not delivered. It does not store audio, merged drafts, or conversation-context text.

Records are private daily NDJSON files. Credential-like values are always redacted, text fields are hard-capped, session and scope identifiers use keyed HMACs, and expired files are removed according to `retentionDays`. A bounded background writer keeps slow or failed storage off the voice-response path; overflow or write failure is warned and drops audit data rather than delaying speech input. See [configuration](docs/configuration.md) for the opt-in settings and storage path.

## Privacy and security

- Audio goes only to the configured ASR adapter.
- Conversation text and learned terms go only to the configured refinement adapter when refinement is enabled.
- API keys are read from named server environment variables.
- Audio bodies and context are size- and time-bounded.
- The plugin applies same-origin CSRF checks and limits concurrent processing; DSH authentication remains the access-control boundary.
- Audio is held in memory and discarded after processing.
- Correction memory is an owner-readable JSON file; likely secrets are excluded.
- Opt-in refinement audit files are owner-readable, time-bounded, and redact obvious credentials; transcript text can still be sensitive.

Read [SECURITY.md](SECURITY.md) before exposing DSH or any model endpoint beyond a trusted network.

## Development

```bash
npm install
npm run typecheck
npm test
DSH_SOURCE_DIR=/path/to/deepseek-harness npm run verify:dsh-rc8-contract
npm run build
npm run pack:check
```

Node.js `22.19+` or `24+` is required to match current DSH release candidates.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and review workflow.

## License

MIT
