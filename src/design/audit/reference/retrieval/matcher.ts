/**
 * Exemplar retrieval — the de-hardcoding PURE core. Implements `ExemplarMatcher`.
 *
 * Instead of the scattered if/else domain tables the v1 audit uses, retrieval
 * ranks exemplars by similarity: a hard `pageType` filter, then a blended score
 * over aesthetic-vector cosine similarity, an optional structural-vector signal,
 * and a low-weight job-to-be-done token overlap. The de-hardcoding guarantee:
 * a NOVEL `pageType` with no same-type exemplar does not fall through a table —
 * it resolves to its nearest neighbour across the whole corpus.
 *
 * Purity: the matcher consumes the PRE-COMPUTED `query.aestheticVector` (the
 * orchestrator embeds once) and NEVER embeds. Its only same-layer imports are
 * `cosineSimilarity` (the pure half of the embedding boundary) and
 * `structuralFeatures` — the SAME projection the orchestrator uses to build
 * `query.structuralVector`, so both sides of the structural comparison live in
 * one feature space. No IO, no LLM.
 */

import type { CorpusQuery, Exemplar, RetrievalResult, RetrieveWeights } from '../contracts.js'
import { cosineSimilarity } from './embedding-hash.js'
import { structuralFeatures } from '../dna/descriptor.js'

/**
 * Fallback blend used ONLY when no weights are passed (direct/test calls).
 * Aesthetic + pageType dominate; `job` is intentionally low because
 * classification intent is noisy and is fabricated on `--profile` runs. The
 * orchestrator always supplies config's canonical `DEFAULT_RETRIEVE_WEIGHTS`.
 */
const FALLBACK_WEIGHTS: RetrieveWeights = { aesthetic: 0.7, structural: 0.2, job: 0.1 }

// Score differences below this read as a tie and defer to the elo/id tie-break.
const SCORE_TIE_EPSILON = 1e-9

const round2 = (n: number): number => Math.round(n * 100) / 100
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/** Jaccard overlap of the word tokens in two job-to-be-done strings, 0-1. */
function jobOverlap(a: string, b: string): number {
  const sa = new Set((a.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2))
  const sb = new Set((b.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2))
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * Blended similarity of one exemplar to the query, in [0, 1]. Pure: the
 * weighted sub-scores are renormalised by the weights actually applied, so the
 * absence of a structural vector does not deflate the score.
 */
export function scoreExemplar(query: CorpusQuery, e: Exemplar, weights: RetrieveWeights = FALLBACK_WEIGHTS): number {
  let acc = 0
  let wsum = 0

  const aesthetic = clamp01(cosineSimilarity(query.aestheticVector, e.aestheticVector))
  acc += weights.aesthetic * aesthetic
  wsum += weights.aesthetic

  if (query.structuralVector && query.structuralVector.length > 0) {
    const structural = clamp01(cosineSimilarity(query.structuralVector, structuralFeatures(e.dna)))
    acc += weights.structural * structural
    wsum += weights.structural
  }

  const job = jobOverlap(query.jobToBeDone, e.jobToBeDone)
  acc += weights.job * job
  wsum += weights.job

  return wsum > 0 ? clamp01(acc / wsum) : 0
}

function buildReasons(query: CorpusQuery, e: Exemplar, novel: boolean): string[] {
  const reasons: string[] = []
  reasons.push(
    novel
      ? `nearest-neighbour fallback: no '${query.pageType}' exemplar, matched across types (${e.pageType})`
      : `page-type match: ${e.pageType}`,
  )
  reasons.push(`aesthetic similarity ${round2(clamp01(cosineSimilarity(query.aestheticVector, e.aestheticVector)))}`)
  if (query.structuralVector && query.structuralVector.length > 0) {
    reasons.push(`structural similarity ${round2(clamp01(cosineSimilarity(query.structuralVector, structuralFeatures(e.dna))))}`)
  }
  const job = jobOverlap(query.jobToBeDone, e.jobToBeDone)
  if (job > 0) reasons.push(`job overlap ${round2(job)}`)
  return reasons
}

/**
 * Rank a corpus of exemplars against a query. Hard-filters to same-`pageType`
 * candidates; if none exist (novel page type) it ranks the FULL corpus by nearest
 * neighbour rather than failing or table-dispatching. Sorted best→worst by
 * blended score, tie-broken by `eloRating` (desc) then `id` (asc) for full
 * determinism. Returns every candidate (no `k` truncation — the orchestrator
 * slices to its configured `k`).
 */
export function retrieve(
  query: CorpusQuery,
  corpus: Exemplar[],
  weights: RetrieveWeights = FALLBACK_WEIGHTS,
): RetrievalResult[] {
  if (corpus.length === 0) return []
  const sameType = corpus.filter((e) => e.pageType === query.pageType)
  const novel = sameType.length === 0
  const candidates = novel ? corpus : sameType

  const scored: RetrievalResult[] = candidates.map((e) => ({
    exemplar: e,
    score: scoreExemplar(query, e, weights),
    reasons: buildReasons(query, e, novel),
  }))

  scored.sort((x, y) => {
    if (Math.abs(y.score - x.score) > SCORE_TIE_EPSILON) return y.score - x.score
    if (y.exemplar.eloRating !== x.exemplar.eloRating) return y.exemplar.eloRating - x.exemplar.eloRating
    return x.exemplar.id.localeCompare(y.exemplar.id)
  })

  return scored
}
