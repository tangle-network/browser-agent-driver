/**
 * `bad preview` — plan-only mode, no execution.
 *
 * `terraform plan` for browser agents. Given a goal + URL, launch a
 * browser, observe the page once, ask the Brain's planner to emit a
 * full structured plan, render it as a dry-run tree, then EXIT without
 * executing a single action.
 *
 * Use cases:
 *   - Regulated workflows where BSA / compliance needs to review the
 *     agent's intent before execution
 *   - Pre-flight for expensive long runs ("will this agent do the
 *     right thing? let me see the plan first")
 *   - Debugging — which approach is the agent taking?
 *
 * Library-friendly: throws `PreviewError`; CLI dispatcher catches.
 *
 * Implementation: reuses BrowserAgent.brain.plan() — the planner is
 * already a first-class concept in the runner. We just never hand the
 * plan to the executor.
 */

import * as fs from 'node:fs'
import chalk from 'chalk'
import type { Plan } from './types.js'

export class PreviewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreviewError'
  }
}

export interface PreviewOptions {
  goal: string
  url: string
  model?: string
  provider?: string
  apiKey?: string
  baseUrl?: string
  /** Write the plan as JSON to this path in addition to printing it. */
  output?: string
  /** Emit JSON on stdout (pipe-friendly). */
  json?: boolean
  /** Cap on plan steps. Default 12. */
  maxSteps?: number
  /** Headed browser (default: headless). Useful when you want to see the page the plan is built against. */
  headed?: boolean
}

export interface PreviewResult {
  goal: string
  url: string
  plan: Plan | null
  raw: string
  parseError?: string
  tokensUsed?: number
  durationMs: number
}

/**
 * Run the planner against a single observation of the URL. Never
 * executes an action. Returns the structured plan + raw model output.
 */
async function runPreview(opts: PreviewOptions): Promise<PreviewResult> {
  if (!opts.goal) throw new PreviewError('preview requires --goal "..."')
  if (!opts.url) throw new PreviewError('preview requires --url "..."')

  // Lazy-load the heavy surface — browser, brain, driver. Keeps
  // `bad --help` snappy for users who never run preview.
  const { chromium } = await import('playwright')
  const { Brain } = await import('./brain/index.js')
  const { PlaywrightDriver } = await import('./drivers/playwright.js')

  const startedAt = Date.now()
  const browser = await chromium.launch({ headless: !opts.headed })
  let result: PreviewResult
  try {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const driver = new PlaywrightDriver(page, { captureScreenshots: false })
    const state = await driver.observe()

    const brain = new Brain({
      provider: (opts.provider as 'openai' | 'anthropic' | 'google' | undefined) ?? undefined,
      model: opts.model,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
    })

    const planResult = await brain.plan(opts.goal, state, { maxSteps: opts.maxSteps ?? 12 })
    result = {
      goal: opts.goal,
      url: opts.url,
      plan: planResult.plan,
      raw: planResult.raw,
      parseError: planResult.parseError,
      tokensUsed: planResult.tokensUsed,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    await browser.close().catch(() => { /* best-effort */ })
  }
  return result
}

/** Print a plan as a tree to stdout (human-readable). */
function renderPreview(result: PreviewResult): void {
  const G = chalk.green
  const D = chalk.dim
  const C = chalk.cyan
  const Y = chalk.yellow
  const R = chalk.red

  console.log('')
  console.log(`  ${chalk.bold('Goal:')} ${result.goal}`)
  console.log(`  ${chalk.bold('URL:')}  ${result.url}`)
  console.log(`  ${D(`planned in ${result.durationMs}ms${result.tokensUsed ? ` · ${result.tokensUsed} tokens` : ''}`)}`)
  console.log('')

  if (!result.plan) {
    console.log(`  ${R('✗ No structured plan returned.')}`)
    if (result.parseError) console.log(`  ${D('parse error:')} ${result.parseError}`)
    console.log('')
    console.log(`  ${D('Raw model output:')}`)
    console.log(indent(result.raw, '    '))
    return
  }
  const plan = result.plan
  const n = plan.steps.length
  console.log(`  ${G(`✓ Plan: ${n} step${n === 1 ? '' : 's'}`)}`)
  if (plan.reasoning) console.log(`  ${D('strategy:')} ${plan.reasoning}`)
  console.log('')

  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i]
    const action = s.action
    const verb = action.action
    const target = (() => {
      switch (verb) {
        case 'click': return (action as { selector: string }).selector
        case 'type': return `${(action as { selector: string; text: string }).selector} ← ${C(`"${(action as { text: string }).text}"`)}`
        case 'press': return `${(action as { selector: string; key: string }).selector} ← ${Y((action as { key: string }).key)}`
        case 'navigate': return (action as { url: string }).url
        default: return ''
      }
    })()
    const num = String(i + 1).padStart(String(n).length, ' ')
    console.log(`  ${D(num + '.')} ${C(verb)}${target ? '  ' + target : ''}`)
    if (s.rationale) console.log(`       ${D(s.rationale)}`)
    if (s.expectedEffect) console.log(`       ${D('→ verify:')} ${s.expectedEffect}`)
  }
  if (plan.finalResult) {
    console.log('')
    console.log(`  ${G('complete:')} ${plan.finalResult}`)
  }
  console.log('')
}

export async function handlePreviewCommand(opts: PreviewOptions): Promise<PreviewResult> {
  const result = await runPreview(opts)
  if (opts.output) {
    fs.writeFileSync(opts.output, JSON.stringify(result, null, 2))
  }
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    renderPreview(result)
  }
  return result
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map((l) => prefix + l).join('\n')
}
