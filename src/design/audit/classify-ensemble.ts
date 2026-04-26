/**
 * Ensemble classifier — Layer 1 of the world-class design-audit architecture.
 *
 * Three-signal vote (URL pattern + DOM heuristic + LLM) decides the page type
 * and reports an ensemble confidence so downstream layers (first-principles
 * fallback, rubric loader, telemetry) can act on uncertainty honestly.
 *
 * Vote logic:
 *   - URL + DOM agree on a type AND combined confidence > 0.7  → accept (skip LLM)
 *   - else                                                      → run LLM, take majority
 *   - if LLM confidence < 0.5 AND signals disagree              → return 'unknown' with dissent
 */

import type { Brain } from '../../brain/index.js'
import type { PageState } from '../../types.js'
import { classifyPage, defaultClassification } from './classify.js'
import type { PageClassification, PageType } from './types.js'
import type {
  ClassifierSignal,
  ClassifierSource,
  DomHeuristics,
  EnsembleClassification,
} from './v2/types.js'

interface UrlPatternRule {
  pattern: RegExp
  type: PageType
  confidence: number
  rationale: string
}

/**
 * URL pattern rules — straight from the RFC. Order matters: more specific
 * patterns first. Each rule's confidence is the URL signal's contribution to
 * the ensemble vote.
 */
const URL_PATTERN_RULES: UrlPatternRule[] = [
  { pattern: /\/(docs|reference|api|guide|help|faq)(\/|$)/, type: 'docs', confidence: 0.85, rationale: 'URL contains a docs path segment' },
  { pattern: /\/(checkout|cart|pay|order|billing)(\/|$)/, type: 'ecommerce', confidence: 0.85, rationale: 'URL contains a commerce path segment' },
  { pattern: /\/(app|dashboard|workspace|admin)(\/|$)/, type: 'saas-app', confidence: 0.75, rationale: 'URL contains an app/dashboard path segment' },
  { pattern: /\/(login|signup|auth|sign-in)(\/|$)/, type: 'utility', confidence: 0.85, rationale: 'URL contains an auth path segment' },
  { pattern: /\/(pricing|plans|features|product)(\/|$)/, type: 'marketing', confidence: 0.7, rationale: 'URL contains a marketing path segment' },
  { pattern: /\/(blog|articles|news|stories)(\/|$)/, type: 'blog', confidence: 0.8, rationale: 'URL contains a blog path segment' },
  { pattern: /\/$/, type: 'marketing', confidence: 0.4, rationale: 'URL is a root path — weak marketing default' },
]

const ENSEMBLE_AGREEMENT_THRESHOLD = 0.7
const LLM_FALLBACK_CONFIDENCE = 0.5

export interface EnsembleClassifyInput {
  brain: Brain
  state: PageState
  url: string
  /** Optional pre-captured DOM heuristics. If absent, we attempt to derive them from the snapshot. */
  domHeuristics?: DomHeuristics
}

/** Public entry point. */
export async function classifyEnsemble(input: EnsembleClassifyInput): Promise<EnsembleClassification> {
  const signals: ClassifierSignal[] = []

  // ── 1. URL pattern signal ──
  const urlSignal = classifyByUrl(input.url)
  if (urlSignal) signals.push(urlSignal)

  // ── 2. DOM heuristic signal ──
  const dom = input.domHeuristics ?? deriveHeuristics(input.state)
  const domSignal = classifyByDom(dom)
  if (domSignal) signals.push(domSignal)

  // ── Quick path: URL + DOM agree with combined confidence > threshold ──
  if (
    urlSignal &&
    domSignal &&
    urlSignal.type === domSignal.type &&
    urlSignal.confidence + domSignal.confidence > ENSEMBLE_AGREEMENT_THRESHOLD
  ) {
    const ensembleConfidence = clamp01(
      Math.min(1, (urlSignal.confidence + domSignal.confidence) / 1.6),
    )
    return finalize({
      type: urlSignal.type,
      base: defaultClassification(),
      signals,
      ensembleConfidence,
      signalsAgreed: true,
    })
  }

  // ── 3. LLM tiebreaker ──
  const llmClass = await classifyPage(input.brain, input.state).catch(() => defaultClassification())
  signals.push({
    source: 'llm',
    type: llmClass.type,
    confidence: llmClass.confidence,
    rationale: llmClass.intent || 'LLM page classification',
  })

  // ── Vote ──
  const tally = new Map<PageType, number>()
  for (const sig of signals) {
    tally.set(sig.type, (tally.get(sig.type) ?? 0) + sig.confidence)
  }

  const sortedVotes = [...tally.entries()].sort((a, b) => b[1] - a[1])
  const winner = sortedVotes[0]
  const winningType = winner ? winner[0] : 'unknown'
  const winningTotal = winner ? winner[1] : 0

  // Compute aggregate confidence: average over participating signals, weighted by agreement.
  const winningSignals = signals.filter((s) => s.type === winningType)
  const agreementShare = winningSignals.length / signals.length
  const meanConfidence = winningSignals.reduce((acc, s) => acc + s.confidence, 0) / Math.max(winningSignals.length, 1)
  const ensembleConfidence = clamp01(meanConfidence * agreementShare + 0.05 * (winningTotal - meanConfidence))

  const signalsAgreed = signals.every((s) => s.type === winningType)
  const dissent = signals.filter((s) => s.type !== winningType).map((s) => ({ source: s.source, type: s.type }))

  // ── Low-confidence + disagreement → 'unknown' with dissent ──
  if (!signalsAgreed && llmClass.confidence < LLM_FALLBACK_CONFIDENCE) {
    return finalize({
      type: 'unknown',
      base: llmClass,
      signals,
      ensembleConfidence: Math.min(ensembleConfidence, 0.5),
      signalsAgreed: false,
      dissent,
    })
  }

  return finalize({
    type: winningType,
    base: llmClass,
    signals,
    ensembleConfidence,
    signalsAgreed,
    dissent: signalsAgreed ? undefined : dissent,
  })
}

