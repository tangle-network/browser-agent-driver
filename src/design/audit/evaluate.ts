/**
 * Evaluator — composes classification + rubric + measurements + LLM vision
 * into structured findings.
 *
 * Architecture:
 *   1. Classifier output drives which rubric fragments apply.
 *   2. Deterministic measurements (contrast, axe) become "ground-truth" findings
 *      injected directly into the result. The LLM is not asked to invent these.
 *   3. The LLM's job is purely subjective: visual quality, hierarchy, polish,
 *      design system coherence. It sees the screenshot, the composed rubric,
 *      and a summary of the deterministic findings as context.
 *
 * This split is the whole point of Gen 2: stop asking the LLM to estimate
 * things that are computable.
 */

import type { Brain } from '../../brain/index.js'
import type { PageState, DesignFinding } from '../../types.js'
import type {
  PageClassification,
  ComposedRubric,
  MeasurementBundle,
  PageAuditResult,
} from './types.js'
import { impactToSeverity } from './measure/index.js'
import { computeRoi, annotateRoi } from './roi.js'

export interface EvaluateInput {
  url: string
  state: PageState
  classification: PageClassification
  rubric: ComposedRubric
  measurements: MeasurementBundle
  screenshotPath?: string
  auditPasses?: AuditPassId[]
  /**
   * Evolve-aware overrides. When present, these supersede the hard-coded
   * defaults below — used by the GEPA harness to A/B candidate prompts
   * without forking the audit pipeline.
   */
  overrides?: AuditOverrides
}

export type AuditPassId = 'standard' | 'product' | 'visual' | 'trust' | 'workflow' | 'content'

export interface AuditPass {
  id: AuditPassId
  title: string
  goal: string
  instructions: string
  /**
   * Per-pass opening sentence for the system prompt. Different passes need
   * different framings: a `trust` pass should NOT open with "your job is the
   * subjective visual layer only" — that sets the model to ignore the very
   * findings it's supposed to surface.
   */
  systemOpener: string
  /**
   * Suggested categories the LLM is most likely to emit for this pass. Used
   * inside the few-shot example so the example matches the pass's focus.
   * The category enum itself is shared (see brain/index.ts:VALID_CATEGORIES).
   */
  primaryCategory: 'visual-bug' | 'layout' | 'spacing' | 'typography' | 'ux'
}

export interface AuditOverrides {
  /** Override one or more pass definitions. Missing keys fall through to defaults. */
  passDefinitions?: Partial<Record<AuditPassId, AuditPass>>
  /** Override the classification → audit-mode mapping. */
  inferAuditMode?: (classification: PageClassification) => string
  /** Override the embedded few-shot finding. The example is the single most
   *  influential prompt knob — see `DEFAULT_FEW_SHOT_EXAMPLES` for shape. */
  fewShotExamples?: Partial<Record<AuditPassId, string>>
  /** Override the NO-BS rules block (one rule per array element). */
  noBsRules?: string[]
  /** Override the (min,mean) weights for `conservativeScore`. */
  conservativeWeights?: { min: number; mean: number }
  /** Override the deep-mode pass bundle per page type. Keyed by classification.type. */
  deepPassesByPageType?: Partial<Record<PageClassification['type'] | 'default', AuditPassId[]>>
}

export const DEFAULT_NO_BS_RULES: string[] = [
  'If the page is pretty but the product purpose or primary action is unclear, say that and cap the score at 6.',
  'If the page is mostly empty states, skeletons, generic cards, or copy explaining the UI, judge it as unfinished unless it previews the real product state clearly.',
  'If multiple actions have equal visual weight but unequal user importance, flag action hierarchy.',
  'If important trust details are missing before a user commits money, data, identity, deployment, or medical/legal decisions, flag it as major or critical.',
  'If the page could belong to any startup after swapping nouns, call out lack of product specificity.',
  'Do not write soft feedback like "could benefit from." State the defect and the fix.',
]

export const DEFAULT_CONSERVATIVE_WEIGHTS = { min: 0.65, mean: 0.35 }

export const DEFAULT_DEEP_PASSES_BY_TYPE: Record<PageClassification['type'] | 'default', AuditPassId[]> = {
  marketing: ['product', 'visual', 'content'],
  ecommerce: ['product', 'visual', 'trust'],
  'saas-app': ['product', 'visual', 'workflow'],
  dashboard: ['product', 'visual', 'workflow'],
  docs: ['product', 'content', 'visual'],
  social: ['product', 'visual', 'workflow'],
  tool: ['product', 'workflow', 'visual'],
  blog: ['content', 'visual', 'product'],
  utility: ['workflow', 'visual', 'product'],
  unknown: ['product', 'visual', 'trust'],
  default: ['product', 'visual', 'trust'],
}

