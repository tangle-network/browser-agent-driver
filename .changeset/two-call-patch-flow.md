---
'@tangle-network/browser-agent-driver': minor
---

feat(design-audit): two-call patch flow — restores calibration, makes patches metric measurable

Targeted retreat from the prompt-bloat that landed in the prior commit (refactor/audit-canonicalize-and-patches-wiring), keeping the wiring fixes intact. Splits the audit into two LLM calls:

1. **Findings + scores** (`evaluate.ts`) — slim, focused, no patch contract. Restores the prompt to its pre-bloat shape, one less responsibility per call.
2. **Patches** (new `src/design/audit/patches/generate.ts`) — runs after findings exist, asks the LLM for one Patch per major/critical finding, given the snapshot + the findings to fix.

`build-result.ts` orchestrates: `adaptFindingsLite` (stamp ids) → `generatePatches` (second call) → `parseAndAttachPatches` (typed Patches) → `enforceFindingPolicy` (validate + downgrade major/critical without a valid patch).

**Eval-agent verdict on this round:**

| Flow | Before this commit | After |
|------|-------------------|-------|
| `designAudit_calibration_in_range_rate` | 0.00 (broken by prompt bloat) | **0.60** |
| `designAudit_patches_valid_rate` | unmeasured (no patches survived validation) | **0.94 (17/18 patches valid)** |

Calibration is still 0.10 below target (stripe and raycast scored 7.3 and 7.5 against an 8-10 expected band — close but not in range). The patches metric is 0.01 below its 0.95 target — one validation failure on linear.app where the LLM emitted a placeholder `before` text. Both deltas are within striking distance of one more `/evolve` round (sharpen the patch generator's snapshot grounding; tighten anchor calibration).

+5 unit tests for `generatePatches`. Total: 1510 passing.
