/**
 * Redesign-generation prompt builder — a PURE core of the generative layer.
 *
 * `buildDirectionPrompt` grounds ONE retrieved world-class exemplar's identity
 * (id + DNA) into a single-direction generation request for the page under
 * audit. The generator (`generate/generator.ts`) fans this out — one
 * `brain.complete` per exemplar — so the N named `RedesignDirection`s emerge
 * from N independent, individually-grounded calls rather than one mega-prompt.
 *
 * It performs NO IO, NO LLM, NO browser work and is byte-stable for fixed
 * inputs (no clock, no randomness), so it unit-tests on static fixtures and a
 * fixed-input snapshot pins its determinism.
 *
 * Budget discipline: both injected DNA summaries are bounded by `maxRefChars`
 * (via the deterministic `summarizeDNA`) and any operator rubric is truncated,
 * so a large reference can never blow the generation token budget.
 */

import type { GenerationContext, RetrievalResult } from '../contracts.js'
import { summarizeDNA } from '../dna/derive.js'

/** Tuning knobs for the deterministic prompt. */
export interface DirectionPromptOptions {
  /**
   * Max chars for EACH injected DNA summary (page-under-audit + exemplar). The
   * single lever that bounds the prompt's reference payload. px/ms values inside
   * the summary are preserved; only the tail is clipped.
   */
  maxRefChars?: number
}

const DEFAULT_MAX_REF_CHARS = 900
// The composed rubric body can be arbitrarily long; cap it so scoring criteria
// never dominate the generation budget. Independent of `maxRefChars` (a
// different concern: criteria vs reference identity).
const MAX_RUBRIC_CHARS = 1600

const truncate = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s

/**
 * The art-director persona + output contract. A module constant so the system
 * half of every generation call is byte-identical run-to-run.
 */
const GENERATION_SYSTEM_PROMPT = [
  'You are a world-class art director. You translate ONE concrete, named',
  'world-class reference into a single coherent, buildable redesign direction for',
  'the page under audit — not a menu of options, one opinionated direction.',
  '',
  'Hard rules:',
  '- Ground every decision in the named REFERENCE EXEMPLAR below. Echo its id in',
  '  `groundedInExemplarIds`. NEVER invent, guess, or cite an exemplar id you',
  '  were not given.',
  '- Specify concrete values: hex colors, px type sizes, ms durations, and real',
  '  revised copy strings — never placeholders like "TODO" or "lorem ipsum".',
  '- The ASCII layout must be a real box-drawing diagram of the proposed page',
  '  structure, top to bottom.',
  '- Preserve or improve the page\'s measured accessibility (contrast, a11y).',
  '  Never propose a change that would regress it.',
  '- Output STRICT JSON only: a single object matching the OUTPUT CONTRACT, with',
  '  no surrounding prose and no markdown code fences.',
].join('\n')

function renderPageBlock(ctx: GenerationContext, maxRefChars: number): string {
  const c = ctx.classification
  return [
    'PAGE UNDER REDESIGN',
    `url: ${ctx.url}`,
    `type: ${c.type}   domain: ${c.domain}   maturity: ${c.maturity}`,
    `intent: ${c.intent}`,
    'current design DNA:',
    summarizeDNA(ctx.dna, { maxChars: maxRefChars }),
  ].join('\n')
}

function renderExemplarBlock(hit: RetrievalResult, maxRefChars: number): string {
  const e = hit.exemplar
  const reasons = hit.reasons.length > 0 ? hit.reasons.join('; ') : 'nearest aesthetic neighbour'
  return [
    'REFERENCE EXEMPLAR (ground every choice in this one page)',
    `id: ${e.id}   source: ${e.source}   type: ${e.pageType}`,
    `url: ${e.url}`,
    `job-to-be-done: ${e.jobToBeDone}`,
    `why it was retrieved: ${reasons}`,
    'its design DNA:',
    summarizeDNA(e.dna, { maxChars: maxRefChars }),
  ].join('\n')
}

function renderConstraints(ctx: GenerationContext): string | null {
  const m = ctx.measurements
  if (!m) return null
  const aa = m.contrast.summary.aaPassRate
  const blocking = m.a11y.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  ).length
  return [
    'GROUND-TRUTH CONSTRAINTS (deterministic — do not regress)',
    `current AA contrast pass rate: ${aa}; blocking a11y issues: ${blocking}.`,
    'The redesign must keep contrast at or above this rate and must not introduce',
    'new blocking accessibility issues.',
  ].join('\n')
}

const OUTPUT_CONTRACT = [
  'OUTPUT CONTRACT — return STRICT JSON matching this exact shape, nothing else:',
  '{',
  '  "id": "short-slug",',
  '  "name": "evocative direction name",',
  '  "rationale": "why this direction serves the page\'s job-to-be-done",',
  '  "asciiLayout": "ASCII / box-drawing diagram of the proposed page structure",',
  '  "typeSystem": { "families": ["Font A"], "scalePx": [14, 18, 24, 32], "ratio": 1.25, "rationale": "..." },',
  '  "colorSystem": { "primary": "#2563eb", "accent": "#f59e0b", "neutrals": ["#111827", "#6b7280"], "background": "#ffffff", "rationale": "..." },',
  '  "motionSpec": { "durationsMs": [160, 240], "easings": ["ease-out"], "cues": ["where motion is applied and why"] },',
  '  "hierarchy": ["most prominent element", "...", "least prominent element"],',
  '  "copy": [{ "location": "h1", "before": "current copy", "after": "revised copy" }],',
  '  "groundedInExemplarIds": ["<the reference exemplar id above>"]',
  '}',
].join('\n')

/**
 * Build the `{ system, user }` pair for a single reference-grounded redesign
 * direction. Deterministic: identical inputs always yield identical strings.
 */
export function buildDirectionPrompt(
  ctx: GenerationContext,
  exemplar: RetrievalResult,
  opts: DirectionPromptOptions = {},
): { system: string; user: string } {
  const maxRefChars = opts.maxRefChars ?? DEFAULT_MAX_REF_CHARS

  const sections: string[] = [
    renderPageBlock(ctx, maxRefChars),
    renderExemplarBlock(exemplar, maxRefChars),
  ]

  const constraints = renderConstraints(ctx)
  if (constraints) sections.push(constraints)

  if (ctx.rubricBody && ctx.rubricBody.trim().length > 0) {
    sections.push(['SCORING CRITERIA (optimise the redesign against these)', truncate(ctx.rubricBody.trim(), MAX_RUBRIC_CHARS)].join('\n'))
  }

  sections.push(OUTPUT_CONTRACT)
  sections.push(
    `Produce exactly ONE redesign direction grounded in exemplar "${exemplar.exemplar.id}". Return ONLY the JSON object.`,
  )

  return { system: GENERATION_SYSTEM_PROMPT, user: sections.join('\n\n') }
}
