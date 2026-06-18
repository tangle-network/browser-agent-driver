/**
 * Artifact assembly — the PURE core that folds the engine's stage outputs into
 * the first-class `RedesignArtifact`.
 *
 * No IO, no LLM: identical inputs always yield an identical artifact, so it
 * unit-tests on plain fixtures. Two invariants are enforced FAIL-CLOSED (we
 * throw rather than silently repair or fabricate):
 *
 *  - Directions are returned in RANKING order (winner first). A direction the
 *    ranker did not place is appended in its original order — never dropped —
 *    so a partial ranking can never silently lose a generated direction.
 *  - Every `groundedInExemplarIds` entry MUST resolve to a retrieved exemplar.
 *    A direction claiming grounding in an exemplar that was never retrieved is
 *    provenance fabrication; the artifact is the thing the taste eval trusts for
 *    provenance, so we refuse to assemble a lying one.
 */

import type {
  RedesignArtifact,
  RedesignDirection,
  RankResult,
  RetrievalResult,
  TasteVerdict,
} from '../contracts.js'

/**
 * Inputs to {@link buildRedesignArtifact}. Mirrors the inline shape the
 * `engine/core` sequencer passes; named here so callers and tests share one
 * definition.
 */
export interface BuildRedesignArtifactInput {
  url: string
  directions: RedesignDirection[]
  ranking: RankResult
  retrieval: RetrievalResult[]
  verdicts: TasteVerdict[]
  referenceId?: string
  tokensUsed: number
}

export function buildRedesignArtifact(input: BuildRedesignArtifactInput): RedesignArtifact {
  const retrievedIds = new Set(input.retrieval.map((r) => r.exemplar.id))
  for (const d of input.directions) {
    for (const id of d.groundedInExemplarIds) {
      if (!retrievedIds.has(id)) {
        throw new Error(
          `Direction "${d.id}" claims grounding in exemplar "${id}", which is not in the retrieval set ` +
            `(${[...retrievedIds].join(', ') || 'none'}). Refusing to assemble an artifact with fabricated provenance.`,
        )
      }
    }
  }

  return {
    url: input.url,
    directions: orderByRanking(input.directions, input.ranking),
    ranking: input.ranking,
    retrieval: input.retrieval,
    verdicts: input.verdicts,
    tokensUsed: input.tokensUsed,
    ...(input.referenceId !== undefined ? { referenceId: input.referenceId } : {}),
  }
}

/**
 * Order directions by the ranker's verdict, winner first. Directions the ranker
 * never placed are appended in their original relative order so nothing is lost.
 */
function orderByRanking(directions: RedesignDirection[], ranking: RankResult): RedesignDirection[] {
  const byId = new Map(directions.map((d) => [d.id, d]))
  const ordered: RedesignDirection[] = []
  const placed = new Set<string>()
  for (const id of ranking.order) {
    const d = byId.get(id)
    if (d && !placed.has(id)) {
      ordered.push(d)
      placed.add(id)
    }
  }
  for (const d of directions) {
    if (!placed.has(d.id)) {
      ordered.push(d)
      placed.add(d.id)
    }
  }
  return ordered
}
