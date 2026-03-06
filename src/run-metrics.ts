import type { Action, Turn, RunWasteMetrics } from './types.js';

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function looksLikeSearchSelector(selector: string): boolean {
  const normalized = selector.toLowerCase();
  return /\b(search|query|keywords?)\b/.test(normalized)
    || /\[name=['"]q['"]\]/.test(normalized)
    || /\[type=['"]search['"]\]/.test(normalized);
}

function extractQueryKey(action: Action): string | null {
  if (action.action !== 'type') return null;
  if (!looksLikeSearchSelector(action.selector)) return null;
  const text = normalizeWhitespace(action.text);
  if (!text) return null;
  return `${action.selector.toLowerCase()}::${text}`;
}

export function countRepeatedQueries(turns: Turn[]): number {
  const seen = new Set<string>();
  let repeated = 0;

  for (const turn of turns) {
    const key = extractQueryKey(turn.action);
    if (!key) continue;
    if (seen.has(key)) {
      repeated++;
      continue;
    }
    seen.add(key);
  }

  return repeated;
}

export function deriveWasteMetrics(
  turns: Turn[],
  verificationRejectionCount: number,
  firstSufficientEvidenceTurn?: number,
): RunWasteMetrics {
  const effectiveEvidenceTurn = firstSufficientEvidenceTurn && firstSufficientEvidenceTurn > 0
    ? firstSufficientEvidenceTurn
    : undefined;

  return {
    repeatedQueryCount: countRepeatedQueries(turns),
    verificationRejectionCount,
    turnsAfterSufficientEvidence: effectiveEvidenceTurn
      ? Math.max(0, turns.length - effectiveEvidenceTurn)
      : 0,
    errorTurns: turns.filter((turn) => Boolean(turn.error)).length,
  };
}
