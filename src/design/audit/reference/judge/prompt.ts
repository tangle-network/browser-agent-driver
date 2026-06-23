/**
 * Pairwise / absolute-quality judge prompts — the PURE prompt core of the taste
 * judge. No IO, no LLM, no browser: every output is a deterministic function of
 * the `JudgePairInput` + the chosen presentation `slot`, so identical inputs
 * always yield byte-identical prompts (a hard requirement for reproducibility and
 * for the position-swapped double run to cancel bias rather than introduce it).
 *
 * Two builders, one per judging leg:
 *  - `buildPairwisePrompt` — the RELATIVE leg: two redesign directions judged
 *    against a named reference (holistic taste/craft/fit).
 *  - `buildQualityPrompt` — the ABSOLUTE leg: page vs world-class exemplar,
 *    optionally narrowed to ONE product `Dimension` so the per-dimension win-rate
 *    is genuinely judge-resolved, never one overall number stamped across dims.
 *
 * Both carry an explicit anti-position-bias clause: SLOT A/B order is declared
 * information-free so the model is told to judge on merit alone. The `slot`
 * argument decides which logical subject (`input.a` / `input.b`) is physically
 * rendered as SLOT A — the debias core drives both orders through here.
 */

import type { JudgePairInput, JudgeSubject, ReferenceContext, Dimension } from '../contracts.js'

/** Presentation order: 'AB' renders input.a as SLOT A; 'BA' swaps them. */
export type Slot = 'AB' | 'BA'

// Plain-language guidance per product-quality dimension, injected only when the
// absolute leg scopes a comparison to one `Dimension`. Lives here (with the
// prompt logic) — never in the logic-free contracts hub.
const DIMENSION_GUIDANCE: Record<Dimension, string> = {
  product_intent: 'how clearly and directly the design serves its core job-to-be-done',
  visual_craft: 'typographic precision, colour discipline, spacing rhythm, and overall polish',
  trust_clarity: 'legibility, contrast, restraint, and signals of credibility',
  workflow: 'how efficiently a user can complete the primary task with minimal friction',
  content_ia: 'information hierarchy, scannability, and content organisation',
}

const ANTI_POSITION_BIAS =
  'SLOT A and SLOT B are presented in a randomized order that carries NO information. ' +
  'Do not favour a design because of its slot — judge only on merit.'

// Both pairwise subjects redesign the SAME real page, so "richer" content is not
// a virtue when it is fabricated. Without this, the judge rewards a direction for
// importing the reference's content (e.g. an invented activity feed) — exactly
// the failure that inflates sparse-page redesigns. Fidelity to the page's real
// content is the floor; "fit to the reference" is aesthetic, not content, fit.
const CONTENT_FIDELITY =
  'Both directions redesign the SAME real page. Judge them as faithful redesigns of that page, not as new pages. ' +
  'A direction that invents content the page does not have — fabricated metrics, counts, dates, statuses, activity ' +
  'feeds, or whole sections of made-up data — is LESS faithful and must be penalised, never rewarded as "richer". ' +
  '"Fit to the reference" means matching its visual craft (type, colour, motion, spacing, hierarchy), not importing its content.'

const RESPONSE_CONTRACT = [
  'Respond with ONLY a JSON object and no surrounding prose:',
  '{"winner": "A" | "B" | "tie", "confidence": <number 0-1>, "reasons": [<short strings>]}',
].join('\n')

function orderedSubjects(input: JudgePairInput, slot: Slot): [JudgeSubject, JudgeSubject] {
  return slot === 'AB' ? [input.a, input.b] : [input.b, input.a]
}

function renderReference(ref?: ReferenceContext): string {
  if (!ref) return ''
  return `REFERENCE (${ref.kind}) — judge both designs against this world-class target:\n${ref.summary}`
}

function renderRubric(body?: string): string {
  if (!body) return ''
  return `SCORING CRITERIA:\n${body}`
}

function renderSubject(label: 'A' | 'B', s: JudgeSubject): string {
  const lines = [`SLOT ${label} (identity withheld):`]
  if (s.directionSummary) lines.push(s.directionSummary)
  lines.push(s.dnaSummary)
  return lines.join('\n')
}

function joinSections(sections: string[]): string {
  return sections.filter((s) => s.length > 0).join('\n\n')
}

function pairwiseSystem(): string {
  return [
    'You are a world-class art director comparing two redesign directions for the same page against a named reference.',
    'Pick the direction with stronger taste, craft, information hierarchy, and fit to the reference.',
    CONTENT_FIDELITY,
    ANTI_POSITION_BIAS,
    RESPONSE_CONTRACT,
    'Use "tie" only when the two are genuinely indistinguishable in quality.',
  ].join('\n')
}

function qualitySystem(dimension?: Dimension): string {
  const focus = dimension
    ? ` Focus ONLY on the "${dimension}" dimension: ${DIMENSION_GUIDANCE[dimension]}.`
    : ''
  return [
    `You are a world-class design critic judging which of two designs is closer to world-class quality.${focus}`,
    ANTI_POSITION_BIAS,
    RESPONSE_CONTRACT,
    'Use "tie" only when the two are genuinely on par.',
  ].join('\n')
}

/**
 * The RELATIVE leg prompt: two redesign directions judged against a reference.
 */
export function buildPairwisePrompt(input: JudgePairInput, slot: Slot): { system: string; user: string } {
  const [first, second] = orderedSubjects(input, slot)
  const user = joinSections([
    renderReference(input.reference),
    renderRubric(input.rubricBody),
    renderSubject('A', first),
    renderSubject('B', second),
    'Which slot is the stronger redesign direction?',
  ])
  return { system: pairwiseSystem(), user }
}

/**
 * The ABSOLUTE leg prompt: page vs world-class exemplar, optionally narrowed to
 * a single product `Dimension`.
 */
export function buildQualityPrompt(input: JudgePairInput, slot: Slot): { system: string; user: string } {
  const [first, second] = orderedSubjects(input, slot)
  const question = input.dimension
    ? `Which slot better exemplifies world-class "${input.dimension}"?`
    : 'Which slot is the higher-quality design overall?'
  const user = joinSections([
    renderReference(input.reference),
    renderRubric(input.rubricBody),
    renderSubject('A', first),
    renderSubject('B', second),
    question,
  ])
  return { system: qualitySystem(input.dimension), user }
}