export const PASS_DEFINITIONS: Record<AuditPassId, AuditPass> = {
  standard: {
    id: 'standard',
    title: 'Integrated product and design audit',
    goal: 'Audit the product clarity, workflow quality, and visual design quality of this page',
    instructions:
      'Run the full integrated review. Balance product intent, primary action, trust, IA, visual craft, and interaction quality.',
    systemOpener:
      'You are a principal product-design auditor. You review with the precision of a typographer and the ruthlessness of a design director, balanced against whether the screen actually helps the real audience finish the real job.',
    primaryCategory: 'ux',
  },
  product: {
    id: 'product',
    title: 'Product intent and usefulness audit',
    goal: 'Audit whether the page makes the product, audience, job, and next action obvious',
    instructions:
      'Focus on product specificity, audience, job-to-be-done, primary action, useful state, real domain objects, and whether the screen would help a human complete the actual product task. Penalize generic dashboard filler, vague empty states, and copy that explains itself instead of showing the product.',
    systemOpener:
      'You are a head of product reviewing whether this screen is doing its job. You do not care if the page is pretty. You care whether the audience, primary action, and product state are obvious within five seconds. Decorative cleanliness without product specificity is a defect.',
    primaryCategory: 'ux',
  },
  visual: {
    id: 'visual',
    title: 'Visual system and craft audit',
    goal: 'Audit the visual design system, layout, typography, spacing, color, and component craft',
    instructions:
      'Focus on hierarchy, density, rhythm, typography, color tokens, surfaces, component coherence, visual bugs, and whether the page has a deliberate design language rather than default UI kit assembly. Do not spend findings on product strategy unless it directly damages visual hierarchy.',
    systemOpener:
      'You are a principal design engineer who has shipped design systems at Linear, Stripe, and Vercel. You review with the precision of a typographer: count the type sizes, measure the rhythm, name the radii. Generic component-library assembly without intentional decisions is a defect.',
    primaryCategory: 'spacing',
  },
  trust: {
    id: 'trust',
    title: 'Trust, risk, and commitment audit',
    goal: 'Audit whether users can trust the page before committing money, identity, data, deployment, or operational changes',
    instructions:
      'Focus on risk communication, provenance, verification, permissions, fees, irreversible actions, security posture, operator/source identity, and confidence before commitment. Treat missing trust details as major when the UI asks users to pay, connect a wallet, deploy, register, run jobs, or share sensitive data.',
    systemOpener:
      'You are a senior trust-and-safety reviewer. The job is to catch what users would lose money, data, identity, or operational reputation over. Missing fees, missing provenance, ambiguous destructive actions, and unverifiable parties are the defects you look for first.',
    primaryCategory: 'ux',
  },
  workflow: {
    id: 'workflow',
    title: 'Workflow and interaction audit',
    goal: 'Audit whether the page supports the end-to-end workflow without confusion or dead ends',
    instructions:
      'Focus on sequencing, state transitions, disabled/loading/error/empty states, navigation, progressive disclosure, action hierarchy, and whether the user can recover from failure. Flag buttons, tabs, dropdowns, and CTAs that appear interactive but do not clarify outcome.',
    systemOpener:
      'You are a senior interaction designer. You evaluate sequences, not snapshots: what happens after click, what state recovery looks like, where the user gets stuck. Dead-end controls and unrecoverable error paths are the defects you call out first.',
    primaryCategory: 'ux',
  },
  content: {
    id: 'content',
    title: 'Content and information architecture audit',
    goal: 'Audit copy, labels, information architecture, and screen-level communication',
    instructions:
      'Focus on plain language, labels, headings, table/card structure, data naming, unnecessary meta-copy, vague marketing language, and whether the page says exactly what users need at the moment they need it.',
    systemOpener:
      'You are a senior content designer. You read the page like a user under time pressure. Meta-copy that explains the UI, vague marketing language, and labels that hide their meaning are the defects you call out first.',
    primaryCategory: 'typography',
  },
}

/**
 * Pass-specific few-shot examples. Each example uses a CONCRETE finding shape
 * for that pass's focus — no fake CSS, no vague meta-findings. The example
 * sets the *shape* of every output the model produces, so we keep them
 * realistic and category-appropriate.
 */
