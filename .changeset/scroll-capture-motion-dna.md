---
'@tangle-network/browser-agent-driver': minor
---

Add opt-in scroll-capture motion DNA to the reference-grounded design audit.

Extends `DesignDNA.motion` with a live-observed `scroll` record — scroll length (`pageHeightRatio`), reveal-on-scroll count + kinds (fade/slide/scale), sticky/pinned scene count, parallax score, and a `scrollDriven` rollup — captured by a fresh-page scroll pass that runs before the page is otherwise scrolled (so one-shot scroll reveals are observed as they fire) and tracks elements spread across the full page height. The signal is surfaced so the redesign generator recommends grounded motion specs, and the audit can flag a static page whose world-class peers are scroll-rich. Additive and opt-in via `captureScrollMotion` (default off) — default token extraction is byte-identical.