interface FinalizeArgs {
  type: PageType
  base: PageClassification
  signals: ClassifierSignal[]
  ensembleConfidence: number
  signalsAgreed: boolean
  dissent?: { source: ClassifierSource; type: PageType }[]
}

function finalize(args: FinalizeArgs): EnsembleClassification {
  const { type, base, signals, ensembleConfidence, signalsAgreed } = args
  const firstPrinciplesMode = !signalsAgreed || ensembleConfidence < 0.6

  const out: EnsembleClassification = {
    ...base,
    type,
    confidence: ensembleConfidence,
    signals,
    signalsAgreed,
    ensembleConfidence,
    firstPrinciplesMode,
  }
  if (args.dissent && args.dissent.length > 0) out.dissent = args.dissent
  return out
}

// ── URL-pattern classifier ──────────────────────────────────────────────────

export function classifyByUrl(url: string): ClassifierSignal | null {
  let pathname: string
  try {
    pathname = new URL(url).pathname || '/'
  } catch {
    return null
  }
  for (const rule of URL_PATTERN_RULES) {
    if (rule.pattern.test(pathname)) {
      return {
        source: 'url-pattern',
        type: rule.type,
        confidence: rule.confidence,
        rationale: `${rule.rationale} (${pathname})`,
      }
    }
  }
  return null
}

// ── DOM-heuristic classifier ────────────────────────────────────────────────

export function classifyByDom(dom: DomHeuristics): ClassifierSignal | null {
  // docs: lots of paragraphs + code blocks, modest nav
  if (dom.codeBlockCount >= 3 && dom.paragraphCount >= 6) {
    return signal('dom-heuristic', 'docs', 0.7, `code blocks=${dom.codeBlockCount}, paragraphs=${dom.paragraphCount}`)
  }
  // dashboard: many table rows or charts + sidebar
  if ((dom.tableRowCount >= 8 || dom.chartCount >= 2) && dom.hasSidebar) {
    return signal('dom-heuristic', 'dashboard', 0.7, `rows=${dom.tableRowCount}, charts=${dom.chartCount}, sidebar=true`)
  }
  // saas-app: sidebar + multiple forms or many inputs
  if (dom.hasSidebar && (dom.formCount >= 1 || dom.inputCount >= 4)) {
    return signal('dom-heuristic', 'saas-app', 0.65, `sidebar=true, forms=${dom.formCount}, inputs=${dom.inputCount}`)
  }
  // utility: single dominant form, no hero, no sidebar
  if (dom.formCount >= 1 && dom.inputCount >= 2 && !dom.hasHeroSection && !dom.hasSidebar) {
    return signal('dom-heuristic', 'utility', 0.7, `single form, no hero, no sidebar`)
  }
  // ecommerce: forms + many nav items + footer links (storefront chrome)
  if (dom.formCount >= 1 && dom.navItems >= 6 && dom.hasFooterLinks) {
    return signal('dom-heuristic', 'ecommerce', 0.6, `nav=${dom.navItems}, footer-links, form present`)
  }
  // blog: long body of paragraphs without forms or tables
  if (dom.paragraphCount >= 8 && dom.formCount === 0 && dom.tableRowCount === 0) {
    return signal('dom-heuristic', 'blog', 0.65, `paragraphs=${dom.paragraphCount}, no forms or tables`)
  }
  // marketing: hero + footer-link cloud + few paragraphs
  if (dom.hasHeroSection && dom.hasFooterLinks && dom.paragraphCount < 8) {
    return signal('dom-heuristic', 'marketing', 0.6, `hero present, footer-links, paragraphs=${dom.paragraphCount}`)
  }
  return null
}

function signal(source: ClassifierSource, type: PageType, confidence: number, rationale: string): ClassifierSignal {
  return { source, type, confidence, rationale }
}

// ── DOM heuristic derivation from snapshot ──────────────────────────────────

/**
 * Best-effort DOM heuristic derivation from the accessibility-tree snapshot.
 * Pipelines that capture true DOM heuristics via Playwright should pass them
 * in directly; this fallback works against the @ref-snapshot text.
 */
export function deriveHeuristics(state: PageState): DomHeuristics {
  const snapshot = state.snapshot ?? ''
  return {
    formCount: countMatches(snapshot, /\bform\b/gi),
    inputCount: countMatches(snapshot, /\b(textbox|searchbox|combobox|spinbutton|input)\b/gi),
    tableRowCount: countMatches(snapshot, /\brow\b/gi),
    chartCount: countMatches(snapshot, /\b(graphics-document|graphics-symbol|figure)\b/gi),
    navItems: countMatches(snapshot, /\bnavigation\b/gi),
    hasFooterLinks: /\bcontentinfo\b/i.test(snapshot),
    hasHeroSection: /\bhero\b/i.test(snapshot) || /\bbanner\b/i.test(snapshot),
    hasSidebar: /\bcomplementary\b/i.test(snapshot) || /\bsidebar\b/i.test(snapshot),
    paragraphCount: countMatches(snapshot, /\bparagraph\b/gi),
    codeBlockCount: countMatches(snapshot, /\bcode\b/gi),
  }
}

function countMatches(haystack: string, pattern: RegExp): number {
  const m = haystack.match(pattern)
  return m ? m.length : 0
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(1, n))
}

export const ENSEMBLE_INTERNALS = {
  URL_PATTERN_RULES,
  ENSEMBLE_AGREEMENT_THRESHOLD,
  LLM_FALLBACK_CONFIDENCE,
}
