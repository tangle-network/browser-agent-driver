/**
 * CLI handler for `bad design-audit` — multi-page design quality audit.
 *
 * Crawls a site, captures screenshots at each page, and produces a
 * structured report with findings scored by severity.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { Brain } from './brain/index.js'
import type { DesignFinding, PageState } from './types.js'
import { PlaywrightDriver } from './drivers/playwright.js'
import { resolveProviderApiKey, resolveProviderModelName, type SupportedProvider } from './provider-defaults.js'
import { loadLocalEnvFiles } from './env-loader.js'

// ---------------------------------------------------------------------------
// Audit profiles — domain-specific rubrics injected into the system prompt
// ---------------------------------------------------------------------------

const PROFILE_RUBRICS: Record<string, string> = {
  general: `
CALIBRATION — be ruthlessly honest:
- 9-10: Only world-class design (Linear, Stripe, Vercel). Exceptional typography, spacing, micro-interactions.
- 7-8: Professional and polished. Minor inconsistencies tolerated if the overall system is coherent.
- 5-6: Functional but clearly lacks design investment. Default component libraries with no customization.
- 3-4: Noticeably broken or amateurish. Inconsistent spacing, clashing colors, poor hierarchy.
- 1-2: Unusable or visually broken. Overlapping elements, unreadable text, broken layouts.

Most production apps score 5-7. Very few deserve 8+. Do NOT grade on a curve.`,

  saas: `
SaaS APPLICATION AUDIT — evaluate as a paying customer would:
- Information density: is data presented efficiently without clutter?
- Navigation: can I find features in <3 clicks? Is the sidebar/nav intuitive?
- Empty states: what happens with no data? Are there helpful onboarding prompts?
- Loading states: are there skeleton screens or spinners, or does content pop in?
- Form design: inline validation? Clear labels? Logical tab order?
- Dashboard layout: is the most important data prominent? Card hierarchy clear?
- Error states: are errors actionable with clear recovery paths?
- Consistency: do buttons, inputs, modals follow the same patterns throughout?

CALIBRATION: Linear, Notion, Figma = 9. Generic admin templates = 5. Broken CRUD apps = 3.`,

  defi: `
DeFi/CRYPTO APPLICATION AUDIT — evaluate as a trader managing real money:
- Trust signals: does the UI feel safe to connect a wallet to? Professional or sketchy?
- Token displays: are balances formatted correctly? Right decimal places? USD equivalents?
- Transaction clarity: is it clear what you're signing? Amount, fees, slippage shown?
- Loading states: RPC calls are slow — are there proper loading indicators for balances, quotes, gas estimates?
- Mobile responsiveness: most DeFi usage is mobile — does it work on small viewports?
- Dark mode: most DeFi apps use dark mode — is contrast sufficient? Are borders visible?
- Error handling: what happens when RPC fails? Wallet rejects? Insufficient balance?
- Swap UX: is token selection intuitive? Can you paste addresses? Is the price impact shown?
- Wallet connection: is the connect flow smooth? Are supported wallets clearly shown?
- Gas/fee transparency: are gas estimates shown before confirmation?

CALIBRATION: Uniswap v4, Aave v3 = 8. Average DEX = 5. Rug-pull-looking sites = 2.
Uniswap is good but not perfect — dense token lists, some spacing issues, swap review could be clearer.`,

  marketing: `
MARKETING/LANDING PAGE AUDIT — evaluate as a potential customer deciding in 10 seconds:
- Hero clarity: in 5 seconds, can I tell what this product does and who it's for?
- Visual hierarchy: does the eye flow naturally from headline → subtext → CTA?
- CTA prominence: is the primary call-to-action obvious and compelling?
- Social proof: are testimonials, logos, or metrics shown convincingly?
- Typography: is the headline typography impactful? Body text readable?
- Imagery: are images/illustrations high quality and relevant, or stock photo generic?
- Whitespace: does the page breathe, or is it cramped?
- Mobile: does the hero and CTA work on mobile without scrolling?
- Performance perception: does it feel fast? Are images optimized? No layout shift?
- Footer: is navigation complete? Legal links present?

CALIBRATION: Stripe, Linear, Vercel = 9. Average startup landing page = 5. Template sites = 3.`,
}

// ---------------------------------------------------------------------------
// Upgraded system prompt — much more opinionated than the original
// ---------------------------------------------------------------------------

function buildAuditPrompt(profile: string): string {
  const rubric = PROFILE_RUBRICS[profile] || PROFILE_RUBRICS.general
  return `You are a brutal, honest design critic with 15 years of experience at top design studios.
You have zero tolerance for mediocrity. You call out every flaw you see.

Your job: audit this page's visual design, UX, and polish. Be specific — reference exact elements, colors, spacing values, and positions.

EVALUATION CRITERIA:
1. LAYOUT — Grid consistency, alignment, responsive behavior, content hierarchy
2. TYPOGRAPHY — Font pairing, size scale, line height, letter spacing, readability
3. COLOR — Palette coherence, contrast ratios (WCAG AA: 4.5:1 text, 3:1 large text), semantic usage
4. SPACING — Consistent rhythm (4/8px grid), padding/margin consistency, breathing room
5. COMPONENTS — Button styles, input fields, cards, modals — are they consistent?
6. INTERACTIONS — Hover states, focus indicators, transitions, loading states
7. ACCESSIBILITY — Alt text, labels, keyboard navigation, screen reader compatibility
8. VISUAL POLISH — Border radius consistency, shadow depth, icon style, micro-details

${rubric}

IMPORTANT RULES:
- Be SPECIFIC. "Spacing is inconsistent" is useless. "The gap between the header and hero section is 48px but between hero and features is 24px — inconsistent vertical rhythm" is useful.
- Reference element positions: "top-left navigation", "hero CTA button", "footer column 3".
- Call out GOOD design too — note what works well alongside what doesn't.
- If the page looks like it uses a default component library (shadcn, MUI, Ant) with no customization, say so.
- Compare to best-in-class: "The token selector dropdown lacks the polish of Uniswap's — no token icons, no search, no recent tokens."

RESPOND WITH ONLY a JSON object:
{
  "score": 6,
  "summary": "One-sentence overall assessment",
  "strengths": ["Specific thing done well", "Another strength"],
  "findings": [
    {
      "category": "spacing",
      "severity": "major",
      "description": "Hero section has 64px top padding but only 16px bottom padding before the feature grid, creating visual imbalance",
      "location": "Hero section → feature grid transition",
      "suggestion": "Use consistent 48px vertical sections throughout"
    }
  ]
}

Categories: visual-bug, layout, contrast, alignment, spacing, typography, accessibility, ux
Severities: critical (blocks usage), major (looks unprofessional), minor (polish issue)
Score: 1-10 per calibration above. Most sites are 5-7. Be honest.`
}

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

interface PageAuditResult {
  url: string
  score: number
  summary: string
  strengths: string[]
  findings: DesignFinding[]
  screenshotPath?: string
  tokensUsed?: number
  error?: string
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function generateReport(results: PageAuditResult[], profile: string): string {
  const lines: string[] = []
  const avgScore = results.length > 0
    ? results.reduce((sum, r) => sum + r.score, 0) / results.length
    : 0

  const allFindings = results.flatMap(r => r.findings)
  const critical = allFindings.filter(f => f.severity === 'critical').length
  const major = allFindings.filter(f => f.severity === 'major').length
  const minor = allFindings.filter(f => f.severity === 'minor').length
  const totalTokens = results.reduce((sum, r) => sum + (r.tokensUsed ?? 0), 0)

  lines.push('# Design Audit Report')
  lines.push('')
  lines.push(`**Profile:** ${profile}`)
  lines.push(`**Pages audited:** ${results.length}`)
  lines.push(`**Overall score:** ${avgScore.toFixed(1)}/10`)
  lines.push(`**Findings:** ${allFindings.length} (${critical} critical, ${major} major, ${minor} minor)`)
  if (totalTokens > 0) lines.push(`**Tokens used:** ${totalTokens.toLocaleString()}`)
  lines.push('')

  // Score bar
  const scoreBar = '█'.repeat(Math.round(avgScore)) + '░'.repeat(10 - Math.round(avgScore))
  lines.push(`\`${scoreBar}\` ${avgScore.toFixed(1)}/10`)
  lines.push('')

  // Per-page results
  for (const result of results) {
    lines.push(`## ${result.url}`)
    lines.push('')
    const pageBar = '█'.repeat(Math.round(result.score)) + '░'.repeat(10 - Math.round(result.score))
    lines.push(`**Score:** \`${pageBar}\` ${result.score}/10`)
    if (result.summary) lines.push(`**Summary:** ${result.summary}`)
    if (result.error) lines.push(`**Error:** ${result.error}`)
    lines.push('')

    if (result.strengths.length > 0) {
      lines.push('**Strengths:**')
      for (const s of result.strengths) lines.push(`- ${s}`)
      lines.push('')
    }

    if (result.findings.length > 0) {
      lines.push('**Findings:**')
      lines.push('')
      lines.push('| Sev | Category | Description | Location | Fix |')
      lines.push('|-----|----------|-------------|----------|-----|')
      for (const f of result.findings) {
        const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120)
        const icon = f.severity === 'critical' ? '🔴' : f.severity === 'major' ? '🟡' : '⚪'
        lines.push(`| ${icon} ${f.severity} | ${f.category} | ${esc(f.description)} | ${esc(f.location)} | ${esc(f.suggestion)} |`)
      }
      lines.push('')
    } else if (!result.error) {
      lines.push('No issues found.')
      lines.push('')
    }
  }

  return lines.join('\n')
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
  output?: string
  json?: boolean
  headless?: boolean
  debug?: boolean
  viewport?: string
}

export async function runDesignAudit(opts: DesignAuditOptions): Promise<void> {
  loadLocalEnvFiles(process.cwd())

  const profile = opts.profile ?? 'general'
  if (!PROFILE_RUBRICS[profile]) {
    console.error(`Unknown profile: ${profile}. Options: ${Object.keys(PROFILE_RUBRICS).join(', ')}`)
    process.exit(1)
  }

  const maxPages = opts.pages ?? 5
  const provider = (opts.provider ?? 'openai') as SupportedProvider
  const modelName = resolveProviderModelName(provider, opts.model)
  const apiKey = opts.apiKey ?? resolveProviderApiKey(provider)

  const [vw, vh] = (opts.viewport ?? '1440x900').split('x').map(Number)

  console.log('=== Design Audit ===')
  console.log(`URL:      ${opts.url}`)
  console.log(`Profile:  ${profile}`)
  console.log(`Model:    ${modelName}`)
  console.log(`Pages:    up to ${maxPages}`)
  console.log(`Viewport: ${vw}x${vh}`)
  console.log('')

  const browser = await chromium.launch({ headless: opts.headless ?? true })
  const context = await browser.newContext({ viewport: { width: vw, height: vh } })
  const page = await context.newPage()

  // Discover pages
  console.log('Discovering pages...')
  const pages = await discoverPages(page, opts.url, maxPages)
  console.log(`Found ${pages.length} page(s):`)
  for (const p of pages) console.log(`  ${p}`)
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
    provider: opts.provider as 'openai' | 'anthropic' | undefined,
    vision: true,
    debug: opts.debug,
  })

  const driver = new PlaywrightDriver(page)

  // Audit each page
  const results: PageAuditResult[] = []
  for (let i = 0; i < pages.length; i++) {
    const url = pages[i]
    console.log(`[${i + 1}/${pages.length}] Auditing ${url}...`)

    const result = await auditSinglePage(brain, driver, page, url, profile, screenshotDir)
    results.push(result)

    const icon = result.score >= 8 ? '✓' : result.score >= 5 ? '~' : '✗'
    console.log(`  ${icon} Score: ${result.score}/10 — ${result.findings.length} findings`)
  }

  // Generate report
  const report = generateReport(results, profile)
  const reportPath = path.join(outputDir, 'report.md')
  fs.writeFileSync(reportPath, report)

  if (opts.json) {
    const jsonPath = path.join(outputDir, 'report.json')
    fs.writeFileSync(jsonPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      profile,
      url: opts.url,
      pages: results,
      summary: {
        avgScore: results.reduce((s, r) => s + r.score, 0) / results.length,
        totalFindings: results.flatMap(r => r.findings).length,
        critical: results.flatMap(r => r.findings).filter(f => f.severity === 'critical').length,
        major: results.flatMap(r => r.findings).filter(f => f.severity === 'major').length,
        minor: results.flatMap(r => r.findings).filter(f => f.severity === 'minor').length,
      },
    }, null, 2))
    console.log(`\nJSON:   ${jsonPath}`)
  }

  console.log(`\nReport: ${reportPath}`)
  console.log(`Screenshots: ${screenshotDir}`)

  // Print summary
  console.log('\n' + report.split('\n').slice(0, 15).join('\n'))

  await browser.close()
}

// Direct page audit using brain.generate with custom prompt
async function auditSinglePage(
  brain: Brain,
  driver: PlaywrightDriver,
  page: Page,
  url: string,
  profile: string,
  screenshotDir?: string,
): Promise<PageAuditResult> {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 }).catch(() =>
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    )
    await page.waitForTimeout(2000)

    // Dismiss cookie banners
    for (const sel of ['button:has-text("Accept all")', 'button:has-text("Accept")', 'button:has-text("Reject all")', 'button:has-text("Got it")', 'button:has-text("Close")']) {
      const btn = page.locator(sel).first()
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click({ timeout: 2000 }).catch(() => null)
        await page.waitForTimeout(500)
        break
      }
    }

    const state = await driver.observe()

    // Save screenshot
    let screenshotPath: string | undefined
    if (screenshotDir) {
      const slug = new URL(url).pathname.replace(/\//g, '_').replace(/^_/, '') || 'index'
      screenshotPath = path.join(screenshotDir, `${slug}.png`)
      await page.screenshot({ path: screenshotPath, fullPage: false })
    }

    const result = await brain.auditDesign(
      state,
      `Audit the design quality of this page: ${url}`,
      [],
      buildAuditPrompt(profile),
    )

    let summary = ''
    let strengths: string[] = []
    try {
      let text = result.raw.trim()
      if (text.startsWith('```')) text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
      const parsed = JSON.parse(text)
      summary = parsed.summary || ''
      strengths = Array.isArray(parsed.strengths) ? parsed.strengths : []
    } catch { /* use defaults */ }

    return {
      url,
      score: result.score,
      summary,
      strengths,
      findings: result.findings,
      screenshotPath,
      tokensUsed: result.tokensUsed,
    }
  } catch (err) {
    return {
      url,
      score: 0,
      summary: 'Failed to audit',
      strengths: [],
      findings: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
