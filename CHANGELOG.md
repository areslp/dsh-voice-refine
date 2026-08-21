# Changelog

All notable changes to this project will be documented in this file.

## 0.1.0-alpha.7 - 2026-08-21

### Changed

- Published the first clean public source snapshot with GitHub metadata, contribution guidance, CI, and public security-reporting instructions.

### Fixed

- Clear voice draft-delivery notices as soon as DSH begins adjudicating or sending the associated message, without treating ordinary draft edits as submissions.
- Stabilized asynchronous voice lifecycle tests by waiting for observable draft-delivery outcomes instead of assuming a fixed event-loop schedule.

## 0.1.0-alpha.6 - 2026-08-20

### Added

- Added opt-in, time-bounded local NDJSON refinement audits with accepted/rejected proposals, exact outcome reasons, guard versions, browser delivery receipts, mandatory best-effort credential redaction, HMAC identifiers, and a bounded background writer isolated from the voice path.

## 0.1.0-alpha.5 - 2026-08-20

### Fixed

- Fixed conservative-repair tokenization for adjacent Latin and CJK text so safe boundary-spacing corrections are not mistaken for semantic rewrites.

## 0.1.0-alpha.4 - 2026-08-20

### Added

- Added a configurable minimum recording duration, a final recorder-data flush, and friendly handling for undecodable or speech-free audio.

## 0.1.0-alpha.3 - 2026-08-20

### Changed

- Enabled bounded recent conversation context by default, migrated legacy stored defaults to enabled, and preserved explicit browser opt-outs made after migration.
- Tightened the context window to at most eight messages within a 6,000-character draft-plus-message budget for small local refinement models.

## 0.1.0-alpha.2 - 2026-08-20

### Changed

- Clarified the conservative refinement prompt so small local models apply clear context, learned-term, product-spelling, punctuation, and casing repairs without changing intent or facts.

## 0.1.0-alpha.1 - 2026-08-20

### Added

- Browser audio capture without browser speech recognition.
- Provider-neutral ASR and refinement adapter contracts.
- Bounded context assembly and conservative transcription refinement.
- Thresholded correction memory with secret filtering.
- Same-origin host API with size, timeout, and concurrency limits.
- DeepSeek Harness rc.8 input-zone integration and editable draft insertion.
- Browser-side opaque workspace scopes with recent conversation context initially disabled by default.

### Security

- Protected negation, number, URL, path, and command-flag semantics from LLM refinement changes.
- Required scoped learning by default and isolated correction-memory reads.
- Added exact additional-origin allowlisting without trusting forwarded protocol headers.
- Added bounded request-body, ASR, and refinement timeouts.
- Rejected URL credentials and credential-like endpoint query parameters.
- Added explicit `publicOrigin` support for TLS-terminating reverse proxies.

### Changed

- Automatic correction learning now observes official direct-user submission events; the unused client feedback endpoint was removed.
- Learning candidates are created only after a one-time receipt confirms the exact draft written by the client.
- Concurrent user typing is preserved, and results are not written or registered for learning after a session switch.
- Package creation now builds artifacts through `prepack`, including from a clean checkout.
