# RFC-002: World-Class Design Audit — 8-Layer Architecture

**Status:** Draft · **Date:** 2026-04-26 · **Owner:** browser-agent-driver
**Supersedes:** none · **Audience:** senior engineers picking up any layer

---

## TL;DR

Today `bad design-audit` is a single-pass LLM scorer with one calibration anchor, scalar score output, and prose findings. Two production teams just hit the same calibration drift bug ("5/10 floor, asks for marketing-page polish on app surfaces"). The fix is not one tweak — it's an 8-layer architecture that produces machine-actionable patches, grounds itself in fleet outcomes, and gracefully covers the long tail.

**Primary consumer is coding agents** (Claude Code, Codex, OpenCode, Pi), not humans. The architecture is JSON-first, tool-callable, and self-explaining when uncertain.

The three target capabilities, with success metrics:

1. **"Designing apps is a walk in the park"** — agents apply `Patch[]` directly. Mean fixes-per-hour ≥ 10 for the median app. Generic-polish-advice rate < 5%.
2. **"Auto-evolve quality"** — every applied patch logs an outcome. Patch reliability scores converge per-pattern after N≥30 fleet applications. Calibration drift detection triggers retune within 48 hours.
3. **"Expert senior feedback across every input"** — first-principles fallback for any unclassified surface. Score-distribution per page type is honest (not all 5/10). Hard ethics floors for medical / kids / finance / legal.

8 layers, 4 release milestones (0.31 → 0.34), ~22 hrs critical path each, total ~120 hrs of focused work. Each layer is independently shippable.

---

## Why this RFC exists

### What we have
- `bad design-audit` returns `score: number, findings: DesignFinding[], summary: string, designSystemScore: Record<string, number>`
- 14 rubric fragments composed by classification predicates (type / domain / maturity / designSystem / universal)
- 1 calibration anchor (`universal-calibration.md`) referencing Linear / Stripe / Vercel / Apple as 9-10 examples
- Per-pass scoring (standard / product / visual / trust / workflow / content) merged via `conservativeScore = 0.65*min + 0.35*mean`
- GEPA harness for retuning prompts (shipped in 0.30.0)
- Fleet telemetry envelopes (shipped in 0.30.0)

### What's wrong
1. **Calibration anchor is marketing-biased.** Linear's *marketing site* ≠ Linear's *app*. Apps share an anchor that punishes them for not having custom illustrations.
2. **Scalar score collapses 5+ dimensions.** "5/10" mixes polish, product clarity, trust, workflow into one number, then surfaces advice on whichever the auditor noticed first (usually polish).
3. **Classifier is a single point of failure.** Confidence < 0.5 silently falls back to a marketing-flavored "general" rubric. The user has no visibility into this.
4. **Prose findings, not patches.** Agents have to parse natural-language advice and invent patches themselves, often badly.
5. **No outcome attribution.** Every audit is fire-and-forget. Whether a fix actually moved the needle is unmeasured.
6. **No first-principles fallback.** Long-tail surfaces (CLI tools, embedded widgets, internal admin) get the general rubric and a 5/10.
7. **No domain ethics.** A polished pediatric app missing dosage warnings can score 8.
8. **No machine-readable patterns.** Coding agents can't query "what does an 8/10 leaderboard look like?" because the patterns aren't an artifact, just text in fragments.

### Why agent-first changes everything
The bad CLI is consumed by Claude Code, Codex, OpenCode, and Pi (per `~/code/dotfiles/claude/install.sh`). Skills under `~/.claude/skills/` are how agents discover and operate the tool. Every architectural change must:
- Be reflected in the skill that documents it
- Produce JSON the agent can consume directly
- Include enough confidence/uncertainty signal that the agent can decide whether to retry, apply, or escalate

This RFC's design choices follow from that.

---

## The 8-layer stack

Layers ordered by leverage for **agent consumers**. Each layer is a discrete shippable unit. Earlier layers are dependencies for later ones.

```
                   Agent (Claude Code / Codex / OpenCode / Pi)
                                      │
                         invokes via skill + CLI
                                      ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Layer 1 · Multi-dimensional scoring foundation              │
   │           classify (ensemble) → load rubric → score per-dim  │
   │           → per-type rollup → range + confidence             │
   ├──────────────────────────────────────────────────────────────┤
   │  Layer 2 · Patch primitives                                  │
   │           every finding produces an applyable Patch          │
   ├──────────────────────────────────────────────────────────────┤
   │  Layer 3 · First-principles fallback                         │
   │           explicit "I haven't seen this before" mode         │
   ├──────────────────────────────────────────────────────────────┤
   │  Layer 4 · Outcome attribution                               │
   │           every patch is a hypothesis the system later checks│
   ├──────────────────────────────────────────────────────────────┤
   │  Layer 5 · Pattern library (query API)                       │
   │           "what does an 8/10 leaderboard look like?"         │
   ├──────────────────────────────────────────────────────────────┤
   │  Layer 6 · Composable predicates (audience × modality × …)   │
   │           long-tail coverage by composition                  │
   ├──────────────────────────────────────────────────────────────┤
   │  Layer 7 · Domain ethics gate                                │
   │           medical / kids / finance / legal hard floors       │
   ├──────────────────────────────────────────────────────────────┤
   │  Layer 8 · Modality adapters                                 │
   │           native mobile / terminal / voice — same framework  │
   └──────────────────────────────────────────────────────────────┘
```

Layer 9 from earlier sketches (Live IDE WebSocket) is **deprecated** — agents don't need it. Drev consumers can re-evaluate later.

---

## Layer 1 — Multi-dimensional scoring foundation

### ELI5
Stop returning one number. Return five numbers (product, visual, trust, workflow, content) plus a context-dependent rollup. Use different rollup weights for different page types so apps don't get judged like marketing sites.

### Why required
Every other layer reads from this layer's output. Without per-dim scores, patches can't target specific dimensions, attribution can't measure what moved, and the marketing-bias bug persists.

### Data shapes

```typescript
// src/design/audit/types.ts (additive)

export type Dimension = 'product_intent' | 'visual_craft' | 'trust_clarity' | 'workflow' | 'content_ia'

export interface DimensionScore {
  score: number         // 1-10 integer
  range: [number, number]   // self-reported uncertainty
  confidence: 'high' | 'medium' | 'low'
  summary: string       // one-sentence assessment
  primaryFindings: string[]   // ids of top 3 findings driving this score
}

export interface RollupScore {
  score: number
  range: [number, number]
  confidence: 'high' | 'medium' | 'low'
  rule: string          // human-readable formula, e.g. "saas-app: product*0.35 + workflow*0.30 + ..."
  weights: Record<Dimension, number>
}

export interface AuditResult_v2 {
  schemaVersion: 2
  classification: PageClassification & { ensembleConfidence: number, signalsAgreed: boolean }
  scores: Record<Dimension, DimensionScore>
  rollup: RollupScore
  findings: DesignFinding[]
  measurements: MeasurementBundle
  // ... existing fields ...
}
```

### Rollup weights per page type