export const DEFAULT_FEW_SHOT_EXAMPLES: Record<AuditPassId, string> = {
  standard: `{
      "category": "spacing",
      "severity": "major",
      "description": "Hero section has 64px top padding but 16px bottom — inconsistent vertical rhythm breaks the 8px grid",
      "location": "Hero → first feature row",
      "suggestion": "Use 48px or 64px consistently for major section transitions",
      "cssSelector": "main > section:first-child",
      "cssFix": "padding-bottom: 48px",
      "impact": 6,
      "effort": 1,
      "blast": "page"
    }`,
  product: `{
      "category": "ux",
      "severity": "major",
      "description": "First viewport shows six equal-weight outline buttons (Create project, Invite member, Edit billing, Change password, Configure SSO, Browse templates) with no dominant primary; nothing tells a returning user what to do next",
      "location": "Workspace home, action grid below the welcome heading",
      "suggestion": "Pick one primary action for this page state (likely Create project) and render it as a filled button; demote the rest to a secondary toolbar or settings section",
      "cssSelector": "main .actions",
      "cssFix": "/* structural: keep one filled primary, demote the rest to text/icon-only */",
      "impact": 8,
      "effort": 3,
      "blast": "page"
    }`,
  visual: `{
      "category": "typography",
      "severity": "major",
      "description": "Five distinct font sizes visible (12, 13, 14, 15, 22) with no apparent scale — body sizes drift by 1px between cards instead of stepping on a defined ramp",
      "location": "Card grid in the Overview section",
      "suggestion": "Collapse to a 3-step type scale (12, 14, 22) and pin card body to 14px",
      "cssSelector": ".card .label, .card .value, .card .delta",
      "cssFix": "font-size: 14px",
      "impact": 5,
      "effort": 2,
      "blast": "system"
    }`,
  trust: `{
      "category": "ux",
      "severity": "critical",
      "description": "Order summary shows a single $120.00 line and a Pay now button — no fees, taxes, or merchant identity are surfaced before the user commits payment",
      "location": "Confirm payment card, summary rows above the Pay now button",
      "suggestion": "Add fee, tax, and total breakdown rows; show merchant logo + verified domain near the heading; require payment method confirmation before enabling Pay now",
      "cssSelector": ".wrap .row.total",
      "cssFix": "/* structural: insert fee + tax rows above .total; render merchant identity + payment method block */",
      "impact": 9,
      "effort": 4,
      "blast": "page"
    }`,
  workflow: `{
      "category": "ux",
      "severity": "major",
      "description": "Empty inbox shows a Got it button as the only call to action; clicking it doesn't move the user toward any next step in the product",
      "location": "Empty state, action below the illustration",
      "suggestion": "Replace Got it with a concrete next step (Compose first message / Connect inbox / Invite a teammate) and preview a sample row above it",
      "cssSelector": "main .empty button",
      "cssFix": "/* structural: replace generic ack button with a real next-step CTA + sample preview */",
      "impact": 7,
      "effort": 3,
      "blast": "page"
    }`,
  content: `{
      "category": "typography",
      "severity": "major",
      "description": "Body copy describes what the Reports page is supposed to do (\\"From here you can view reports about your data\\") instead of helping the user act; this is meta-copy, not product copy",
      "location": "Reports page intro paragraph",
      "suggestion": "Replace the descriptive paragraph with a real first row (most-recent report, sample report, or a one-line filter helper) and a single CTA",
      "cssSelector": "main p",
      "cssFix": "/* structural: remove descriptive paragraphs, render real or starter content */",
      "impact": 6,
      "effort": 2,
      "blast": "page"
    }`,
}

export function resolveAuditPasses(
  value?: string | number | AuditPassId[],
  options?: { classification?: PageClassification; overrides?: AuditOverrides },
): AuditPassId[] {
  if (Array.isArray(value)) return normalizeAuditPasses(value)
  if (typeof value === 'number') return auditPassesForCount(value)

  const raw = value?.trim().toLowerCase()
  if (!raw || raw === 'standard' || raw === 'single' || raw === 'default') return ['standard']
  // Layer 1 — `auto` is the new default for the v2 path: classification-aware
  // selection mirroring `deep`. The pipeline runs the ensemble classifier
  // first, then this picks the focused pass bundle for that page type.
  if (raw === 'auto' || raw === 'deep' || raw === 'parallel' || raw === 'full') {
    return deepPassesForClassification(options?.classification, options?.overrides)
  }
  if (raw === 'max' || raw === 'exhaustive') return ['product', 'visual', 'trust', 'workflow', 'content']
  if (/^\d+$/.test(raw)) return auditPassesForCount(Number(raw))

  return normalizeAuditPasses(raw.split(',').map(part => part.trim()) as AuditPassId[])
}

/** Pick the deep-mode bundle that fits the page's classification. */
function deepPassesForClassification(
  classification?: PageClassification,
  overrides?: AuditOverrides,
): AuditPassId[] {
  const map = { ...DEFAULT_DEEP_PASSES_BY_TYPE, ...(overrides?.deepPassesByPageType ?? {}) }
  if (!classification) return map.default ?? DEFAULT_DEEP_PASSES_BY_TYPE.default
  return map[classification.type] ?? map.default ?? DEFAULT_DEEP_PASSES_BY_TYPE.default
}

function normalizeAuditPasses(passes: AuditPassId[]): AuditPassId[] {
  const valid = new Set<AuditPassId>(['standard', 'product', 'visual', 'trust', 'workflow', 'content'])
  const normalized = passes.filter((pass): pass is AuditPassId => valid.has(pass))
  return Array.from(new Set(normalized.length > 0 ? normalized : ['standard']))
}

