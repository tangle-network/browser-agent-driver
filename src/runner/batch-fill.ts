/**
 * Batch-fill opportunity detection — injects a "must batch next turn" hint
 * when the agent starts filling a multi-field form one field at a time.
 */

import type { Turn, PageState } from '../types.js'

/**
 * Detect when the agent is filling a multi-field form one input at a time and
 * inject a hint that demands a `fill` batch on the next turn.
 *
 * Trigger conditions (all must hold):
 *   1. The agent's most recent action was a single-step `type` on the
 *      current URL
 *   2. The current snapshot has 2+ unused fillable refs (textbox /
 *      searchbox / combobox) that the agent hasn't typed into yet
 *   3. We haven't already injected this hint in the last turn (to avoid
 *      hint loops if the agent ignores it)
 *
 * The detector fires after one type action when two or more unused fields
 * remain, which catches common two-field-per-step forms before the agent
 * burns extra turns.
 *
 * The hint is high-priority (100) so it survives ctxBudget truncation, and
 * it explicitly lists the unused @refs from the current snapshot so the LLM
 * doesn't have to guess. The injection is gated by BAD_BATCH_HINT=0 for
 * rollback.
 */
export function detectBatchFillOpportunity(turns: Turn[], state: PageState): string | null {
  if (turns.length === 0) return null
  const lastTurn = turns[turns.length - 1]

  // Last action must be a single-step type on the current URL
  if (lastTurn.action.action !== 'type') return null
  if (lastTurn.state.url !== state.url) return null

  // Collect the @refs the agent has typed into across the ENTIRE run on
  // the same URL. The detector should never ask the agent to re-fill a
  // field it already filled, even if the earlier fill happened many
  // turns ago.
  const usedRefs = new Set<string>()
  for (const t of turns) {
    if (t.state.url !== state.url) continue
    const a = t.action
    if (a.action === 'type' && 'selector' in a && typeof a.selector === 'string') {
      usedRefs.add(a.selector)
    }
    if (a.action === 'fill') {
      for (const k of Object.keys(a.fields ?? {})) usedRefs.add(k)
      for (const k of Object.keys(a.selects ?? {})) usedRefs.add(k)
      for (const k of a.checks ?? []) usedRefs.add(k)
    }
  }

  // Find unused fillable refs in the current snapshot. We look for textbox,
  // searchbox, combobox, and spinbutton roles — anything that takes text.
  // Snapshot lines look like: `  - textbox "First name" [ref=t1f2a]`
  const unusedRefs: Array<{ ref: string; name: string; role: string }> = []
  for (const line of state.snapshot.split('\n')) {
    const match = line.match(/\b(textbox|searchbox|combobox|spinbutton)\b[^"]*"([^"]*)"[^[]*\[ref=([^\]]+)\]/i)
    if (!match) continue
    const role = match[1].toLowerCase()
    const name = match[2]
    const ref = `@${match[3]}`
    if (usedRefs.has(ref)) continue
    unusedRefs.push({ ref, name, role })
  }

  // Need at least 2 unused fields to make batching worthwhile
  if (unusedRefs.length < 2) return null

  const refList = unusedRefs
    .slice(0, 12) // cap so we don't explode the prompt
    .map((u) => `  - ${u.ref} (${u.role}: "${u.name}")`)
    .join('\n')

  return `\n[BATCH FILL REQUIRED]\nYou just typed into a single field, but ${unusedRefs.length} more fillable fields are visible on this same form. STOP. Your NEXT action MUST be a \`fill\` action that batches ALL remaining unused fields on this page in one turn. Do not emit another single-step \`type\` — emit \`fill\` with multiple entries.\n\nUnused fillable @refs from the current snapshot (use these in your \`fill.fields\` map):\n${refList}\n\nExample:\n{\"action\":\"fill\",\"fields\":{\"${unusedRefs[0].ref}\":\"value1\",\"${unusedRefs[1].ref}\":\"value2\"}}\n`
}
