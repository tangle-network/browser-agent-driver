/**
 * CLI handler for `bad design-audit` — multi-page design quality audit.
 *
 * Crawls a site, captures screenshots at each page, and produces a
 * structured report with findings scored by severity.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import chalk from 'chalk'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { Brain } from './brain/index.js'
import type { DesignFinding, PageState, DesignEvolveResult } from './types.js'
import { PlaywrightDriver } from './drivers/playwright.js'
import { resolveDefaultProvider, resolveProviderApiKey, resolveProviderModelName, type SupportedProvider } from './provider-defaults.js'
import { loadLocalEnvFiles } from './env-loader.js'
import { cliError } from './cli-ui.js'
import { auditOnePage } from './design/audit/pipeline.js'
import type { PageAuditResult as Gen2PageAuditResult, EthicsViolation } from './design/audit/types.js'
import { extractDesignTokens, createZipBundle } from './design/audit/tokens/extract.js'
import { runEvolveLoop, runAgentEvolveLoop, generateEvolveReport, buildApplyPrompt } from './design/audit/evolve/index.js'
import type { ReferenceCommonOpts } from './design/audit/evolve/index.js'
import {
  parseTagList,
  printEthicsViolations,
  lowestRollupCap,
  printScoreBreakdown,
  generateDesignReport,
} from './design/audit/report.js'
import { resolveAuditPasses } from './design/audit/evaluate.js'
import { detectSystemicFindings, topByRoi } from './design/audit/roi.js'
import { getTelemetry, setInvocation } from './telemetry/index.js'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Page discovery — find key pages by crawling links
// ---------------------------------------------------------------------------

async function discoverPages(page: Page, startUrl: string, maxPages: number): Promise<string[]> {
  const origin = new URL(startUrl).origin
  const visited = new Set<string>()
  const toVisit = [startUrl]
  const discovered: string[] = []

  while (toVisit.length > 0 && discovered.length < maxPages) {
    const url = toVisit.shift()!
    const normalized = url.split('#')[0].split('?')[0].replace(/\/$/, '')
    if (visited.has(normalized)) continue
    visited.add(normalized)
    discovered.push(url)

    if (discovered.length >= maxPages) break

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      await page.waitForTimeout(1500)

      const links = await page.evaluate((orig: string) => {
        return Array.from(document.querySelectorAll('a[href]'))
          .map(a => {
            try { return new URL((a as HTMLAnchorElement).href, document.location.href).href }
            catch { return null }
          })
          .filter((href): href is string =>
            href !== null &&
            href.startsWith(orig) &&
            !href.includes('#') &&
            !href.match(/\.(png|jpg|jpeg|gif|svg|pdf|zip|css|js)$/i)
          )
      }, origin)

      for (const link of [...new Set(links)]) {
        const norm = link.split('#')[0].split('?')[0].replace(/\/$/, '')
        if (!visited.has(norm)) toVisit.push(link)
      }
    } catch {
      // Page failed to load — skip
    }
  }

  return discovered
}

// ---------------------------------------------------------------------------
// Single-page audit result
// ---------------------------------------------------------------------------

export interface PageAuditResult {
  url: string
  score: number
  summary: string
  strengths: string[]
  findings: DesignFinding[]
  screenshotPath?: string
  tokensUsed?: number
  error?: string
  designSystemScore?: Record<string, number>
  /** Auto-detected page classification */
  classification?: Gen2PageAuditResult['classification']
  /** Rubric fragments applied */
  rubricFragments?: string[]
  /** Deterministic measurements */
  measurements?: Gen2PageAuditResult['measurements']
  /** Layer 7: ethics violations that capped the rollup, if any. */
  ethicsViolations?: EthicsViolation[]
  /** Layer 7: the pre-cap rollup score when ethicsViolations is non-empty. */
  preEthicsScore?: number
  /** Layer 1: opaque result attached for backwards-compat dual-emit. */
  auditResult?: unknown
  /** Reference-grounded mode only: the rich engine artifact (all ranked directions). */
  referenceArtifact?: RedesignArtifact
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export interface DesignAuditOptions {
  url: string
  pages?: number
  profile?: string
  model?: string
  provider?: string
  apiKey?: string
  baseUrl?: string
  output?: string
  json?: boolean
  headless?: boolean
  debug?: boolean
  storageState?: string
  viewport?: string
  extractTokens?: boolean
  /** Evolve mode: true/css for CSS injection, or agent name (claude-code, codex, opencode) for agent dispatch */
  evolve?: string | boolean
  /** Max fix-reaudit cycles (default: 3) */
  evolveRounds?: number
  /** Run 3x and report score variance for reproducibility testing */
  reproducibility?: boolean
  /** Project directory the agent should edit (defaults to cwd) */
  projectDir?: string
  /** Optional path to user-supplied rubric fragments */
  rubricsDir?: string
  /** Subjective LLM audit passes: standard, deep, max, number, or comma-list */
  auditPasses?: string
  // ── Layer 7 — domain ethics gate ──
  /** Bypass the ethics floor entirely. Audited + warned. Test-only. */
  skipEthics?: boolean
  /** Override directory for ethics rule yaml files. */
  ethicsRulesDir?: string
  /** Comma-separated audience tags: developer, clinician, kids, ... */
  audience?: string
  /** Comma-separated regulatory contexts: hipaa, gdpr, coppa, ... */
  regulatoryContext?: string
  /** Comma-separated audience-vulnerability tags: patient-facing, minor-facing, ... */
  audienceVulnerability?: string
  /** Single modality: mobile, tablet, desktop, tv, kiosk */
  modality?: string
  // ── Reference-grounded eval (opt-in; default OFF → evalMode 'v1') ──
  /** Operator reference page (URL or local ripped-site path) to ground against. */
  reference?: string
  /** Force reference-grounded mode without an explicit `--reference`. */
  referenceGrounded?: boolean
}

