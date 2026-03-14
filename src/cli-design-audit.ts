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
import type { DesignFinding, PageState, DesignTokens, ColorToken, FontFamily, TypeScaleEntry, LogoAsset, SvgIcon, ViewportTokens, SpacingToken, BorderToken, ShadowToken, ComponentFingerprint, NavPattern, AnimationToken } from './types.js'
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
  extractTokens?: boolean
}

export async function runDesignAudit(opts: DesignAuditOptions): Promise<void> {
  loadLocalEnvFiles(process.cwd())

  // Token extraction mode — no LLM, pure DOM extraction
  if (opts.extractTokens) {
    await runTokenExtraction(opts)
    return
  }

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

// ---------------------------------------------------------------------------
// Design Token Extraction — pure DOM, no LLM calls
// ---------------------------------------------------------------------------

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
] as const

interface RawExtractionResult {
  customProperties: Record<string, string>
  colors: Array<{ value: string; count: number; properties: string[] }>
  typography: {
    families: Array<{ family: string; weights: number[]; headingUse: boolean; monoUse: boolean }>
    scale: Array<{ fontSize: string; fontWeight: string; lineHeight: string; letterSpacing: string; fontFamily: string; tag: string; count: number }>
  }
  brand: {
    title?: string
    description?: string
    themeColor?: string
    favicon?: string
    ogImage?: string
    appleTouchIcon?: string
    manifestUrl?: string
  }
  logos: LogoAsset[]
  icons: SvgIcon[]
  spacing: Array<{ value: string; count: number; properties: string[] }>
  borders: Array<{ borderRadius: string; count: number }>
  shadows: Array<{ value: string; count: number }>
  components: {
    buttons: ComponentFingerprint[]
    inputs: ComponentFingerprint[]
    cards: ComponentFingerprint[]
    nav: NavPattern[]
  }
  animations: Array<{ property: string; value: string; count: number }>
}

