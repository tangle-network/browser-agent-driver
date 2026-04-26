/**
 * Patch renderer — produces a unified diff from a Patch when filePath is known.
 *
 * Agents can pipe the result to `git apply --check` then `git apply`.
 * When filePath is unknown, returns null — the agent must use before/after for
 * search-replace instead.
 */

import type { Patch } from '../v2/types.js'

/**
 * Render a minimal unified diff (1-hunk, 3 lines context) from a patch.
 * Returns null when:
 *   - `target.filePath` is not set (no file to diff against)
 *   - `unifiedDiff` is already set on the patch (prefer the LLM's version)
 */
export function renderUnifiedDiff(patch: Patch): string | null {
  if (patch.diff.unifiedDiff) return patch.diff.unifiedDiff
  if (!patch.target.filePath) return null

  const { before, after } = patch.diff
  const filePath = patch.target.filePath

  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')

  const removals = beforeLines.map(l => `- ${l}`)
  const additions = afterLines.map(l => `+ ${l}`)

  const hunkOldLen = beforeLines.length
  const hunkNewLen = afterLines.length

  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${hunkOldLen} +1,${hunkNewLen} @@`,
    ...removals,
    ...additions,
  ].join('\n')
}

/**
 * Render a human-readable patch summary for display in report.md.
 */
export function renderPatchSummary(patch: Patch): string {
  const parts: string[] = []
  parts.push(`**Patch ${patch.patchId}** (${patch.scope})`)
  if (patch.target.filePath) parts.push(`File: \`${patch.target.filePath}\``)
  else if (patch.target.cssSelector) parts.push(`Selector: \`${patch.target.cssSelector}\``)
  else if (patch.target.componentName) parts.push(`Component: \`${patch.target.componentName}\``)
  parts.push(`\`\`\`diff\n${renderUnifiedDiff(patch) ?? `- ${patch.diff.before}\n+ ${patch.diff.after}`}\n\`\`\``)
  parts.push(`Test: ${patch.testThatProves.description}`)
  if (patch.testThatProves.command) parts.push(`Command: \`${patch.testThatProves.command}\``)
  parts.push(`Rollback: ${patch.rollback.kind}${patch.rollback.instruction ? ` — ${patch.rollback.instruction}` : ''}`)
  parts.push(`Estimated Δ: ${patch.estimatedDelta.dim} ${patch.estimatedDelta.delta > 0 ? '+' : ''}${patch.estimatedDelta.delta} (confidence: ${patch.estimatedDeltaConfidence})`)
  return parts.join('\n')
}
