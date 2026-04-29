/**
 * Patch generator — Layer 2's second LLM call.
 *
 * The findings prompt (evaluate.ts) stays slim and focused on scoring +
 * findings. After findings exist, this module makes a SECOND LLM call given
 * those major/critical findings and asks for one Patch per finding. The
 * second-call shape is intentionally narrow: only the patch contract +
 * ground-truth snapshot, nothing else. That keeps each call's cognitive load
 * low and lets us measure them independently.
 *
 * Flow:
 *   1. Filter findings to severity ∈ {major, critical}.
 *   2. Build a focused prompt (snapshot + JSON of those findings).
 *   3. Call the LLM, parse + validate the response, attach valid patches
 *      back to their findings by id.
 *
 * On any failure: return findings unchanged. Layer 2 enforcement (downgrade
 * major/critical without a valid patch) runs after this in build-result.ts,
 * so a failed generator → graceful degradation, not a broken pipeline.
 */

import type { Brain } from '../../../brain/index.js'
import type { DesignFinding } from '../score-types.js'
import { parsePatches } from './parse.js'

export const DEFAULT_PATCH_SYNTHESIS_SYSTEM =
  'You are a code-mod author. For each finding below, emit ONE Patch the agent can apply literally. Patches that target HTML or page structure must reference verbatim text in the snapshot. Patches that target source files (CSS/TSX/Tailwind) reference selectors only — the agent verifies them at apply-time against the source.'

export interface PatchSynthesisConfig {
  /** Stable system instruction for the patch-generation call. */
  system: string
  /** Snapshot-grounding and omit rules appended after the schema. */
  groundingRules: string[]
  /** Few-shot or extra examples appended before the final JSON-only instruction. */
  examples?: string[]
}

export const DEFAULT_PATCH_SYNTHESIS_CONFIG: PatchSynthesisConfig = {
  system: DEFAULT_PATCH_SYNTHESIS_SYSTEM,
  groundingRules: [
    'target.scope MUST be "css" by default. Use "html" or "structural" ONLY when you are paste-copying a literal substring from the SNAPSHOT BLOCK above (not from your imagination, not from typical-site assumptions).',
    'Before setting target.scope to "html", verify diff.before is a verbatim substring of the snapshot block above. If it is not, change target.scope to "css".',
    'For css / tsx / jsx / tailwind / module-css / styled-component scopes, diff.before is a source-file fragment the agent resolves at apply-time; the audit does not validate it. This is the safe default.',
    'If a finding does not admit a clean patch, OMIT it (do not invent diffs).',
  ],
}

export interface GeneratePatchesOptions {
  brain: Brain
  /** Page snapshot (accessibility tree). */
  snapshot: string
  /** Findings from the first LLM call. Only major/critical get patches. */
  findings: DesignFinding[]
  /** Hard cap on the number of findings to send to the LLM. Default 8 — top
   *  major/critical by ROI; cheaper to skip stragglers than blow the prompt. */
  maxFindings?: number
  /** Evolve/GEPA override for the patch synthesis signature. */
  config?: PatchSynthesisConfig
}

export interface GeneratePatchesResult {
  /** Findings with `rawPatches` populated for those that got a patch back. */
  findings: DesignFinding[]
  /** LLM tokens consumed by the patch call. */
  tokensUsed: number
  /** Per-finding diagnostics for telemetry / debugging. */
  notes: Array<{ findingId: string; reason: string }>
}

const DEFAULT_MAX = 8

