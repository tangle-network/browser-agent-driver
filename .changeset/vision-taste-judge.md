---
'@tangle-network/browser-agent-driver': minor
---

Add a provider-agnostic, ensemble-capable vision taste judge.

`design-audit --judge vision` scores designs from their SCREENSHOTS instead of DNA text — a vision-capable model looks at the audited page and the world-class reference/exemplars and judges quality visually. `--judge-models "openai:gpt-5.4,anthropic:claude-opus-4-8"` runs an ENSEMBLE: each model votes position-swapped (A-vs-B and B-vs-A to cancel order bias) and the verdicts are aggregated (majority winner, agreement→confidence, split→tie); a model that returns no usable verdict is dropped, and an all-dropped ensemble fails closed rather than fabricating a tie. Any provider the Brain layer supports works via a `{provider, model}` ref. The default judge stays `text` (byte-identical). Vision applies to screenshot-bearing subjects (page + exemplars); unrendered redesign directions still rank via the text judge.
