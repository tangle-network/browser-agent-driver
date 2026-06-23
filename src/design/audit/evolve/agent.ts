// ---------------------------------------------------------------------------
// Agent-dispatched evolve — sends findings to a coding agent that edits source
// ---------------------------------------------------------------------------

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import chalk from 'chalk'
import type { Page } from 'playwright'
import type { Brain } from '../../../brain/index.js'
import type { DesignEvolveResult } from '../../../types.js'
import type { PlaywrightDriver } from '../../../drivers/playwright.js'
import type { SupportedProvider } from '../../../provider-defaults.js'
import { cliError } from '../../../cli-ui.js'
import { auditOnePage } from '../pipeline.js'
import type { resolveAuditPasses } from '../evaluate.js'
import { getTelemetry } from '../../../telemetry/index.js'
import type { PageAuditResult } from '../../../cli-design-audit.js'
import type { ReferenceCommonOpts } from './types.js'

// Type-only — erased at runtime; the reference engine is loaded lazily, and only
// when a reference-grounded run is requested (default audits never touch it).
import type { RedesignArtifact } from '../reference/index.js'

const AGENT_COMMANDS: Record<string, (prompt: string, projectDir: string) => string[]> = {
  'claude-code': (prompt, dir) => ['claude', '-p', prompt, '--dangerously-skip-permissions', '--add-dir', dir],
  'codex': (prompt, dir) => ['codex', 'exec', prompt, '-c', `cwd="${dir}"`],
  'opencode': (prompt, dir) => ['opencode', 'run', prompt],
}

export function resolveAgentCommand(agent: string, prompt: string, projectDir: string): { cmd: string; args: string[]; cwd: string } {
  const builder = AGENT_COMMANDS[agent]
  if (builder) {
    const [cmd, ...args] = builder(prompt, projectDir)
    return { cmd, args, cwd: projectDir }
  }
  // Custom command — treat the agent string as a command template
  // e.g. "aider --message" becomes: aider --message "<prompt>"
  const parts = agent.split(/\s+/)
  return { cmd: parts[0], args: [...parts.slice(1), prompt], cwd: projectDir }
}

function buildAgentFixPrompt(results: PageAuditResult[], profile: string, round: number, redesignTarget?: string): string {
  const allFindings = results.flatMap(r => r.findings)
  const critical = allFindings.filter(f => f.severity === 'critical')
  const major = allFindings.filter(f => f.severity === 'major')
  const minor = allFindings.filter(f => f.severity === 'minor')

  const findingsList = [...critical, ...major, ...minor.slice(0, 5)]
    .map((f, i) => {
      let entry = `${i + 1}. [${f.severity}/${f.category}] ${f.description}`
      entry += `\n   Location: ${f.location}`
      entry += `\n   Suggestion: ${f.suggestion}`
      if (f.cssSelector) entry += `\n   CSS Selector: ${f.cssSelector}`
      if (f.cssFix) entry += `\n   CSS Fix: ${f.cssFix}`
      return entry
    })
    .join('\n\n')

  const scoreBreakdowns = results
    .filter(r => r.designSystemScore)
    .map(r => {
      const ds = r.designSystemScore!
      return `  ${r.url}: ${Object.entries(ds).map(([k, v]) => `${k}=${v}`).join(', ')}`
    })
    .join('\n')

  // Reference-grounded: lead with the coherent redesign TARGET (the winning
  // direction, grounded in world-class exemplars) so the agent implements a
  // cohesive redesign, with findings as secondary issues. Absent in v1.
  const intro = redesignTarget
    ? `You are applying a world-class, reference-grounded REDESIGN to a real app's source code.

${redesignTarget}

Realize the REDESIGN TARGET above as a COHERENT SYSTEM — its type scale, colour tokens, layout structure, motion, hierarchy, and copy — adapted to this project's stack, using only the app's REAL content. The findings below are secondary issues to also resolve as you redesign.`
    : `You are fixing design issues found by an automated design audit.`

  return `${intro}

AUDIT PROFILE: ${profile}
ROUND: ${round} (${round === 1 ? 'initial fixes' : 'fixing remaining issues from previous round'})
CURRENT SCORES:
  Overall: ${(results.reduce((s, r) => s + r.score, 0) / results.length).toFixed(1)}/10
${scoreBreakdowns}

FINDINGS ${redesignTarget ? '(secondary — resolve while you redesign)' : 'TO FIX'} (${critical.length} critical, ${major.length} major, ${minor.length} minor):

${findingsList}

INSTRUCTIONS:
1. Read the project's source files to understand the styling approach (Tailwind, CSS modules, plain CSS, styled-components, etc.)
2. ${redesignTarget ? 'Implement the redesign target by editing the ACTUAL SOURCE FILES' : 'Fix the findings by editing the ACTUAL SOURCE FILES'} — not by creating new CSS override files
3. Match the project's existing styling conventions and stack
4. Work at the design-SYSTEM level (shared components, tokens, globals) — not one-off instances
5. ${redesignTarget ? 'Realise the type scale, colour tokens, layout, motion and copy cohesively, not piecemeal' : 'Prioritize critical and major findings'}
6. Only change visual/styling/layout/copy — never change business logic, state, or event handlers
7. After making changes, verify the dev server is still running (no build errors)

Do NOT:
- Create new standalone CSS override files — edit the existing styles
- Add comments explaining what you changed — just change it
- Refactor unrelated code
- Change component structure or HTML semantics unless a finding specifically requires it
- Invent content the app does not already have — no fabricated data, metrics, counts, timestamps, activity feeds, or made-up sections. Restyle and restructure the real content only; if a section would be empty, leave it out rather than filling it with placeholder facts`
}