function auditPassesForCount(count: number): AuditPassId[] {
  if (count <= 1) return ['standard']
  const ordered: AuditPassId[] = ['product', 'visual', 'trust', 'workflow', 'content']
  return ordered.slice(0, Math.min(Math.max(count, 1), ordered.length))
}

function resolvePassDefinition(passId: AuditPassId, overrides?: AuditOverrides): AuditPass {
  return overrides?.passDefinitions?.[passId] ?? PASS_DEFINITIONS[passId]
}

/**
 * Build the LLM prompt for visual evaluation. Includes:
 *   - The composed rubric (only fragments matching the classification)
 *   - A summary of the deterministic measurements (so the LLM knows what's
 *     already been counted and doesn't double-count)
 *   - Strict instructions: no estimating contrast, no inventing a11y findings
 */
const UNIVERSAL_DIMENSIONS = [
  'layout',
  'typography',
  'color',
  'spacing',
  'components',
  'interactions',
  'accessibility',
  'polish',
] as const

export function inferAuditMode(classification: PageClassification): string {
  const domain = classification.domain.toLowerCase()
  if (/(crypto|defi|web3|wallet|payments?|finance|fintech|banking)/.test(domain)) {
    return 'High-trust transactional product. Judge transaction clarity, trust, risk, provenance, verification, and whether users understand what they are committing to before they act.'
  }
  if (/(devtools?|developer|infrastructure|api|sdk|cloud|hosting|deploy|database|observability)/.test(domain)) {
    return 'Developer/operator product. Judge whether the UI exposes real operational objects, status, logs, source, commands, deploy paths, and debugging affordances instead of generic dashboard filler.'
  }
  if (/(ai|ml|llm|agent|model|inference|training)/.test(domain)) {
    return 'AI/ML product. Judge whether model capability, latency/cost, job state, inputs/outputs, safety limits, and failure recovery are concrete and usable.'
  }
  if (/(health|medical|clinical|legal|insurance)/.test(domain)) {
    return 'High-stakes professional product. Judge clarity, safety, auditability, error prevention, and whether the UI avoids ambiguous or decorative communication.'
  }
  if (classification.type === 'ecommerce') {
    return 'Commerce product. Judge product comprehension, comparison, price/fees, checkout confidence, inventory/delivery signals, and purchase path clarity.'
  }
  if (classification.type === 'docs') {
    return 'Documentation product. Judge information scent, quickstart path, examples, API/reference scanability, versioning, and whether readers can get unstuck quickly.'
  }
  if (classification.type === 'marketing') {
    return 'Marketing/conversion product. Judge whether the page makes the offer, audience, proof, differentiation, and next step obvious without vague hype.'
  }
  return 'General product surface. Judge whether the page makes its audience, purpose, state, and next action obvious, then evaluate visual craft in service of that job.'
}