```typescript
// src/design/audit/rubric/rollup-weights.ts (new)

export const ROLLUP_WEIGHTS: Record<PageType | 'default', Record<Dimension, number>> = {
  marketing:  { product_intent: 0.30, visual_craft: 0.30, content_ia: 0.25, trust_clarity: 0.10, workflow: 0.05 },
  'saas-app': { product_intent: 0.35, workflow: 0.30, visual_craft: 0.15, trust_clarity: 0.10, content_ia: 0.10 },
  dashboard:  { product_intent: 0.30, workflow: 0.30, content_ia: 0.20, visual_craft: 0.15, trust_clarity: 0.05 },
  docs:       { content_ia: 0.45, workflow: 0.25, product_intent: 0.15, visual_craft: 0.15, trust_clarity: 0.0 },
  ecommerce:  { trust_clarity: 0.35, product_intent: 0.30, workflow: 0.20, visual_craft: 0.10, content_ia: 0.05 },
  social:     { product_intent: 0.30, workflow: 0.30, content_ia: 0.20, visual_craft: 0.15, trust_clarity: 0.05 },
  tool:       { workflow: 0.40, product_intent: 0.30, content_ia: 0.15, visual_craft: 0.10, trust_clarity: 0.05 },
  blog:       { content_ia: 0.50, visual_craft: 0.25, product_intent: 0.15, workflow: 0.10, trust_clarity: 0.0 },
  utility:    { workflow: 0.45, product_intent: 0.25, content_ia: 0.20, visual_craft: 0.10, trust_clarity: 0.0 },
  unknown:    { product_intent: 0.30, workflow: 0.25, visual_craft: 0.20, content_ia: 0.15, trust_clarity: 0.10 },
  default:    { product_intent: 0.30, workflow: 0.25, visual_craft: 0.20, content_ia: 0.15, trust_clarity: 0.10 },
}
```

These weights are evolvable via GEPA target `pareto-rollup-weights`.

### Per-page-type calibration anchors

Replace `src/design/audit/rubric/fragments/universal-calibration.md` with **per-type anchor files** loaded by the rubric loader.

```
src/design/audit/rubric/anchors/
├── saas-app.yaml        # Linear's app, Figma file UI, Notion editor, Superhuman, GitHub
├── marketing.yaml       # Stripe, Linear, Vercel, Apple
├── dashboard.yaml       # Linear's app, Figma file UI, Datadog, Vercel dashboard
├── docs.yaml            # Stripe Docs, Tailwind Docs, MDN, Vercel Docs
├── ecommerce.yaml       # Apple Store, Shopify, Allbirds
├── social.yaml          # Threads (web), Bluesky web, Substack inline
├── tool.yaml            # Linear's command palette, GitHub PR view, Raycast
├── blog.yaml            # Stratechery, Substack, Notion blog templates
└── utility.yaml         # Vercel deployment status, Cloudflare dashboard, GitHub Actions
```

Each anchor file:

```yaml
# src/design/audit/rubric/anchors/saas-app.yaml
type: saas-app
score_9_10:
  criteria:
    - Domain object visible above the fold (tasks, deployments, conversations, files)
    - One visually-dominant primary action per page state
    - Empty states preview real product (sample rows, setup checklists, status timelines), not generic illustrations
    - Action hierarchy = product hierarchy; no decorative buttons competing with workflow
    - Trust details visible where commitment exists (price, permissions, undo, audit trail)
  fixtures:
    - fixture:linear-app
    - fixture:figma-file-ui
    - fixture:notion-editor
    - fixture:superhuman
    - fixture:github-pr-view
score_7_8:
  criteria:
    - Most criteria from 9-10 with one or two minor gaps
    - Polish gaps that don't block job completion
  fixtures:
    - fixture:airtable-grid
    - fixture:notion-database
score_5_6:
  criteria:
    - Functional but generic component-library assembly
    - No domain object above the fold OR action hierarchy unclear
    - Empty states show illustrations + platitudes
  fixtures:
    - fixture:generic-dashboard  (controlled fixture in bench/design/gepa/fixtures/)
score_3_4:
  criteria:
    - No primary job inferable from screen
    - Equal-weight CTAs blocking workflow
    - Decorative elements actively distract
  fixtures:
    - fixture:no-primary-action  (controlled fixture)
```

### Ensemble classifier

```typescript
// src/design/audit/classify-ensemble.ts (new)

export interface ClassifierSignal {
  source: 'url-pattern' | 'dom-heuristic' | 'llm'
  type: PageType
  confidence: number
  rationale: string
}

export interface EnsembleClassification extends PageClassification {
  signals: ClassifierSignal[]
  signalsAgreed: boolean
  ensembleConfidence: number   // 0..1
  dissent?: { source: ClassifierSignal['source']; type: PageType }[]
}

// URL pattern check
const URL_PATTERN_RULES = [
  { pattern: /\/(docs|reference|api|guide|help|faq)(\/|$)/, type: 'docs' as const, confidence: 0.85 },
  { pattern: /\/(checkout|cart|pay|order|billing)(\/|$)/, type: 'ecommerce' as const, confidence: 0.85 },
  { pattern: /\/(app|dashboard|workspace|admin)(\/|$)/, type: 'saas-app' as const, confidence: 0.75 },
  { pattern: /\/(login|signup|auth|sign-in)(\/|$)/, type: 'utility' as const, confidence: 0.85 },
  { pattern: /\/(pricing|plans|features|product)(\/|$)/, type: 'marketing' as const, confidence: 0.70 },
  { pattern: /\/(blog|articles|news|stories)(\/|$)/, type: 'blog' as const, confidence: 0.80 },
  { pattern: /\/$/, type: 'marketing' as const, confidence: 0.40 },   // weak default
]

// DOM heuristic check (fires after page load)
export interface DomHeuristics {
  formCount: number
  inputCount: number
  tableRowCount: number
  chartCount: number
  navItems: number
  hasFooterLinks: boolean
  hasHeroSection: boolean
  hasSidebar: boolean
  paragraphCount: number
  codeBlockCount: number
}

// Ensemble logic
//   if URL + DOM agree on type AND combined confidence > 0.7  → accept (skip LLM)
//   else                                                       → run LLM, vote 3-way
//   if LLM confidence < 0.5 AND signals disagree              → return 'unknown' with dissent
```

### Range scores

The LLM is required to commit to a range, not a point estimate. The range width is the auditor's stated uncertainty.

```
RESPOND WITH ONLY a JSON object:
{
  "scores": {
    "product_intent": { "score": 6, "range": [5, 7], "confidence": "medium", ... },
    ...
  },
  "rollup": { ... },
  "findings": [...],
  ...
}
```

### Files affected

**New:**
- `src/design/audit/classify-ensemble.ts` (~200 LOC)
- `src/design/audit/rubric/rollup-weights.ts` (~80 LOC)
- `src/design/audit/rubric/anchors/*.yaml` (9 files, ~50 LOC each)
- `src/design/audit/rubric/anchor-loader.ts` (~80 LOC)

**Modified:**
- `src/design/audit/types.ts` — add `Dimension`, `DimensionScore`, `RollupScore`, `AuditResult_v2`
- `src/design/audit/evaluate.ts` — new `buildEvalPrompt_v2`, parser for v2 output, `conservativeScore` becomes per-dim
- `src/design/audit/pipeline.ts` — call ensemble classifier; produce `AuditResult_v2`
- `src/design/audit/rubric/loader.ts` — `composeRubric` returns `{ ..., anchorFile: string }`
- `src/cli-design-audit.ts` — print per-dim breakdown in CLI summary
- `tests/design-audit-rubric.test.ts` + new `tests/design-audit-ensemble.test.ts` + `tests/design-audit-rollup.test.ts`

