---
'@tangle-network/browser-agent-driver': minor
---

Apply the reference-grounded redesign brief in the `--evolve` agent loop.

When a reference-grounded audit runs with `--evolve`, the coding agent's prompt now leads with the winning redesign DIRECTION — its type scale, colour tokens, layout, motion, hierarchy and copy, plus the grounding exemplars — and is instructed to implement it as a coherent system, with the individual findings as secondary issues, rather than applying piecemeal CSS fixes. Adds the reusable `renderRedesignTarget` artifact renderer. Default (v1) evolve behaviour is unchanged (lazy-imported, so v1 never loads the engine).
