/**
 * CLI rendering — colors, spinners, progress display.
 *
 * Zero external deps beyond chalk. Spinner is custom (no ora needed).
 * Degrades gracefully: colors off when piped, spinner disabled in non-TTY.
 */

import chalk from 'chalk'

// ── Formatting ──

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`
}

export function cliError(msg: string): void {
  console.error(`  ${chalk.red('error:')} ${msg}`)
}

export function cliWarn(msg: string): void {
  console.warn(`  ${chalk.yellow('warn:')} ${msg}`)
}

export function cliLog(prefix: string, msg: string): void {
  console.log(`  ${chalk.dim(`[${prefix}]`)} ${msg}`)
}

// ── Spinner ──

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
let cursorHookInstalled = false

class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null
  private frame = 0
  private text = ''
  private textFn?: () => string

  constructor() {
    if (process.stdout.isTTY && !cursorHookInstalled) {
      cursorHookInstalled = true
      process.on('exit', () => process.stdout.write('\x1B[?25h'))
    }
  }

  get running(): boolean { return this.timer !== null }

  start(text: string): void {
    if (!process.stdout.isTTY) return
    this.textFn = undefined
    this.text = text
    process.stdout.write('\x1B[?25l')
    this.tick()
    this.timer = setInterval(() => this.tick(), 80)
  }

  /** Start with a dynamic text function — re-evaluated every tick for live updates */
  startDynamic(fn: () => string): void {
    if (!process.stdout.isTTY) return
    this.textFn = fn
    this.text = fn()
    process.stdout.write('\x1B[?25l')
    this.tick()
    this.timer = setInterval(() => this.tick(), 80)
  }

  update(text: string): void {
    this.textFn = undefined
    this.text = text
  }

  updateDynamic(fn: () => string): void {
    this.textFn = fn
  }

  /** Clear spinner line — call before console.log to avoid collision */
  clear(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    if (process.stdout.isTTY) process.stdout.write('\r\x1B[K')
  }

  stop(): void {
    this.clear()
    this.text = ''
    this.textFn = undefined
  }

  private tick(): void {
    if (this.textFn) this.text = this.textFn()
    const f = FRAMES[this.frame++ % FRAMES.length]
    process.stdout.write(`\r\x1B[K  ${f} ${this.text}`)
  }
}

// ── Renderer ──

export class CliRenderer {
  private spinner = new Spinner()
  private active = new Map<string, { name: string; turn?: number; action?: string; startedAt: number }>()
  private done = 0
  private total = 0
  private totalTurns = 0
  private showDebug: boolean

  constructor(opts?: { debug?: boolean }) {
    this.showDebug = opts?.debug ?? false
  }

  // ── Banner ──

  banner(opts: {
    version: string
    provider: string
    model: string
    browser: string
    testCount: number
    concurrency: number
    mode?: string
    profile?: string
    adaptiveRouting?: { navProvider: string; navModel: string }
    outputDir: string
  }): void {
    const { version, provider, model, browser, testCount, concurrency, mode, profile, adaptiveRouting, outputDir } = opts
    const n = testCount
    console.log('')
    console.log(`  ${chalk.bold('bad')} ${chalk.dim(`v${version}`)}`)
    console.log(`  ${chalk.cyan(`${provider}/${model}`)} ${chalk.dim('·')} ${browser} ${chalk.dim('·')} ${chalk.bold(String(n))} test${n !== 1 ? 's' : ''} ${chalk.dim('·')} ×${concurrency}`)
    const meta: string[] = []
    if (mode) meta.push(mode)
    if (profile && profile !== 'default') meta.push(profile)
    if (adaptiveRouting) {
      meta.push(`adaptive ${chalk.dim(`(${adaptiveRouting.navProvider}/${adaptiveRouting.navModel})`)}`)
    }
    meta.push(chalk.dim(`→ ${outputDir}`))
    console.log(`  ${meta.join(chalk.dim('  ·  '))}`)
    console.log('')
  }

  // ── Launch phase ──

  launchStart(browser: string): void {
    this.spinner.start(`Launching ${browser}…`)
  }

  launchDone(): void {
    this.spinner.stop()
  }

  // ── Progress events ──

  suiteStart(totalTests: number): void {
    this.total = totalTests
    this.done = 0
    this.totalTurns = 0
  }

  testStart(testId: string, testName: string): void {
    this.active.set(testId, { name: testName, startedAt: Date.now() })
    this.syncSpinner()
  }

  testTurn(testId: string, turn: number, action: string, durationMs: number, modelUsed?: string): void {
    const t = this.active.get(testId)
    if (t) {
      t.turn = turn
      t.action = action
    }
    if (this.showDebug) {
      this.spinner.clear()
      const tag = modelUsed ? chalk.dim(` [${modelUsed}]`) : ''
      console.log(`       ${chalk.dim(`turn ${turn}:`)} ${action} ${chalk.dim(`(${durationMs}ms)`)}${tag}`)
    }
    this.syncSpinner()
  }

  testComplete(
    testId: string,
    passed: boolean,
    verdict: string,
    turnsUsed: number,
    durationMs: number,
    estimatedCostUsd?: number,
  ): void {
    this.active.delete(testId)
    this.done++
    this.totalTurns += turnsUsed
    this.spinner.clear()

    const icon = passed ? chalk.green('✓') : chalk.red('✗')
    const name = passed ? chalk.green(testId) : chalk.red(testId)
    const cost = estimatedCostUsd ? ` · ${chalk.yellow(`$${estimatedCostUsd.toFixed(3)}`)}` : ''
    const stats = `${turnsUsed} turns · ${fmtDuration(durationMs)}${cost}`
    // Single-task: show full result on its own line for readability
    if (this.total === 1) {
      console.log(`  ${icon} ${name} ${chalk.dim(`(${stats})`)}`)
      const resultText = passed ? verdict : chalk.red(verdict)
      console.log(`     ${resultText}`)
    } else {
      const truncated = verdict.length > 80 ? verdict.slice(0, 77) + '…' : verdict
      const verdictText = passed ? truncated : chalk.red(truncated)
      console.log(`  ${icon} ${name} ${chalk.dim('—')} ${verdictText} ${chalk.dim(`(${stats})`)}`)
    }

    this.syncSpinner()
  }

  suiteComplete(
    passed: number,
    failed: number,
    skipped: number,
    totalMs: number,
    totalCostUsd?: number,
    manifestUri?: string,
  ): void {
    this.spinner.stop()
    console.log('')
    console.log(`  ${chalk.dim('─'.repeat(52))}`)

    const parts: string[] = []
    if (passed > 0) parts.push(chalk.green.bold(`${passed} passed`))
    if (failed > 0) parts.push(chalk.red.bold(`${failed} failed`))
    if (skipped > 0) parts.push(chalk.yellow(`${skipped} skipped`))

    const extras = [fmtDuration(totalMs)]
    if (this.totalTurns > 0) extras.push(`${this.totalTurns} turns`)
    if (totalCostUsd) extras.push(chalk.yellow(`$${totalCostUsd.toFixed(2)}`))

    console.log(`  ${parts.join(chalk.dim('  ·  '))}  ${chalk.dim('·')}  ${extras.join(chalk.dim(' · '))}`)
    if (manifestUri) console.log(`  ${chalk.dim('Artifacts →')} ${manifestUri}`)
    console.log('')
  }

  report(reportPath: string): void {
    console.log(`  ${chalk.dim('Report →')} ${reportPath}`)
  }

  destroy(): void {
    this.spinner.stop()
  }

  // ── Internal ──

  private buildSpinnerText(): string {
    const items = [...this.active.values()]
    const names = items.slice(0, 3).map(t => t.name).join(chalk.dim(', '))
    const overflow = items.length > 3 ? chalk.dim(` +${items.length - 3}`) : ''
    // Show latest turn number and action
    const latest = items.find(t => t.turn)
    const turnInfo = latest
      ? chalk.dim(` · turn ${latest.turn}`) + (latest.action ? ` ${chalk.dim(latest.action)}` : '')
      : ''
    // Live elapsed time — recomputed every spinner tick
    const oldest = items.reduce((a, b) => a.startedAt < b.startedAt ? a : b)
    const elapsed = chalk.dim(` · ${fmtDuration(Date.now() - oldest.startedAt)}`)
    const counter = chalk.dim(`[${this.done}/${this.total}]`)
    return `${counter} ${names}${overflow}${turnInfo}${elapsed}`
  }

  private syncSpinner(): void {
    if (this.active.size === 0) {
      this.spinner.stop()
      return
    }

    const textFn = () => this.buildSpinnerText()
    if (this.spinner.running) {
      this.spinner.updateDynamic(textFn)
    } else {
      this.spinner.startDynamic(textFn)
    }
  }
}

// ── Help ──

export function printStyledHelp(runModes: readonly string[], driverProfiles: readonly string[], personaIds: readonly string[]): void {
  const H = chalk.bold
  const C = chalk.cyan
  const D = chalk.dim

  console.log(`
${chalk.bold('bad')} ${D('— LLM-driven browser automation CLI')}

${H('USAGE')}
  bad run [options]
  bad runs [--session-id <id>] [--json]
  bad design-audit --url <url>

${H('SINGLE TASK')}
  ${D('$')} bad run ${C('--goal')} "Sign up for account" ${C('--url')} http://localhost:3000
  ${D('$')} bad run ${C('-g')} "Build a todo app" ${C('-u')} http://localhost:5173 ${C('-m')} claude-sonnet-4-20250514
  ${D('$')} bad run ${C('--goal')} "Explore key routes" ${C('--url')} https://example.com ${C('--mode')} fast-explore

${H('RESUME / FORK')}
  ${D('$')} bad run ${C('--resume-run')} run_1710543210_abc ${C('--goal')} "Now add dark mode"
  ${D('$')} bad run ${C('--fork-run')} run_1710543210_abc ${C('--goal')} "Build auth instead"
  ${D('$')} bad runs ${D('# list recent runs')}
  ${D('$')} bad runs ${C('--session-id')} proj_123 ${C('--json')}

${H('TEST SUITE')}
  ${D('$')} bad run ${C('--cases')} ./cases.json ${C('--concurrency')} 4
  ${D('$')} bad run ${C('--cases')} ./cases.json ${C('--sink')} ./results/ ${C('--model')} gpt-5.4

${H('DESIGN AUDIT')}
  ${D('$')} bad design-audit ${C('--url')} https://stripe.com
  ${D('$')} bad design-audit ${C('--url')} https://app.uniswap.org ${C('--profile')} defi
  ${D('$')} bad design-audit ${C('--url')} http://localhost:3000 ${C('--profile')} saas ${C('--pages')} 10

  Profiles: ${C('general')}, ${C('saas')}, ${C('defi')}, ${C('marketing')}

${H('DESIGN TOKEN EXTRACTION')}
  ${D('$')} bad design-audit ${C('--url')} https://stripe.com ${C('--extract-tokens')}
  ${D('$')} bad design-audit ${C('--url')} https://app.example.com ${C('--extract-tokens')} ${C('--json')}

  Extracts colors, typography, spacing, components, logos, icons,
  CSS custom properties, and brand assets at mobile/tablet/desktop viewports.
  Outputs tokens.json — no LLM calls, pure DOM extraction.

${H('DOCKER')}
  ${D('$')} docker run -v ./cases.json:/data/cases.json -v ./out:/output \\
    bad run ${C('--cases')} /data/cases.json ${C('--sink')} /output/

${H('OPTIONS')}

  ${D('Config')}
      ${C('--config')} <path>         Path to config file ${D('(default: auto-detect)')}

  ${D('Test specification')}
  ${C('-g, --goal')} <text>           Natural language goal for single task
  ${C('-u, --url')} <url>             Starting URL
  ${C('-c, --cases')} <file>          JSON file with test cases array
      ${C('--allowed-domains')} <csv> Comma-separated host allowlist
      ${C('--vision-strategy')} <m>   Vision policy: ${D('always, never, auto')}

  ${D('LLM configuration')}
  ${C('-m, --model')} <name>          LLM model ${D('(default: gpt-5.4)')}
      ${C('--provider')} <name>       LLM provider: ${D('openai, anthropic, google, codex-cli, claude-code, sandbox-backend')}
      ${C('--model-adaptive')}        Enable adaptive model routing for decide() turns
      ${C('--nav-model')} <name>      Fast navigation model for adaptive routing
      ${C('--nav-provider')} <name>   Provider for nav model
      ${C('--api-key')} <key>         API key ${D('(or set OPENAI_API_KEY / ANTHROPIC_API_KEY)')}
      ${C('--base-url')} <url>        Custom LLM endpoint ${D('(e.g., LiteLLM proxy)')}
      ${C('--persona')} <id>          Append persona directive ${D(`(${personaIds.join(', ')})`)}

  ${D('Execution')}
      ${C('--mode')} <name>           Mode preset: ${D(runModes.join(', '))}
      ${C('--profile')} <name>        Execution profile: ${D(driverProfiles.join(', '))}
      ${C('--prompt-file')} <path>    Load system prompt from file
      ${C('--browser')} <name>        Browser: ${D('chromium, firefox, webkit')}
      ${C('--storage-state')} <file>  Playwright storage state JSON
      ${C('--concurrency')} <n>       Parallel workers ${D('(default: 1)')}
      ${C('--max-turns')} <n>         Max turns per test ${D('(default: 30)')}
      ${C('--llm-timeout')} <ms>      Timeout per LLM call
      ${C('--retries')} <n>           Retries for transient failures
      ${C('--retry-delay-ms')} <ms>   Base retry backoff
      ${C('--timeout')} <ms>          Per-test timeout ${D('(default: 600000)')}
      ${C('--headless')}              Run browser headless ${D('(default: true)')}
      ${C('--no-headless')}           Show browser window
      ${C('--screenshot-interval')} <n>  Capture every N turns ${D('(default: 5)')}

  ${D('Scout')}
      ${C('--scout')}                 Enable scout/ranker recommendations
      ${C('--scout-model')} <name>    Model override for scout
      ${C('--scout-provider')} <name> Provider override for scout
      ${C('--scout-vision')}          Let scout inspect screenshots
      ${C('--scout-max-candidates')} <n>
      ${C('--scout-min-top-score')} <n>
      ${C('--scout-max-score-gap')} <n>

  ${D('Wallet mode')}
      ${C('--wallet')}               Enable wallet mode ${D('(persistent Chromium profile)')}
      ${C('--extension')} <path>     Load unpacked wallet/browser extension ${D('(repeatable)')}
      ${C('--user-data-dir')} <dir>  Persistent profile directory
      ${C('--wallet-auto-approve')}  Extension prompt auto-approval ${D('(default: true)')}
      ${C('--wallet-password')} <v>  Wallet unlock password
      ${C('--wallet-preflight')}     Run wallet origin preflight ${D('(default: true)')}
      ${C('--wallet-seed-url')} <u>  Preflight URL ${D('(repeatable)')}
      ${C('--wallet-chain-id')} <n>  Target chain ID for preflight
      ${C('--wallet-chain-rpc-url')} <u>  RPC URL for preflight

  ${D('Session continuity')}
      ${C('--session-id')} <id>        Session ID for cross-run continuity ${D('(chains runs together)')}
      ${C('--resume-run')} <runId>     Resume from a previous run ${D('(navigates to finalUrl)')}
      ${C('--fork-run')} <runId>       Fork a new session from a previous run ${D('(requires --goal)')}

  ${D('Memory & scoring')}
      ${C('--memory')}               Enable trajectory memory ${D('(default: on)')}
      ${C('--no-memory')}            Disable trajectory memory
      ${C('--memory-dir')} <dir>     Memory directory ${D('(default: .agent-memory)')}
      ${C('--quality-threshold')} <n> Min quality score 1-10 ${D('(default: 0 = skip)')}
      ${C('--trace-scoring')}         Enable trajectory scoring
      ${C('--trace-ttl-days')} <n>    Retention window ${D('(default: 30)')}

  ${D('Output')}
  ${C('-s, --sink')} <dir>            Output directory ${D('(default: ./agent-results)')}
      ${C('--json')}                  Output progress as JSON lines ${D('(for piping)')}
  ${C('-q, --quiet')}                 Suppress all output
      ${C('--goal-verification')}     Verify goal completion ${D('(default: true)')}
      ${C('--no-goal-verification')}  Skip goal verification
      ${C('--vision')}                Enable vision/screenshots ${D('(default: true)')}
      ${C('--no-vision')}             Disable vision
      ${C('--block-analytics')}       Block analytics/tracking scripts
      ${C('--block-images')}          Block image loading
      ${C('--block-media')}           Block media loading

  ${D('Other')}
  ${C('-d, --debug')}                 Enable debug logging
  ${C('-h, --help')}                  Show this help
  ${C('-v, --version')}               Show version

  ${D('Sandbox backend')}
      ${C('--sandbox-backend-type')} <type>
      ${C('--sandbox-backend-profile')} <id>
      ${C('--sandbox-backend-provider')} <id>

${H('TEST CASES JSON FORMAT')}
  [
    {
      ${C('"id"')}: "signup",
      ${C('"name"')}: "User signup flow",
      ${C('"goal"')}: "Create a new account with email test@example.com",
      ${C('"startUrl"')}: "http://localhost:3000/signup",
      ${C('"maxTurns"')}: 20,
      ${C('"timeoutMs"')}: 300000,
      ${C('"successDescription"')}: "Account created and redirected to dashboard"
    }
  ]

${H('ENVIRONMENT VARIABLES')}
  ${C('OPENAI_API_KEY')}              OpenAI API key
  ${C('ANTHROPIC_API_KEY')}           Anthropic API key
  ${C('LLM_BASE_URL')}                Custom LLM endpoint URL
  ${C('BROWSER_ENDPOINT')}            Remote browser endpoint ${D('(CDP or Playwright)')}
  ${C('CODEX_CLI_PATH')}              Optional Codex CLI binary path
  ${C('CODEX_ALLOW_NPX')}             Set to 0 to disable npx fallback for codex-cli
  ${C('CLAUDE_CODE_CLI_PATH')}        Optional Claude CLI binary path
  ${C('SANDBOX_BACKEND_TYPE')}        Native backend type for sandbox-backend
  ${C('SANDBOX_BACKEND_PROFILE')}     Native backend profile/preset
  ${C('SANDBOX_BACKEND_MODEL_PROVIDER')}  Native backend provider override
  ${C('SANDBOX_SIDECAR_URL')}         Sidecar API URL ${D('(default: http://127.0.0.1:$SIDECAR_PORT)')}
  ${C('SANDBOX_SIDECAR_AUTH_TOKEN')}  Sidecar API bearer token
`)
}
