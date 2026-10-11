/**
 * Completion-result policy — decides whether a planner-emitted complete.result
 * is a fabricated placeholder and whether runScript output is usable enough to
 * auto-complete on. The plan executor and the per-action loop both consult these.
 */

/**
 * Detect placeholder patterns in a planner-generated complete.result.
 *
 * The planner has to commit to its `complete.result` text BEFORE any prior
 * runScript step actually runs, so on extraction tasks it fabricates
 * placeholders. We detect those patterns and substitute the runScript
 * output (deterministic, no extra LLM call).
 *
 * Patterns we catch:
 *   - JSON `null` literals (e.g. `{"x": null, "y": null}`)
 *   - "<from prior step>", "<placeholder>", "<value from ...>", "<extracted ...>", "<observed ...>"
 *   - "{{...}}" template markers
 *
 * Conservative on purpose — we only substitute when the planner clearly
 * didn't know real values at planning time. A complete.result that contains
 * actual data (no nulls, no placeholder markers) passes through unchanged.
 */
export function hasPlaceholderPattern(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  if (/<from prior step>|<placeholder>|<value from|<extracted|<observed|<previous step|<runscript output>/i.test(text)) {
    return true
  }
  if (/\{\{[^}]+\}\}/.test(text)) {
    return true
  }
  // JSON-shape detection: a result that parses as JSON and contains null
  // values is almost always a planner-fabricated extraction shell. Pure
  // strings with the word "null" elsewhere don't match because we look
  // for the JSON null literal pattern (`: null` or `[null`).
  if (/:\s*null\b|\[\s*null\b/.test(text)) {
    return true
  }
  return false
}

/** Returns true only when runScript output contains usable extracted data. */
export function isMeaningfulRunScriptOutput(output: string | null | undefined): boolean {
  if (typeof output !== 'string') return false
  const trimmed = output.trim()
  if (trimmed.length === 0) return false
  if (trimmed === 'null' || trimmed === 'undefined' || trimmed === '""' || trimmed === "''") return false
  // Empty JSON shells: `{}`, `[]`, `{"x": null}`, `[null, null]`
  if (trimmed === '{}' || trimmed === '[]') return false
  if (hasPlaceholderPattern(trimmed)) return false
  // If the output parses as JSON and EVERY top-level value is null/empty,
  // treat it as not meaningful. This catches `{"x": null, "y": ""}` even
  // though the placeholder regex would already catch the null one.
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const values = Object.values(parsed)
      if (values.length > 0) {
        const allEmpty = values.every(
          (v) => v === null || v === undefined || v === '' || v === 0,
        )
        if (allEmpty) return false
      }
    }
    if (Array.isArray(parsed) && parsed.length === 0) return false
  } catch {
    // Not JSON, that's fine — fall through to "meaningful" if we got here.
  }
  return true
}

/**
 * Terminal-action guarantee for the final turn.
 *
 * The model occasionally spends its last turn on another extraction action
 * even though the answer is already on the evidence ledger — the run then
 * dies at max turns with `result: "Max turns reached"` and the data on the
 * floor (both lost hn-top-story-score reps in the 2026-10-11 bench were
 * this: turnsAfterSufficientEvidence=2). When that happens, complete from
 * the most recent SCRIPT RESULT instead of executing the non-terminal
 * action.
 *
 * Conservative by construction: only fires on the final turn, only for
 * non-terminal actions, only when a meaningful script result exists.
 * Returns the original action untouched in every other case.
 */
export function synthesizeFinalTurnCompletion<T extends { action: string }>(
  action: T,
  goalVerificationEvidence: string[],
  isFinalTurn: boolean,
): { action: T | { action: 'complete'; result: string }; synthesized: boolean } {
  if (!isFinalTurn) return { action, synthesized: false }
  if (action.action === 'complete' || action.action === 'abort') return { action, synthesized: false }
  const evidence = [...goalVerificationEvidence]
    .reverse()
    .find((e) => e.startsWith('SCRIPT RESULT:'))
  if (!evidence) return { action, synthesized: false }
  const result = evidence.slice('SCRIPT RESULT:'.length).trim()
  if (!isMeaningfulRunScriptOutput(result)) return { action, synthesized: false }
  return { action: { action: 'complete', result }, synthesized: true }
}

/**
 * Evidence-corroborated completion: every top-level field of the claimed
 * result JSON appears in at least one SCRIPT RESULT JSON with an equal,
 * non-empty value.
 *
 * The over-conservatism fix (bench wave 1: hn rep3 completed with the
 * correct JSON at turn 5 and was re-prompted three times before the LLM
 * verifier accepted — $0.087 for one pass). When the claim is a faithful
 * echo of deterministic DOM evidence, hallucination is impossible by
 * construction; re-asking an LLM to confirm it is pure cost.
 *
 * Conservative shape: BOTH sides must parse as flat JSON objects, the
 * claim must have ≥1 key, and EVERY claimed key must match a script-result
 * value exactly (string-normalized). Nested objects compare via JSON.
 */
export function evidenceCorroboratesResult(
  claimedResult: string,
  goalVerificationEvidence: string[],
): boolean {
  const claim = parseFlatJsonObject(claimedResult);
  if (!claim) return false;
  const scriptObjects = goalVerificationEvidence
    .filter((e) => e.startsWith('SCRIPT RESULT:'))
    .map((e) => parseFlatJsonObject(e.slice('SCRIPT RESULT:'.length).trim()))
    .filter((o): o is Record<string, unknown> => o !== null);
  if (scriptObjects.length === 0) return false;
  return Object.entries(claim).every(([key, value]) => {
    if (value === null || value === undefined || value === '') return false;
    return scriptObjects.some(
      (obj) => key in obj && String(obj[key]) === String(value) && obj[key] !== null && obj[key] !== '',
    );
  });
}

function parseFlatJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      return keys.length > 0 ? parsed as Record<string, unknown> : null;
    }
  } catch { /* not JSON */ }
  return null;
}
