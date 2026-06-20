/**
 * Artifact renderers + a thin disk writer.
 *
 * `renderArtifactMarkdown` and `renderArtifactJson` are PURE and deterministic:
 * identical artifacts render identical bytes, so the markdown is snapshot-stable
 * and reproducible across pages/reps. `writeArtifact` is the ONLY IO in this
 * file — a small `fs` wrapper that lands both renderings next to each other.
 *
 * The markdown is the human-facing face of the engine: it names each direction,
 * shows the ASCII layout, the type/colour/motion systems, the information
 * hierarchy and the revised copy, plus the grounding exemplars and the pairwise
 * ranking — everything the lossy `DesignFinding` projection cannot carry.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RedesignArtifact, RedesignDirection, RetrievalResult } from '../contracts.js'
import { clipToWord } from './text.js'

export function renderArtifactMarkdown(a: RedesignArtifact): string {
  const lines: string[] = []
  lines.push(`# Redesign directions — ${a.url}`, '')
  if (a.referenceId) lines.push(`Reference: \`${a.referenceId}\``, '')
  lines.push(
    `Winner: ${a.ranking.winnerId || '—'} · ${a.directions.length} direction(s) · ${a.tokensUsed} tokens`,
    '',
  )

  lines.push('## Grounding exemplars', '')
  if (a.retrieval.length === 0) {
    lines.push('_No exemplars retrieved._', '')
  } else {
    for (const r of a.retrieval) lines.push(renderRetrieval(r))
    lines.push('')
  }

  lines.push('## Ranking', '')
  if (a.ranking.order.length === 0) {
    lines.push('_Unranked._', '')
  } else {
    lines.push('| rank | direction | Bradley-Terry | Elo |', '| --- | --- | --- | --- |')
    a.ranking.order.forEach((id, i) => {
      const bt = a.ranking.bradleyTerry[id]
      const elo = a.ranking.elo[id]
      lines.push(
        `| ${i + 1} | ${id} | ${bt !== undefined ? bt.toFixed(3) : '—'} | ${elo !== undefined ? Math.round(elo) : '—'} |`,
      )
    })
    lines.push('')
  }

  a.directions.forEach((d) => lines.push(renderDirection(d, d.id === a.ranking.winnerId)))

  if (a.verdicts.length > 0) {
    lines.push('## Pairwise verdicts', '')
    for (const v of a.verdicts) {
      const w = v.winner === 'tie' ? 'tie' : v.winner
      const reasons = v.reasons.length ? ` — ${v.reasons.join('; ')}` : ''
      lines.push(`- ${v.aId} vs ${v.bId} → **${w}** (margin ${v.margin.toFixed(2)})${reasons}`)
    }
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Agent-ready "apply this" spec for the WINNING direction — the single coherent,
 * grounded redesign the `--evolve` coding agent should implement (not a pile of
 * piecemeal findings). Names the grounding exemplars so the agent knows the bar.
 */
export function renderRedesignTarget(a: RedesignArtifact): string {
  const winner = a.directions.find((d) => d.id === a.ranking.winnerId) ?? a.directions[0]
  if (!winner) return ''
  const grounded = a.retrieval
    .slice(0, 3)
    .map((r) => r.exemplar.url || r.exemplar.id)
    .filter(Boolean)
    .join(', ')
  const lines: string[] = ['REDESIGN TARGET — implement this single, coherent, world-class direction holistically.']
  if (grounded) lines.push(`Grounded in real reference designs: ${grounded}`)
  lines.push('', renderDirection(winner, true))
  return lines.join('\n')
}

export function renderArtifactJson(a: RedesignArtifact): string {
  return `${JSON.stringify(a, null, 2)}\n`
}

/**
 * A COMPACT projection of the artifact for the main audit report — the winner in
 * brief (rationale + a one-line type/colour/hierarchy signature) plus the names
 * and rationales of the ranked alternates, with a pointer to the full
 * `<slug>.redesign.md`. Pure and deterministic. The full rich brief (ASCII
 * layouts, complete type/colour/motion systems, hierarchy, copy) is
 * `renderArtifactMarkdown`; this is the at-a-glance version that keeps the report
 * scannable while still surfacing every direction by name.
 */
