/**
 * Ethics check — Layer 7.
 *
 * Given a page state + classification, evaluate every loaded `EthicsRule` whose
 * `appliesWhen` matches the classification. Each rule produces zero-or-one
 * `EthicsViolation`. Violations enforce a hard floor on the rollup score:
 * `critical-floor → 4`, `major-floor → 6`.
 *
 * Detector kinds:
 *   pattern-absent   → regex must appear in page text; violation if absent
 *   pattern-present  → regex must NOT appear in page text; violation if present
 *   llm-classifier   → ask the LLM the question; violation when answer is yes
 *
 * Pattern matches are case-insensitive. The LLM classifier asks for a
 * single-token yes/no answer to keep latency + cost predictable.
 */

import type { Brain } from '../../../brain/index.js'
import type {
  AppliesWhen,
  EthicsRule,
  EthicsViolation,
  PageClassification,
  AudienceTag,
  ModalityTag,
  RegulatoryContextTag,
  AudienceVulnerabilityTag,
} from '../v2/types.js'
import { rollupCapFor } from './loader.js'

export interface EthicsCheckContext {
  /** Lowercased page text used by `pattern-absent` / `pattern-present`. */
  pageText: string
  /** Page snapshot — passed verbatim to the LLM classifier prompt. */
  snapshot: string
  /** The page-type / domain / maturity / designSystem classification. */
  classification: PageClassification
  /** Operator-supplied audience / modality / regulatory hints (Layer 6). */
  audience?: AudienceTag[]
  modality?: ModalityTag[]
  regulatoryContext?: RegulatoryContextTag[]
  audienceVulnerability?: AudienceVulnerabilityTag[]
}

export interface EthicsCheckOptions {
  /** When set, llm-classifier rules are evaluated; else skipped (deterministic-only). */
  brain?: Brain
  /** Optional screenshot URL/path passed alongside snapshot context (unused today). */
  screenshotPath?: string
  /** Logger override — defaults to console.warn for skipped rules. */
  warn?: (msg: string) => void
}

/**
 * Run every applicable rule against the page. Returns one violation per rule
 * that fires. Rules whose detector is `llm-classifier` are skipped (with a
 * warning) when no `brain` is supplied — the alternative is silent passes,
 * which would hide ethics gaps in offline tests.
 */
export async function checkEthics(
  rules: EthicsRule[],
  ctx: EthicsCheckContext,
  opts: EthicsCheckOptions = {},
): Promise<EthicsViolation[]> {
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const violations: EthicsViolation[] = []
  for (const rule of rules) {
    if (!appliesWhenMatches(rule.appliesWhen, ctx)) continue
    const fired = await runDetector(rule, ctx, opts.brain, warn)
    if (fired) violations.push(toViolation(rule))
  }
  return violations
}

function toViolation(rule: EthicsRule): EthicsViolation {
  return {
    ruleId: rule.ruleId,
    detected: true,
    severity: rule.severity,
    rollupCap: rollupCapFor(rule.severity),
    remediation: rule.remediation,
    ...(rule.citation ? { citation: rule.citation } : {}),
  }
}

/**
 * Predicate evaluator — extends the rubric loader's logic with the v2 fields
 * (audience / modality / regulatoryContext / audienceVulnerability). All
 * declared predicates are AND-combined.
 */
export function appliesWhenMatches(w: AppliesWhen, ctx: EthicsCheckContext): boolean {
  if (w.universal) return true
  const cls = ctx.classification

  if (w.type?.length && !w.type.includes(cls.type)) return false
  if (w.maturity?.length && !w.maturity.includes(cls.maturity)) return false
  if (w.designSystem?.length && !w.designSystem.includes(cls.designSystem)) return false
  if (w.domain?.length) {
    const domain = (cls.domain ?? '').toLowerCase()
    const ok = w.domain.some(d => domain.includes(d.toLowerCase()))
    if (!ok) return false
  }
  if (w.audience?.length) {
    if (!w.audience.some(a => (ctx.audience ?? []).includes(a))) return false
  }
  if (w.modality?.length) {
    if (!w.modality.some(m => (ctx.modality ?? []).includes(m))) return false
  }
  if (w.regulatoryContext?.length) {
    if (!w.regulatoryContext.some(r => (ctx.regulatoryContext ?? []).includes(r))) return false
  }
  if (w.audienceVulnerability?.length) {
    if (!w.audienceVulnerability.some(v => (ctx.audienceVulnerability ?? []).includes(v))) return false
  }

  // Same conservative behavior as the rubric loader: with no predicates and
  // no `universal: true`, the rule does NOT apply (don't fire blindly).
  const hasPredicate =
    !!w.type?.length ||
    !!w.maturity?.length ||
    !!w.designSystem?.length ||
    !!w.domain?.length ||
    !!w.audience?.length ||
    !!w.modality?.length ||
    !!w.regulatoryContext?.length ||
    !!w.audienceVulnerability?.length
  return hasPredicate
}

async function runDetector(
  rule: EthicsRule,
  ctx: EthicsCheckContext,
  brain: Brain | undefined,
  warn: (m: string) => void,
): Promise<boolean> {
  const d = rule.detector
  if (d.kind === 'pattern-absent') {
    const re = compilePattern(d.pattern)
    return !re.test(ctx.pageText)
  }
  if (d.kind === 'pattern-present') {
    const re = compilePattern(d.pattern)
    return re.test(ctx.pageText)
  }
  if (d.kind === 'llm-classifier') {
    if (!brain) {
      warn(`ethics: skipping llm-classifier rule ${rule.ruleId} — no brain provided`)
      return false
    }
    return await runLlmClassifier(brain, d.llmCheck, ctx.snapshot)
  }
  return false
}

function compilePattern(pattern: string): RegExp {
  // Allow already-anchored regexes; default is case-insensitive substring.
  try {
    return new RegExp(pattern, 'i')
  } catch {
    // Fallback: treat as a literal token if regex compile fails.
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
}

const LLM_SYSTEM = `You are an ethics auditor. Answer the user's yes/no question about the page snapshot. Respond with exactly one token — yes or no — followed by an optional one-sentence rationale. Do not hedge. If the evidence is missing, answer no.`

export async function runLlmClassifier(
  brain: Brain,
  question: string,
  snapshot: string,
): Promise<boolean> {
  const truncated = snapshot.length > 8000 ? `${snapshot.slice(0, 8000)}\n…[truncated]` : snapshot
  const user = `QUESTION: ${question}\n\nPAGE SNAPSHOT:\n${truncated}\n\nAnswer yes or no.`
  const { text } = await brain.complete(LLM_SYSTEM, user, { maxOutputTokens: 80 })
  const first = text.trim().toLowerCase().match(/^[a-z]+/)?.[0] ?? ''
  return first === 'yes'
}

/** Build the lowercased text blob used by pattern detectors. */
export function pageTextBlob(snapshot: string, extra?: { url?: string; title?: string }): string {
  const parts = [snapshot, extra?.title ?? '', extra?.url ?? '']
  return parts.join('\n').toLowerCase()
}