**Skill contract changes:**
- `~/code/dotfiles/claude/skills/bad/SKILL.md` — document new JSON shape with per-dim scores. Show a worked example of how an agent reads `result.scores.product_intent.score` to decide whether to invest in product or visual fixes.
- `skills/design-evolve/SKILL.md` — update Phase 2 (triage) to read per-dim scores instead of overall score.

### Acceptance criteria
- `pnpm test` green; new tests cover: ensemble agreement, ensemble dissent, range bounds enforcement, per-type rollup math, anchor file loading.
- Running `bad design-audit --url https://linear.app/method` returns `rollup.score >= 8` (Linear-app saas-app reference).
- Running on `bench/design/gepa/fixtures/no-primary-action.html` returns `scores.product_intent.score <= 4` AND `rollup.score <= 6`.
- `--audit-passes deep` defaults remain classification-aware; new `--audit-passes auto` (default) runs ensemble classifier first.
- `report.json` has `schemaVersion: 2`. Old `score` field present for backwards-compat with one-release lag.

### Effort
~22 hrs. Single PR. ~+1170 / -200 LOC.

### Risks
- **Backwards compatibility**: bad-app, design-evolve skill, and the rollup CLI all consume the current schema. Ship `schemaVersion: 2` alongside `schemaVersion: 1` for one release; deprecate v1 after consumers migrate.
- **Anchor authoring is opinionated.** Linear's app vs Figma vs Notion are all different at 9/10. The anchor file lists multiple references and criteria so the LLM can triangulate. Get a designer-tier review before merging.
- **Ensemble can be wrong.** If URL says `saas-app` but DOM says `marketing`, the page might be a hybrid (marketing site with a live demo). Mark `signalsAgreed: false`, return `unknown` if LLM can't break the tie. Don't pretend false confidence.

### Dependencies
None — Layer 1 is the foundation.

---

## Layer 2 — Patch primitives

### ELI5
Every finding becomes an applyable code patch with a unified diff, a test that proves it, an estimated score delta, and a rollback plan. Coding agents stop reading prose advice and start applying patches mechanically.

### Why required for agent-first
This is the layer that makes "designing apps a walk in the park." Without patches, agents have to translate prose findings into code changes — which is where they fabricate, drift, or stall. With patches, the agent's job is reduced to apply → re-audit → loop.

### Data shapes

```typescript
// src/design/audit/types.ts

export interface Patch {
  patchId: string                  // stable id derived from finding hash + target
  findingId: string                // links back to the DesignFinding it fixes
  scope: 'page' | 'section' | 'component' | 'system'
  target: PatchTarget
  diff: PatchDiff
  testThatProves: PatchTest
  rollback: { kind: 'git-revert' | 'css-disable' | 'manual'; instruction?: string }
  estimatedDelta: { dim: Dimension; delta: number }   // calibrated from fleet (Layer 4)
  estimatedDeltaConfidence: 'high' | 'medium' | 'low' | 'untested'
}

export interface PatchTarget {
  filePath?: string                 // when known via component scan
  componentName?: string            // 'Sidebar', 'PrimaryButton'
  cssSelector?: string              // fallback when filePath unknown
  scope: 'tsx' | 'css' | 'tailwind' | 'module-css' | 'styled-component' | 'structural'
}

export interface PatchDiff {
  before: string                    // exact substring the patch replaces
  after: string                     // replacement
  unifiedDiff?: string              // when filePath is known, full diff format
}

export interface PatchTest {
  kind: 'storybook' | 'a11y-rule' | 'visual-snapshot' | 'unit' | 'rerun-audit'
  description: string               // human-readable description of what proves the patch worked
  command?: string                  // optional CLI command an agent can invoke
}
```

### Mandatory patch enforcement

Currently `cssFix` is optional and often weak. After Layer 2 ships, **every finding with `severity: 'major' | 'critical'` MUST emit a `Patch[]` with at least one patch.** Findings without patches are downgraded to severity `minor` or rejected at parse-time.

Update the LLM prompt:

```
For every major/critical finding, you MUST produce a Patch with:
  - target.cssSelector OR target.componentName (one is required)
  - diff.before (the exact text being replaced) + diff.after (replacement)
  - testThatProves.description (what would prove this patch worked)
  - estimatedDelta.dim + estimatedDelta.delta (your prediction of which dimension moves)
  - rollback (if you cannot describe rollback, the patch is too risky — skip it)

If you cannot produce a patch for a major finding, downgrade it to minor severity
and explain why in the suggestion field.
```

### Files affected

**New:**
- `src/design/audit/patches/types.ts`
- `src/design/audit/patches/parse.ts` — parse Patch[] from LLM JSON
- `src/design/audit/patches/validate.ts` — schema validation, severity enforcement
- `src/design/audit/patches/render.ts` — render `unifiedDiff` from `before`/`after` + `filePath`

**Modified:**
- `src/design/audit/evaluate.ts` — prompt now requires Patch[]
- `src/types.ts` — `DesignFinding.patches: Patch[]` (replaces optional `cssFix` string)
- `src/cli-design-audit.ts` — Top Fixes section in `report.md` shows patch unified-diffs

**Skill contract changes:**
- `~/code/dotfiles/claude/skills/bad/SKILL.md` — patch consumption pattern: "Read `result.findings[*].patches[*]`. For each patch, apply the diff via your file-edit tool, run `result.findings[*].patches[*].testThatProves.command`, then re-run `bad design-audit` to verify."
- `skills/design-evolve/SKILL.md` — Phase 3 (apply fixes) becomes "iterate over `topFixes[*].patches[*]`, apply each, run testThatProves, re-audit."

### Acceptance criteria
- Every major/critical finding in a fresh audit run has ≥1 patch.
- `result.findings[*].patches[*].diff.before` is a substring present in the page (verifiable via a regex on `state.snapshot`).
- `pnpm tsx bench/design/gepa/run.ts --target patch-quality --population 4` runs to completion (Layer 4 will measure quality; Layer 2 just requires they exist).
- A coding agent can apply patches via `git apply` (when `unifiedDiff` is present) OR via search-replace (when only `before`/`after` are present) without manual translation.

### Effort
~16 hrs. ~+600 / -100 LOC.

### Risks
- **Patch quality varies wildly without grounding.** The LLM can produce technically-valid patches that are pointless ("change padding from 16px to 17px"). Mitigation: add `prediction-vs-outcome` metric to GEPA's scorecard once Layer 4 is shipped — patches whose actual delta doesn't match estimated delta get downweighted.
- **`diff.before` may not match the page.** The LLM hallucinates substrings that aren't actually there. Mitigation: validate with a regex over `state.snapshot` at parse time; reject patches whose `before` isn't found.
- **Patches require knowing the component/file.** Without static analysis of the source code, the auditor can't always name the right file. Layer 2 v1 ships with `cssSelector` as the primary target; component scan integration deferred to v1.1.

