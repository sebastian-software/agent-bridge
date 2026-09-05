# ADR-0012: Use normalized events and typed multimodal content

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

Claude Code, Codex, and future harnesses expose different event vocabularies and
content shapes. Copying each native protocol into the bridge would make callers
harness-aware, while reducing every result to text would lose structured and
multimodal capabilities such as OCR, images, audio, files, and machine-readable
reports.

Workspace modifications also need to remain distinguishable from values a
delegate intentionally returns. A changed repository file is an observed
effect; a returned report or image is an artifact.

## Decision

The versioned operations contract defines:

- a small normalized set of invocation event categories;
- a common event envelope with stable invocation identity, sequence/cursor,
  timestamp, category, and provenance;
- optional namespaced native extensions for adapter-specific detail;
- typed content parts for text, JSON, image, audio, file, and resource values;
- referenced representation for large data, including path or resource
  identity, MIME type, byte size, and digest; and
- separate artifact and workspace-effect collections in terminal outcomes.

Native extensions preserve useful evidence but are not required for portable
caller behavior. Unknown native event types are retained as bounded diagnostic
provenance rather than silently discarded.

## Consequences

- Callers can implement portable progress and outcome handling without knowing
  the selected harness.
- The initial schema is multimodal without placing large binary blobs in every
  event or broker response.
- Adapters may expose richer data without forcing immediate growth of the core
  event union.
- Event-category and content-part evolution requires explicit schema
  versioning and compatibility tests.
- Observed effects never imply that the delegate intended to return an
  artifact, and artifacts never imply that the workspace was modified.
