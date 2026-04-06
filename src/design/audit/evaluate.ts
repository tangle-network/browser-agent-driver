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

function buildEvalPrompt(input: EvaluateInput): string {
  const { classification, rubric, measurements } = input

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

  // Compose the full dimension list (universal + custom from rubric fragments)
  const allDimensions = [...UNIVERSAL_DIMENSIONS, ...rubric.dimensions]
  const dimensionExample = allDimensions
    .map(d => `    "${d}": ${Math.floor(Math.random() * 4) + 5}`)
    .join(',\n')

  return `You are a principal design engineer who has shipped design systems at Linear, Stripe, and Vercel. You review with the precision of a typographer and the ruthlessness of a design director.

You are evaluating a page that has been pre-classified and pre-measured. Your job is the SUBJECTIVE layer only: visual quality, hierarchy, polish, design system coherence. You must NOT invent contrast or accessibility findings — those have already been measured deterministically and will be merged with your output.

PAGE CLASSIFICATION:
- Type: ${classification.type}
- Domain: ${classification.domain}
- Framework: ${classification.framework ?? 'unknown'}
- Design system: ${classification.designSystem}
- Maturity: ${classification.maturity}
- Intent: ${classification.intent}
- Classifier confidence: ${classification.confidence}

DETERMINISTIC MEASUREMENTS:
${measurementSummary}

EVALUATION RUBRIC (composed from fragments matching this page):

${rubric.body}

YOUR JOB:
1. Score this page 1-10 against the rubric above. Use the calibration anchors strictly.
2. Produce findings ONLY for things you can SEE in the screenshot — visual hierarchy, typography choices, spacing rhythm, component coherence, polish details.
3. Do NOT produce contrast findings — they've been measured.
4. Do NOT produce accessibility findings — axe has been run.
5. Be specific. Reference exact elements, measured spacing, typography choices.
6. For each finding include a concrete CSS fix in the cssFix field.
7. For each finding ALSO include impact, effort, and blast — these drive the ROI ranking.

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
  "summary": "One-sentence assessment of the design system's coherence and the page's effectiveness for its classified intent",
  "strengths": [
    "Specific evidence-based strength",
    "Another measured strength"
  ],
  "findings": [
    {
      "category": "spacing",
      "severity": "major",
      "description": "Hero section has 64px top padding but only 16px bottom — inconsistent vertical rhythm breaks the 8px grid",
      "location": "Hero section → features grid transition",
      "suggestion": "Use 48px or 64px consistently for all major section transitions",
      "cssSelector": "main > section:first-child",
      "cssFix": "padding-bottom: 48px",
      "impact": 6,
      "effort": 1,
      "blast": "page"
    }
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
  // Run the LLM visual evaluation
  const result = await brain.auditDesign(
    input.state,
    `Audit the visual design quality of this ${input.classification.type} page`,
    [],
    buildEvalPrompt(input),
  )

  // Parse summary/strengths/designSystemScore from raw LLM response
  let summary = ''
  let strengths: string[] = []
  let designSystemScore: Record<string, number> | undefined
  try {
    let text = result.raw.trim()
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    }
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(text.slice(start, end + 1))
      summary = typeof parsed.summary === 'string' ? parsed.summary : ''
      strengths = Array.isArray(parsed.strengths) ? parsed.strengths : []
      if (parsed.designSystemScore && typeof parsed.designSystemScore === 'object') {
        designSystemScore = {}
        for (const [k, v] of Object.entries(parsed.designSystemScore)) {
          if (typeof v === 'number') designSystemScore[k] = v
        }
      }
    }
  } catch {
    // fall through with defaults
  }

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
  const visualFindings = result.findings.filter(f => visualCategories.has(f.category))

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
  let finalScore = result.score
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
    tokensUsed: result.tokensUsed,
  }
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