export function buildEvalPrompt(input: EvaluateInput, pass: AuditPass): string {
  const { classification, rubric, measurements, overrides } = input

  const measurementSummary = [
    `CONTRAST (already measured by deterministic math, do not re-evaluate):`,
    `  - ${measurements.contrast.totalChecked} text elements checked`,
    `  - ${measurements.contrast.aaFailures.length} fail WCAG AA`,
    `  - ${measurements.contrast.aaaFailures.length} fail WCAG AAA`,
    measurements.contrast.aaFailures.length > 0
      ? `  - Top failures: ${measurements.contrast.aaFailures
          .slice(0, 3)
          .map(f => `${f.color} on ${f.background} (${f.ratio}:1)`)
          .join(', ')}`
      : '',
    '',
    `ACCESSIBILITY (already measured by axe-core, do not re-evaluate):`,
    `  - axe ran: ${measurements.a11y.ran}`,
    `  - ${measurements.a11y.violations.length} WCAG violations found`,
    measurements.a11y.violations.length > 0
      ? `  - Top issues: ${measurements.a11y.violations
          .slice(0, 5)
          .map(v => `${v.id} (${v.impact})`)
          .join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  // Compose the full dimension list (universal + custom from rubric fragments).
  // The example payload uses a fixed placeholder value (7) so the prompt is
  // byte-for-byte deterministic across runs — required for `--reproducibility`.
  const allDimensions = [...UNIVERSAL_DIMENSIONS, ...rubric.dimensions]
  const dimensionExample = allDimensions
    .map(d => `    "${d}": 7`)
    .join(',\n')

  const auditMode = (overrides?.inferAuditMode ?? inferAuditMode)(classification)
  const fewShot = overrides?.fewShotExamples?.[pass.id] ?? DEFAULT_FEW_SHOT_EXAMPLES[pass.id]
  const noBsRules = overrides?.noBsRules ?? DEFAULT_NO_BS_RULES

  return `${pass.systemOpener}

You are evaluating a page that has been pre-classified and pre-measured. Contrast and axe-core accessibility findings have already been counted deterministically — DO NOT invent them. They will be merged with your output. Everything else (product clarity, action hierarchy, trust, IA, visual craft, interaction quality) is yours to judge.

PAGE CLASSIFICATION:
- Type: ${classification.type}
- Domain: ${classification.domain}
- Framework: ${classification.framework ?? 'unknown'}
- Design system: ${classification.designSystem}
- Maturity: ${classification.maturity}
- Intent: ${classification.intent}
- Classifier confidence: ${classification.confidence}

AUDIT MODE:
${auditMode}

AUDIT PASS:
${pass.title}

PASS-SPECIFIC FOCUS:
${pass.instructions}

DETERMINISTIC MEASUREMENTS:
${measurementSummary}

EVALUATION RUBRIC (composed from fragments matching this page):

${rubric.body}

YOUR JOB:
1. First infer the page's product job-to-be-done from screenshot + classification. Judge the screen against that job before judging surface polish.
2. Apply the pass-specific focus above, then score this page 1-10 against the rubric. Use the calibration anchors strictly. Do not grade on a curve.
3. Produce findings ONLY for things you can SEE in the screenshot: product clarity, action hierarchy, trust/risk communication, information architecture, visual hierarchy, typography choices, spacing rhythm, component coherence, polish details.
4. Do NOT produce contrast findings — they've been measured.
5. Do NOT produce accessibility findings — axe has been run.
6. Be specific. Reference exact visible elements, wording, layout relationships, and interaction surfaces.
7. Prefer findings that would actually move the product outcome, not tiny decorative nits.
8. For each finding include a concrete CSS fix in the cssFix field when CSS can help. If the real fix is content/IA/component structure, put the smallest honest structural hint in cssFix as a comment.
9. For each finding ALSO include impact, effort, and blast — these drive the ROI ranking.

NO-BS REVIEW RULES:
${noBsRules.map((r) => `- ${r}`).join('\n')}

ROI FIELDS — score each finding on:
- impact (1-10): how much this hurts the user. 1 = nitpick, 10 = breaks the experience.
- effort (1-10): how hard the fix is. 1 = single CSS line, 5 = a few component edits, 10 = redesign.
- blast: scope of the fix's effect.
    "page" = only this page benefits
    "section" = a region of this page (hero, footer)
    "component" = a shared component (Card, Button) — multiple pages benefit
    "system" = a design token or global style — every page benefits

A high-blast / low-effort fix has massive ROI. Use this scale honestly — the user will fix the top-ROI items first.

RESPOND WITH ONLY a JSON object:
{
  "score": 7,
  "summary": "One-sentence assessment of whether the page helps the inferred audience complete the inferred job, plus design-system quality",
  "strengths": [
    "Specific evidence-based strength",
    "Another measured strength"
  ],
  "findings": [
    ${fewShot}
  ],
  "designSystemScore": {
${dimensionExample}
  }
}

Categories: visual-bug, layout, alignment, spacing, typography, ux
(Do NOT use 'contrast' or 'accessibility' — those come from measurements.)
Severities: critical, major, minor
Score: 1-10. Most production apps score 5-7.

DIMENSIONS — score each of these on a 1-10 scale in designSystemScore:
${allDimensions.map(d => `- ${d}`).join('\n')}`
}

/**
 * Convert deterministic measurements into findings.
 *
 * Both contrast and a11y measurements are GROUPED before becoming findings:
 *   - Contrast: grouped by (color, background) pair → one finding per token
 *     mismatch, with affected element count. A site with 47 elements using
 *     the same failing gray gets ONE finding ("change --color-text-muted"),
 *     not 47 spammy entries.
 *   - axe: grouped by rule id → one finding per rule, with N affected nodes.
 *
 * Grouping has two big effects:
 *   1. Top Fixes by ROI surfaces real systemic issues, not 5 copies of the same one.
 *   2. blast scales with how many elements are affected — a contrast pair on
 *      47 elements is `system`; a one-off is `page`.
 */
export function measurementsToFindings(measurements: MeasurementBundle): DesignFinding[] {
  const findings: DesignFinding[] = []

  // ── Contrast: group by (normalizedColor|normalizedBackground) ──
  const contrastGroups = new Map<
    string,
    {
      color: string
      background: string
      ratio: number
      required: number
      selectors: string[]
      sampleText: string
      isCritical: boolean
    }
  >()

  for (const f of measurements.contrast.aaFailures) {
    const key = `${f.color}|${f.background}`
    const existing = contrastGroups.get(key)
    if (existing) {
      existing.selectors.push(f.selector)
      // Track the worst (lowest) ratio in the group
      if (f.ratio < existing.ratio) existing.ratio = f.ratio
      if (f.ratio < f.required - 1.5) existing.isCritical = true
    } else {
      contrastGroups.set(key, {
        color: f.color,
        background: f.background,
        ratio: f.ratio,
        required: f.required,
        selectors: [f.selector],
        sampleText: f.text,
        isCritical: f.ratio < f.required - 1.5,
      })
    }
  }

  // Convert each group to a single finding. Cap to top 10 groups by element count.
  const sortedGroups = [...contrastGroups.values()].sort(
    (a, b) => b.selectors.length - a.selectors.length,
  )
  for (const g of sortedGroups.slice(0, 10)) {
    const count = g.selectors.length
    const target = g.required.toFixed(1)
    // Blast scales with how many elements use this color pair
    const blast: DesignFinding['blast'] =
      count >= 5 ? 'system' : count >= 2 ? 'component' : 'page'
    findings.push({
      category: 'contrast',
      severity: g.isCritical ? 'critical' : 'major',
      description:
        count > 1
          ? `Text color ${g.color} on background ${g.background} fails WCAG AA on ${count} elements (worst ratio ${g.ratio}:1, need ${target}:1)`
          : `Text color ${g.color} on background ${g.background} has contrast ratio ${g.ratio}:1, fails WCAG AA (need ${target}:1)`,
      location:
        count > 1
          ? `${count} elements (e.g. ${g.selectors[0]})`
          : `${g.selectors[0]} — "${g.sampleText}"`,
      suggestion:
        count > 1
          ? `Change the shared color token. ${count} elements use this pairing — fix once, all benefit. Increase contrast to at least ${target}:1.`
          : `Increase contrast to at least ${target}:1. Darken the text color or lighten the background.`,
      cssSelector: g.selectors[0],
      cssFix: `/* ${count} element${count !== 1 ? 's' : ''} affected: ${g.ratio}:1 → need ${target}:1 */`,
      impact: g.isCritical ? 9 : 7,
      effort: 1,
      blast,
    })
  }

  // ── Accessibility: group by axe rule id ──
  // axe already returns one violation per rule (with multiple nodes), so the
  // grouping is mostly about reframing the description to surface the count.
  for (const v of measurements.a11y.violations.slice(0, 15)) {
    const nodeCount = v.nodes.length
    const firstNode = v.nodes[0]
    const blast: DesignFinding['blast'] =
      nodeCount >= 5 ? 'system' : nodeCount >= 2 ? 'component' : 'page'
    findings.push({
      category: 'accessibility',
      severity: impactToSeverity(v.impact),
      description:
        nodeCount > 1
          ? `[axe: ${v.id}] ${v.description} (${nodeCount} affected elements)`
          : `[axe: ${v.id}] ${v.description}`,
      location: firstNode
        ? nodeCount > 1
          ? `${nodeCount} elements (e.g. ${firstNode.selector})`
          : firstNode.selector
        : 'page',
      suggestion:
        nodeCount > 1
          ? `${firstNode?.failureSummary ?? 'Fix all affected elements.'} ${nodeCount} elements affected — likely a shared component bug.`
          : firstNode?.failureSummary || `See ${v.helpUrl}`,
      ...(firstNode ? { cssSelector: firstNode.selector } : {}),
      impact: v.impact === 'critical' ? 9 : v.impact === 'serious' ? 7 : v.impact === 'moderate' ? 5 : 3,
      effort: 3,
      blast,
    })
  }

  return findings
}

/**
 * Run the full evaluation pipeline for one page.
 *
 * Returns a PageAuditResult with merged findings (deterministic + LLM visual).
 */
export async function evaluatePage(
  brain: Brain,
  input: EvaluateInput,
): Promise<PageAuditResult> {
  const passIds = resolveAuditPasses(input.auditPasses, {
    classification: input.classification,
    overrides: input.overrides,
  })
  const passes = passIds.map(id => resolvePassDefinition(id, input.overrides))

  // Run independent subjective passes concurrently. Deterministic findings are
  // still merged once below; this only broadens the LLM review surface.
  const passResults = await Promise.allSettled(
    passes.map(async pass => ({
      pass,
      result: await brain.auditDesign(
        input.state,
        pass.goal,
        [],
        buildEvalPrompt(input, pass),
      ),
    })),
  )

  const fulfilled = passResults
    .filter((r): r is PromiseFulfilledResult<{
      pass: AuditPass
      result: Awaited<ReturnType<Brain['auditDesign']>>
    }> => r.status === 'fulfilled')
    .map(r => r.value)

  if (fulfilled.length === 0) {
    const reason = passResults.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason
    throw reason instanceof Error ? reason : new Error(String(reason ?? 'All audit passes failed'))
  }

  // Parse summary/strengths/designSystemScore from raw LLM response
  const parsedPasses = fulfilled.map(({ pass, result }) => ({
    pass,
    result,
    parsed: parseAuditResponse(result.raw),
  }))
  const summary = buildMergedSummary(parsedPasses)
  const strengths = mergeStrengths(parsedPasses.flatMap(p => p.parsed.strengths))
  let designSystemScore = mergeDesignSystemScores(parsedPasses.map(p => p.parsed.designSystemScore))

  // Filter LLM findings to only the categories we expect from the visual layer
  // (the LLM should not be producing contrast/accessibility findings, but be defensive)
  const visualCategories = new Set<DesignFinding['category']>([
    'visual-bug',
    'layout',
    'alignment',
    'spacing',
    'typography',
    'ux',
  ])
  const visualFindings = dedupeFindings(
    fulfilled.flatMap(({ result }) => result.findings.filter(f => visualCategories.has(f.category))),
  )

  // Merge: deterministic measurements first (they're ground truth), then visual
  const measurementFindings = measurementsToFindings(input.measurements)
  const mergedFindings = [...measurementFindings, ...visualFindings]

  // Annotate every finding with its computed ROI score so downstream sorting works.
  // Visual findings have impact/effort/blast from the LLM; measurement findings
  // get derived defaults below.
  annotateRoi(mergedFindings)

  // Override the accessibility dimension in the design system score with
  // measurement-driven truth. The overall score still reflects visual quality
  // (the LLM's job) — but the a11y dimension is no longer LLM-estimated.
  if (designSystemScore) {
    designSystemScore.accessibility = computeAccessibilityScore(input.measurements)
  }

  // Only hard-cap the overall score in catastrophic cases (broken contrast on
  // most text). Otherwise trust the LLM's visual judgment and let the
  // accessibility dimension carry the measurement story.
  let finalScore = conservativeScore(fulfilled.map(p => p.result.score), input.overrides?.conservativeWeights)
  const contrastFailRate = 1 - input.measurements.contrast.summary.aaPassRate
  const trueCriticalA11y = input.measurements.a11y.violations.filter(
    v => v.impact === 'critical',
  ).length

  if (contrastFailRate > 0.5 && trueCriticalA11y >= 3) {
    finalScore = Math.min(finalScore, 6)
  }

  return {
    url: input.url,
    score: finalScore,
    summary,
    strengths,
    findings: mergedFindings,
    classification: input.classification,
    rubricFragments: input.rubric.fragments.map(f => f.id),
    measurements: input.measurements,
    designSystemScore: designSystemScore as PageAuditResult['designSystemScore'],
    screenshotPath: input.screenshotPath,
    tokensUsed: fulfilled.reduce((sum, p) => sum + (p.result.tokensUsed ?? 0), 0),
  }
}

function parseAuditResponse(raw: string): {
  summary: string
  strengths: string[]
  designSystemScore?: Record<string, number>
} {
  try {
    let text = raw.trim()
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    }
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return { summary: '', strengths: [] }

    const parsed = JSON.parse(text.slice(start, end + 1))
    const designSystemScore: Record<string, number> = {}
    if (parsed.designSystemScore && typeof parsed.designSystemScore === 'object') {
      for (const [k, v] of Object.entries(parsed.designSystemScore)) {
        if (typeof v === 'number') designSystemScore[k] = v
      }
    }

    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      strengths: Array.isArray(parsed.strengths)
        ? parsed.strengths.filter((s: unknown): s is string => typeof s === 'string')
        : [],
      designSystemScore:
        Object.keys(designSystemScore).length > 0 ? designSystemScore : undefined,
    }
  } catch {
    return { summary: '', strengths: [] }
  }
}

function buildMergedSummary(
  passes: Array<{
    pass: AuditPass
    parsed: { summary: string }
  }>,
): string {
  if (passes.length === 1) return passes[0]?.parsed.summary ?? ''
  const summaries = passes
    .filter(p => p.parsed.summary)
    .map(p => `${p.pass.id}: ${p.parsed.summary}`)
  return summaries.slice(0, 3).join(' ')
}

function mergeStrengths(strengths: string[]): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const strength of strengths) {
    const key = strength.toLowerCase().replace(/\s+/g, ' ').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(strength)
    if (merged.length >= 6) break
  }
  return merged
}

function mergeDesignSystemScores(
  scores: Array<Record<string, number> | undefined>,
): Record<string, number> | undefined {
  const buckets = new Map<string, number[]>()
  for (const score of scores) {
    if (!score) continue
    for (const [dimension, value] of Object.entries(score)) {
      const bucket = buckets.get(dimension) ?? []
      bucket.push(value)
      buckets.set(dimension, bucket)
    }
  }
  if (buckets.size === 0) return undefined

  const merged: Record<string, number> = {}
  for (const [dimension, values] of buckets) {
    const average = values.reduce((sum, value) => sum + value, 0) / values.length
    merged[dimension] = Math.round(average * 10) / 10
  }
  return merged
}

function dedupeFindings(findings: DesignFinding[]): DesignFinding[] {
  const byKey = new Map<string, DesignFinding>()
  for (const finding of findings) {
    const key = `${finding.category}|${canonicalFindingTopic(finding)}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, finding)
      continue
    }
    if (shouldReplaceFinding(existing, finding)) {
      byKey.set(key, finding)
    }
  }
  return [...byKey.values()].slice(0, 18)
}

