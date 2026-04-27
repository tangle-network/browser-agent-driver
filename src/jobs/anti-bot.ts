/**
 * Anti-bot / blocked-page detection. Pure pattern match against an audit's
 * report.json — we propagate the existing audit signals rather than re-running
 * inference.
 *
 * Returns a reason string when blocked (so the job can carry it through to
 * the result envelope), else null.
 */

const TITLE_PATTERNS = [
  /just a moment\.{3}/i,
  /^attention required/i,
  /access denied/i,
  /verify you are human/i,
  /enable javascript and cookies/i,
  /one more step/i,
  /please complete the security check/i,
  /^cloudflare/i,
  /challenge[- ]page/i,
]

const INTENT_PATTERNS = [
  /cloudflare challenge/i,
  /anti.?bot/i,
  /captcha/i,
  /verify (the )?(human|user|browser)/i,
  /access (denied|restricted|blocked)/i,
]

export interface BlockSignals {
  title?: string
  intent?: string
  type?: string
  ensembleConfidence?: number
  findingCount?: number
}

/** Check the audit's report.json for anti-bot patterns. Returns the reason or null. */
export function detectBlock(report: unknown): string | null {
  const r = report as { pages?: Array<{ title?: string; classification?: { type?: string; intent?: string; ensembleConfidence?: number }; findings?: unknown[]; auditResult?: { classification?: { intent?: string; type?: string; ensembleConfidence?: number } } }> }
  const page = r.pages?.[0]
  if (!page) return null
  const v2cls = page.auditResult?.classification
  const cls = v2cls ?? page.classification ?? {}
  const signals: BlockSignals = {
    title: page.title,
    intent: cls.intent,
    type: cls.type,
    ensembleConfidence: cls.ensembleConfidence,
    findingCount: page.findings?.length ?? 0,
  }
  return reasonFor(signals)
}

export function reasonFor(s: BlockSignals): string | null {
  const title = (s.title ?? '').trim()
  const intent = (s.intent ?? '').trim()
  if (TITLE_PATTERNS.some(re => re.test(title))) {
    return `blocked: page title looks like an anti-bot challenge ("${title.slice(0, 80)}")`
  }
  if (INTENT_PATTERNS.some(re => re.test(intent))) {
    return `blocked: classification intent indicates a challenge page ("${intent.slice(0, 80)}")`
  }
  // Last-resort heuristic: zero findings + very low ensemble confidence + unknown
  // page-type is overwhelmingly an anti-bot or empty page. Leaving it in the
  // leaderboard pollutes rankings.
  if ((s.findingCount ?? 0) === 0
    && typeof s.ensembleConfidence === 'number'
    && s.ensembleConfidence < 0.35
    && s.type === 'unknown') {
    return 'blocked: zero findings, low classifier confidence, unknown type — likely empty/blocked'
  }
  return null
}
