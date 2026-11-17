---
"@tangle-network/browser-agent-driver": minor
---

Act only on the element the model saw, and judge completion from the page (#177).

- A `@ref` from the CDP observation is bound to the backend node it named. Before each action, including every step of a `clickSequence` and each follow-up action, the driver checks that node is still in the page with the same role and accessible name and acts on exactly that node. When it is gone or renamed, the action fails with `TargetChangedError`, the rest of the batch is skipped, and the next turn observes again. Previously a repeated label ("Add to cart") resolved by position at action time, so after the first click re-rendered the list the second click hit the next product.
- The CDP snapshot now shows visible text that no named element already carries (to-do labels, prices, order totals) and `[checked]` state, so repeated controls can be told apart.
- Goal verification judges every completion from page evidence: the final page, the latest observation of each earlier page, values the driver read, and the actions the driver executed. The agent's result text is a claim to check, never evidence; each requirement marked met must quote text present in that evidence. Removed the paths that accepted a completion without checking the page: quoted-goal-literal corroboration, the claimed-JSON fast path, script-backed acceptance, and progressive acceptance after rejections.