function canonicalFindingTopic(finding: DesignFinding): string {
  const text = `${finding.description} ${finding.location} ${finding.suggestion}`
    .toLowerCase()
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  const topicRules: Array<[RegExp, string]> = [
    [/\b(primary|product)\s+(job|purpose)|next action|first viewport|what.+(doing|for)|product model|5 seconds/, 'product-clarity'],
    [/equal[- ]weight|action hierarchy|button|cta|control set|peer controls|dominant primary|visually compete/, 'action-hierarchy'],
    [/wallet|trust|pricing|price|cost|commit|authorize|approval|payment|identity|permission|network|chain|funds|fees/, 'trust-commitment'],
    [/blueprint root|internal.+term|jargon|implementation term|leaked.+system|object name/, 'jargon-leak'],
    [/what you buy|what you need|what you monitor|domain object|generic heading|abstract heading|abstract bucket|actual product/, 'domain-content'],
    [/typography|type hierarchy|heading system|title|subtitle|information hierarchy/, 'type-hierarchy'],
    [/spacing|rhythm|dead air|whitespace|vertical flow|gaps/, 'spacing-rhythm'],
    [/layout|content frame|two-column|grid|alignment|grouped information|reviewable transaction/, 'layout-structure'],
    [/label|grammatical|naming|button labels|language hierarchy|copy hierarchy/, 'label-consistency'],
    [/console|marketing\/setup stub|operational product|component library|visual language|assembled ui/, 'product-surface-maturity'],
  ]

  for (const [pattern, topic] of topicRules) {
    if (pattern.test(text)) return topic
  }

  return text.slice(0, 140)
}