### Dependencies
- Layer 1 (per-dim scores) — patches reference which dimension they're estimated to move.

---

## Layer 3 — First-principles fallback

### ELI5
When the auditor doesn't recognize a page, it doesn't pretend. It says "I haven't seen this pattern before" and falls back to universal product principles (clarity of purpose, primary action, trust before commitment). The agent gets honest signal, not a marketing-flavored 5/10.

### Why required for agent-first
Agents fail silently when the auditor returns mush. If the auditor admits uncertainty, the agent can decide to retry with more context, escalate to a human, or commit anyway. Today the auditor returns a confidently-bad 5/10 and the agent acts on bad signal.

### Trigger conditions

First-principles mode fires when ANY of:
- `ensembleClassification.ensembleConfidence < 0.6`
- `ensembleClassification.signalsAgreed === false`
- No fixture in any anchor file matches the page's structure within similarity threshold (Layer 5 dependency — until Layer 5 ships, use signals-agreed only)
- LLM explicitly emits `"first_principles_mode": true` in classification output

### What the auditor does in first-principles mode

```
You haven't seen this pattern before. Do not fabricate a classification.
Audit against the universal product principles only:

1. PRIMARY JOB CLARITY (5 sec test)
   - Within 5 seconds, can a stranger name what this page is for?
   - If no: severity major; finding category 'product_intent'.

2. PRIMARY ACTION OBVIOUSNESS
   - Is there one visually-dominant action this page is built around?
   - Are competing actions visually subordinate?
   - If equal-weight: severity major; finding category 'product_intent'.

3. STATE PREVIEW
   - Are empty/loading/error states designed, or browser-default / placeholder?
   - Do empty states preview the real product, or show generic illustrations?
   - If generic: severity major; finding category 'product_intent'.

4. TRUST BEFORE COMMITMENT
   - Does the page ask the user to commit (money, identity, deploy, share)?
   - If yes: are price, permissions, scope, undo path visible BEFORE the commit button?
   - If no: severity critical; finding category 'trust_clarity'.

5. RECOVERY FROM FAILURE
   - Can the user undo their last action?
   - Is there a clear path forward when something fails?
   - If no: severity major; finding category 'workflow'.

Score per-dimension as usual. Set rollup.confidence = 'low'.
Add a top-level "novel_pattern_signal" with what you observed, so this can be
mined into a new fragment after enough fleet exposure.
```

### Files affected

**New:**
- `src/design/audit/rubric/fragments/first-principles.md` — the universal-principles checklist
- `src/design/audit/first-principles-mode.ts` — trigger logic + queue writer

**Modified:**
- `src/design/audit/evaluate.ts` — when first-principles mode triggers, swap the prompt
- `src/design/audit/pipeline.ts` — write novel-pattern observations to `~/.bad/novel-patterns/<date>.jsonl` for fleet mining
- `src/telemetry/schema.ts` — add `kind: 'novel-pattern-observed'`

**Skill contract changes:**
- `skills/bad` SKILL.md — agents that see `rollup.confidence === 'low'` AND `firstPrinciplesMode === true` should treat findings as advisory, not authoritative; should consider re-running with `--rubric-hint <type>` if they have a strong prior.

### Acceptance criteria
- An entirely synthetic page type (e.g. a Storybook story for a custom toolbar) triggers first-principles mode and returns a non-marketing-flavored set of findings.
- Confidence is correctly reported as `'low'`.
- Novel-pattern observations are queued for fleet mining.
- Existing fixtures (`no-primary-action`, `generic-dashboard`, etc.) STILL classify correctly and don't trigger first-principles.

### Effort
~8 hrs. ~+400 LOC, mostly fragment + prompt + queue writer.

### Risks
- **Over-triggering = useless audits for everyone.** If first-principles mode fires too often, every audit looks like a generic checklist. Tune the trigger threshold via GEPA target `first-principles-trigger-threshold`.
- **The first-principles prompt can become its own slop generator.** The 5 universal principles must stay tight. Don't expand to 20.

### Dependencies
- Layer 1 (ensemble classifier provides the confidence signal)

---

## Layer 4 — Outcome attribution

### ELI5
Every patch the auditor proposes is a hypothesis. The next audit (after the patch is applied) is the experiment. Log the predicted delta vs the actual delta. After enough applications, every patch has a *reliability score* — and the auditor's prediction model self-calibrates.

### Why required for agent-first
Without attribution, agents apply patches blindly and the system never improves. With attribution:
- The auditor's score-delta predictions become measurable; bad predictors get retuned
- Patches with poor reliability get downweighted in `topFixes` ROI ranking
- Cross-tenant pattern emergence ("47 leaderboards converged on layout X") becomes possible (Layer 5)
- Calibration drift is detectable: if all `saas-app` audits start scoring 4-5, the rubric drifted

### Data shapes

```typescript
// src/design/audit/attribution/types.ts (new)

export interface PatchApplication {
  applicationId: string
  patchId: string
  appliedAt: string                 // ISO 8601
  appliedBy: 'agent:claude-code' | 'agent:codex' | 'agent:opencode' | 'human' | 'css-injection' | string
  preAuditRunId: string             // the audit run that produced the patch
  postAuditRunId?: string           // the audit run after the patch was applied (may be null if not yet re-audited)
  predicted: { dim: Dimension; delta: number }
  observed?: { dim: Dimension; delta: number }   // populated when post-audit lands
  agreementScore?: number           // (predicted - observed) / max(|predicted|, |observed|, 1)
}

export interface PatchReliability {
  patchHash: string                 // hash of the patch's diff + target — same patch across tenants
  applications: number              // total times this patch was applied
  meanPredictedDelta: number
  meanObservedDelta: number
  replicationRate: number           // % of applications where observed >= 0.5 * predicted
  recommendation: 'recommended' | 'neutral' | 'antipattern'
}
```

### Storage

Telemetry envelopes already carry per-page audit results. Add two new envelope kinds:

- `kind: 'patch-applied'` — emitted when a coding agent reports back via the bad CLI's new `bad design-audit ack-patch <patchId>` command
- `kind: 'patch-outcome'` — auto-emitted when a re-audit happens within 24 hours of a `patch-applied`, computing the observed delta

The fleet rollup CLI gets a `--patch-reliability` mode that aggregates by `patchHash` across tenants.

### Bad CLI surface

```bash
# Coding agent invokes after applying a patch
bad design-audit ack-patch <patchId> --pre-run-id <runId>

# Re-audit (auto-detects there was a recent ack-patch)
bad design-audit --url <url> --post-patch <patchId>

# Operator queries
bad telemetry rollup --patch-reliability
```

### Files affected

**New:**
- `src/design/audit/attribution/types.ts`
- `src/design/audit/attribution/store.ts` — JSONL append for applications/outcomes
- `src/design/audit/attribution/aggregate.ts` — patchHash rollup
- `src/cli-ack-patch.ts` — `bad design-audit ack-patch` subcommand
- `bench/telemetry/rollup-patch-reliability.ts` — reliability rollup

**Modified:**
- `src/cli-design-audit.ts` — when invoked with `--post-patch <id>`, link to prior run, compute observed delta, emit `kind: 'patch-outcome'` envelope
- `src/telemetry/schema.ts` — add `'patch-applied'`, `'patch-outcome'` to `TelemetryKind`

