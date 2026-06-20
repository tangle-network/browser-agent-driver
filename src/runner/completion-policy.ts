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