/**
 * The self-contained implementation prompt a CODING AGENT (Claude Code, Codex,
 * Cursor, …) reads and executes to apply the reference-grounded redesign in its
 * OWN project — the default, non-spawning output of a reference-grounded audit
 * (the agent calls `bad`, not the other way around). Same content as the
 * spawn-mode round-1 prompt, surfaced as a portable, re-usable artifact.
 */
export function buildApplyPrompt(
  results: PageAuditResult[],
  profile: string | undefined,
  redesignTarget?: string,
): string {
  return buildAgentFixPrompt(results, profile ?? 'auto', 1, redesignTarget)
}

export async function runAgentEvolveLoop(
  brain: Brain,
  driver: PlaywrightDriver,
  page: Page,
  pages: string[],
  profile: string,
  initialResults: PageAuditResult[],
  outputDir: string,
  maxRounds: number,
  agentName: string,
  projectDir: string,
  debug?: boolean,
  auditPasses?: ReturnType<typeof resolveAuditPasses>,
  parentRunId?: string,
  provider?: SupportedProvider,
  model?: string,
  referenceCommonOpts?: ReferenceCommonOpts,
): Promise<DesignEvolveResult> {
  const telemetry = parentRunId ? getTelemetry() : undefined
  const initialAvg = initialResults.reduce((s, r) => s + r.score, 0) / initialResults.length
  const scoreHistory: number[] = [initialAvg]
  const appliedFixes: DesignEvolveResult['appliedFixes'] = []
  let currentResults = initialResults
  let currentAvg = initialAvg

  const resolvedProjectDir = path.resolve(projectDir)
  if (!fs.existsSync(resolvedProjectDir)) {
    cliError(`project directory not found: ${resolvedProjectDir}`)
    process.exit(1)
  }

  console.log('')
  console.log(`  ${chalk.bold('Design Evolve')} ${chalk.dim('via')} ${chalk.cyan(agentName)}`)
  console.log(`  ${chalk.dim('Project:')} ${resolvedProjectDir}`)
  console.log(`  ${chalk.dim('Initial score:')} ${currentAvg.toFixed(1)}/10`)
  console.log(`  ${chalk.dim('Max rounds:')} ${maxRounds}`)
  console.log('')

  for (let round = 1; round <= maxRounds; round++) {
    console.log(`  ${chalk.dim(`Round ${round}/${maxRounds}`)}`)

    // Reference-grounded: render the winning redesign direction so the agent
    // prompt leads with a coherent, grounded TARGET (not just findings). Lazy
    // import keeps the v1 path from loading the engine; best-effort.
    let redesignTarget: string | undefined
    const artifactResult = currentResults.find((r) => (r as { referenceArtifact?: unknown }).referenceArtifact)
    if (artifactResult) {
      try {
        const { renderRedesignTarget } = await import('../reference/index.js')
        redesignTarget = renderRedesignTarget(
          (artifactResult as { referenceArtifact: RedesignArtifact }).referenceArtifact,
        )
      } catch {
        // fall back to the findings-only prompt
      }
    }

    // Build the prompt for the agent
    const prompt = buildAgentFixPrompt(currentResults, profile, round, redesignTarget)

    // Write the prompt to a file for debugging
    const promptPath = path.join(outputDir, `agent-prompt-round-${round}.txt`)
    fs.writeFileSync(promptPath, prompt)

    // Also write the full report JSON so the agent could read it
    const findingsPath = path.join(outputDir, `findings-round-${round}.json`)
    fs.writeFileSync(findingsPath, JSON.stringify({
      round,
      score: currentAvg,
      results: currentResults.map(r => ({
        url: r.url,
        score: r.score,
        designSystemScore: r.designSystemScore,
        findings: r.findings,
      })),
    }, null, 2))

    // Dispatch to the coding agent
    const { cmd, args, cwd } = resolveAgentCommand(agentName, prompt, resolvedProjectDir)

    console.log(`  ${chalk.dim(`  Dispatching to ${agentName}…`)}`)
    if (debug) {
      console.log(`  ${chalk.dim(`  cmd: ${cmd} ${args.map(a => a.length > 80 ? a.slice(0, 80) + '…' : a).join(' ')}`)}`)
    }

    try {
      // execFileSync passes argv directly to the binary — NO shell. The prompt
      // contains text mined from the audited DOM (findings, copy revisions), so
      // building a shell string + JSON.stringify would let a hostile page inject
      // `$(...)`/backtick command substitution (bash evaluates those inside the
      // double quotes JSON.stringify emits). Argv passing closes that vector.
      const result = execFileSync(cmd, args, {
        cwd,
        stdio: debug ? 'inherit' : 'pipe',
        timeout: 300_000, // 5min max per agent round
        env: { ...process.env },
        maxBuffer: 64 * 1024 * 1024,
      })

      if (!debug && result) {
        const agentOutputPath = path.join(outputDir, `agent-output-round-${round}.txt`)
        fs.writeFileSync(agentOutputPath, result.toString())
      }

      console.log(`  ${chalk.dim('  Agent completed')}`)
    } catch (err) {
      const exitCode = (err as { status?: number }).status ?? 'unknown'
      console.log(`  ${chalk.yellow(`  Agent exited with code ${exitCode} — continuing with re-audit`)}`)

      // Write stderr if available
      const stderr = (err as { stderr?: Buffer }).stderr
      if (stderr) {
        const errPath = path.join(outputDir, `agent-error-round-${round}.txt`)
        fs.writeFileSync(errPath, stderr.toString())
      }
    }

    // Wait for hot reload to settle
    console.log(`  ${chalk.dim('  Waiting for hot reload…')}`)
    await new Promise(resolve => setTimeout(resolve, 5000))

    // Re-audit
    console.log(`  ${chalk.dim('  Re-auditing…')}`)
    const roundResults: PageAuditResult[] = []
    const roundScreenshotDir = path.join(outputDir, `screenshots-round-${round}`)
    fs.mkdirSync(roundScreenshotDir, { recursive: true })

    for (const url of pages) {
      const result = (await auditOnePage({
        brain,
        driver,
        page,
        url,
        profileOverride: profile,
        screenshotDir: roundScreenshotDir,
        auditPasses,
        ...(parentRunId ? { runId: parentRunId, parentRunId } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(referenceCommonOpts ?? {}),
      })) as PageAuditResult
      roundResults.push(result)
    }

    const roundAvg = roundResults.reduce((s, r) => s + r.score, 0) / roundResults.length
    scoreHistory.push(roundAvg)
    const delta = roundAvg - currentAvg

    const deltaStr = delta >= 0 ? chalk.green(`+${delta.toFixed(1)}`) : chalk.red(delta.toFixed(1))
    console.log(`  ${chalk.dim('  Score:')} ${roundAvg.toFixed(1)}/10 (${deltaStr})`)

    // Track what changed
    const prevFindingCount = currentResults.flatMap(r => r.findings).length
    const newFindingCount = roundResults.flatMap(r => r.findings).length
    const resolvedCount = Math.max(0, prevFindingCount - newFindingCount)
    if (resolvedCount > 0) {
      appliedFixes.push({
        cssSelector: `round-${round}`,
        cssFix: `${agentName} resolved ${resolvedCount} findings`,
        finding: `Score: ${currentAvg.toFixed(1)} → ${roundAvg.toFixed(1)}`,
      })
    }

    if (telemetry && parentRunId) {
      telemetry.emit({
        kind: 'design-evolve-round',
        runId: parentRunId,
        parentRunId,
        ok: true,
        durationMs: 0,
        ...(provider && model ? { model: { provider, name: model } } : {}),
        data: {
          mode: `agent:${agentName}`,
          round,
          resolvedCount,
        },
        metrics: {
          round,
          beforeScore: currentAvg,
          afterScore: roundAvg,
          delta,
          findingsResolved: resolvedCount,
        },
      })
    }

    currentResults = roundResults
    currentAvg = roundAvg

    // Check convergence
    if (delta <= 0.1 && round > 1) {
      console.log(`  ${chalk.dim('  Converged — no further improvement')}`)
      break
    }
  }

  const totalDelta = currentAvg - initialAvg
  const deltaColor = totalDelta >= 2 ? chalk.green : totalDelta > 0 ? chalk.yellow : chalk.red
  console.log('')
  console.log(`  ${chalk.bold('Evolve complete')} ${chalk.dim('via')} ${chalk.cyan(agentName)}`)
  console.log(`  ${chalk.dim('Score:')} ${initialAvg.toFixed(1)} → ${currentAvg.toFixed(1)} (${deltaColor(totalDelta >= 0 ? `+${totalDelta.toFixed(1)}` : totalDelta.toFixed(1))})`)
  console.log(`  ${chalk.dim('Rounds:')} ${scoreHistory.length - 1}`)
  console.log('')

  return {
    beforeScore: initialAvg,
    afterScore: currentAvg,
    delta: totalDelta,
    rounds: scoreHistory.length - 1,
    appliedFixes,
    skippedFixes: [],
    scoreHistory,
    cssOverride: '', // no CSS override in agent mode — agent edited source directly
  }
}