**Skill contract changes:**
- `skills/bad` SKILL.md — close-the-loop pattern: "After applying a patch, run `bad design-audit ack-patch <patchId>`. Then re-audit with `bad design-audit --post-patch <patchId>` so the system learns whether your fix actually moved the score."
- `skills/design-evolve` SKILL.md — Phase 4 (re-audit) updated to use `--post-patch` for attribution.

### Acceptance criteria
- A coding agent applying a patch and re-auditing produces a complete attribution record (predicted, observed, agreementScore).
- Running 10 synthetic pre/post pairs produces a `PatchReliability` rollup with non-trivial replication rates.
- Telemetry rollup CLI surfaces patches whose `replicationRate < 0.3` for review.
- Auditor's prediction calibration is queryable: `pnpm telemetry:rollup --calibration` returns predicted-vs-observed Pearson correlation per dimension.

### Effort
~14 hrs. ~+700 LOC.

### Risks
- **Sparse data.** Per-patch reliability needs N≥30 to be meaningful. For the first 6 weeks the reliability scores are noise. Surface "untested" as a first-class status until N is reached.
- **Re-audit rate drift.** If agents apply patches but don't re-audit, attribution silently fails. Mitigation: skill instructions are explicit; bad CLI prints a warning if a recent `ack-patch` has no `post-patch` audit within 24 hours.
- **Tenant-private patches.** A patch tied to a specific component name in tenant A's codebase may not be directly comparable to tenant B's. Use `patchHash = hash(diff.before, diff.after, scope)` rather than `target.filePath`.

### Dependencies
- Layer 2 (patches must exist)
- Telemetry shipped (already done in 0.30.0)

---

## Layer 5 — Pattern library (query API)

### ELI5
After enough applied-and-measured patches accumulate, the system mines them into named "patterns" — known-good design solutions for specific surfaces. The auditor cites them: "Your leaderboard scored product_intent=4. Pattern `linear-tier-leaderboard` scored 8 in 47 fleet applications. Here's the diff to get there."

### Why required for agent-first
This is what makes "auto-evolve quality" actually evolutionary. Without a pattern library, every audit is a fresh proposal. With one, the system *cites prior wins* — and the auditor's recommendations have an N attached.

### Data shapes

```typescript
// src/design/audit/patterns/types.ts (new)

export interface Pattern {
  patternId: string                 // 'pattern:leaderboard:linear-tier'
  category: string                  // 'leaderboard', 'empty-state', 'pricing-table', etc.
  classification: { type: PageType; tags: string[] }
  scaffold: {
    description: string
    referenceTsx?: string
    referenceCss?: string
    keyDecisions: string[]          // 'comparison metric in header', 'criterion expanded on hover'
  }
  scores: { whenFollowed: Record<Dimension, number> }
  fleetEvidence: {
    applications: number
    successRate: number             // % where adopting this pattern delivered the predicted dim delta
    medianDimDelta: Record<Dimension, number>
    sampleTenants: number           // distinct tenants
  }
  fixtures: string[]                // fixture ids that exemplify this pattern
}

export interface PatternQuery {
  category?: string
  pageType?: PageType
  weakDimension?: Dimension         // "I'm scoring 4 on product_intent — show me patterns that lift it"
  minApplications?: number          // minimum N to be considered (default 5)
  minSuccessRate?: number           // default 0.5
}

export interface PatternMatch {
  pattern: Pattern
  matchConfidence: number
  expectedDelta: Record<Dimension, number>
  applicationGuidance: string       // how to adapt this pattern to the current page
}
```

### Mining rule

Patterns are mined from accumulated `PatchApplication[]` once a cluster meets:
- N ≥ 30 applications across ≥ 5 distinct tenants
- replicationRate ≥ 0.7
- patches share structural similarity (same scope, similar `target.componentName` or `target.cssSelector` patterns)

Mining runs as a periodic job: `pnpm patterns:mine` (Cloudflare Worker cron in production).

### Bad CLI surface

```bash
# Auditor automatically cites matching patterns in findings
bad design-audit --url ... --include-patterns

# Agent queries directly
bad patterns query --category leaderboard --weak-dimension product_intent
bad patterns show pattern:leaderboard:linear-tier
```

### Files affected

**New:**
- `src/design/audit/patterns/types.ts`
- `src/design/audit/patterns/store.ts` — JSONL or D1-backed
- `src/design/audit/patterns/mine.ts` — clustering algorithm
- `src/design/audit/patterns/match.ts` — fuzzy match a page against catalogued patterns
- `src/cli-patterns.ts` — `bad patterns query|show|mine` subcommands

**Modified:**
- `src/design/audit/evaluate.ts` — when patterns are included, the LLM prompt gets a "matching patterns" appendix
- `src/types.ts` — `DesignFinding.matchedPatterns?: PatternMatch[]`

**Skill contract changes:**
- `skills/bad` SKILL.md — pattern query surface; agent example showing query → adapt → apply.

### Acceptance criteria
- A synthetic dataset of 30 applications converging on the same patch shape mines into a Pattern with `successRate >= 0.7`.
- `bad patterns query --category leaderboard` returns at least one Pattern after the dataset is loaded.
- An audit run on a page matching a known pattern includes `matchedPatterns` in at least one finding.

### Effort
~24 hrs (clustering + mining + matching is real work). ~+1100 LOC.

### Risks
- **Cold-start.** First 6+ weeks of fleet operation, the pattern library is empty. Layer 5 is valuable only after Layer 4 has accumulated data.
- **False patterns.** A coincidental cluster can mine into a "pattern" that's actually noise. Require ≥5 distinct tenants and ≥0.7 replication rate; flag low-N patterns explicitly.
- **Pattern overfit.** Once patterns exist, the system might over-recommend them, producing homogeneous output. Mitigation: ensure `pareto-rollup-weights` GEPA target measures pattern-recommendation prevalence and dampens it if it gets too high.

### Dependencies
- Layer 4 (attribution data is the input)
- Telemetry collector deployed (Layer 5 mining runs as a Worker on the collected data)

---

## Layer 6 — Composable predicates

### ELI5
Today rubric fragments match by `type / domain / maturity / designSystem / universal`. Add three more predicate dimensions: `audience`, `modality`, `regulatoryContext`. A pediatric medical app on tablet for clinicians loads `type-saas-app + domain-medical + audience-clinician + modality-tablet + regulatory-hipaa` simultaneously. The framework doesn't need a custom mode — it composes.

### Why required for agent-first
Long-tail surfaces are the majority of real apps. Without composability, every new domain needs a new fragment from scratch. With composability, agents can hint at any dimension (`--audience kids`, `--regulatory hipaa`) and the right fragments load automatically.

### Data shapes

```typescript
// src/design/audit/types.ts (additive)

export interface AppliesWhen {
  type?: PageType[]
  domain?: string[]
  maturity?: Maturity[]
  designSystem?: DesignSystemTag[]
  universal?: boolean

  // NEW
  audience?: ('developer' | 'clinician' | 'analyst' | 'consumer' | 'admin' | 'kids' | 'enterprise-buyer' | 'creator')[]
  modality?: ('desktop' | 'tablet' | 'mobile' | 'tv' | 'kiosk')[]
  regulatoryContext?: ('hipaa' | 'gdpr' | 'sox' | 'pci-dss' | 'coppa' | 'wcag-aaa')[]
  audienceVulnerability?: ('patient-facing' | 'minor-facing' | 'high-stakes-financial' | 'crisis-context')[]
}
```

