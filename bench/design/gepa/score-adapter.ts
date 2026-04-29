/**
 * Design-audit ScoreAdapter — runs one (variant, fixture, rep) trial and
 * returns a TrialResult with golden-finding matches and metric inputs.
 *
 * The adapter:
 *   1. compiles the variant payload to AuditOverrides via targets.ts
 *   2. spins up a Playwright page (one per worker, reused across trials)
 *   3. invokes auditOnePage(...) with the overrides
 *   4. matches output findings against the fixture's goldenFindings
 */

import * as path from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { Brain } from '../../../src/brain/index.js'
import { PlaywrightDriver } from '../../../src/drivers/playwright.js'
import { auditOnePage } from '../../../src/design/audit/pipeline.js'
import {
  resolveProviderApiKey,
  resolveProviderModelName,
  type SupportedProvider,
} from '../../../src/provider-defaults.js'
import { matchGoldenFindings } from './metrics.js'
import { compileOverrides } from './targets.js'
import { resolveFixtureUrl } from './fixtures/loader.js'
import type { FixtureCase, PromptVariant, TrialResult } from './types.js'
import type { ScoreAdapter } from './loop.js'

export interface AuditScoreAdapterOptions {
  provider?: SupportedProvider
  model?: string
  /** Same env override CLI uses. */
  apiKey?: string
  /** Custom OpenAI-compatible base URL, e.g. router.tangle.tools. */
  baseUrl?: string
  /** When true, run the browser headless (default). */
  headless?: boolean
  /** Viewport WxH; defaults to 1440x900. */
  viewport?: { width: number; height: number }
  /** Where per-trial screenshots land. */
  screenshotDir?: string
}

/**
 * Adapter holds onto the browser+context+page across trials. Per-trial Brain
 * is cheap — we recreate it so the model/provider/baseUrl can change between
 * variants if needed (none today, but it's the obvious extension point).
 */
export class AuditScoreAdapter implements ScoreAdapter {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private driver: PlaywrightDriver | null = null

  constructor(private readonly opts: AuditScoreAdapterOptions = {}) {}

  async start(): Promise<void> {
    const headless = this.opts.headless ?? true
    const viewport = this.opts.viewport ?? { width: 1440, height: 900 }
    this.browser = await chromium.launch({ headless })
    this.context = await this.browser.newContext({ viewport })
    this.page = await this.context.newPage()
    this.driver = new PlaywrightDriver(this.page)
  }

  async stop(): Promise<void> {
    await this.context?.close().catch(() => undefined)
    await this.browser?.close().catch(() => undefined)
    this.browser = null
    this.context = null
    this.page = null
    this.driver = null
  }

  async score(args: {
    variant: PromptVariant
    fixture: FixtureCase
    rep: number
  }): Promise<TrialResult> {
    if (!this.page || !this.driver) await this.start()
    const page = this.page!
    const driver = this.driver!

    const provider = this.opts.provider ?? 'claude-code'
    const model = resolveProviderModelName(provider, this.opts.model)
    const apiKey = this.opts.apiKey ?? resolveProviderApiKey(provider)
    const baseUrl = this.opts.baseUrl ?? process.env.LLM_BASE_URL
    const brain = new Brain({
      model,
      apiKey,
      provider,
      baseUrl,
      vision: true,
      llmTimeoutMs: 120_000,
    })

    const overrides = compileOverrides(args.variant)
    const url = resolveFixtureUrl(args.fixture)
    const screenshotDir = this.opts.screenshotDir
      ? path.join(this.opts.screenshotDir, args.variant.id, args.fixture.id, `rep-${args.rep}`)
      : undefined

    const startedAt = Date.now()
    try {
      const result = await auditOnePage({
        brain,
        driver,
        page,
        url,
        profileOverride: args.fixture.profile,
        screenshotDir,
        auditPasses: ['standard'], // GEPA pins single-pass by default; mutator can override via 'pass-selection' target
        overrides,
        provider,
        model,
      })

      const findings = result.auditResult?.findings ?? result.findings
      const goldenMatches = matchGoldenFindings(args.fixture, findings)
      return {
        variantId: args.variant.id,
        fixtureId: args.fixture.id,
        rep: args.rep,
        ok: !result.error,
        score: result.score,
        findings,
        goldenMatches,
        tokensUsed: result.tokensUsed ?? 0,
        durationMs: Date.now() - startedAt,
        ...(args.variant.target === 'patch-synthesis-signature' ? { patchMetrics: patchMetrics(findings) } : {}),
        ...(result.error ? { error: result.error } : {}),
      }
    } catch (err) {
      return {
        variantId: args.variant.id,
        fixtureId: args.fixture.id,
        rep: args.rep,
        ok: false,
        score: 0,
        findings: [],
        goldenMatches: args.fixture.goldenFindings.map(() => false),
        tokensUsed: 0,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

function patchMetrics(findings: TrialResult['findings']): NonNullable<TrialResult['patchMetrics']> {
  const eligible = findings.filter((finding) => {
    const raw = (finding as unknown as { rawPatches?: unknown[] }).rawPatches
    return finding.severity === 'major'
      || finding.severity === 'critical'
      || (Array.isArray(raw) && raw.length > 0)
      || /\[auto-downgraded: patch required/.test(finding.suggestion ?? '')
  })
  const rawPatches = eligible.reduce((sum, finding) => {
    const raw = (finding as unknown as { rawPatches?: unknown[] }).rawPatches
    return sum + (Array.isArray(raw) ? raw.length : 0)
  }, 0)
  const validPatches = eligible.reduce((sum, finding) => sum + ((finding as { patches?: unknown[] }).patches?.length ?? 0), 0)
  return {
    eligibleFindings: eligible.length,
    rawPatches,
    validPatches,
    coverage: eligible.length === 0 ? 1 : Math.min(1, rawPatches / eligible.length),
    validRate: rawPatches === 0 ? 0 : validPatches / rawPatches,
  }
}