function shouldReplaceFinding(existing: DesignFinding, candidate: DesignFinding): boolean {
  const severityDiff = severityRank(candidate.severity) - severityRank(existing.severity)
  if (severityDiff < 0) return true
  if (severityDiff > 0) return false

  const candidateImpact = candidate.impact ?? 0
  const existingImpact = existing.impact ?? 0
  if (candidateImpact !== existingImpact) return candidateImpact > existingImpact

  const candidateText = `${candidate.description} ${candidate.suggestion}`
  const existingText = `${existing.description} ${existing.suggestion}`
  return candidateText.length > existingText.length
}

export function conservativeScore(
  scores: number[],
  weights: { min: number; mean: number } = DEFAULT_CONSERVATIVE_WEIGHTS,
): number {
  if (scores.length === 0) return 5
  if (scores.length === 1) return scores[0]!
  const min = Math.min(...scores)
  const average = scores.reduce((sum, score) => sum + score, 0) / scores.length
  const total = weights.min + weights.mean
  const wMin = total > 0 ? weights.min / total : 0.65
  const wMean = total > 0 ? weights.mean / total : 0.35
  return Math.round((min * wMin + average * wMean) * 10) / 10
}

function severityRank(severity: DesignFinding['severity']): number {
  return severity === 'critical' ? 0 : severity === 'major' ? 1 : 2
}