The rubric loader's `fragmentApplies` function gets matching logic for each new dimension. Operators can hint via CLI:

```bash
bad design-audit --url ... --audience clinician --regulatory hipaa --modality tablet
```

When hints aren't provided, the classifier infers (e.g. detecting medical terminology in copy → `domain-medical`).

### Files affected

**Modified:**
- `src/design/audit/types.ts` — extend `AppliesWhen`
- `src/design/audit/rubric/loader.ts` — predicate matching for new dims
- `src/design/audit/classify.ts` — infer audience / regulatoryContext from page content
- `src/cli-design-audit.ts` — accept `--audience`, `--regulatory`, `--modality` hints

**New (initial fragment seeding):**
- `src/design/audit/rubric/fragments/audience-clinician.md`
- `src/design/audit/rubric/fragments/audience-kids.md`
- `src/design/audit/rubric/fragments/audience-developer.md`
- `src/design/audit/rubric/fragments/regulatory-hipaa.md`
- `src/design/audit/rubric/fragments/regulatory-gdpr.md`
- `src/design/audit/rubric/fragments/regulatory-coppa.md`
- `src/design/audit/rubric/fragments/modality-mobile.md`
- `src/design/audit/rubric/fragments/modality-tablet.md`
- `src/design/audit/rubric/fragments/audience-vulnerability-minor-facing.md`

**Skill contract changes:**
- `skills/bad` SKILL.md — document hint flags. Show worked example: medical app audit invocation.

### Acceptance criteria
- A page with regulatory copy in <head> tags is auto-classified with `regulatoryContext: ['hipaa']` (no flag needed).
- `--audience kids` loads `audience-kids` + `audience-vulnerability-minor-facing` fragments.
- Composing 5 predicate dims simultaneously produces a coherent rubric without redundant findings.

### Effort
~12 hrs. ~+600 LOC (mostly markdown fragments).

### Risks
- **Predicate explosion.** N dimensions × M values each = combinatorially many possible compositions, most unhit. Don't pre-author every possible combination; ship the high-value 9 fragments listed above and let GEPA + fleet mining surface the rest.
- **Hint vs inference conflict.** If operator passes `--audience kids` but classifier infers `audience: enterprise-buyer`, the hint wins but a warning surfaces. Don't silently override.

### Dependencies
- Layer 1 (rubric loader is already there; this layer extends predicate set)

---

## Layer 7 — Domain ethics gate

### ELI5
Some findings aren't aesthetics — they're legal / safety / ethical hard requirements. A medical app missing dosage warnings is a critical bug regardless of polish. A kids' app with dark patterns is critical regardless of trust score. These get a **floor** on overall score until fixed.

### Why required for agent-first
Without an ethics gate, agents optimize toward score and can ship features that are pretty but harmful. With it, certain finding categories are non-overridable: regardless of polish, regardless of patches, the overall score has a hard ceiling until the ethics finding is resolved.

### Data shapes

```typescript
// src/design/audit/ethics/types.ts (new)

export interface EthicsRule {
  ruleId: string                    // 'medical:dosage-warning-required'
  category: 'medical' | 'kids' | 'finance' | 'legal' | 'accessibility' | 'crisis'
  severity: 'critical-floor' | 'major-floor'   // critical-floor caps rollup at 4; major-floor caps at 6
  appliesWhen: AppliesWhen          // composable predicate
  detector: {
    kind: 'pattern-absent' | 'pattern-present' | 'llm-classifier'
    pattern?: string                // for pattern-* kinds, regex or text token
    llmCheck?: string               // for llm-classifier kind, the question to ask the model
  }
  remediation: string               // what fixes it
  citation?: string                 // FDA / GDPR / COPPA section etc.
}

export interface EthicsViolation {
  ruleId: string
  detected: true
  severity: 'critical-floor' | 'major-floor'
  rollupCap: number                 // 4 or 6
  remediation: string
}
```

### Initial rule seed

```yaml
# src/design/audit/ethics/rules/medical.yaml
- ruleId: medical:dosage-warning-required
  category: medical
  severity: critical-floor
  appliesWhen:
    domain: [medical, clinical, pharmacy]
  detector:
    kind: pattern-absent
    pattern: '(dosage|warning|contraindication|adverse|side effect)'
  remediation: Display dosage warnings, contraindications, and adverse-effect summaries before any prescription action.
  citation: FDA 21 CFR 201.57

# src/design/audit/ethics/rules/kids.yaml
- ruleId: kids:dark-patterns-prohibited
  category: kids
  severity: critical-floor
  appliesWhen:
    audience: [kids]
  detector:
    kind: llm-classifier
    llmCheck: Does this page use any dark pattern (hidden costs, forced action, fake urgency, confirmshaming, manipulated visual hierarchy) targeting a minor user?
  remediation: Remove all dark patterns. Use clear, age-appropriate, friction-symmetric flows.
  citation: COPPA 16 CFR 312.5

- ruleId: kids:age-gate-required
  category: kids
  severity: critical-floor
  appliesWhen:
    audience: [kids]
    audienceVulnerability: [minor-facing]
  detector:
    kind: pattern-absent
    pattern: '(age|date of birth|verify your age)'
  remediation: Implement an age gate before collecting any data or showing user-generated content.
  citation: COPPA 16 CFR 312.5

# src/design/audit/ethics/rules/finance.yaml
- ruleId: finance:fees-disclosed-pre-commitment
  category: finance
  severity: critical-floor
  appliesWhen:
    type: [ecommerce]
    domain: [fintech, finance, banking, payments]
  detector:
    kind: llm-classifier
    llmCheck: Are all fees, taxes, and charges disclosed BEFORE the commit/pay button is reachable?
  remediation: Surface every line item (fees, taxes, FX) above the pay button.

# src/design/audit/ethics/rules/legal.yaml
- ruleId: legal:gdpr-cookie-consent
  category: legal
  severity: major-floor
  appliesWhen:
    regulatoryContext: [gdpr]
  detector:
    kind: pattern-absent
    pattern: '(cookie|consent|necessary|preferences)'
  remediation: Display GDPR-compliant cookie consent banner with granular controls.
```

### Files affected

**New:**
- `src/design/audit/ethics/types.ts`
- `src/design/audit/ethics/loader.ts` — load all rules from `rules/*.yaml`
- `src/design/audit/ethics/check.ts` — apply rules against page state, return `EthicsViolation[]`
- `src/design/audit/ethics/rules/medical.yaml`
- `src/design/audit/ethics/rules/kids.yaml`
- `src/design/audit/ethics/rules/finance.yaml`
- `src/design/audit/ethics/rules/legal.yaml`

**Modified:**
- `src/design/audit/pipeline.ts` — run ethics check after rubric scoring; apply `rollupCap` to `result.rollup.score`
- `src/types.ts` — `AuditResult_v2.ethicsViolations: EthicsViolation[]`