// Type-only — erased at runtime; the reference engine is loaded lazily, and only
// when a reference-grounded run is requested (default audits never touch it).
import type {
  EvalMode,
  RedesignArtifact,
} from './design/audit/reference/index.js'

export async function runDesignAudit(opts: DesignAuditOptions): Promise<void> {
  loadLocalEnvFiles(process.cwd())

  // Token extraction mode — no LLM, pure DOM extraction
  if (opts.extractTokens) {
    await runTokenExtraction(opts)
    return
  }

  // Profile is optional — auto-classified by default. Override with --profile
  // selects a single type fragment instead of letting the classifier decide.
  const profile = opts.profile

  const maxPages = opts.pages ?? 5
  const provider = (opts.provider ?? resolveDefaultProvider()) as SupportedProvider
  const modelName = resolveProviderModelName(provider, opts.model)
  const apiKey = opts.apiKey ?? resolveProviderApiKey(provider)
  const auditPasses = resolveAuditPasses(opts.auditPasses)

  // Layer 7 — ethics gate options. Threaded into every auditOnePage call site.
  if (opts.skipEthics) {
    console.warn(`  ${chalk.yellow('⚠')} ${chalk.bold('--skip-ethics')} ${chalk.dim('— ethics floor disabled (test-only)')}`)
  }
  const ethicsCommonOpts = {
    skipEthics: opts.skipEthics,
    ethicsRulesDir: opts.ethicsRulesDir,
    audience: parseTagList(opts.audience) as never,
    regulatoryContext: parseTagList(opts.regulatoryContext) as never,
    audienceVulnerability: parseTagList(opts.audienceVulnerability) as never,
    modality: parseTagList(opts.modality) as never,
  }

  // ── Reference-grounded eval — acquire-once. Default OFF: evalMode 'v1' and an
  // empty bundle, so spreading `...referenceCommonOpts` adds only `evalMode:'v1'`
  // to each auditOnePage call and the pipeline's stage-6 branch is never entered
  // (default behaviour byte-identical). When ON, resolve the operator reference
  // and load the exemplar corpus a SINGLE time here — before the page/rep loops —
  // so a multi-page / multi-rep run never re-reads them (protects the ±0.5
  // reproducibility gate). The engine is imported lazily so default audits never
  // load it. ──
  const evalMode: EvalMode = opts.referenceGrounded || opts.reference ? 'reference-grounded' : 'v1'
  let referenceCommonOpts: ReferenceCommonOpts = { evalMode }
  if (evalMode === 'reference-grounded') {
    const { resolveReferenceConfig, createFileCorpusStore, resolveReferenceContext } = await import(
      './design/audit/reference/index.js'
    )
    const { createPageDnaExtractor } = await import('./design/audit/reference/dna/page-adapter.js')
    const referenceConfig = resolveReferenceConfig({ model: modelName })
    const reference = await resolveReferenceContext(
      opts.reference,
      { extractor: createPageDnaExtractor() },
      { headless: opts.headless ?? true },
    )
    const corpus = await createFileCorpusStore(referenceConfig.corpusDir).load()
    referenceCommonOpts = { evalMode, reference, corpus, referenceConfig }
    const refLabel = reference ? `, reference ${opts.reference ?? ''}` : ''
    console.log(`  ${chalk.cyan('reference-grounded')} ${chalk.dim('—')} corpus ${chalk.bold(String(corpus.length))} exemplar${corpus.length !== 1 ? 's' : ''}${refLabel}`)
  }

  // Telemetry: every design-audit invocation gets a stable runId. Child
  // envelopes link back via parentRunId so fleet rollups can reconstruct
  // the run tree.
  const runId = randomUUID()
  const runStartedAt = Date.now()
  const invocation = opts.evolve ? 'design-audit:evolve' : opts.reproducibility ? 'design-audit:reproducibility' : 'design-audit'
  setInvocation(invocation)
  const telemetry = getTelemetry()

  const [vw, vh] = (opts.viewport ?? '1440x900').split('x').map(Number)

  console.log('')
  console.log(`  ${chalk.bold('bad design-audit')}`)
  const profileLabel = profile ?? chalk.dim('auto-classify')
  const passLabel = auditPasses.length === 1 && auditPasses[0] === 'standard'
    ? '1 audit pass'
    : `${auditPasses.length} audit passes (${auditPasses.join(', ')})`
  console.log(`  ${profileLabel} ${chalk.dim('·')} ${chalk.cyan(modelName)} ${chalk.dim('·')} ${vw}×${vh} ${chalk.dim('·')} ${passLabel} ${chalk.dim('·')} up to ${maxPages} pages`)
  console.log(`  ${chalk.dim('→')} ${opts.url}`)
  console.log('')

  const storageState = opts.storageState ? path.resolve(opts.storageState) : undefined
  if (storageState && !fs.existsSync(storageState)) {
    cliError(`storage state file not found: ${storageState}`)
  }

  const browser = await chromium.launch({ headless: opts.headless ?? true })
  const context = await browser.newContext({
    viewport: { width: vw, height: vh },
    ...(storageState ? { storageState } : {}),
  })
  const page = await context.newPage()

  // Discover pages
  console.log(`  ${chalk.dim('Discovering pages…')}`)
  const pages = await discoverPages(page, opts.url, maxPages)
  console.log(`  Found ${chalk.bold(String(pages.length))} page${pages.length !== 1 ? 's' : ''}`)
  for (const p of pages) console.log(`  ${chalk.dim('·')} ${p}`)
  console.log('')

  // Set up output directory
  let screenshotDir: string | undefined
  const outputDir = opts.output ?? `./audit-results/${new URL(opts.url).hostname}-${Date.now()}`
  fs.mkdirSync(outputDir, { recursive: true })
  screenshotDir = path.join(outputDir, 'screenshots')
  fs.mkdirSync(screenshotDir, { recursive: true })

  const brain = new Brain({
    model: modelName,
    apiKey,
    provider: provider,
    baseUrl: opts.baseUrl ?? process.env.LLM_BASE_URL,
    vision: true,
    debug: opts.debug,
    llmTimeoutMs: 120_000, // design audits generate ~8k tokens of structured JSON — need 2min
  })

  const driver = new PlaywrightDriver(page)

  // Audit each page through the classify → measure → evaluate pipeline
  const results: PageAuditResult[] = []
  for (let i = 0; i < pages.length; i++) {
    const url = pages[i]
    console.log(`  ${chalk.dim(`[${i + 1}/${pages.length}]`)} ${url}`)

    const gen2 = await auditOnePage({
      brain,
      driver,
      page,
      url,
      profileOverride: profile,
      screenshotDir,
      userRubricsDir: opts.rubricsDir,
      auditPasses,
      runId,
      provider,
      model: modelName,
      ...ethicsCommonOpts,
      ...referenceCommonOpts,
    })
    const result = gen2 as PageAuditResult
    results.push(result)

    const icon = result.score >= 8 ? chalk.green('✓') : result.score >= 5 ? chalk.yellow('~') : chalk.red('✗')
    const scoreColor = result.score >= 8 ? chalk.green : result.score >= 5 ? chalk.yellow : chalk.red
    const findingCount = result.findings.length
    const classLabel = result.classification
      ? chalk.dim(` (${result.classification.type}/${result.classification.domain})`)
      : ''
    console.log(`  ${icon} ${scoreColor(`${result.score}/10`)} ${chalk.dim('—')} ${findingCount} finding${findingCount !== 1 ? 's' : ''}${classLabel}`)
    printScoreBreakdown(result)
  }

  // Cross-page systemic detection + top-fixes ranking.
  // Findings appearing on 2+ pages collapse into a single systemic finding.
  // The deduped set drives the Top Fixes section at the top of the report.
  let topFixes: DesignFinding[] = []
  if (results.length > 0) {
    const perPage = results.map(r => r.findings)
    const deduped = detectSystemicFindings(perPage)
    topFixes = topByRoi(deduped, 5)
  }

  // ── Reference-grounded: surface the rich redesign brief. Reference mode only —
  // v1 results carry no `referenceArtifact`, so this block is skipped and both the
  // report and the on-disk output are byte-identical to the legacy path. The
  // render module is imported lazily (and is already module-cached in this mode),
  // so a default audit never loads the reference engine. ──
  let redesignSection: string | undefined
  if (evalMode === 'reference-grounded') {
    const withArtifact = results.filter((r) => r.referenceArtifact)
    if (withArtifact.length > 0) {
      const { renderArtifactMarkdown, renderRedesignDirectionsSummary, renderRedesignTarget, artifactSlug } =
        await import('./design/audit/reference/index.js')
      const sections: string[] = ['## Redesign directions', '']
      for (const r of withArtifact) {
        const artifact = r.referenceArtifact as RedesignArtifact
        const briefFile = `${artifactSlug(r.url)}.redesign.md`
        fs.writeFileSync(path.join(outputDir, briefFile), renderArtifactMarkdown(artifact))
        sections.push(renderRedesignDirectionsSummary(artifact, briefFile))
        console.log(`  ${chalk.dim('Redesign brief →')} ${path.join(outputDir, briefFile)}`)
        // Default (non-spawning) apply path: emit the implementation prompt a
        // coding agent reads and runs ITSELF to apply this grounded redesign in
        // its project. Spawning a coding agent stays opt-in (`--evolve --agent`).
        const applyFile = `${artifactSlug(r.url)}.apply-prompt.md`
        fs.writeFileSync(
          path.join(outputDir, applyFile),
          buildApplyPrompt([r], profile, renderRedesignTarget(artifact)),
        )
        console.log(`  ${chalk.dim('Apply prompt →')} ${path.join(outputDir, applyFile)}`)
      }
      redesignSection = sections.join('\n').trimEnd()
    }
  }

  // Generate report
  const report = generateDesignReport(results, profile, topFixes, redesignSection)
  const reportPath = path.join(outputDir, 'report.md')
  fs.writeFileSync(reportPath, report)

  const allFindings = results.flatMap(r => r.findings)
  const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length
  const critical = allFindings.filter(f => f.severity === 'critical').length
  const major = allFindings.filter(f => f.severity === 'major').length
  const minor = allFindings.filter(f => f.severity === 'minor').length

  if (opts.json) {
    const jsonPath = path.join(outputDir, 'report.json')
    fs.writeFileSync(jsonPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      profile,
      url: opts.url,
      pages: results,
      topFixes,
      summary: { avgScore, totalFindings: allFindings.length, critical, major, minor },
    }, null, 2))
    console.log(`  ${chalk.dim('JSON →')} ${jsonPath}`)
  }

  // ── Layer 7 — surface ethics violations BEFORE the score summary so the
  // operator sees the floor reason, not just the capped number. ──
  printEthicsViolations(results)

  // Summary
  console.log('')
  console.log(`  ${chalk.dim('─'.repeat(52))}`)
  const avgColor = avgScore >= 8 ? chalk.green : avgScore >= 5 ? chalk.yellow : chalk.red
  const findingParts: string[] = []
  if (critical > 0) findingParts.push(chalk.red(`${critical} critical`))
  if (major > 0) findingParts.push(chalk.yellow(`${major} major`))
  if (minor > 0) findingParts.push(chalk.dim(`${minor} minor`))
  console.log(`  Avg: ${avgColor(`${avgScore.toFixed(1)}/10`)}  ${chalk.dim('·')}  ${allFindings.length} findings ${findingParts.length ? chalk.dim('(') + findingParts.join(chalk.dim(' · ')) + chalk.dim(')') : ''}`)
  const lowestCap = lowestRollupCap(results)
  if (lowestCap !== undefined) {
    console.log(`  ${chalk.red('⚠ Rollup capped at')} ${chalk.bold(`${lowestCap}/10`)} ${chalk.dim('— resolve ethics violations to lift the cap')}`)
  }
  console.log(`  ${chalk.dim('Report →')} ${reportPath}`)
  if (screenshotDir) console.log(`  ${chalk.dim('Screenshots →')} ${screenshotDir}`)
  console.log('')

  // ── Reproducibility mode: run 3x and report variance ──
  if (opts.reproducibility) {
    console.log(`  ${chalk.bold('Reproducibility test')} — running 2 additional audits…`)
    const scores: number[] = [avgScore]
    for (let rep = 0; rep < 2; rep++) {
      const repResults: PageAuditResult[] = []
      for (const url of pages) {
        const gen2 = await auditOnePage({
          brain,
          driver,
          page,
          url,
          profileOverride: profile,
          userRubricsDir: opts.rubricsDir,
          auditPasses,
          runId,
          provider,
          model: modelName,
          parentRunId: runId,
          ...ethicsCommonOpts,
          ...referenceCommonOpts,
        })
        repResults.push(gen2 as PageAuditResult)
      }
      const repAvg = repResults.reduce((s, r) => s + r.score, 0) / repResults.length
      scores.push(repAvg)
      console.log(`  ${chalk.dim(`  Rep ${rep + 2}:`)} ${repAvg.toFixed(1)}/10`)
    }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length
    const variance = Math.sqrt(scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length)
    const pass = variance <= 0.5
    const varColor = pass ? chalk.green : chalk.red
    console.log(`  ${chalk.dim('Scores:')} ${scores.map(s => s.toFixed(1)).join(', ')}`)
    console.log(`  ${chalk.dim('Mean:')} ${mean.toFixed(2)} ${chalk.dim('±')} ${varColor(variance.toFixed(2))} ${pass ? chalk.green('PASS (±0.5)') : chalk.red('FAIL (>±0.5)')}`)
    console.log('')

    if (opts.json) {
      const repPath = path.join(outputDir, 'reproducibility.json')
      fs.writeFileSync(repPath, JSON.stringify({ scores, mean, stddev: variance, pass }, null, 2))
    }
  }

  // ── Evolve mode: closed-loop fix → re-audit ──
  if (opts.evolve) {
    // --evolve=css (or --evolve=true) → CSS injection
    // --evolve=claude-code|codex|opencode|<custom> → agent dispatch
    const evolveMode = opts.evolve === true || opts.evolve === 'true' || opts.evolve === 'css' ? 'css' : opts.evolve
    let evolveResult: DesignEvolveResult

    // Evolve loops use a single-profile re-audit. When auto-classified,
    // synthesize the profile from the first page classification.
    const evolveProfile = profile
      ?? results[0]?.classification?.type
      ?? 'general'

    if (evolveMode !== 'css') {
      // Agent-dispatched evolve — a coding agent edits the actual source code
      const projectDir = opts.projectDir ?? process.cwd()
      evolveResult = await runAgentEvolveLoop(
        brain, driver, page, pages, evolveProfile, results, outputDir,
        opts.evolveRounds ?? 3, evolveMode, projectDir, opts.debug, auditPasses,
        runId, provider, modelName, referenceCommonOpts,
      )
    } else {
      // CSS-injection evolve — ephemeral fixes injected into the browser page
      evolveResult = await runEvolveLoop(
        brain, driver, page, pages, evolveProfile, results, outputDir,
        opts.evolveRounds ?? 3, auditPasses, runId, provider, modelName, referenceCommonOpts,
      )
    }

    // Write evolve report
    const evolvePath = path.join(outputDir, 'evolve-report.md')
    fs.writeFileSync(evolvePath, generateEvolveReport(evolveResult))
    console.log(`  ${chalk.dim('Evolve report →')} ${evolvePath}`)

    // Write CSS override file (CSS-injection mode only)
    if (evolveResult.cssOverride) {
      const cssPath = path.join(outputDir, 'design-fixes.css')
      fs.writeFileSync(cssPath, evolveResult.cssOverride)
      console.log(`  ${chalk.dim('CSS fixes →')} ${cssPath}`)
    }

    if (opts.json) {
      const evJsonPath = path.join(outputDir, 'evolve.json')
      fs.writeFileSync(evJsonPath, JSON.stringify(evolveResult, null, 2))
    }
    console.log('')

    telemetry.emit({
      kind: 'design-evolve-run',
      runId,
      ok: true,
      durationMs: Date.now() - runStartedAt,
      model: { provider, name: modelName },
      data: {
        url: opts.url,
        pages: pages.length,
        rounds: evolveResult.scoreHistory.length - 1,
        scoreHistory: evolveResult.scoreHistory,
        appliedFixCount: evolveResult.appliedFixes?.length ?? 0,
        evolveMode: evolveMode === 'css' ? 'css' : `agent:${evolveMode}`,
      },
      metrics: {
        initialScore: evolveResult.scoreHistory[0] ?? 0,
        finalScore: evolveResult.scoreHistory[evolveResult.scoreHistory.length - 1] ?? 0,
        delta: (evolveResult.scoreHistory[evolveResult.scoreHistory.length - 1] ?? 0) - (evolveResult.scoreHistory[0] ?? 0),
        rounds: evolveResult.scoreHistory.length - 1,
      },
    })
  }

  // Run-level summary envelope — fires for every design-audit invocation,
  // evolve or not. This is the row a fleet rollup queries to track audit
  // health across repos over time.
  telemetry.emit({
    kind: 'design-audit-run',
    runId,
    ok: true,
    durationMs: Date.now() - runStartedAt,
    model: { provider, name: modelName },
    data: {
      url: opts.url,
      pages: pages.length,
      profile: profile ?? null,
      auditPasses,
      outputDir,
    },
    metrics: {
      avgScore,
      pageCount: pages.length,
      totalFindings: allFindings.length,
      criticalFindings: critical,
      majorFindings: major,
      minorFindings: minor,
      topFixCount: topFixes.length,
    },
    tags: {
      evolveMode: opts.evolve ? (opts.evolve === true || opts.evolve === 'css' ? 'css' : 'agent') : 'off',
      reproducibility: opts.reproducibility ? 'on' : 'off',
    },
  })

  await browser.close()
}