/**
 * Translate raw measurement data into a 1-10 accessibility score.
 *
 * Anchors:
 *  - 10: 100% AA contrast pass + 0 axe violations
 *  -  8: 95%+ AA contrast pass + ≤2 minor/moderate violations
 *  -  6: 90%+ AA contrast pass + 0 critical violations
 *  -  4: 75%+ AA contrast pass OR 1 critical violation
 *  -  2: <75% AA contrast pass OR 3+ critical violations
 */
function computeAccessibilityScore(measurements: MeasurementBundle): number {
  const aaPass = measurements.contrast.summary.aaPassRate
  const critical = measurements.a11y.violations.filter(v => v.impact === 'critical').length
  const serious = measurements.a11y.violations.filter(v => v.impact === 'serious').length
  const moderate = measurements.a11y.violations.filter(v => v.impact === 'moderate').length

  // Catastrophic
  if (aaPass < 0.5 || critical >= 3) return 2
  // Severe
  if (aaPass < 0.75 || critical >= 1) return 4
  // Significant issues
  if (aaPass < 0.9 || serious >= 3) return 6
  // Minor issues
  if (aaPass < 0.95 || serious >= 1 || moderate >= 3) return 7
  // Mostly clean
  if (aaPass < 1 || moderate >= 1) return 8
  // Pristine
  return 10
}