**Skill contract changes:**
- `skills/bad` SKILL.md — document the floor concept: "If `result.ethicsViolations.length > 0`, the rollup score is capped. Patches that don't address ethics violations cannot lift the rollup above the cap. Address ethics violations FIRST."

### Acceptance criteria
- A medical app fixture missing dosage warnings returns `ethicsViolations: [{ ruleId: 'medical:dosage-warning-required', rollupCap: 4 }]` and `rollup.score <= 4` regardless of other scores.
- A kids' app with `audience: [kids]` and a hidden-fees pattern returns 2 ethics violations (dark-pattern + missing age gate if applicable).
- Operators can override (with explicit `--skip-ethics` flag, audited and logged) for testing scenarios.

### Effort
~14 hrs. ~+800 LOC (mostly YAML rules + their tests).

### Risks
- **Over-strict ethics rules block legit pages.** A "patient-facing" page that's intentionally a marketing landing for a clinical product might trip dosage warnings rule even though it's not a prescription page. Use `appliesWhen` predicates tightly. Add `--ethics-rule-allowlist` per tenant if needed.
- **Cultural / jurisdictional variance.** What's "appropriate for kids" varies by jurisdiction. Make ethics rules tenant-configurable; ship sensible defaults, allow override.
- **Rule maintenance burden.** Regulatory text changes; rules can go stale. Add `citation` field to every rule and queue a periodic review job.

### Dependencies
- Layer 6 (composable predicates — ethics rules use the same `appliesWhen` shape)

---

## Layer 8 — Modality adapters

### ELI5
Today the auditor only handles HTML+CSS. Native iOS, native Android, terminal apps, voice apps all use the same scoring framework — but with a different evidence layer. The framework is modality-independent; only the measurement adapter changes per modality.

