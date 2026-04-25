/**
 * Statistical primitives for benchmark analysis.
 *
 * The bench harnesses (run-ab-experiment, run-multi-rep, run-competitive)
 * all need the same set of primitives: mean, stddev, Wilson CIs for
 * proportions, bootstrap CIs for differences, and effect-size measures.
 * They live here so the harnesses share one implementation.
 *
 * All RNG-driven functions accept a seed so results are reproducible.
 *
 * Conventions:
 * - All CIs are 95% by default (z=1.96 for normal, 0.025/0.975 quantiles for bootstrap).
 * - Sample stddev (n-1 denominator), not population stddev.
 * - Cohen's d uses pooled stddev.
 * - Mann-Whitney U is two-sided, with normal approximation for the p-value
 *   (valid for combined sample sizes ≥ 8; smaller samples should use the
 *   exact distribution but bench cells are typically n=3-10 so we accept
 *   the approximation and report an honest n).
 */

// ── Central tendency ────────────────────────────────────────────────────

export function mean(values) {
  if (values.length === 0) return 0
  return values.reduce((acc, v) => acc + v, 0) / values.length
}

export function stddev(values) {
  if (values.length < 2) return 0
  const avg = mean(values)
  const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

export function median(values) {
  if (values.length === 0) return 0
  return quantile(values, 0.5)
}

export function quantile(values, q) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  const frac = pos - lo
  return sorted[lo] * (1 - frac) + sorted[hi] * frac
}

export function min(values) {
  if (values.length === 0) return 0
  return Math.min(...values)
}

export function max(values) {
  if (values.length === 0) return 0
  return Math.max(...values)
}

/** Quick descriptive bundle for any continuous metric. */
export function describe(values) {
  return {
    n: values.length,
    mean: mean(values),
    stddev: stddev(values),
    min: min(values),
    median: median(values),
    p95: quantile(values, 0.95),
    max: max(values),
  }
}

// ── Wilson interval for proportions ────────────────────────────────────

/** Wilson 95% CI for a binomial proportion. Tighter than normal approx for small n. */
export function wilsonInterval(successes, n, z = 1.96) {
  if (n === 0) return [0, 0]
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom
  return [Math.max(0, center - margin), Math.min(1, center + margin)]
}

// ── Seeded PRNG (Numerical Recipes LCG) ────────────────────────────────