// The in-page extraction function — runs inside page.evaluate()
function extractTokensFromDOM(): RawExtractionResult {
  const MAX_ELEMENTS = 5000

  // --- CSS Custom Properties ---
  const customProperties: Record<string, string> = {}
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSStyleRule &&
            (rule.selectorText === ':root' || rule.selectorText?.includes('html') || rule.selectorText?.includes('body'))) {
          for (let i = 0; i < rule.style.length; i++) {
            const prop = rule.style[i]
            if (prop.startsWith('--')) {
              customProperties[prop] = rule.style.getPropertyValue(prop).trim()
            }
          }
        }
      }
    } catch { /* cross-origin stylesheet */ }
  }

  // --- Element traversal ---
  const colorMap = new Map<string, { count: number; properties: Set<string> }>()
  const spacingMap = new Map<string, { count: number; properties: Set<string> }>()
  const borderRadiusMap = new Map<string, number>()
  const shadowMap = new Map<string, number>()
  const fontFamilyMap = new Map<string, { weights: Set<number>; headingUse: boolean; monoUse: boolean }>()
  const typeScaleMap = new Map<string, { fontSize: string; fontWeight: string; lineHeight: string; letterSpacing: string; fontFamily: string; tag: string; count: number }>()
  const animationMap = new Map<string, { property: string; value: string; count: number }>()

  function addColor(value: string, property: string) {
    if (!value || value === 'transparent' || value === 'rgba(0, 0, 0, 0)' || value === 'inherit' || value === 'initial') return
    const entry = colorMap.get(value)
    if (entry) {
      entry.count++
      entry.properties.add(property)
    } else {
      colorMap.set(value, { count: 1, properties: new Set([property]) })
    }
  }

  function addSpacing(value: string, property: string) {
    if (!value || value === '0px' || value === 'auto' || value === 'normal') return
    // Normalize multi-value shorthands — take individual values
    const vals = value.split(/\s+/).filter(v => v !== '0px' && v !== 'auto')
    for (const v of vals) {
      if (!v.endsWith('px') && !v.endsWith('rem') && !v.endsWith('em')) continue
      const entry = spacingMap.get(v)
      if (entry) {
        entry.count++
        entry.properties.add(property)
      } else {
        spacingMap.set(v, { count: 1, properties: new Set([property]) })
      }
    }
  }

  function parseGradientColors(bg: string) {
    const colorRegex = /(?:rgba?\([^)]+\)|hsla?\([^)]+\)|#[0-9a-fA-F]{3,8})/g
    const matches = bg.match(colorRegex) || []
    for (const c of matches) addColor(c, 'gradient')
  }

  function parseShadowColors(shadow: string) {
    if (shadow === 'none') return
    const colorRegex = /(?:rgba?\([^)]+\)|hsla?\([^)]+\)|#[0-9a-fA-F]{3,8})/g
    const matches = shadow.match(colorRegex) || []
    for (const c of matches) addColor(c, 'boxShadow')
  }

  const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
  const MONO_FAMILIES = /mono|consolas|courier|fira\s*code|jetbrains|source\s*code/i

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
  let elementCount = 0
  let el: Element | null = walker.currentNode as Element

  while (el && elementCount < MAX_ELEMENTS) {
    elementCount++
    const htmlEl = el as HTMLElement
    if (htmlEl.offsetWidth === 0 && htmlEl.offsetHeight === 0) {
      el = walker.nextNode() as Element | null
      continue
    }

    const cs = getComputedStyle(el)

    // Colors
    addColor(cs.color, 'color')
    addColor(cs.backgroundColor, 'backgroundColor')
    addColor(cs.borderTopColor, 'borderColor')
    addColor(cs.borderRightColor, 'borderColor')
    addColor(cs.borderBottomColor, 'borderColor')
    addColor(cs.borderLeftColor, 'borderColor')
    addColor(cs.outlineColor, 'outlineColor')
    if (cs.backgroundImage.includes('gradient')) parseGradientColors(cs.backgroundImage)
    if (cs.boxShadow !== 'none') parseShadowColors(cs.boxShadow)

    // Spacing
    addSpacing(cs.paddingTop, 'padding')
    addSpacing(cs.paddingRight, 'padding')
    addSpacing(cs.paddingBottom, 'padding')
    addSpacing(cs.paddingLeft, 'padding')
    addSpacing(cs.marginTop, 'margin')
    addSpacing(cs.marginRight, 'margin')
    addSpacing(cs.marginBottom, 'margin')
    addSpacing(cs.marginLeft, 'margin')
    addSpacing(cs.gap, 'gap')
    addSpacing(cs.rowGap, 'gap')
    addSpacing(cs.columnGap, 'gap')

    // Border radius
    const br = cs.borderRadius
    if (br && br !== '0px') {
      borderRadiusMap.set(br, (borderRadiusMap.get(br) ?? 0) + 1)
    }

    // Shadows
    if (cs.boxShadow !== 'none') {
      shadowMap.set(cs.boxShadow, (shadowMap.get(cs.boxShadow) ?? 0) + 1)
    }

    // Typography — only for elements with text content
    if (el.childNodes.length > 0 && Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())) {
      const family = cs.fontFamily
      const weight = parseInt(cs.fontWeight) || 400
      const isHeading = HEADING_TAGS.has(el.tagName)
      const isMono = MONO_FAMILIES.test(family)

      const fEntry = fontFamilyMap.get(family)
      if (fEntry) {
        fEntry.weights.add(weight)
        if (isHeading) fEntry.headingUse = true
        if (isMono) fEntry.monoUse = true
      } else {
        fontFamilyMap.set(family, { weights: new Set([weight]), headingUse: isHeading, monoUse: isMono })
      }

      const scaleKey = `${cs.fontSize}|${cs.fontWeight}|${cs.lineHeight}|${cs.letterSpacing}|${family}`
      const scaleEntry = typeScaleMap.get(scaleKey)
      if (scaleEntry) {
        scaleEntry.count++
      } else {
        typeScaleMap.set(scaleKey, {
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          lineHeight: cs.lineHeight,
          letterSpacing: cs.letterSpacing,
          fontFamily: family,
          tag: el.tagName.toLowerCase(),
          count: 1,
        })
      }
    }

    // Animations/transitions
    if (cs.transition && cs.transition !== 'all 0s ease 0s' && cs.transition !== 'none') {
      const key = cs.transition
      const aEntry = animationMap.get(key)
      if (aEntry) {
        aEntry.count++
      } else {
        animationMap.set(key, { property: 'transition', value: cs.transition, count: 1 })
      }
    }
    if (cs.animationName && cs.animationName !== 'none') {
      const key = `animation:${cs.animationName}`
      const aEntry = animationMap.get(key)
      if (aEntry) {
        aEntry.count++
      } else {
        animationMap.set(key, { property: 'animation', value: `${cs.animationName} ${cs.animationDuration} ${cs.animationTimingFunction}`, count: 1 })
      }
    }

    el = walker.nextNode() as Element | null
  }

  // --- Components: Buttons ---
  const buttonStyles: ComponentFingerprint[] = []
  const btnFingerprints = new Map<string, ComponentFingerprint>()
  const BUTTON_STYLE_KEYS = ['backgroundColor', 'color', 'borderRadius', 'padding', 'fontSize', 'fontWeight', 'border', 'boxShadow', 'textTransform', 'letterSpacing'] as const
  for (const btn of document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')) {
    const htmlBtn = btn as HTMLElement
    if (htmlBtn.offsetWidth === 0 && htmlBtn.offsetHeight === 0) continue
    const cs = getComputedStyle(btn)
    const styles: Record<string, string> = {}
    for (const k of BUTTON_STYLE_KEYS) styles[k] = cs[k]
    const fp = JSON.stringify(styles)
    const existing = btnFingerprints.get(fp)
    if (existing) {
      existing.count++
    } else {
      const entry: ComponentFingerprint = { fingerprint: fp, count: 1, exampleText: htmlBtn.textContent?.trim().slice(0, 60) || '', styles }
      btnFingerprints.set(fp, entry)
    }
  }
  buttonStyles.push(...btnFingerprints.values())

  // --- Components: Inputs ---
  const inputStyles: ComponentFingerprint[] = []
  const inputFingerprints = new Map<string, ComponentFingerprint>()
  const INPUT_STYLE_KEYS = ['backgroundColor', 'color', 'borderRadius', 'padding', 'fontSize', 'border', 'boxShadow', 'outline'] as const
  for (const inp of document.querySelectorAll('input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="number"], input[type="tel"], input[type="url"], textarea, select, [role="textbox"], [role="combobox"]')) {
    const htmlInp = inp as HTMLElement
    if (htmlInp.offsetWidth === 0 && htmlInp.offsetHeight === 0) continue
    const cs = getComputedStyle(inp)
    const styles: Record<string, string> = {}
    for (const k of INPUT_STYLE_KEYS) styles[k] = cs[k]
    const fp = JSON.stringify(styles)
    const existing = inputFingerprints.get(fp)
    if (existing) {
      existing.count++
    } else {
      const entry: ComponentFingerprint = { fingerprint: fp, count: 1, exampleText: (inp as HTMLInputElement).placeholder?.slice(0, 60) || '', styles }
      inputFingerprints.set(fp, entry)
    }
  }
  inputStyles.push(...inputFingerprints.values())

  // --- Components: Cards (elements with shadow or border-radius + multiple children) ---
  const cardStyles: ComponentFingerprint[] = []
  const cardFingerprints = new Map<string, ComponentFingerprint>()
  const CARD_STYLE_KEYS = ['borderRadius', 'boxShadow', 'padding', 'backgroundColor', 'border'] as const
  for (const el of document.querySelectorAll('div, section, article, li')) {
    const htmlEl = el as HTMLElement
    if (htmlEl.offsetWidth === 0 || htmlEl.children.length < 2) continue
    const cs = getComputedStyle(el)
    if (cs.boxShadow === 'none' && cs.borderRadius === '0px' && cs.border === '0px none rgb(0, 0, 0)') continue
    const styles: Record<string, string> = {}
    for (const k of CARD_STYLE_KEYS) styles[k] = cs[k]
    const fp = JSON.stringify(styles)
    const existing = cardFingerprints.get(fp)
    if (existing) {
      existing.count++
    } else {
      const entry: ComponentFingerprint = { fingerprint: fp, count: 1, styles }
      cardFingerprints.set(fp, entry)
    }
  }
  // Only keep card patterns with 2+ instances (skip one-off containers)
  for (const c of cardFingerprints.values()) {
    if (c.count >= 2) cardStyles.push(c)
  }

  // --- Components: Navigation ---
  const navPatterns: NavPattern[] = []
  for (const nav of document.querySelectorAll('nav, [role="navigation"], header')) {
    const cs = getComputedStyle(nav)
    const links = nav.querySelectorAll('a')
    if (links.length === 0) continue
    const firstLinkCs = getComputedStyle(links[0])
    navPatterns.push({
      selector: nav.tagName.toLowerCase() + (nav.className ? '.' + nav.className.split(/\s+/)[0] : ''),
      layout: {
        display: cs.display,
        flexDirection: cs.flexDirection,
        gap: cs.gap,
        alignItems: cs.alignItems,
        justifyContent: cs.justifyContent,
        backgroundColor: cs.backgroundColor,
        padding: cs.padding,
      },
      linkCount: links.length,
      linkStyles: {
        color: firstLinkCs.color,
        fontSize: firstLinkCs.fontSize,
        fontWeight: firstLinkCs.fontWeight,
        textDecoration: firstLinkCs.textDecoration,
      },
    })
  }

  // --- Logos & Icons ---
  const logos: LogoAsset[] = []
  const icons: SvgIcon[] = []

  // SVG logos (in header/nav or with logo-related attributes)
  for (const svg of document.querySelectorAll('svg')) {
    const parent = svg.closest('header, nav, [role="banner"]')
    const classes = (svg.getAttribute('class') || '') + ' ' + (svg.parentElement?.getAttribute('class') || '')
    const ariaLabel = svg.getAttribute('aria-label') || ''
    const isLogo = parent !== null || /logo|brand|mark/i.test(classes) || /logo|brand/i.test(ariaLabel)

    if (isLogo) {
      const content = svg.outerHTML.slice(0, 4096)
      logos.push({
        type: 'svg',
        width: svg.width?.baseVal?.value || undefined,
        height: svg.height?.baseVal?.value || undefined,
        svgContent: content,
      })
    } else if (svg.outerHTML.length < 2048) {
      // Collect as icon (small SVGs)
      icons.push({
        selector: svg.tagName + (svg.getAttribute('class') ? '.' + svg.getAttribute('class')!.split(/\s+/)[0] : ''),
        viewBox: svg.getAttribute('viewBox') || undefined,
        width: svg.width?.baseVal?.value || undefined,
        height: svg.height?.baseVal?.value || undefined,
        content: svg.outerHTML,
      })
    }
  }

  // IMG logos
  for (const img of document.querySelectorAll('img')) {
    const parent = img.closest('header, nav, [role="banner"]')
    const src = img.src || ''
    const alt = img.alt || ''
    const classes = img.className || ''
    if (parent !== null || /logo|brand|mark/i.test(src) || /logo|brand/i.test(alt) || /logo|brand/i.test(classes)) {
      logos.push({
        type: 'img',
        src: img.src,
        alt: img.alt || undefined,
        width: img.naturalWidth || undefined,
        height: img.naturalHeight || undefined,
      })
    }
  }

  // Limit icons to top 50 unique by viewBox
  const seenViewBoxes = new Set<string>()
  const dedupedIcons = icons.filter(icon => {
    const key = icon.viewBox || icon.content.slice(0, 100)
    if (seenViewBoxes.has(key)) return false
    seenViewBoxes.add(key)
    return true
  }).slice(0, 50)

  // --- Brand Meta ---
  const getMeta = (sel: string) => document.querySelector(sel)?.getAttribute('content') || undefined
  const getLink = (sel: string) => {
    const el = document.querySelector(sel)
    return el ? (el as HTMLLinkElement).href || el.getAttribute('href') || undefined : undefined
  }

  const brand = {
    title: getMeta('meta[property="og:title"]') || document.title || undefined,
    description: getMeta('meta[property="og:description"]') || getMeta('meta[name="description"]'),
    themeColor: getMeta('meta[name="theme-color"]'),
    favicon: getLink('link[rel="icon"]') || getLink('link[rel="shortcut icon"]'),
    ogImage: getMeta('meta[property="og:image"]'),
    appleTouchIcon: getLink('link[rel="apple-touch-icon"]'),
    manifestUrl: getLink('link[rel="manifest"]'),
  }

  // --- Assemble result ---
  return {
    customProperties,
    colors: Array.from(colorMap.entries())
      .map(([value, data]) => ({ value, count: data.count, properties: Array.from(data.properties) }))
      .sort((a, b) => b.count - a.count),
    typography: {
      families: Array.from(fontFamilyMap.entries()).map(([family, data]) => ({
        family,
        weights: Array.from(data.weights).sort((a, b) => a - b),
        headingUse: data.headingUse,
        monoUse: data.monoUse,
      })),
      scale: Array.from(typeScaleMap.values()).sort((a, b) => b.count - a.count),
    },
    brand,
    logos,
    icons: dedupedIcons,
    spacing: Array.from(spacingMap.entries())
      .map(([value, data]) => ({ value, count: data.count, properties: Array.from(data.properties) }))
      .sort((a, b) => b.count - a.count),
    borders: Array.from(borderRadiusMap.entries())
      .map(([borderRadius, count]) => ({ borderRadius, count }))
      .sort((a, b) => b.count - a.count),
    shadows: Array.from(shadowMap.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count),
    components: {
      buttons: buttonStyles.sort((a, b) => b.count - a.count),
      inputs: inputStyles.sort((a, b) => b.count - a.count),
      cards: cardStyles.sort((a, b) => b.count - a.count),
      nav: navPatterns,
    },
    animations: Array.from(animationMap.values()).sort((a, b) => b.count - a.count),
  }
}