### Why required for agent-first
Coding agents work across many modalities (Apple's xcode bridge, Android Studio, terminal app builders, voice agent SDKs). One scoring framework that covers all of them is leverage. Without modality adapters, every team builds its own lite version of bad CLI for their stack.

### Architecture

```
                Evidence layer (per modality)
   ┌─────────────────────────────────────────────────┐
   │  HTML+CSS adapter      Playwright + axe + DOM   │ (current, complete)
   │  iOS adapter           XCUITest + ax-tree       │ (Layer 8 target)
   │  Android adapter       UI Automator + ax-tree   │ (Layer 8 target)
   │  Terminal adapter      ANSI capture + text-bbox │ (deferred)
   │  Voice adapter         Transcript + turn-count  │ (deferred)
   └─────────────────────────────────────────────────┘
                          │
                          ▼
   ┌─────────────────────────────────────────────────┐
   │  Unified Evidence record                        │
   │   { measurements, surfaces[], snapshot, screenshot } │
   └─────────────────────────────────────────────────┘
                          │
                          ▼
              [Layers 1–7 — unchanged]
                          │
                          ▼
                  AuditResult_v2
```

### Adapter interface

```typescript
// src/design/audit/modality/types.ts (new)

export interface ModalityAdapter {
  modality: 'html' | 'ios' | 'android' | 'terminal' | 'voice'
  capture(input: ModalityInput): Promise<Evidence>
}

export interface Evidence {
  modality: ModalityAdapter['modality']
  surfaces: SurfaceRecord[]         // multiple surfaces if a multi-screen flow
  measurements: MeasurementBundle   // a11y, contrast (modality-specific)
  snapshot: string                   // text representation
  screenshot?: string               // base64 or URL
}

export interface SurfaceRecord {
  identifier: string                // URL for HTML; screen name for native; turn for voice
  measurements: SurfaceMeasurements
  snapshot: string
  screenshot?: string
}
```

### Files affected

**New:**
- `src/design/audit/modality/types.ts`
- `src/design/audit/modality/html.ts` — refactor existing pipeline into the adapter shape
- `src/design/audit/modality/ios.ts` — XCUITest bridge
- `src/design/audit/modality/android.ts` — UI Automator bridge
- `src/cli-design-audit.ts` — `--modality ios|android` flag dispatches to the right adapter

**Modified:**
- `src/design/audit/pipeline.ts` — input is `Evidence`, not `state`; works modality-independent
- `src/design/audit/measure/index.ts` — modality-specific contrast/a11y plug-ins

**Skill contract changes:**
- New `skills/bad-mobile` SKILL.md documenting native mobile audit invocation

### Acceptance criteria
- A native iOS app launched via XCUITest produces an `Evidence` record that flows through the existing pipeline and produces an `AuditResult_v2`.
- Android equivalent.
- Modality-specific findings (e.g. iOS missing voiceover labels) are properly categorized.

### Effort
~30 hrs. ~+1500 LOC (significant infrastructure).

### Risks
- **Native mobile is its own world.** XCUITest setup, simulator management, build artifacts — large operational surface. Defer Android until iOS proves the abstraction.
- **The HTML pipeline isn't actually modality-independent today.** Some logic is web-specific (cookie banners, viewport handling). Refactoring exposes that. Allocate refactor budget on top of new-adapter budget.

### Dependencies
- Layers 1–4 (all of them — Layer 8 plugs into the existing scoring framework, not the other way around).

---

## Sequencing across releases

| Release | Layers | Status to ship | Effort | Outcome |
|---|---|---|---|---|
| **0.31** | 1, 2, 3 | Foundation + patches + first-principles fallback | ~46 hrs | Marketing-bias bug fixed, agents apply patches mechanically, novel patterns recognized |
| **0.32** | 4 | Outcome attribution | ~14 hrs | Closed loop grounded; auditor self-calibrates; patches earn or lose reliability |
| **0.33** | 5, 6 | Pattern library + composable predicates | ~36 hrs | Auditor cites fleet evidence; long-tail covered by composition |
| **0.34** | 7 | Ethics gate | ~14 hrs | Hard floors for medical / kids / finance / legal |
| **0.35+** | 8 | Modality adapters | ~30 hrs | Native mobile, terminal, voice |

Each release is independently shippable, in-week deployable. Cumulative ~140 hrs.

---

## Skill contract — every agent's source of truth

The bad CLI's contract with agents lives in `~/code/dotfiles/claude/skills/bad/SKILL.md` and is symlinked to Claude / Codex / OpenCode / Pi via `install.sh`. Every layer above ships **a coordinated SKILL.md update** that:

1. Documents the new JSON shape (with worked examples)
2. Documents the new CLI flags
3. Provides a code snippet showing the agent's consumption pattern
4. Explicitly names what changed vs. the prior contract

Without this, agents drift away from the new capabilities. The skill is part of the contract, not documentation.

---

## Success metrics

Measurable per-release acceptance, beyond unit tests.

### 0.31
- **Calibration honesty.** Linear's app scores `rollup.score >= 8`. Same against Linear's marketing page. Same against `bench/design/gepa/fixtures/no-primary-action.html` scores `<= 5`.
- **Patch density.** ≥90% of major/critical findings emit a Patch.
- **First-principles trigger rate.** Across the existing fixture set, first-principles fires on ≥10% of audits (proves it works without over-firing).
- **No regressions.** Per-fixture mean rollup score is within ±1.0 of pre-0.31.

### 0.32
- **Attribution coverage.** ≥70% of patches applied via `--evolve` produce a complete attribution record (predicted + observed + agreement) within 24 hours.
- **Auditor calibration.** Predicted-vs-observed Pearson correlation per dimension ≥0.5 after 50 patches.

### 0.33
- **Pattern emergence.** ≥10 patterns mined from the first 6 weeks of attribution data.
- **Pattern adoption rate.** ≥30% of audits cite at least one matching pattern.
- **Composability use.** ≥1 audit run per week uses ≥3 simultaneously-loaded predicate fragments.

### 0.34
- **Ethics rule reliability.** Each rule has ≥1 fixture passing AND ≥1 fixture failing. Rule false-positive rate <5% on production audits.

### 0.35+
- **Modality coverage.** iOS adapter produces a coherent audit on ≥3 real iOS apps with `rollup.confidence >= medium`.

---

## Open questions

These need product decisions before later layers ship.

1. **Attribution storage.** Layer 4's data lands where? The bad-app R2 collector handles envelopes; patch reliability rollup needs cross-tenant aggregation. D1 vs warehouse?
2. **Pattern licensing.** Layer 5 mines patterns from real applied patches. Each tenant's patches are their IP. Anonymization sufficient? Per-tenant opt-out for pattern contributions?
3. **Ethics rule jurisdiction.** Layer 7 ships sensible defaults but cultural / regulatory variance is huge. Per-tenant overrides? Default to most-restrictive (US + EU + UK)?
4. **Modality priority.** Layer 8 — iOS first, or Android first, or native parity? Voice next or terminal next?
5. **Skill installation.** Pi gets a skill subset today (`reflect`, `capture-decisions`, `research`). Does Pi need the bad skill too once mobile-modality lands?

---

## Risks summary

| Risk | Layer | Mitigation |
|---|---|---|
| Backwards compat (schema v1 → v2) | 1 | Ship both schemas for 1 release; deprecate v1 with warning |
| Patch quality drift | 2 | Layer 4 measures it; GEPA retunes |
| First-principles slop | 3 | Tight 5-principle prompt; GEPA target `first-principles-trigger-threshold` |
| Sparse attribution data | 4 | "Untested" status; warn on missing post-audit |
| Pattern overfit | 5 | Pareto weights downweight pattern prevalence in GEPA target |
| Predicate explosion | 6 | Ship 9 high-value fragments; let fleet mining surface more |
| Ethics false positives | 7 | Per-tenant allowlist; tight `appliesWhen` predicates |
| Modality refactor exposing web-specific logic | 8 | Allocate refactor budget; ship iOS only first |

---

## Appendix A: file map

Senior eng picking up a layer can find the entry point here.

```
src/design/audit/
├── classify.ts                          # existing single-LLM classifier
├── classify-ensemble.ts                 # Layer 1 (NEW)
├── evaluate.ts                          # extended every layer
├── pipeline.ts                          # extended every layer
├── types.ts                             # extended every layer
│
├── attribution/                         # Layer 4 (NEW)
│   ├── types.ts
│   ├── store.ts
│   └── aggregate.ts
│
├── ethics/                              # Layer 7 (NEW)
│   ├── types.ts
│   ├── loader.ts
│   ├── check.ts
│   └── rules/
│       ├── medical.yaml
│       ├── kids.yaml
│       ├── finance.yaml
│       └── legal.yaml
│
├── first-principles-mode.ts             # Layer 3 (NEW)
│
├── modality/                            # Layer 8 (NEW)
│   ├── types.ts
│   ├── html.ts                          # refactored from pipeline.ts
│   ├── ios.ts
│   └── android.ts
│
├── patches/                             # Layer 2 (NEW)
│   ├── types.ts
│   ├── parse.ts
│   ├── validate.ts
│   └── render.ts
│
├── patterns/                            # Layer 5 (NEW)
│   ├── types.ts
│   ├── store.ts
│   ├── mine.ts
│   └── match.ts
│
└── rubric/
    ├── loader.ts                        # extended Layer 6
    ├── rollup-weights.ts                # Layer 1 (NEW)
    ├── anchor-loader.ts                 # Layer 1 (NEW)
    ├── anchors/                         # Layer 1 (NEW)
    │   └── *.yaml
    └── fragments/
        ├── first-principles.md          # Layer 3
        ├── audience-*.md                # Layer 6 (9 files)
        ├── modality-*.md                # Layer 6 (3 files)
        └── regulatory-*.md              # Layer 6 (3 files)

src/cli-design-audit.ts                  # extended every layer
src/cli-ack-patch.ts                     # Layer 4 (NEW)
src/cli-patterns.ts                      # Layer 5 (NEW)

bench/design/gepa/                       # GEPA targets per layer
└── targets.ts                           # extended each layer with new tunable knobs

bench/telemetry/
└── rollup-patch-reliability.ts          # Layer 4 (NEW)

skills/bad/SKILL.md                      # primary agent contract — extended every layer
skills/design-evolve/SKILL.md            # closed-loop skill — extended Layers 2 + 4
skills/bad-mobile/SKILL.md               # Layer 8 (NEW)
```

---

## Appendix B: how to pick this up

A senior eng joining mid-stream:

1. Read this RFC end-to-end.
2. Pick the lowest-numbered layer not yet shipped (`bad design-audit --version` reveals current layer).
3. Read that layer's section in full: ELI5 → data shapes → files → acceptance.
4. Open a feature branch named `feat/design-audit-layer-N-<short-name>` off main.
5. Land the data shapes first (interfaces only, no impl). Run `pnpm typecheck` green.
6. Land the impl. Run new + existing tests green.
7. Update the skill contract files listed under "Skill contract changes" — this is mandatory, not optional.
8. Add a migration note to `CHANGELOG.md` (changeset).
9. Open a PR. Title format: `feat(design-audit): Layer N — <short-name>`.
10. Verify the layer's "Acceptance criteria" before merging.
11. Update the ops board task associated with that layer to DONE with PR URL.

If a layer is in flight (someone else's branch exists), pick the next one. Don't fork.

---

## Appendix C: relationship to existing infrastructure

This RFC builds on:

- **GEPA harness** (`bench/design/gepa/`) — already shipped. New tunable targets per layer are added to `targets.ts`.
- **Telemetry envelopes** (`src/telemetry/`) — already shipped. New `kind` discriminators in 0.32 (`patch-applied`, `patch-outcome`) and 0.33 (`pattern-mined`, `novel-pattern-observed`).
- **Adversarial fixture set** (`bench/design/gepa/fixtures/`) — already shipped. Each anchor file in Layer 1 references fixture IDs; new fixtures added per layer to seed pattern library.
- **agent-eval** — `@tangle-network/agent-eval@0.13.0` ships `bootstrapCi`, `paretoFrontierWithCrowding`, `runPromptEvolution`, `judgeReplayGate`. Layer 4's calibration self-test uses `bootstrapCi`. Layer 1's per-type rollup-weight evolution uses `runPromptEvolution`. Layer 5's pattern reliability uses `judgeReplayGate` to validate before promotion.

Nothing here invalidates existing work. Every layer extends; nothing replaces. Backwards compat is maintained for one release per schema bump.

---

End of RFC.