/** Returns a deterministic Math.random()-like function from a numeric seed. */
export function seededRandom(seed) {
  let state = (seed >>> 0) || 1
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

// ── Bootstrap CIs ──────────────────────────────────────────────────────

/** Resample a list with replacement, returning the mean of the resample. */
function resampleMean(values, random) {
  let total = 0
  for (let i = 0; i < values.length; i++) {
    const idx = Math.floor(random() * values.length)
    total += values[idx]
  }
  return total / values.length
}

/**
 * Bootstrap 95% CI for the mean of a single sample.
 * Works for any continuous metric — wall-time, tokens, cost, etc.
 */
export function bootstrapMean95(values, samples = 2000, seed = 7) {
  if (values.length === 0) return [0, 0]
  if (values.length === 1) return [values[0], values[0]]
  const random = seededRandom(seed)
  const means = []
  for (let i = 0; i < samples; i++) {
    means.push(resampleMean(values, random))
  }
  means.sort((a, b) => a - b)
  return [means[Math.floor(samples * 0.025)], means[Math.floor(samples * 0.975)]]
}

/**
 * Bootstrap 95% CI for the difference of means (treatment − control).
 * Works for outcomes (0/1) and continuous metrics alike.
 * Negative values mean treatment improved (e.g. lower wall-time, lower cost).
 */
export function bootstrapDiff95(treatmentValues, controlValues, samples = 2000, seed = 11) {
  if (treatmentValues.length === 0 || controlValues.length === 0) return [0, 0]
  const random = seededRandom(seed)
  const diffs = []
  for (let i = 0; i < samples; i++) {
    const t = resampleMean(treatmentValues, random)
    const c = resampleMean(controlValues, random)
    diffs.push(t - c)
  }
  diffs.sort((a, b) => a - b)
  return [diffs[Math.floor(samples * 0.025)], diffs[Math.floor(samples * 0.975)]]
}

// ── Effect size ────────────────────────────────────────────────────────

/**
 * Cohen's d — standardized effect size for the difference between two means.
 * Uses pooled stddev (assumes roughly equal variances).
 *
 * Conventional thresholds:
 * - |d| < 0.2  → trivial
 * - 0.2-0.5    → small
 * - 0.5-0.8    → medium
 * - > 0.8      → large
 *
 * Sign: positive d means treatment > control.
 */
export function cohenD(treatmentValues, controlValues) {
  if (treatmentValues.length < 2 || controlValues.length < 2) return 0
  const mt = mean(treatmentValues)
  const mc = mean(controlValues)
  const st = stddev(treatmentValues)
  const sc = stddev(controlValues)
  const nt = treatmentValues.length
  const nc = controlValues.length
  // Pooled variance
  const pooledVar =
    ((nt - 1) * st * st + (nc - 1) * sc * sc) / (nt + nc - 2)
  const pooledSd = Math.sqrt(pooledVar)
  if (pooledSd === 0) return 0
  return (mt - mc) / pooledSd
}

/** Magnitude classifier for Cohen's d. */
export function classifyEffectSize(d) {
  const abs = Math.abs(d)
  if (abs < 0.2) return 'trivial'
  if (abs < 0.5) return 'small'
  if (abs < 0.8) return 'medium'
  return 'large'
}

// ── Mann-Whitney U (non-parametric two-sample test) ────────────────────

/**
 * Mann-Whitney U test (a.k.a. Wilcoxon rank-sum). Two-sided p-value
 * via normal approximation. Use this when the metric distribution is
 * non-normal or has outliers (e.g. wall-time with occasional 3-7s LLM
 * latency spikes).
 *
 * Returns: { U, z, p }
 *   - U: smaller of the two U statistics
 *   - z: standardized test statistic (with continuity correction)
 *   - p: two-sided p-value (normal approximation; valid for n1+n2 ≥ ~8)
 *
 * For samples smaller than 8, the normal approximation is unreliable
 * and you should use the exact distribution. We do not implement that
 * here; the caller should report n alongside p so the reader can judge.
 */
export function mannWhitneyU(treatment, control) {
  const n1 = treatment.length
  const n2 = control.length
  if (n1 === 0 || n2 === 0) return { U: 0, z: 0, p: 1 }

  // Combine and rank with average-rank for ties.
  const combined = [
    ...treatment.map((v) => ({ v, group: 't' })),
    ...control.map((v) => ({ v, group: 'c' })),
  ]
  combined.sort((a, b) => a.v - b.v)

  // Assign average ranks for ties.
  const ranks = new Array(combined.length)
  let i = 0
  while (i < combined.length) {
    let j = i
    while (j + 1 < combined.length && combined[j + 1].v === combined[i].v) j++
    const avgRank = (i + j + 2) / 2 // 1-indexed average
    for (let k = i; k <= j; k++) ranks[k] = avgRank
    i = j + 1
  }

  // Sum of ranks for treatment group
  let R1 = 0
  for (let k = 0; k < combined.length; k++) {
    if (combined[k].group === 't') R1 += ranks[k]
  }

  const U1 = R1 - (n1 * (n1 + 1)) / 2
  const U2 = n1 * n2 - U1
  const U = Math.min(U1, U2)

  // Normal approximation with continuity correction
  const meanU = (n1 * n2) / 2
  const sigmaU = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12)
  if (sigmaU === 0) return { U, z: 0, p: 1 }
  const z = (U - meanU + 0.5) / sigmaU
  // Two-sided p-value
  const p = 2 * (1 - normalCdf(Math.abs(z)))
  return { U, z, p }
}

/** Standard normal CDF via Abramowitz & Stegun 7.1.26 approximation. */
function normalCdf(x) {
  const sign = x < 0 ? -1 : 1
  const absX = Math.abs(x) / Math.SQRT2
  // Abramowitz & Stegun 7.1.26
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const t = 1 / (1 + p * absX)
  const y =
    1 -
    (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX)
  return 0.5 * (1 + sign * y)
}

// ── Spread-test verdict (matches CLAUDE.md rigor rules) ────────────────

/**
 * Spread-test verdict from CLAUDE.md Measurement Rigor:
 *   "If `(challenger_mean − baseline_mean)` is less than the worst-case
 *    spread of either side, the result is comparable, not an improvement."
 *
 * `direction` is which way "better" goes:
 *   - 'lower' (default): smaller is better (wall-time, cost, tokens, turns)
 *   - 'higher': larger is better (pass rate, score)
 *
 * Returns: 'win' | 'comparable' | 'regression'
 */
export function spreadVerdict(challenger, baseline, direction = 'lower') {
  if (challenger.length === 0 || baseline.length === 0) return 'comparable'
  const cMean = mean(challenger)
  const bMean = mean(baseline)
  const cSpread = max(challenger) - min(challenger)
  const bSpread = max(baseline) - min(baseline)
  const worstSpread = Math.max(cSpread, bSpread)
  const delta = cMean - bMean
  if (direction === 'lower') {
    if (delta < -worstSpread) return 'win'
    if (delta > worstSpread) return 'regression'
    return 'comparable'
  } else {
    if (delta > worstSpread) return 'win'
    if (delta < -worstSpread) return 'regression'
    return 'comparable'
  }
}