export async function generatePatches(opts: GeneratePatchesOptions): Promise<GeneratePatchesResult> {
  const max = opts.maxFindings ?? DEFAULT_MAX
  const eligible = opts.findings
    .filter(f => f.severity === 'major' || f.severity === 'critical')
    .slice(0, max)
  if (eligible.length === 0) {
    return { findings: opts.findings, tokensUsed: 0, notes: [] }
  }

  const config = opts.config ?? DEFAULT_PATCH_SYNTHESIS_CONFIG
  const prompt = buildPrompt(opts.snapshot, eligible, config)
  let raw = ''
  let tokensUsed = 0
  try {
    const llm = await opts.brain.complete(config.system, prompt, { maxOutputTokens: 2000 })
    raw = llm.text ?? ''
    tokensUsed = llm.tokensUsed ?? 0
  } catch (err) {
    return {
      findings: opts.findings,
      tokensUsed: 0,
      notes: [{ findingId: '*', reason: `LLM call failed: ${(err as Error).message}` }],
    }
  }

  const parsed = parseGeneratorResponse(raw)
  const byFinding = new Map<string, unknown>()
  for (const item of parsed.items) {
    if (item.findingId) byFinding.set(item.findingId, item.patch)
  }

  const notes: Array<{ findingId: string; reason: string }> = []
  const updated: DesignFinding[] = opts.findings.map(f => {
    const patchRaw = byFinding.get(f.id)
    if (!patchRaw) {
      if (f.severity === 'major' || f.severity === 'critical') {
        notes.push({ findingId: f.id, reason: 'no patch in generator response' })
      }
      return f
    }
    // Stamp the canonical findingId onto the patch (LLM may have used a placeholder).
    const stamped = withFindingId(patchRaw, f.id)
    // Quick parse check so the build-result stage sees a sane shape.
    const parsedOne = parsePatches([stamped])
    if (parsedOne.patches.length === 0) {
      notes.push({ findingId: f.id, reason: `parse failed: ${parsedOne.errors[0]?.reason ?? 'unknown'}` })
      return f
    }
    return { ...f, rawPatches: [stamped] }
  })

  return { findings: updated, tokensUsed, notes }
}

function buildPrompt(snapshot: string, findings: DesignFinding[], config: PatchSynthesisConfig): string {
  // Trim the snapshot to keep the prompt cheap. The findings reference visible
  // elements; trimming should not cost meaningful context.
  const trimmedSnapshot = snapshot.length > 8000 ? snapshot.slice(0, 8000) + '\n…[truncated]' : snapshot
  const findingsBlock = findings.map(f => ({
    id: f.id,
    severity: f.severity,
    description: f.description,
    location: f.location,
    cssSelector: f.cssSelector,
    suggestion: f.suggestion,
  }))

  return `PAGE SNAPSHOT (accessibility-tree text):
${trimmedSnapshot}

FINDINGS THAT NEED A PATCH (one per id):
${JSON.stringify(findingsBlock, null, 2)}

For each finding above, emit ONE Patch object. Required shape:
{
  "patchId": "p-<short-stable-id>",
  "findingId": "<copy verbatim from the finding>",
  "scope": "page" | "section" | "component" | "system",
  "target": {
    "scope": "css" | "tsx" | "jsx" | "tailwind" | "module-css" | "styled-component" | "html" | "structural",
    "cssSelector": "...",  // OR
    "filePath": "...",     // OR
    "componentName": "..." // at least ONE must be set
  },
  "diff": {
    "before": "<verbatim text the agent will search-replace>",
    "after":  "<replacement text>"
  },
  "testThatProves": { "kind": "rerun-audit" | "visual-snapshot" | "a11y-rule" | "storybook" | "unit" | "manual", "description": "..." },
  "rollback": { "kind": "css-disable" | "git-revert" | "manual" },
  "estimatedDelta": { "dim": "product_intent" | "visual_craft" | "trust_clarity" | "workflow" | "content_ia", "delta": -3..3 },
  "estimatedDeltaConfidence": "high" | "medium" | "low" | "untested"
}

Snapshot-anchoring rule (READ CAREFULLY — most patch failures fail this):
${config.groundingRules.map((rule) => `- ${rule}`).join('\n')}
${config.examples?.length ? `\nEXAMPLES:\n${config.examples.join('\n\n')}\n` : ''}

RESPOND WITH ONLY a JSON object:
{
  "patches": [
    { "findingId": "<id>", "patch": <the Patch object above> }
  ]
}`
}

interface ParsedItem {
  findingId: string
  patch: unknown
}

function parseGeneratorResponse(raw: string): { items: ParsedItem[] } {
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { items: [] }
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as { patches?: unknown }
    if (!Array.isArray(obj.patches)) return { items: [] }
    const items: ParsedItem[] = []
    for (const p of obj.patches) {
      if (!p || typeof p !== 'object') continue
      const rec = p as { findingId?: unknown; patch?: unknown }
      if (typeof rec.findingId !== 'string') continue
      items.push({ findingId: rec.findingId, patch: rec.patch ?? p })
    }
    return { items }
  } catch {
    return { items: [] }
  }
}

function withFindingId(raw: unknown, findingId: string): unknown {
  if (raw && typeof raw === 'object') {
    return { ...(raw as Record<string, unknown>), findingId }
  }
  return raw
}