// ---------------------------------------------------------------------------
// Color clustering — assign semantic roles to extracted colors
// ---------------------------------------------------------------------------

function rgbaToHsl(rgba: string): { h: number; s: number; l: number; a: number } | null {
  const match = rgba.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/)
  if (!match) return null
  const r = parseFloat(match[1]) / 255
  const g = parseFloat(match[2]) / 255
  const b = parseFloat(match[3]) / 255
  const a = match[4] !== undefined ? parseFloat(match[4]) : 1
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l, a }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: h * 360, s: s * 100, l: l * 100, a }
}

function rgbaToHex(rgba: string): string {
  const match = rgba.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/)
  if (!match) return rgba
  const r = Math.round(parseFloat(match[1]))
  const g = Math.round(parseFloat(match[2]))
  const b = Math.round(parseFloat(match[3]))
  const a = match[4] !== undefined ? parseFloat(match[4]) : 1
  const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
  if (a < 1) return `${hex}${Math.round(a * 255).toString(16).padStart(2, '0')}`
  return hex
}

function clusterColors(colors: Array<{ value: string; count: number; properties: string[] }>): ColorToken[] {
  const result: ColorToken[] = []
  let primaryHue = -1
  let secondaryHue = -1

  for (const c of colors) {
    const hsl = rgbaToHsl(c.value)
    const hex = rgbaToHex(c.value)
    let cluster: ColorToken['cluster']

    if (!hsl || hsl.s < 10) {
      // Low saturation = neutral (grays, black, white)
      if (hsl && hsl.l > 90) cluster = 'background'
      else cluster = 'neutral'
    } else if (c.properties.includes('borderColor') && !c.properties.includes('color') && !c.properties.includes('backgroundColor')) {
      cluster = 'border'
    } else if (primaryHue < 0) {
      primaryHue = hsl.h
      cluster = 'primary'
    } else if (Math.abs(hsl.h - primaryHue) < 30 || Math.abs(hsl.h - primaryHue) > 330) {
      cluster = 'primary'
    } else if (secondaryHue < 0) {
      secondaryHue = hsl.h
      cluster = 'secondary'
    } else if (Math.abs(hsl.h - secondaryHue) < 30 || Math.abs(hsl.h - secondaryHue) > 330) {
      cluster = 'secondary'
    } else {
      cluster = 'accent'
    }

    result.push({ value: c.value, hex, count: c.count, properties: c.properties, cluster })
  }

  return result
}

