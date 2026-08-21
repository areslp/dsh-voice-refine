# Security policy

## Threat model

DSH can execute agent actions, so its authentication and network boundary remain more important than this plugin. Installing DSH Voice Refine does not make an unauthenticated or publicly exposed DSH instance safe.

The plugin handles three data classes:

- microphone audio, sent to the configured ASR endpoint;
- transcript plus bounded conversation context, sent to the refinement endpoint when enabled;
- submitted text corrections, stored locally only as small derived terminology substitutions.
- optional refinement audit text, stored locally only when a deployment explicitly enables it.

## Deployment requirements

- Use HTTPS whenever audio or text crosses an untrusted network.
- Keep ASR and LLM credentials in server environment variables.
- Do not put credentials in Cordis YAML, browser storage, repository files, or URL query strings.
- Configure endpoint authentication and network ACLs independently of this plugin.
- Keep automatic submission disabled while the project is alpha.
- Review the recent-conversation context setting before use. It is bounded and enabled by default, but can be disabled in the browser when its privacy trade-off is not acceptable.
- Review learned terminology periodically and remove sensitive or incorrect entries.
- Keep the opt-in audit directory private, set a dedicated random HMAC key, retain records only as long as needed, and treat transcript text as potentially sensitive even with mandatory best-effort credential redaction.

## Defaults and failure behavior

- The packaged ASR URL uses the reserved `.invalid` domain and cannot receive real audio.
- Audio is not written to disk.
- Refinement audit persistence is disabled by default; when enabled, it never stores audio, merged drafts, or conversation-context text, and its bounded writer drops records instead of blocking voice responses.
- Refinement failure falls back to raw ASR text.
- ASR failure does not replace the existing draft.
- Cross-site requests are rejected.
- Reverse-proxy deployments must set an exact browser-facing `publicOrigin`; forwarding headers are not trusted.
- Adapter URLs reject userinfo and credential-like query parameters.
- Body size, metadata size, context size, timeout, and concurrency are bounded.
- Origin validation is a CSRF control, not authentication; preserve DSH's authenticated network boundary.

## Reporting

Please do not disclose vulnerabilities in a public issue. When private vulnerability reporting is enabled, use the repository's **Security → Report a vulnerability** flow to open a private GitHub Security Advisory:

https://github.com/areslp/dsh-voice-refine/security/advisories/new

Include the affected version, impact, reproduction steps, and any suggested mitigation. If the private form is unavailable, open a minimal issue that contains no vulnerability details and asks the maintainer to enable a private channel.