export function renderRedesignDirectionsSummary(a: RedesignArtifact, briefFile?: string): string {
  const lines: string[] = []
  lines.push(`### ${a.url}`, '')
  if (a.referenceId) lines.push(`Grounded in reference \`${a.referenceId}\`.`, '')

  const winner = a.directions.find((d) => d.id === a.ranking.winnerId) ?? a.directions[0]
  if (!winner) {
    lines.push('_No ranked direction was produced._', '')
    return `${lines.join('\n').trimEnd()}\n`
  }

  lines.push(`**Winner — ${winner.name}**`, '')
  if (winner.rationale.trim()) lines.push(clipToWord(winner.rationale, 280), '')
  for (const sig of directionSignature(winner)) lines.push(`- ${sig}`)
  lines.push('')

  const alternates = a.directions.filter((d) => d.id !== winner.id)
  if (alternates.length > 0) {
    lines.push(`**Alternate directions (${alternates.length}):**`, '')
    for (const d of alternates) {
      const why = d.rationale.trim() ? ` — ${clipToWord(d.rationale, 160)}` : ''
      lines.push(`- **${d.name}**${why}`)
    }
    lines.push('')
  }

  if (briefFile) {
    lines.push(`Full brief — ASCII layout, type/colour/motion systems, hierarchy, and copy: \`${briefFile}\``, '')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

/** Compact one-line signatures of a direction's type / colour / hierarchy. */
function directionSignature(d: RedesignDirection): string[] {
  const out: string[] = []
  const t = d.typeSystem
  out.push(
    `Type: ${t.families.join(', ') || '—'} · ${t.scalePx.join('/') || '—'}px${t.ratio ? ` · ~${t.ratio}×` : ''}`,
  )
  const c = d.colorSystem
  out.push(`Colour: ${c.primary}${c.accent ? ` / ${c.accent}` : ''} on ${c.background}`)
  if (d.hierarchy.length > 0) out.push(`Hierarchy: ${clipToWord(d.hierarchy.join(' → '), 160)}`)
  return out
}

/** Stable slug for an audited URL — shared by the brief file name and the report. */
export function artifactSlug(url: string): string {
  return slugForUrl(url)
}

export async function writeArtifact(
  a: RedesignArtifact,
  dir: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await fs.mkdir(dir, { recursive: true })
  const slug = slugForUrl(a.url)
  const jsonPath = path.join(dir, `${slug}.artifact.json`)
  const markdownPath = path.join(dir, `${slug}.artifact.md`)
  await fs.writeFile(jsonPath, renderArtifactJson(a), 'utf8')
  await fs.writeFile(markdownPath, renderArtifactMarkdown(a), 'utf8')
  return { jsonPath, markdownPath }
}

function renderRetrieval(r: RetrievalResult): string {
  const e = r.exemplar
  const reasons = r.reasons.length ? ` — ${r.reasons.join('; ')}` : ''
  return `- \`${e.id}\` (${e.source}, ${e.pageType}) · score ${r.score.toFixed(3)} · elo ${Math.round(e.eloRating)}${reasons}`
}

function renderDirection(d: RedesignDirection, isWinner: boolean): string {
  const lines: string[] = []
  lines.push(`## ${isWinner ? '★ ' : ''}${d.name}`, '')
  if (d.rationale.trim()) lines.push(d.rationale.trim(), '')

  if (d.asciiLayout.trim()) {
    lines.push('### Layout', '', '```', d.asciiLayout.replace(/\n+$/, ''), '```', '')
  }

  if (d.hierarchy.length > 0) {
    lines.push('### Hierarchy', '')
    d.hierarchy.forEach((h, i) => lines.push(`${i + 1}. ${h}`))
    lines.push('')
  }

  const t = d.typeSystem
  lines.push('### Type', '')
  lines.push(`- Families: ${t.families.join(', ') || '—'}`)
  lines.push(`- Scale: ${t.scalePx.join(' / ') || '—'} px`)
  lines.push(`- Ratio: ${t.ratio ? `~${t.ratio}×` : '—'}`)
  if (t.rationale.trim()) lines.push(`- ${t.rationale.trim()}`)
  lines.push('')

  const c = d.colorSystem
  lines.push('### Color', '')
  lines.push(`- Primary: ${c.primary}`)
  if (c.accent) lines.push(`- Accent: ${c.accent}`)
  lines.push(`- Background: ${c.background}`)
  lines.push(`- Neutrals: ${c.neutrals.join(', ') || '—'}`)
  if (c.rationale.trim()) lines.push(`- ${c.rationale.trim()}`)
  lines.push('')

  const m = d.motionSpec
  lines.push('### Motion', '')
  lines.push(`- Durations: ${m.durationsMs.join(' / ') || '—'} ms`)
  lines.push(`- Easings: ${m.easings.join(', ') || '—'}`)
  if (m.cues.length > 0) lines.push(`- Cues: ${m.cues.join('; ')}`)
  lines.push('')

  // Drop no-op revisions (before === after after trim) so the brief's Copy table
  // mirrors the findings projection — a row that changes nothing is noise.
  const copy = d.copy.filter((rev) => rev.before === undefined || rev.before.trim() !== rev.after.trim())
  if (copy.length > 0) {
    lines.push('### Copy', '', '| location | before | after |', '| --- | --- | --- |')
    for (const rev of copy) {
      lines.push(`| ${mdCell(rev.location)} | ${mdCell(rev.before ?? '—')} | ${mdCell(rev.after)} |`)
    }
    lines.push('')
  }

  if (d.groundedInExemplarIds.length > 0) {
    lines.push(`Grounded in: ${d.groundedInExemplarIds.map((id) => `\`${id}\``).join(', ')}`, '')
  }

  return lines.join('\n')
}

function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim() || '—'
}

function slugForUrl(url: string): string {
  const s = url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .toLowerCase()
  return s || 'artifact'
}