// ---------------------------------------------------------------------------
// Grid base unit detection
// ---------------------------------------------------------------------------

function detectGridUnit(spacingValues: SpacingToken[]): number | undefined {
  // Build frequency-weighted pairs
  const pairs = spacingValues
    .map(s => ({ px: parseFloat(s.value), count: s.count }))
    .filter(p => p.px > 0 && p.px <= 200 && Number.isInteger(p.px))

  if (pairs.length < 3) return undefined

  // Score common grid units by how much of the total usage they explain
  const CANDIDATES = [4, 5, 6, 8, 10]
  let bestUnit = 0
  let bestScore = 0

  for (const unit of CANDIDATES) {
    let aligned = 0
    let total = 0
    for (const p of pairs) {
      total += p.count
      if (p.px % unit === 0) aligned += p.count
    }
    const score = aligned / total
    if (score > bestScore) {
      bestScore = score
      bestUnit = unit
    }
  }

  // Require at least 60% of usage aligns with the grid
  return bestScore >= 0.6 ? bestUnit : undefined
}

// ---------------------------------------------------------------------------
// Token extraction orchestrator
// ---------------------------------------------------------------------------

async function dismissCookieBanners(page: Page): Promise<void> {
  for (const sel of ['button:has-text("Accept all")', 'button:has-text("Accept")', 'button:has-text("Reject all")', 'button:has-text("Got it")', 'button:has-text("Close")']) {
    const btn = page.locator(sel).first()
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click({ timeout: 2000 }).catch(() => null)
      await page.waitForTimeout(500)
      break
    }
  }
}

