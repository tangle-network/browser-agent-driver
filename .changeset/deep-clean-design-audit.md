---
'@tangle-network/browser-agent-driver': patch
---

Deep-clean the reference-grounded design-audit subsystem (no capability change).

- Canonicalize duplicated infra: `VIEWPORTS` (3 copies → one `src/design/viewports.ts` leaf) and cookie-banner dismissal (the two audit copies → one `src/design/cookie-consent.ts` leaf; page-interaction's richer `dismissModals` is left distinct).
- Validate `--provider` against a new runtime `SUPPORTED_PROVIDERS` list before casting, so an unknown value fails fast with a clear message.
- Extract `setupReferenceGrounded()` out of `runDesignAudit`, wrapping the lazy engine load + reference/corpus resolution in a try/catch that emits a clean diagnostic instead of an unhandled rejection.
- Deep-freeze the default `visionModels` ref; remove dead type imports; add `parseModelRefs` edge-case tests.
