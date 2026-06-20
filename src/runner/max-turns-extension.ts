/**
 * One-time max-turns extension decision.
 *
 * Pure: given the current turn and progress signals, decide whether to grant
 * the single budget extension and to what new cap. The caller (the run loop)
 * keeps the side effects — emitting the recovery event and mutating the live
 * cap — so this stays a testable predicate over the loop's budget signals.
 */

import { EXTENSION_TURNS_GRANTED, EXTENSION_HARD_CAP, EXTENSION_PROGRESS_LOOKBACK } from './constants.js';

export function decideMaxTurnsExtension(params: {
  turn: number;
  maxTurns: number;
  extensionGranted: boolean;
  isVisionMode: boolean;
  lastProgressTurn: number;
}): { extendedMax: number; extra: number } | null {
  const { turn, maxTurns, extensionGranted, isVisionMode, lastProgressTurn } = params;
  if (
    !(
      turn === maxTurns
      && !extensionGranted
      && !isVisionMode
      && maxTurns < EXTENSION_HARD_CAP
      && lastProgressTurn >= maxTurns - EXTENSION_PROGRESS_LOOKBACK
    )
  ) {
    return null;
  }
  const extendedMax = Math.min(maxTurns + EXTENSION_TURNS_GRANTED, EXTENSION_HARD_CAP);
  const extra = extendedMax - maxTurns;
  if (extra <= 0) return null;
  return { extendedMax, extra };
}