async function runTokenExtraction(opts: DesignAuditOptions): Promise<void> {
  console.log('=== Design Token Extraction ===')
  console.log(`URL: ${opts.url}`)
  console.log('')

  const outputDir = opts.output ?? `./audit-results/${new URL(opts.url).hostname}-tokens-${Date.now()}`
  fs.mkdirSync(outputDir, { recursive: true })
  const screenshotDir = path.join(outputDir, 'screenshots')
  fs.mkdirSync(screenshotDir, { recursive: true })

  const browser = await chromium.launch({ headless: opts.headless ?? true })

  // Merged token storage
  const allCustomProps: Record<string, string> = {}
  const allColors = new Map<string, { count: number; properties: Set<string> }>()
  const allFamilies = new Map<string, { weights: Set<number>; headingUse: boolean; monoUse: boolean }>()
  const allScaleEntries: Array<{ fontSize: string; fontWeight: string; lineHeight: string; letterSpacing: string; fontFamily: string; tag: string; count: number }> = []
  let brand: RawExtractionResult['brand'] = {}
  const allLogos: LogoAsset[] = []
  const allIcons: SvgIcon[] = []
  const responsiveTokens: Record<string, ViewportTokens> = {}

  for (const vp of VIEWPORTS) {
    console.log(`[${vp.name}] Extracting at ${vp.width}x${vp.height}...`)
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    const page = await context.newPage()

    try {
      await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 20_000 }).catch(() =>
        page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      )
      await page.waitForTimeout(2000)
      await dismissCookieBanners(page)
      await page.waitForTimeout(500)

      // Screenshot
      const screenshotPath = path.join(screenshotDir, `${vp.name}.png`)
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() =>
        page.screenshot({ path: screenshotPath, fullPage: false })
      )

      // Extract
      const raw = await page.evaluate(extractTokensFromDOM)

      // Merge custom properties (same across viewports, but some may differ)
      Object.assign(allCustomProps, raw.customProperties)

      // Merge colors
      for (const c of raw.colors) {
        const existing = allColors.get(c.value)
        if (existing) {
          existing.count += c.count
          for (const p of c.properties) existing.properties.add(p)
        } else {
          allColors.set(c.value, { count: c.count, properties: new Set(c.properties) })
        }
      }

      // Merge typography
      for (const f of raw.typography.families) {
        const existing = allFamilies.get(f.family)
        if (existing) {
          for (const w of f.weights) existing.weights.add(w)
          if (f.headingUse) existing.headingUse = true
          if (f.monoUse) existing.monoUse = true
        } else {
          allFamilies.set(f.family, { weights: new Set(f.weights), headingUse: f.headingUse, monoUse: f.monoUse })
        }
      }
      allScaleEntries.push(...raw.typography.scale)

      // Brand: desktop wins for meta tags
      if (vp.name === 'desktop' || !brand.title) {
        brand = raw.brand
      }

      // Logos & icons: merge, dedup by src/content
      for (const logo of raw.logos) {
        if (!allLogos.some(l => l.src === logo.src && l.svgContent === logo.svgContent)) {
          allLogos.push(logo)
        }
      }
      for (const icon of raw.icons) {
        if (!allIcons.some(i => i.content === icon.content)) {
          allIcons.push(icon)
        }
      }

      // Per-viewport tokens
      responsiveTokens[vp.name] = {
        width: vp.width,
        height: vp.height,
        spacing: raw.spacing,
        gridBaseUnit: detectGridUnit(raw.spacing),
        borders: raw.borders,
        shadows: raw.shadows,
        components: raw.components,
        animations: raw.animations,
        screenshotPath,
      }

      const nColors = raw.colors.length
      const nFonts = raw.typography.families.length
      const nBtns = raw.components.buttons.length
      const nInputs = raw.components.inputs.length
      const nCards = raw.components.cards.length
      console.log(`  ${nColors} colors, ${nFonts} fonts, ${nBtns} button styles, ${nInputs} input styles, ${nCards} card patterns`)
    } catch (err) {
      console.error(`  Error: ${err instanceof Error ? err.message : err}`)
    } finally {
      await context.close()
    }
  }

  await browser.close()

  // Deduplicate type scale across viewports
  const scaleMap = new Map<string, TypeScaleEntry>()
  for (const entry of allScaleEntries) {
    const key = `${entry.fontSize}|${entry.fontWeight}|${entry.lineHeight}|${entry.fontFamily}`
    const existing = scaleMap.get(key)
    if (existing) {
      existing.count += entry.count
    } else {
      const isHeading = /^h[1-6]$/.test(entry.tag)
      const fontSize = parseFloat(entry.fontSize)
      let usage: TypeScaleEntry['usage'] = 'body'
      if (isHeading) usage = 'heading'
      else if (fontSize <= 12) usage = 'caption'
      else if (fontSize <= 14 && entry.fontWeight >= '500') usage = 'label'

      scaleMap.set(key, {
        fontSize: entry.fontSize,
        fontWeight: entry.fontWeight,
        lineHeight: entry.lineHeight,
        letterSpacing: entry.letterSpacing,
        fontFamily: entry.fontFamily,
        usage,
        tag: entry.tag,
        count: entry.count,
      })
    }
  }

  // Cluster colors
  const mergedColors = Array.from(allColors.entries())
    .map(([value, data]) => ({ value, count: data.count, properties: Array.from(data.properties) }))
    .sort((a, b) => b.count - a.count)
  const clusteredColors = clusterColors(mergedColors)

  // Build final token set
  const families: FontFamily[] = Array.from(allFamilies.entries()).map(([family, data]) => ({
    family,
    weights: Array.from(data.weights).sort((a, b) => a - b),
    classification: data.monoUse ? 'mono' as const :
      (data.headingUse && allFamilies.size > 1) ? 'heading' as const :
      data.headingUse ? 'display' as const : 'body' as const,
  }))

  const tokens: DesignTokens = {
    url: opts.url,
    extractedAt: new Date().toISOString(),
    viewportsAudited: VIEWPORTS.map(v => v.name),
    customProperties: allCustomProps,
    colors: clusteredColors,
    typography: {
      families,
      scale: Array.from(scaleMap.values()).sort((a, b) => b.count - a.count),
    },
    brand,
    logos: allLogos,
    icons: allIcons.slice(0, 50),
    responsive: responsiveTokens,
  }

  // Write output
  const tokenPath = path.join(outputDir, 'tokens.json')
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2))

  // Print summary
  const primaryColors = clusteredColors.filter(c => c.cluster === 'primary')
  const secondaryColors = clusteredColors.filter(c => c.cluster === 'secondary')
  const accentColors = clusteredColors.filter(c => c.cluster === 'accent')
  const neutralColors = clusteredColors.filter(c => c.cluster === 'neutral')

  console.log('')
  console.log('=== Extraction Summary ===')
  console.log('')
  console.log(`Colors:            ${clusteredColors.length} unique`)
  console.log(`  Primary:         ${primaryColors.length} (${primaryColors.slice(0, 3).map(c => c.hex).join(', ')})`)
  console.log(`  Secondary:       ${secondaryColors.length} (${secondaryColors.slice(0, 3).map(c => c.hex).join(', ')})`)
  console.log(`  Accent:          ${accentColors.length} (${accentColors.slice(0, 3).map(c => c.hex).join(', ')})`)
  console.log(`  Neutral:         ${neutralColors.length}`)
  console.log(`Font families:     ${families.length}`)
  for (const f of families.slice(0, 5)) {
    console.log(`  ${f.classification.padEnd(8)} ${f.family.slice(0, 50)} [${f.weights.join(', ')}]`)
  }
  console.log(`Type scale:        ${scaleMap.size} entries`)
  console.log(`CSS variables:     ${Object.keys(allCustomProps).length}`)
  console.log(`Logos found:       ${allLogos.length}`)
  console.log(`Icons found:       ${allIcons.length}`)
  console.log(`Brand:`)
  if (brand.title) console.log(`  Title:           ${brand.title}`)
  if (brand.themeColor) console.log(`  Theme color:     ${brand.themeColor}`)
  if (brand.favicon) console.log(`  Favicon:         ${brand.favicon}`)
  if (brand.ogImage) console.log(`  OG image:        ${brand.ogImage}`)
  console.log('')

  for (const [name, vt] of Object.entries(responsiveTokens)) {
    const gridUnit = vt.gridBaseUnit ? `${vt.gridBaseUnit}px grid` : 'no clear grid'
    console.log(`[${name}] ${vt.spacing.length} spacing values (${gridUnit}), ${vt.borders.length} border-radius values, ${vt.shadows.length} shadow styles`)
    console.log(`  Components: ${vt.components.buttons.length} button styles, ${vt.components.inputs.length} input styles, ${vt.components.cards.length} card patterns, ${vt.components.nav.length} nav patterns`)
  }

  console.log('')
  console.log(`Output: ${tokenPath}`)
  console.log(`Screenshots: ${screenshotDir}`)
}
