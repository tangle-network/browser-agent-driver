/**
 * Direction ranking — the PURE Bradley-Terry / Elo rollup. Folds many debiased
 * `TasteVerdict`s into a single `RankResult`. No IO, no model: deterministic for
 * a fixed verdict set, so `rankDirections` IS the `DirectionRanker`
 * implementation (`{ rank: rankDirections }` at the wiring root).
 *
 * Two complementary solvers, both reported:
 *  - Bradley-Terry strengths via minorization-maximization (the maximum-
 *    likelihood stationary ranking; order-independent, sum-normalised).
 *  - Elo via sequential `updateElo` (cheap, online, conserves total rating).
 *
 * The published order is by Bradley-Terry strength, with Elo then id as
 * deterministic tie-breaks. `calibrateAgainstVotes` scores judge-vs-human
 * agreement so the taste judge can be validated against ground-truth votes.
 */

import type { CalibrationResult, HumanVote, RankResult, TasteVerdict } from '../contracts.js'

const ELO_START = 1500
const ELO_K = 32
const BT_ITERATIONS = 200

const round2 = (n: number): number => Math.round(n * 100) / 100
const round4 = (n: number): number => Math.round(n * 10000) / 10000
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

function collectIds(seed: string[], verdicts: TasteVerdict[]): string[] {
  const set = new Set<string>(seed)
  for (const v of verdicts) {
    set.add(v.aId)
    set.add(v.bId)
  }
  return [...set]
}

/**
 * One Elo update for a single game. `outcome` is the score for the FIRST player
 * (1 win, 0.5 tie, 0 loss). Total rating is conserved (the two deltas cancel),
 * and the update is symmetric under swapping players + complementing the outcome.
 */
export function updateElo(ra: number, rb: number, outcome: number, k: number = ELO_K): [number, number] {
  const expectedA = 1 / (1 + Math.pow(10, (rb - ra) / 400))
  const expectedB = 1 - expectedA
  const o = clamp01(outcome)
  const ra2 = ra + k * (o - expectedA)
  const rb2 = rb + k * (1 - o - expectedB)
  return [ra2, rb2]
}

/**
 * Bradley-Terry strengths per id, sum-normalised. A win counts as one game won;
 * a tie splits the game half-and-half. Returns `{}` for no verdicts and a
 * uniform distribution when ids exist but no games were played.
 */
export function bradleyTerry(verdicts: TasteVerdict[]): Record<string, number> {
  const ids = collectIds([], verdicts)
  if (ids.length === 0) return {}

  const wins: Record<string, number> = {}
  const games: Record<string, Record<string, number>> = {}
  for (const id of ids) {
    wins[id] = 0
    games[id] = {}
    for (const other of ids) games[id][other] = 0
  }

  let totalGames = 0
  for (const v of verdicts) {
    if (v.aId === v.bId) continue
    games[v.aId][v.bId] += 1
    games[v.bId][v.aId] += 1
    totalGames += 1
    if (v.winner === v.aId) wins[v.aId] += 1
    else if (v.winner === v.bId) wins[v.bId] += 1
    else {
      wins[v.aId] += 0.5
      wins[v.bId] += 0.5
    }
  }

  if (totalGames === 0) {
    const uniform = 1 / ids.length
    return Object.fromEntries(ids.map((id) => [id, uniform]))
  }

  let p: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 1]))
  for (let iter = 0; iter < BT_ITERATIONS; iter++) {
    const next: Record<string, number> = {}
    for (const i of ids) {
      let denom = 0
      for (const j of ids) {
        if (i === j) continue
        const nij = games[i][j]
        if (nij === 0) continue
        denom += nij / (p[i] + p[j])
      }
      next[i] = denom > 0 ? wins[i] / denom : 0
    }
    const sum = ids.reduce((s, id) => s + next[id], 0)
    p = sum > 0 ? Object.fromEntries(ids.map((id) => [id, next[id] / sum])) : next
  }

  const sum = ids.reduce((s, id) => s + p[id], 0)
  if (sum <= 0) return p
  return Object.fromEntries(ids.map((id) => [id, round6(p[id] / sum)]))
}

/**
 * Roll a set of pairwise verdicts up into a ranking. `ids` seeds the population
 * (so a direction with no verdicts still appears, ranked last). Order is by
 * Bradley-Terry strength, tie-broken by Elo then id for determinism.
 */
export function rankDirections(ids: string[], verdicts: TasteVerdict[]): RankResult {
  const population = collectIds(ids, verdicts)

  const bt = bradleyTerry(verdicts)
  const bradleyTerryMap: Record<string, number> = {}
  for (const id of population) bradleyTerryMap[id] = bt[id] ?? 0
  // No evidence at all over the whole population ⇒ uniform priors (sum-normalised
  // to 1, per contract), not a row of zeros.
  const btSum = population.reduce((s, id) => s + bradleyTerryMap[id], 0)
  if (population.length > 0 && btSum <= 1e-12) {
    const uniform = round6(1 / population.length)
    for (const id of population) bradleyTerryMap[id] = uniform
  }

  // Games played per id — a seeded-but-unjudged direction (0 games) must sink
  // below any direction that was actually compared, even a loser, since we have
  // no evidence to surface it.
  const games: Record<string, number> = {}
  for (const id of population) games[id] = 0
  for (const v of verdicts) {
    if (v.aId === v.bId) continue
    games[v.aId] = (games[v.aId] ?? 0) + 1
    games[v.bId] = (games[v.bId] ?? 0) + 1
  }

  const elo: Record<string, number> = {}
  for (const id of population) elo[id] = ELO_START
  for (const v of verdicts) {
    if (v.aId === v.bId) continue
    if (!(v.aId in elo)) elo[v.aId] = ELO_START
    if (!(v.bId in elo)) elo[v.bId] = ELO_START
    const outcome = v.winner === v.aId ? 1 : v.winner === v.bId ? 0 : 0.5
    const [ra, rb] = updateElo(elo[v.aId], elo[v.bId], outcome)
    elo[v.aId] = ra
    elo[v.bId] = rb
  }

  const order = [...population].sort((x, y) => {
    const db = bradleyTerryMap[y] - bradleyTerryMap[x]
    if (Math.abs(db) > 1e-9) return db
    const dg = games[y] - games[x]
    if (dg !== 0) return dg
    const de = elo[y] - elo[x]
    if (Math.abs(de) > 1e-9) return de
    return x < y ? -1 : x > y ? 1 : 0
  })

  const eloRounded: Record<string, number> = {}
  for (const id of population) eloRounded[id] = round2(elo[id])

  return {
    order,
    winnerId: order[0] ?? '',
    bradleyTerry: bradleyTerryMap,
    elo: eloRounded,
  }
}

/**
 * Judge-vs-human agreement over a set of votes. Ties (on either side) and pairs
 * the judge never compared are excluded from `n`. Empty → `{ agreement: 0, n: 0 }`,
 * never NaN.
 */
export function calibrateAgainstVotes(verdicts: TasteVerdict[], votes: HumanVote[]): CalibrationResult {
  const key = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const judgeByPair = new Map<string, string | 'tie'>()
  for (const v of verdicts) judgeByPair.set(key(v.aId, v.bId), v.winner)

  let n = 0
  let agree = 0
  for (const vote of votes) {
    if (vote.winner === 'tie') continue
    const judged = judgeByPair.get(key(vote.aId, vote.bId))
    if (judged === undefined || judged === 'tie') continue
    n++
    if (judged === vote.winner) agree++
  }
  return { agreement: n > 0 ? round4(agree / n) : 0, n }
}
