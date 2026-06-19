// ---------------------------------------------------------------------------
// Evolve loop — audit → generate CSS fixes → inject → re-audit → compare
// ---------------------------------------------------------------------------

import * as fs from 'node:fs'
import * as path from 'node:path'
import chalk from 'chalk'
import type { Page } from 'playwright'
import type { Brain } from '../../../brain/index.js'
import type { DesignFinding, DesignEvolveResult } from '../../../types.js'
import type { PlaywrightDriver } from '../../../drivers/playwright.js'
import type { SupportedProvider } from '../../../provider-defaults.js'
import { auditOnePage } from '../pipeline.js'
import type { resolveAuditPasses } from '../evaluate.js'
import { getTelemetry } from '../../../telemetry/index.js'
import type { PageAuditResult } from '../../../cli-design-audit.js'
import type { ReferenceCommonOpts } from './types.js'

export async function runEvolveLoop(
  brain: Brain,
  driver: PlaywrightDriver,
  page: Page,
  pages: string[],
  profile: string,
  initialResults: PageAuditResult[],
  outputDir: string,
  maxRounds: number,
  auditPasses: ReturnType<typeof resolveAuditPasses>,
  parentRunId?: string,
  provider?: SupportedProvider,
  model?: string,
  referenceCommonOpts?: ReferenceCommonOpts,
): Promise<DesignEvolveResult> {
  const telemetry = parentRunId ? getTelemetry() : undefined
  const initialAvg = initialResults.reduce((s, r) => s + r.score, 0) / initialResults.length
  const scoreHistory: number[] = [initialAvg]
  const appliedFixes: DesignEvolveResult['appliedFixes'] = []
  const skippedFixes: DesignEvolveResult['skippedFixes'] = []
  let cumulativeCSS = ''
  let currentResults = initialResults
  let currentAvg = initialAvg

  console.log('')
  console.log(`  ${chalk.bold('Design Evolve')} — ${maxRounds} rounds max`)
  console.log(`  ${chalk.dim('Initial score:')} ${currentAvg.toFixed(1)}/10`)
  console.log('')

  for (let round = 1; round <= maxRounds; round++) {
    console.log(`  ${chalk.dim(`Round ${round}/${maxRounds}`)}`)

    // Collect all findings with CSS fixes across all pages
    const fixableFixes = currentResults
      .flatMap(r => r.findings)
      .filter(f => f.cssSelector && f.cssFix)

    if (fixableFixes.length === 0) {
      console.log(`  ${chalk.dim('  No CSS-fixable findings — generating fixes via LLM…')}`)
      // Ask the LLM to generate CSS fixes for the top findings
      const topFindings = currentResults
        .flatMap(r => r.findings)
        .filter(f => f.severity === 'critical' || f.severity === 'major')
        .slice(0, 10)

      if (topFindings.length === 0) {
        console.log(`  ${chalk.green('  No major/critical findings remaining')}`)
        break
      }

      const fixPrompt = buildFixGenerationPrompt(topFindings)
      const fixResult = await brain.auditDesign(
        await driver.observe(),
        'Generate CSS fixes for the design issues listed below',
        [],
        fixPrompt,
      )

      // Parse generated fixes
      try {
        let text = fixResult.raw.trim()
        if (text.startsWith('```')) text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
        const start = text.indexOf('{')
        const end = text.lastIndexOf('}')
        if (start >= 0 && end > start) text = text.slice(start, end + 1)
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed.fixes)) {
          for (const fix of parsed.fixes) {
            if (fix.cssSelector && fix.cssFix) {
              fixableFixes.push({
                category: 'ux' as const,
                severity: 'major' as const,
                description: fix.description || '',
                location: fix.location || '',
                suggestion: fix.cssFix,
                cssSelector: fix.cssSelector,
                cssFix: fix.cssFix,
              })
            }
          }
        }
      } catch { /* failed to parse fixes */ }
    }

    if (fixableFixes.length === 0) {
      console.log(`  ${chalk.dim('  Could not generate fixable CSS — stopping')}`)
      break
    }

    // Build CSS override from all fixable findings
    const roundCSS = fixableFixes
      .map(f => `/* ${f.severity}: ${f.description?.slice(0, 80)} */\n${f.cssSelector} { ${f.cssFix} }`)
      .join('\n\n')

    cumulativeCSS += '\n' + roundCSS

    // Track applied fixes
    for (const f of fixableFixes) {
      appliedFixes.push({
        cssSelector: f.cssSelector!,
        cssFix: f.cssFix!,
        finding: f.description,
      })
    }

    console.log(`  ${chalk.dim(`  Applying ${fixableFixes.length} CSS fixes…`)}`)

    // Re-audit each page with CSS injected
    const roundResults: PageAuditResult[] = []
    for (const url of pages) {
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 }).catch(() =>
          page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
        )
        await page.waitForTimeout(1500)

        // Inject cumulative CSS fixes
        await page.addStyleTag({ content: cumulativeCSS })
        await page.waitForTimeout(500)

        // Take screenshot of fixed state
        const screenshotDir = path.join(outputDir, `screenshots-round-${round}`)
        fs.mkdirSync(screenshotDir, { recursive: true })

        const result = (await auditOnePage({
          brain,
          driver,
          page,
          url,
          profileOverride: profile,
          screenshotDir,
          auditPasses,
          ...(parentRunId ? { runId: parentRunId, parentRunId } : {}),
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          ...(referenceCommonOpts ?? {}),
        })) as PageAuditResult
        roundResults.push(result)
      } catch {
        roundResults.push({
          url,
          score: currentAvg,
          summary: 'Re-audit failed',
          strengths: [],
          findings: [],
          error: 'Re-audit with CSS injection failed',
        })
      }
    }

    const roundAvg = roundResults.reduce((s, r) => s + r.score, 0) / roundResults.length
    scoreHistory.push(roundAvg)
    const delta = roundAvg - currentAvg

    const deltaStr = delta >= 0 ? chalk.green(`+${delta.toFixed(1)}`) : chalk.red(delta.toFixed(1))
    console.log(`  ${chalk.dim('  Score:')} ${roundAvg.toFixed(1)}/10 (${deltaStr})`)

    if (telemetry && parentRunId) {
      telemetry.emit({
        kind: 'design-evolve-round',
        runId: parentRunId,
        parentRunId,
        ok: true,
        durationMs: 0, // round-level wall time would require a per-round timer; the parent run captures total duration
        ...(provider && model ? { model: { provider, name: model } } : {}),
        data: {
          mode: 'css',
          round,
          fixesApplied: fixableFixes.length,
        },
        metrics: {
          round,
          beforeScore: currentAvg,
          afterScore: roundAvg,
          delta,
          fixesApplied: fixableFixes.length,
        },
      })
    }

    currentResults = roundResults
    currentAvg = roundAvg

    // Check convergence — if no improvement, stop
    if (delta <= 0.1 && round > 1) {
      console.log(`  ${chalk.dim('  Converged — no further improvement')}`)
      break
    }
  }

  const totalDelta = currentAvg - initialAvg
  const deltaColor = totalDelta >= 2 ? chalk.green : totalDelta > 0 ? chalk.yellow : chalk.red
  console.log('')
  console.log(`  ${chalk.bold('Evolve complete')}`)
  console.log(`  ${chalk.dim('Score:')} ${initialAvg.toFixed(1)} → ${currentAvg.toFixed(1)} (${deltaColor(`+${totalDelta.toFixed(1)}`)})`)
  console.log(`  ${chalk.dim('Rounds:')} ${scoreHistory.length - 1}`)
  console.log(`  ${chalk.dim('Fixes applied:')} ${appliedFixes.length}`)
  console.log('')

  return {
    beforeScore: initialAvg,
    afterScore: currentAvg,
    delta: totalDelta,
    rounds: scoreHistory.length - 1,
    appliedFixes,
    skippedFixes,
    scoreHistory,
    cssOverride: cumulativeCSS.trim(),
  }
}

function buildFixGenerationPrompt(findings: DesignFinding[]): string {
  const findingList = findings.map((f, i) =>
    `${i + 1}. [${f.severity}/${f.category}] ${f.description}\n   Location: ${f.location}\n   Suggestion: ${f.suggestion}`
  ).join('\n')

  return `You are a CSS engineer fixing design issues. For each finding, generate a precise CSS fix.

FINDINGS TO FIX:
${findingList}

RULES:
- Use specific, targeted CSS selectors. Prefer class-based or semantic selectors.
- Each fix should be a single CSS rule (selector + property:value pairs).
- Fixes must not break other elements — be surgical.
- For spacing: use consistent values (multiples of 4 or 8px).
- For colors: ensure WCAG AA contrast (4.5:1 for text, 3:1 for large text).
- For typography: use a limited scale (14px, 16px, 20px, 24px, 32px, 48px).

RESPOND WITH ONLY a JSON object:
{
  "fixes": [
    {
      "cssSelector": "main > section:first-child",
      "cssFix": "padding-bottom: 48px; margin-bottom: 0",
      "description": "Standardize hero section bottom spacing",
      "location": "Hero → features transition"
    }
  ]
}`
}