// ---------------------------------------------------------------------------
// CLI wrapper for token extraction
// ---------------------------------------------------------------------------

async function runTokenExtraction(opts: DesignAuditOptions): Promise<void> {
  console.log('')
  console.log(`  ${chalk.bold('bad design-audit')} ${chalk.dim('--extract-tokens')}`)
  console.log(`  ${chalk.dim('→')} ${opts.url}`)
  console.log('')

  const outputDir = opts.output ?? `./audit-results/${new URL(opts.url).hostname}-tokens-${Date.now()}`

  const { tokens, screenshotPaths } = await extractDesignTokens({
    url: opts.url,
    headless: opts.headless,
    outputDir,
    onProgress: (name, width, height, stats) => {
      console.log(`  ${chalk.dim(`[${name}]`)} ${width}×${height} ${chalk.dim('—')} ${stats.colors} colors ${chalk.dim('·')} ${stats.fonts} fonts ${chalk.dim('·')} ${stats.buttons} buttons ${chalk.dim('·')} ${stats.inputs} inputs ${chalk.dim('·')} ${stats.cards} cards`)
    },
  })

  const primaryColors = tokens.colors.filter(c => c.cluster === 'primary')
  const secondaryColors = tokens.colors.filter(c => c.cluster === 'secondary')
  const accentColors = tokens.colors.filter(c => c.cluster === 'accent')
  const neutralColors = tokens.colors.filter(c => c.cluster === 'neutral')

  console.log('')
  console.log(`  ${chalk.dim('─'.repeat(52))}`)
  console.log('')

  const label = (name: string) => chalk.dim(name.padEnd(20))
  const sub = (name: string) => chalk.dim(`  ${name.padEnd(18)}`)

  console.log(`  ${label('Colors')}${chalk.bold(String(tokens.colors.length))} unique`)
  if (primaryColors.length) console.log(`  ${sub('Primary')}${primaryColors.length} ${chalk.dim(`(${primaryColors.slice(0, 3).map(c => c.hex).join(', ')})`)}`)
  if (secondaryColors.length) console.log(`  ${sub('Secondary')}${secondaryColors.length} ${chalk.dim(`(${secondaryColors.slice(0, 3).map(c => c.hex).join(', ')})`)}`)
  if (accentColors.length) console.log(`  ${sub('Accent')}${accentColors.length} ${chalk.dim(`(${accentColors.slice(0, 3).map(c => c.hex).join(', ')})`)}`)
  if (neutralColors.length) console.log(`  ${sub('Neutral')}${neutralColors.length}`)
  console.log(`  ${label('Font families')}${tokens.typography.families.length}`)
  for (const f of tokens.typography.families.slice(0, 5)) {
    console.log(`  ${sub(f.classification)}${f.family.slice(0, 50)} ${chalk.dim(`[${f.weights.join(', ')}]`)}`)
  }
  console.log(`  ${label('Type scale')}${tokens.typography.scale.length} entries`)
  console.log(`  ${label('CSS variables')}${Object.keys(tokens.customProperties).length}`)
  console.log(`  ${label('Logos')}${tokens.logos.length}`)
  console.log(`  ${label('Icons')}${tokens.icons.length}`)
  const downloadedCount = tokens.fontFiles.filter(f => f.localPath).length
  console.log(`  ${label('Font files')}${tokens.fontFiles.length} found, ${downloadedCount} downloaded`)
  for (const ff of tokens.fontFiles.slice(0, 5)) {
    const status = ff.localPath ? chalk.dim(path.basename(ff.localPath)) : chalk.dim('(not downloaded)')
    console.log(`  ${sub(`${ff.family} ${ff.weight}`)}${ff.style} ${chalk.dim(`[${ff.format}]`)} ${status}`)
  }
  const downloadedImageCount = tokens.images.filter(i => i.localPath).length
  console.log(`  ${label('Images')}${tokens.images.length} found, ${downloadedImageCount} downloaded`)
  const downloadedVideoCount = tokens.videos.filter(v => v.localPath).length
  if (tokens.videos.length > 0) {
    console.log(`  ${label('Videos')}${tokens.videos.length} found, ${downloadedVideoCount} downloaded`)
  }
  const downloadedCssCount = tokens.stylesheets.filter(s => s.localPath).length
  console.log(`  ${label('Stylesheets')}${tokens.stylesheets.length} found, ${downloadedCssCount} downloaded`)
  if (tokens.detectedLibraries.length > 0) {
    console.log(`  ${label('Libraries')}${tokens.detectedLibraries.join(', ')}`)
  }
  if (tokens.brand.title || tokens.brand.themeColor || tokens.brand.favicon) {
    console.log(`  ${label('Brand')}`)
    if (tokens.brand.title) console.log(`  ${sub('Title')}${tokens.brand.title}`)
    if (tokens.brand.themeColor) console.log(`  ${sub('Theme color')}${tokens.brand.themeColor}`)
    if (tokens.brand.favicon) console.log(`  ${sub('Favicon')}${chalk.dim(tokens.brand.favicon)}`)
    if (tokens.brand.ogImage) console.log(`  ${sub('OG image')}${chalk.dim(tokens.brand.ogImage)}`)
  }
  console.log('')

  for (const [name, vt] of Object.entries(tokens.responsive)) {
    const gridUnit = vt.gridBaseUnit ? `${vt.gridBaseUnit}px grid` : 'no clear grid'
    console.log(`  ${chalk.dim(`[${name}]`)} ${vt.spacing.length} spacing ${chalk.dim(`(${gridUnit})`)} ${chalk.dim('·')} ${vt.borders.length} radii ${chalk.dim('·')} ${vt.shadows.length} shadows`)
    console.log(`  ${chalk.dim('  Components:')} ${vt.components.buttons.length} buttons ${chalk.dim('·')} ${vt.components.inputs.length} inputs ${chalk.dim('·')} ${vt.components.cards.length} cards ${chalk.dim('·')} ${vt.components.nav.length} nav`)
  }

  // Create zip bundle
  try {
    const zipPath = await createZipBundle(outputDir, tokens)
    const zipSize = fs.statSync(zipPath).size
    const sizeStr = zipSize > 1024 * 1024 ? `${(zipSize / 1024 / 1024).toFixed(1)} MB` : `${(zipSize / 1024).toFixed(0)} KB`
    console.log('')
    console.log(`  ${chalk.dim('Zip →')} ${zipPath} ${chalk.dim(`(${sizeStr})`)}`)
  } catch {
    // zip not available — skip silently
  }

  console.log(`  ${chalk.dim('Output →')} ${outputDir}`)
  console.log(`  ${chalk.dim('Screenshots →')} ${path.join(outputDir, 'screenshots')}`)
  console.log('')
}
