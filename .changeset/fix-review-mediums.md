---
'@tangle-network/browser-agent-driver': patch
---

Address the medium-severity PR review findings on the design audit.

- **Security:** the font-download fallback filename was built from DOM-controlled `@font-face` fields without stripping path separators, so a hostile `family: '../../../tmp/evil'` could write the fetched bytes outside the output directory. Reduced to a safe separator-free basename via a tested `safeAssetFilename` helper.
- **Honest token accounting:** the reference engine reported only judge tokens; `RedesignGenerator.generate` now returns `{ directions, tokensUsed }` and the engine sums generation + judge tokens, so the reported cost is complete.
- **Tests:** added coverage for previously-untested judge logic — the vision-model adapter, plus quality/image-clamp paths.
- **Docs:** `ARCHITECTURE.md` and code comments now reflect that `extractDesignTokens` lives in the `design/audit/tokens/extract.ts` leaf (not `cli-design-audit.ts`), and the embedded pipeline's double page navigation is documented as a deliberate engine-modularity tradeoff.
