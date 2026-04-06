/**
 * CLI handler for `bad design-audit` — multi-page design quality audit.
 *
 * Crawls a site, captures screenshots at each page, and produces a
 * structured report with findings scored by severity.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import chalk from 'chalk'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { Brain } from './brain/index.js'
import type { DesignFinding, PageState, DesignTokens, ColorToken, FontFamily, TypeScaleEntry, LogoAsset, SvgIcon, ViewportTokens, SpacingToken, BorderToken, ShadowToken, ComponentFingerprint, NavPattern, AnimationToken, FontFile, ImageAsset } from './types.js'
import { PlaywrightDriver } from './drivers/playwright.js'
import { resolveProviderApiKey, resolveProviderModelName, type SupportedProvider } from './provider-defaults.js'
import { loadLocalEnvFiles } from './env-loader.js'
import { cliError } from './cli-ui.js'
import { auditOnePage } from './design/audit/pipeline.js'
import type { PageAuditResult as Gen2PageAuditResult } from './design/audit/types.js'

// ---------------------------------------------------------------------------
// Legacy Gen 1 profile rubrics — kept for `--gen 1` fallback only.
// New rubrics live in src/design/audit/rubric/fragments/ as markdown.
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

  vibecoded: `
VIBECODED / AI-GENERATED APP AUDIT — evaluate as a design-literate user who can smell defaults:

TEMPLATE DETECTION (the #1 sin of vibecoded apps):
- Is this clearly an unmodified shadcn/ui, MUI, Ant Design, or Chakra template? Score ceiling: 4 if yes.
- Default border-radius (6-8px shadcn, 4px MUI), default color palette (zinc/slate grays, blue-600 primary)?
- Default component spacing with no customization? Standard card shadows? Stock empty states?
- "Looks like every other AI-generated app" = automatic 3-4 score.

HIERARCHY & INFORMATION ARCHITECTURE:
- Is everything the same visual weight? (Common AI pattern: all cards same size, no primary/secondary distinction)
- Is there clear information hierarchy? Primary action vs secondary vs tertiary?
- Does the layout have purpose or is it "centered column of cards" (the AI default)?
- Navigation: is it a dumped list of features or thoughtfully organized?

DESIGN SYSTEM COHERENCE:
- Are there more than 3 distinct border-radius values? (Incoherent)
- Color palette: intentional and limited (4-6 colors) or random accumulation?
- Spacing: consistent rhythm on an 8px grid, or arbitrary per-component?
- Typography: deliberate scale with 3-4 sizes, or every component picking its own?
- Are interactive states (hover, focus, active, disabled) designed or browser-default?

CRAFT SIGNALS (what separates 7 from 9):
- Custom icons or generic Lucide/Heroicons dump?
- Micro-interactions: button press feedback, page transitions, loading skeletons?
- Empty states: designed illustrations or "No data found" text?
- Error states: helpful messages with recovery actions or raw error strings?
- Dark mode (if present): properly designed or just "invert colors"?
- Content-first: does real content drive the layout, or is it a container waiting for content?

AGENTIC APP SPECIFICS:
- Agent status indicators: is it clear what the agent is doing? Progress feedback?
- Streaming/loading: smooth token streaming or janky text replacement?
- Conversation UI: proper message bubbles with timestamps, or plain text dump?
- Tool call visualization: can the user see what tools the agent used?
- Error recovery: when the agent fails, is there a clear retry/edit path?

CALIBRATION:
- 9-10: Custom design system, thoughtful hierarchy, polished interactions (Linear, Cursor, v0.dev)
- 7-8: Modified template with intentional design decisions, consistent system
- 5-6: Lightly customized template, functional but generic (most AI-generated apps)
- 3-4: Unmodified component library, no design investment, "it works" energy
- 1-2: Broken layout, clashing styles, unusable

Most vibecoded apps score 3-5. The ceiling for unmodified templates is 4 regardless of functionality.`,
}

// ---------------------------------------------------------------------------
// Upgraded system prompt — much more opinionated than the original
// ---------------------------------------------------------------------------

function buildAuditPrompt(profile: string): string {
  const rubric = PROFILE_RUBRICS[profile] || PROFILE_RUBRICS.general
  return `You are a principal design engineer who has shipped design systems at Linear, Stripe, and Vercel. You review with the precision of a typographer and the ruthlessness of a design director. You have built and maintained production design systems used by millions.

Your job: perform an exhaustive visual design audit of this page. You must be specific enough that a developer could fix every issue from your report alone — reference exact elements, computed values, pixel measurements, and CSS properties.

EVALUATION FRAMEWORK (score each area 1-10, then weight into overall):

1. LAYOUT & GRID (weight: 15%)
   - Is there a consistent grid system? What grid unit? (4px, 8px, etc.)
   - Column alignment: do content blocks align to the same left/right edges?
   - Content width: is max-width appropriate? (prose: 65-75ch, app: fluid with sidebar)
   - Responsive: does the layout reflow intentionally or just shrink?
   - Z-index layering: any stacking context issues? Overlapping elements?
   - Check for: orphaned elements floating outside the grid, inconsistent container padding

2. TYPOGRAPHY SYSTEM (weight: 15%)
   - Type scale: is there a clear hierarchy? Count distinct font-size values — more than 5-6 suggests no scale.
   - Line height: body text should be 1.4-1.6, headings 1.1-1.3. Flag violations.
   - Letter spacing: headings often need negative (-0.01 to -0.03em). Is it tuned?
   - Font pairing: max 2 families (heading + body). Flag 3+.
   - Text rendering: are long paragraphs wider than 75ch? That harms readability.
   - Orphans/widows: any single-word last lines in headings?
   - Font loading: is there FOUT/FOIT? Font-display strategy?

3. COLOR & CONTRAST (weight: 15%)
   - WCAG AA compliance: normal text needs 4.5:1, large text (18px+/14px+ bold) needs 3:1. ESTIMATE ratios.
   - Palette size: count distinct hues. More than 5-6 non-neutral hues = incoherent.
   - Semantic color usage: is the primary color used consistently for primary actions?
   - Background layering: do nested surfaces have clear elevation (bg-0, bg-1, bg-2)?
   - Gray scale: are grays consistent? All blue-gray, or mixed warm/cool? Mixed = incoherent.
   - Accent usage: are accent colors used sparingly or splashed everywhere?

4. SPACING & RHYTHM (weight: 15%)
   - Grid adherence: what % of spacing values are multiples of the base unit?
   - Vertical rhythm: are section gaps consistent? Measure gap between each major section.
   - Component internal spacing: is padding consistent within similar components (all cards, all inputs)?
   - Whitespace ratio: is there enough breathing room, or is everything cramped?
   - Margin collapse issues: any unintended spacing from margin collapse?

5. COMPONENT CONSISTENCY (weight: 15%)
   - Button variants: how many distinct button styles? Are they intentional variants or accidents?
   - Input styling: are all form inputs styled consistently? Border, focus ring, label position?
   - Card patterns: same border-radius, shadow, padding across all cards?
   - Icon system: consistent size (16/20/24px), stroke width, and style?
   - Border radius: count distinct values. More than 3 (e.g., 4px, 8px, full) = incoherent.
   - Shadow system: consistent elevation scale or random drop shadows?

6. INTERACTION DESIGN (weight: 10%)
   - Hover states: do interactive elements have visible hover feedback?
   - Focus indicators: are there visible focus rings for keyboard navigation?
   - Active/pressed states: button feedback on click?
   - Transitions: are they present? Consistent duration (150-300ms)? Appropriate easing?
   - Loading states: skeleton screens, spinners, or no loading feedback at all?
   - Cursor changes: does cursor change to pointer on clickable elements?

7. ACCESSIBILITY (weight: 10%)
   - Semantic HTML: are headings in order (h1 → h2 → h3)? Are buttons actually <button>?
   - ARIA labels: do icon-only buttons have labels? Do images have alt text?
   - Keyboard navigation: can you tell what's focused? Is tab order logical?
   - Touch targets: are mobile tap targets at least 44x44px?
   - Screen reader: is content structured so screen reader users get meaningful navigation?

8. VISUAL POLISH (weight: 5%)
   - Pixel precision: any elements off by 1px? Misaligned text baselines?
   - Image quality: are images sharp on retina displays (2x resolution)?
   - Icon consistency: all from the same set, or a mix of styles/weights?
   - Empty states: designed or raw "no data" text?
   - Error states: styled or browser-default?
   - Favicon and meta: present and professional?

${rubric}

SPECIFICITY REQUIREMENTS — your findings must be THIS specific:
- BAD: "Spacing is inconsistent" (vague, useless)
- GOOD: "Section gap between hero and features is 48px, but features-to-pricing is 24px and pricing-to-footer is 64px. Use consistent 48px or 64px vertical rhythm throughout."
- BAD: "Colors don't look right" (vague)
- GOOD: "Body text (#6b7280) on white background has ~4.6:1 contrast ratio (barely passes AA). The same gray on the light-gray card background (#f9fafb) drops to ~3.8:1 — fails AA for normal text. Darken body text to #4b5563 (7:1+)."
- BAD: "Typography needs work" (vague)
- GOOD: "6 distinct font sizes detected (12, 13, 14, 16, 20, 32px) with no clear scale. Consolidate to a 4-step scale: 14px body, 16px large, 24px h2, 36px h1. Current h2 at 20px lacks sufficient contrast with 16px body text."

For EACH finding, you MUST include a concrete CSS fix in the suggestion field. Not "improve spacing" but "gap: 48px" or "font-size: 14px; line-height: 1.5".

RESPOND WITH ONLY a JSON object:
{
  "score": 6,
  "summary": "One-sentence overall assessment with the key design system failure mode",
  "strengths": ["Specific thing done well with evidence", "Another measured strength"],
  "findings": [
    {
      "category": "spacing",
      "severity": "major",
      "description": "Hero section has 64px top padding but only 16px bottom padding before the feature grid, creating visual imbalance. The 4:1 ratio breaks vertical rhythm.",
      "location": "Hero section → feature grid transition (main > section:nth-child(2))",
      "suggestion": "padding-bottom: 48px on hero section. Standardize all section gaps to 48px or 64px.",
      "cssSelector": "main > section:first-child",
      "cssFix": "padding-bottom: 48px"
    }
  ],
  "designSystemScore": {
    "layout": 7,
    "typography": 5,
    "color": 6,
    "spacing": 4,
    "components": 6,
    "interactions": 3,
    "accessibility": 5,
    "polish": 4
  }
}

Categories: visual-bug, layout, contrast, alignment, spacing, typography, accessibility, ux
Severities: critical (blocks usage or fails WCAG), major (looks unprofessional), minor (polish detail)
Score: 1-10 per calibration above. Most production apps score 5-7. Template apps score 3-5. Only world-class ships get 8+. Be honest — inflated scores help nobody.`
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
  designSystemScore?: Record<string, number>
  /** Gen 2: page classification (auto-detected) */
  classification?: Gen2PageAuditResult['classification']
  /** Gen 2: rubric fragments applied */
  rubricFragments?: string[]
  /** Gen 2: deterministic measurements */
  measurements?: Gen2PageAuditResult['measurements']
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function generateReport(results: PageAuditResult[], profile: string | undefined): string {
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
  if (profile) {
    lines.push(`**Profile:** ${profile}`)
  }
  // Surface per-page classification when present (Gen 2)
  const classifications = results
    .filter(r => r.classification)
    .map(r => `${r.url}: ${r.classification!.type}/${r.classification!.domain} (${r.classification!.maturity})`)
  if (classifications.length > 0) {
    lines.push(`**Auto-classified:**`)
    for (const c of classifications) lines.push(`- ${c}`)
  }
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

    if (result.designSystemScore) {
      lines.push('**Design System Breakdown:**')
      lines.push('')
      const ds = result.designSystemScore
      const dsKeys = ['layout', 'typography', 'color', 'spacing', 'components', 'interactions', 'accessibility', 'polish']
      for (const key of dsKeys) {
        if (ds[key] !== undefined) {
          const bar = '█'.repeat(Math.round(ds[key])) + '░'.repeat(10 - Math.round(ds[key]))
          lines.push(`- ${key}: \`${bar}\` ${ds[key]}/10`)
        }
      }
      lines.push('')
    }

    if (result.findings.length > 0) {
      lines.push('**Findings:**')
      lines.push('')
      lines.push('| Sev | Category | Description | Location | Fix | CSS |')
      lines.push('|-----|----------|-------------|----------|-----|-----|')
      for (const f of result.findings) {
        const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120)
        const icon = f.severity === 'critical' ? '🔴' : f.severity === 'major' ? '🟡' : '⚪'
        const cssFix = f.cssFix ? `\`${esc(f.cssFix)}\`` : ''
        lines.push(`| ${icon} ${f.severity} | ${f.category} | ${esc(f.description)} | ${esc(f.location)} | ${esc(f.suggestion)} | ${cssFix} |`)
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
  /** Evolve mode: true/css for CSS injection, or agent name (claude-code, codex, opencode) for agent dispatch */
  evolve?: string | boolean
  /** Max fix-reaudit cycles (default: 3) */
  evolveRounds?: number
  /** Run 3x and report score variance for reproducibility testing */
  reproducibility?: boolean
  /** Project directory the agent should edit (defaults to cwd) */
  projectDir?: string
  /** Audit pipeline generation: 1 (legacy hardcoded profiles) or 2 (classifier + measurements). Default: 2. */
  gen?: 1 | 2
  /** Optional path to user-supplied rubric fragments (Gen 2 only) */
  rubricsDir?: string
}

export async function runDesignAudit(opts: DesignAuditOptions): Promise<void> {
  loadLocalEnvFiles(process.cwd())

  // Token extraction mode — no LLM, pure DOM extraction
  if (opts.extractTokens) {
    await runTokenExtraction(opts)
    return
  }

  // Gen 2 default. Gen 1 stays available via --gen 1 for legacy/comparison.
  const generation: 1 | 2 = opts.gen ?? 2

  // Profile is optional in Gen 2 (auto-classified). Required in Gen 1.
  const profile = opts.profile ?? (generation === 1 ? 'general' : undefined)
  if (generation === 1 && profile && !PROFILE_RUBRICS[profile]) {
    cliError(`unknown profile: ${profile}. Options: ${Object.keys(PROFILE_RUBRICS).join(', ')}`)
    process.exit(1)
  }

  const maxPages = opts.pages ?? 5
  const provider = (opts.provider ?? 'claude-code') as SupportedProvider
  const modelName = resolveProviderModelName(provider, opts.model)
  const apiKey = opts.apiKey ?? resolveProviderApiKey(provider)

  const [vw, vh] = (opts.viewport ?? '1440x900').split('x').map(Number)

  console.log('')
  console.log(`  ${chalk.bold('bad design-audit')} ${chalk.dim(`gen${generation}`)}`)
  const profileLabel = profile ?? chalk.dim('auto-classify')
  console.log(`  ${profileLabel} ${chalk.dim('·')} ${chalk.cyan(modelName)} ${chalk.dim('·')} ${vw}×${vh} ${chalk.dim('·')} up to ${maxPages} pages`)
  console.log(`  ${chalk.dim('→')} ${opts.url}`)
  console.log('')

  const browser = await chromium.launch({ headless: opts.headless ?? true })
  const context = await browser.newContext({ viewport: { width: vw, height: vh } })
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
    provider: opts.provider as 'openai' | 'anthropic' | undefined,
    vision: true,
    debug: opts.debug,
    llmTimeoutMs: 120_000, // design audits generate ~8k tokens of structured JSON — need 2min
  })

  const driver = new PlaywrightDriver(page)

  // Audit each page
  const results: PageAuditResult[] = []
  for (let i = 0; i < pages.length; i++) {
    const url = pages[i]
    console.log(`  ${chalk.dim(`[${i + 1}/${pages.length}]`)} ${url}`)

    let result: PageAuditResult
    if (generation === 2) {
      const gen2 = await auditOnePage({
        brain,
        driver,
        page,
        url,
        profileOverride: profile,
        screenshotDir,
        userRubricsDir: opts.rubricsDir,
      })
      result = gen2 as PageAuditResult
    } else {
      result = await auditSinglePage(brain, driver, page, url, profile ?? 'general', screenshotDir)
    }
    results.push(result)

    const icon = result.score >= 8 ? chalk.green('✓') : result.score >= 5 ? chalk.yellow('~') : chalk.red('✗')
    const scoreColor = result.score >= 8 ? chalk.green : result.score >= 5 ? chalk.yellow : chalk.red
    const findingCount = result.findings.length
    const classLabel = result.classification
      ? chalk.dim(` (${result.classification.type}/${result.classification.domain})`)
      : ''
    console.log(`  ${icon} ${scoreColor(`${result.score}/10`)} ${chalk.dim('—')} ${findingCount} finding${findingCount !== 1 ? 's' : ''}${classLabel}`)
  }

  // Generate report
  const report = generateReport(results, profile)
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
      summary: { avgScore, totalFindings: allFindings.length, critical, major, minor },
    }, null, 2))
    console.log(`  ${chalk.dim('JSON →')} ${jsonPath}`)
  }

  // Summary
  console.log('')
  console.log(`  ${chalk.dim('─'.repeat(52))}`)
  const avgColor = avgScore >= 8 ? chalk.green : avgScore >= 5 ? chalk.yellow : chalk.red
  const findingParts: string[] = []
  if (critical > 0) findingParts.push(chalk.red(`${critical} critical`))
  if (major > 0) findingParts.push(chalk.yellow(`${major} major`))
  if (minor > 0) findingParts.push(chalk.dim(`${minor} minor`))
  console.log(`  Avg: ${avgColor(`${avgScore.toFixed(1)}/10`)}  ${chalk.dim('·')}  ${allFindings.length} findings ${findingParts.length ? chalk.dim('(') + findingParts.join(chalk.dim(' · ')) + chalk.dim(')') : ''}`)
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
        let r: PageAuditResult
        if (generation === 2) {
          const gen2 = await auditOnePage({
            brain,
            driver,
            page,
            url,
            profileOverride: profile,
            userRubricsDir: opts.rubricsDir,
          })
          r = gen2 as PageAuditResult
        } else {
          r = await auditSinglePage(brain, driver, page, url, profile ?? 'general')
        }
        repResults.push(r)
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

    // Evolve loops still use the legacy single-profile re-audit. When Gen 2 auto-classified,
    // synthesize a profile name from the first page's classification (or fall back to 'general').
    const evolveProfile = profile
      ?? results[0]?.classification?.type
      ?? 'general'

    if (evolveMode !== 'css') {
      // Agent-dispatched evolve — a coding agent edits the actual source code
      const projectDir = opts.projectDir ?? process.cwd()
      evolveResult = await runAgentEvolveLoop(
        brain, driver, page, pages, evolveProfile, results, outputDir,
        opts.evolveRounds ?? 3, evolveMode, projectDir, opts.debug,
      )
    } else {
      // CSS-injection evolve — ephemeral fixes injected into the browser page
      evolveResult = await runEvolveLoop(brain, driver, page, pages, evolveProfile, results, outputDir, opts.evolveRounds ?? 3)
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
  }

  await browser.close()
}

// ---------------------------------------------------------------------------
// Evolve loop — audit → generate CSS fixes → inject → re-audit → compare
// ---------------------------------------------------------------------------

import type { DesignEvolveResult } from './types.js'

async function runEvolveLoop(
  brain: Brain,
  driver: PlaywrightDriver,
  page: Page,
  pages: string[],
  profile: string,
  initialResults: PageAuditResult[],
  outputDir: string,
  maxRounds: number,
): Promise<DesignEvolveResult> {
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

        const result = await auditSinglePage(brain, driver, page, url, profile, screenshotDir)
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

function generateEvolveReport(result: DesignEvolveResult): string {
  const lines: string[] = []
  lines.push('# Design Evolve Report')
  lines.push('')
  lines.push(`**Score:** ${result.beforeScore.toFixed(1)} → ${result.afterScore.toFixed(1)} (+${result.delta.toFixed(1)})`)
  lines.push(`**Rounds:** ${result.rounds}`)
  lines.push(`**Score progression:** ${result.scoreHistory.map(s => s.toFixed(1)).join(' → ')}`)
  lines.push('')

  if (result.appliedFixes.length > 0) {
    lines.push('## Applied Fixes')
    lines.push('')
    for (const fix of result.appliedFixes) {
      lines.push(`- \`${fix.cssSelector}\`: \`${fix.cssFix}\``)
      if (fix.finding) lines.push(`  - ${fix.finding}`)
    }
    lines.push('')
  }

  if (result.cssOverride) {
    lines.push('## Generated CSS Override')
    lines.push('')
    lines.push('```css')
    lines.push(result.cssOverride)
    lines.push('```')
    lines.push('')
    lines.push('Apply this CSS to your app to fix the identified design issues:')
    lines.push('```html')
    lines.push('<link rel="stylesheet" href="design-fixes.css">')
    lines.push('```')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Agent-dispatched evolve — sends findings to a coding agent that edits source
// ---------------------------------------------------------------------------

const AGENT_COMMANDS: Record<string, (prompt: string, projectDir: string) => string[]> = {
  'claude-code': (prompt, dir) => ['claude', '-p', prompt, '--dangerously-skip-permissions', '--add-dir', dir],
  'codex': (prompt, dir) => ['codex', 'exec', prompt, '-c', `cwd="${dir}"`],
  'opencode': (prompt, dir) => ['opencode', 'run', prompt],
}

function resolveAgentCommand(agent: string, prompt: string, projectDir: string): { cmd: string; args: string[]; cwd: string } {
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

function buildAgentFixPrompt(results: PageAuditResult[], profile: string, round: number): string {
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

  return `You are fixing design issues found by an automated design audit.

AUDIT PROFILE: ${profile}
ROUND: ${round} (${round === 1 ? 'initial fixes' : 'fixing remaining issues from previous round'})
CURRENT SCORES:
  Overall: ${(results.reduce((s, r) => s + r.score, 0) / results.length).toFixed(1)}/10
${scoreBreakdowns}

FINDINGS TO FIX (${critical.length} critical, ${major.length} major, ${minor.length} minor):

${findingsList}

INSTRUCTIONS:
1. Read the project's source files to understand the styling approach (Tailwind, CSS modules, plain CSS, styled-components, etc.)
2. Fix the findings by editing the ACTUAL SOURCE FILES — not by creating new CSS override files
3. Match the project's existing styling conventions
4. Fix the design SYSTEM (shared components, tokens, globals) not individual instances
5. Prioritize critical and major findings
6. Only change visual/styling properties — never change business logic, state, or event handlers
7. After making changes, verify the dev server is still running (no build errors)

Do NOT:
- Create new standalone CSS override files — edit the existing styles
- Add comments explaining what you changed — just change it
- Refactor unrelated code
- Change component structure or HTML semantics unless a finding specifically requires it`
}

async function runAgentEvolveLoop(
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
): Promise<DesignEvolveResult> {
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

    // Build the prompt for the agent
    const prompt = buildAgentFixPrompt(currentResults, profile, round)

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
      const result = execSync(
        `${cmd} ${args.map(a => JSON.stringify(a)).join(' ')}`,
        {
          cwd,
          stdio: debug ? 'inherit' : 'pipe',
          timeout: 300_000, // 5min max per agent round
          env: { ...process.env },
        },
      )

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
      const result = await auditSinglePage(brain, driver, page, url, profile, roundScreenshotDir)
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
    let designSystemScore: Record<string, number> | undefined
    try {
      let text = result.raw.trim()
      if (text.startsWith('```')) text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
      const parsed = JSON.parse(text)
      summary = parsed.summary || ''
      strengths = Array.isArray(parsed.strengths) ? parsed.strengths : []
      if (parsed.designSystemScore && typeof parsed.designSystemScore === 'object') {
        designSystemScore = {} as Record<string, number>
        for (const [k, v] of Object.entries(parsed.designSystemScore)) {
          if (typeof v === 'number') designSystemScore[k] = v
        }
      }
    } catch { /* use defaults */ }

    return {
      url,
      score: result.score,
      summary,
      strengths,
      findings: result.findings,
      screenshotPath,
      tokensUsed: result.tokensUsed,
      designSystemScore,
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
  fontFiles: Array<{ family: string; weight: string; style: string; src: string; format: string }>
  imageUrls: string[]
  backgroundImageUrls: string[]
  videoUrls: string[]
  externalStylesheetUrls: string[]
  linkAssetUrls: Array<{ url: string; rel: string }>
  detectedLibraries: string[]
}

// The in-page extraction function — runs inside page.evaluate()
function extractTokensFromDOM(): RawExtractionResult {
  const MAX_ELEMENTS = 50_000

  // --- CSS Custom Properties & Font Files ---
  const customProperties: Record<string, string> = {}
  const fontFiles: Array<{ family: string; weight: string; style: string; src: string; format: string }> = []
  const externalStylesheetUrls: string[] = []
  for (const sheet of document.styleSheets) {
    if (sheet.href && (sheet.href.startsWith('http://') || sheet.href.startsWith('https://'))) {
      externalStylesheetUrls.push(sheet.href)
    }
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
        if (rule instanceof CSSFontFaceRule) {
          const family = rule.style.getPropertyValue('font-family').replace(/['"]/g, '').trim()
          const weight = rule.style.getPropertyValue('font-weight') || '400'
          const style = rule.style.getPropertyValue('font-style') || 'normal'
          const src = rule.style.getPropertyValue('src')
          const urlMatch = src.match(/url\(["']?([^"')]+)["']?\)/)
          const formatMatch = src.match(/format\(["']?([^"')]+)["']?\)/)
          if (urlMatch) {
            fontFiles.push({
              family,
              weight,
              style,
              src: urlMatch[1],
              format: formatMatch?.[1] || 'unknown',
            })
          }
        }
      }
    } catch { /* cross-origin stylesheet */ }
  }

  // Supplement with document.fonts API (catches cross-origin @font-face)
  const seenFontSrcs = new Set(fontFiles.map(f => f.src))
  try {
    for (const face of document.fonts) {
      if (face.status === 'loaded') {
        // face.family is the CSS font-family, face.weight/style are strings
        // Check if we already captured this via @font-face rules
        const family = face.family.replace(/['"]/g, '').trim()
        const weight = face.weight || '400'
        const style = face.style || 'normal'
        // document.fonts doesn't expose the URL, but we can match against loaded resources
        if (!fontFiles.some(f => f.family === family && f.weight === weight && f.style === style)) {
          // Will be supplemented by Performance API below
        }
      }
    }
  } catch { /* older browser */ }

  // Use Performance API to find all loaded font resources (works cross-origin)
  try {
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    for (const r of resources) {
      if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(r.name) && !seenFontSrcs.has(r.name)) {
        seenFontSrcs.add(r.name)
        const formatMatch = r.name.match(/\.(woff2?|ttf|otf|eot)/i)
        fontFiles.push({
          family: '',  // can't determine from URL alone
          weight: '',
          style: '',
          src: r.name,
          format: formatMatch?.[1] || 'unknown',
        })
      }
    }
  } catch { /* Performance API not available */ }

  // --- Element traversal ---
  const colorMap = new Map<string, { count: number; properties: Set<string> }>()
  const spacingMap = new Map<string, { count: number; properties: Set<string> }>()
  const borderRadiusMap = new Map<string, number>()
  const shadowMap = new Map<string, number>()
  const fontFamilyMap = new Map<string, { weights: Set<number>; headingUse: boolean; monoUse: boolean }>()
  const typeScaleMap = new Map<string, { fontSize: string; fontWeight: string; lineHeight: string; letterSpacing: string; fontFamily: string; tag: string; count: number }>()
  const animationMap = new Map<string, { property: string; value: string; count: number }>()
  const backgroundImageUrls = new Set<string>()

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

  let elementCount = 0

  // Per-element extraction — shared between light DOM walker and shadow DOM walker
  function processElement(el: Element) {
    const htmlEl = el as HTMLElement
    if (htmlEl.offsetWidth === 0 && htmlEl.offsetHeight === 0) return

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
    if (cs.backgroundImage.includes('url(')) {
      const urlMatches = cs.backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)
      for (const m of urlMatches) {
        const u = m[1]
        if (u && !u.startsWith('data:') && !u.startsWith('blob:')) backgroundImageUrls.add(u)
      }
    }
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
  }

  // --- Light DOM walk ---
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
  let el: Element | null = walker.currentNode as Element

  while (el && elementCount < MAX_ELEMENTS) {
    elementCount++
    processElement(el)
    el = walker.nextNode() as Element | null
  }

  // --- Shadow DOM walk ---
  function walkShadowRoots(root: ShadowRoot) {
    const shadowWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
    // currentNode starts at root (ShadowRoot, not Element) — advance to first element
    let shadowEl: Element | null = shadowWalker.nextNode() as Element | null
    while (shadowEl && elementCount < MAX_ELEMENTS) {
      elementCount++
      processElement(shadowEl)
      if ((shadowEl as any).shadowRoot) {
        walkShadowRoots((shadowEl as any).shadowRoot)
      }
      shadowEl = shadowWalker.nextNode() as Element | null
    }
  }

  const allElements = document.body.querySelectorAll('*')
  for (const bodyEl of allElements) {
    if ((bodyEl as any).shadowRoot && elementCount < MAX_ELEMENTS) {
      walkShadowRoots((bodyEl as any).shadowRoot)
    }
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

  // --- All Image URLs ---
  const imageUrls = new Set<string>()
  for (const img of document.querySelectorAll('img')) {
    const src = (img as HTMLImageElement).src
    if (src && !src.startsWith('data:') && !src.startsWith('blob:')) imageUrls.add(src)
    const srcset = (img as HTMLImageElement).srcset
    if (srcset) {
      for (const part of srcset.split(',')) {
        const url = part.trim().split(/\s+/)[0]
        if (url && !url.startsWith('data:') && !url.startsWith('blob:')) imageUrls.add(url)
      }
    }
  }

  // --- Video URLs ---
  const videoUrls = new Set<string>()
  for (const video of document.querySelectorAll('video')) {
    const src = (video as HTMLVideoElement).src
    if (src && !src.startsWith('data:') && !src.startsWith('blob:')) videoUrls.add(src)
    const poster = (video as HTMLVideoElement).poster
    if (poster && !poster.startsWith('data:') && !poster.startsWith('blob:')) imageUrls.add(poster)
    for (const source of video.querySelectorAll('source')) {
      const ssrc = (source as HTMLSourceElement).src
      if (ssrc && !ssrc.startsWith('data:') && !ssrc.startsWith('blob:')) videoUrls.add(ssrc)
    }
  }
  // Orphan <source> elements (audio, picture)
  for (const source of document.querySelectorAll('source[src]')) {
    const ssrc = (source as HTMLSourceElement).src
    if (ssrc && /\.(mp4|webm|mov|ogg|avi|m3u8)/i.test(ssrc)) videoUrls.add(ssrc)
  }
  // <picture> <source> with srcset
  for (const source of document.querySelectorAll('picture source[srcset]')) {
    const srcset = (source as HTMLSourceElement).srcset
    if (srcset) {
      for (const part of srcset.split(',')) {
        const url = part.trim().split(/\s+/)[0]
        if (url && !url.startsWith('data:') && !url.startsWith('blob:')) imageUrls.add(url)
      }
    }
  }

  // --- Lazy-load data attributes ---
  for (const el of document.querySelectorAll('[data-src], [data-bg], [data-background-image], [data-poster]')) {
    for (const attr of ['data-src', 'data-bg', 'data-background-image', 'data-poster']) {
      const val = el.getAttribute(attr)
      if (!val || val.startsWith('data:') || val.startsWith('blob:')) continue
      try {
        const resolved = new URL(val, document.location.href).href
        if (/\.(mp4|webm|mov|ogg|avi|m3u8)/i.test(val)) videoUrls.add(resolved)
        else imageUrls.add(resolved)
      } catch { /* bad URL */ }
    }
  }

  // --- Link Assets (favicons, icons, manifests) ---
  const linkAssetUrls: Array<{ url: string; rel: string }> = []
  for (const link of document.querySelectorAll('link[href]')) {
    const href = (link as HTMLLinkElement).href
    const rel = (link as HTMLLinkElement).rel || ''
    if (href && !href.startsWith('data:') && !href.startsWith('blob:') &&
        /^(icon|shortcut icon|apple-touch-icon|manifest|preload)$/i.test(rel)) {
      linkAssetUrls.push({ url: href, rel })
    }
  }

  // --- Inline script library detection ---
  const detectedLibraries: string[] = []
  const seenLibs = new Set<string>()
  for (const script of document.querySelectorAll('script')) {
    const src = (script as HTMLScriptElement).src || ''
    const text = script.textContent || ''
    const content = src + ' ' + text.slice(0, 10_000)
    const checks: [RegExp, string][] = [
      [/gsap|ScrollTrigger|ScrollSmoother/i, 'gsap'],
      [/new\s+p5\b|p5\.setup|p5\.draw|p5\.js/i, 'p5.js'],
      [/THREE\.|new\s+THREE\.|from\s+['"]three/i, 'three.js'],
      [/lottie|bodymovin/i, 'lottie'],
      [/anime\s*\(|animejs/i, 'anime.js'],
      [/framer-motion|motion\.div/i, 'framer-motion'],
      [/webflow/i, 'webflow'],
      [/swiper/i, 'swiper'],
      [/locomotive.?scroll/i, 'locomotive-scroll'],
      [/rive\.?app|@rive-app/i, 'rive'],
      [/spline/i, 'spline'],
    ]
    for (const [regex, name] of checks) {
      if (!seenLibs.has(name) && regex.test(content)) {
        seenLibs.add(name)
        detectedLibraries.push(name)
      }
    }
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
    fontFiles,
    imageUrls: Array.from(imageUrls),
    backgroundImageUrls: Array.from(backgroundImageUrls),
    videoUrls: Array.from(videoUrls),
    externalStylesheetUrls,
    linkAssetUrls,
    detectedLibraries,
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

// ---------------------------------------------------------------------------
// Programmatic API — extractDesignTokens()
// ---------------------------------------------------------------------------

export interface ExtractDesignTokensOptions {
  url: string
  headless?: boolean
  outputDir?: string
  viewports?: Array<{ name: string; width: number; height: number }>
  onProgress?: (viewport: string, width: number, height: number, stats: { colors: number; fonts: number; buttons: number; inputs: number; cards: number }) => void
}

export interface ExtractionResult {
  tokens: DesignTokens
  outputDir: string
  screenshotPaths: Record<string, string>
}

/**
 * Extract design tokens from a URL at multiple viewports.
 * Pure DOM extraction — no LLM calls.
 *
 * ```typescript
 * import { extractDesignTokens } from '@tangle-network/browser-agent-driver'
 *
 * const { tokens } = await extractDesignTokens({ url: 'https://stripe.com' })
 * console.log(tokens.colors.filter(c => c.cluster === 'primary'))
 * console.log(tokens.typography.families)
 * console.log(tokens.brand)
 * ```
 */
export async function extractDesignTokens(opts: ExtractDesignTokensOptions): Promise<ExtractionResult> {
  const viewports = opts.viewports ?? [...VIEWPORTS]
  const outputDir = opts.outputDir ?? `./audit-results/${new URL(opts.url).hostname}-tokens-${Date.now()}`
  fs.mkdirSync(outputDir, { recursive: true })
  const screenshotDir = path.join(outputDir, 'screenshots')
  fs.mkdirSync(screenshotDir, { recursive: true })

  const browser = await chromium.launch({ headless: opts.headless ?? true })

  const allCustomProps: Record<string, string> = {}
  const allColors = new Map<string, { count: number; properties: Set<string> }>()
  const allFamilies = new Map<string, { weights: Set<number>; headingUse: boolean; monoUse: boolean }>()
  const allScaleEntries: Array<{ fontSize: string; fontWeight: string; lineHeight: string; letterSpacing: string; fontFamily: string; tag: string; count: number }> = []
  let brand: RawExtractionResult['brand'] = {}
  const allLogos: LogoAsset[] = []
  const allIcons: SvgIcon[] = []
  const allFontFiles = new Map<string, { family: string; weight: string; style: string; src: string; format: string }>()
  const allImageUrls = new Set<string>()
  const allBackgroundImageUrls = new Set<string>()
  const allVideoUrls = new Set<string>()
  const allExternalStylesheetUrls = new Set<string>()
  const allLinkAssetUrls = new Map<string, string>() // url -> rel
  const allDetectedLibraries = new Set<string>()
  const responsiveTokens: Record<string, ViewportTokens> = {}
  const screenshotPaths: Record<string, string> = {}

  for (const vp of viewports) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    const page = await context.newPage()

    try {
      await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 20_000 }).catch(() =>
        page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      )
      await page.waitForTimeout(2000)
      await dismissCookieBanners(page)
      await page.waitForTimeout(500)

      const screenshotPath = path.join(screenshotDir, `${vp.name}.png`)
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() =>
        page.screenshot({ path: screenshotPath, fullPage: false })
      )
      screenshotPaths[vp.name] = screenshotPath

      const raw = await page.evaluate(extractTokensFromDOM)

      Object.assign(allCustomProps, raw.customProperties)

      for (const c of raw.colors) {
        const existing = allColors.get(c.value)
        if (existing) {
          existing.count += c.count
          for (const p of c.properties) existing.properties.add(p)
        } else {
          allColors.set(c.value, { count: c.count, properties: new Set(c.properties) })
        }
      }

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

      if (vp.name === 'desktop' || !brand.title) {
        brand = raw.brand
      }

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
      for (const ff of raw.fontFiles) {
        if (!allFontFiles.has(ff.src)) {
          allFontFiles.set(ff.src, ff)
        }
      }
      for (const u of raw.imageUrls) allImageUrls.add(u)
      for (const u of raw.backgroundImageUrls) allBackgroundImageUrls.add(u)
      for (const u of raw.videoUrls) allVideoUrls.add(u)
      for (const u of raw.externalStylesheetUrls) allExternalStylesheetUrls.add(u)
      for (const la of raw.linkAssetUrls) allLinkAssetUrls.set(la.url, la.rel)
      for (const lib of raw.detectedLibraries) allDetectedLibraries.add(lib)

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

      opts.onProgress?.(vp.name, vp.width, vp.height, {
        colors: raw.colors.length,
        fonts: raw.typography.families.length,
        buttons: raw.components.buttons.length,
        inputs: raw.components.inputs.length,
        cards: raw.components.cards.length,
      })
    } finally {
      await context.close()
    }
  }

  await browser.close()

  // Deduplicate type scale
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
      scaleMap.set(key, { fontSize: entry.fontSize, fontWeight: entry.fontWeight, lineHeight: entry.lineHeight, letterSpacing: entry.letterSpacing, fontFamily: entry.fontFamily, usage, tag: entry.tag, count: entry.count })
    }
  }

  const mergedColors = Array.from(allColors.entries())
    .map(([value, data]) => ({ value, count: data.count, properties: Array.from(data.properties) }))
    .sort((a, b) => b.count - a.count)
  const clusteredColors = clusterColors(mergedColors)

  const families: FontFamily[] = Array.from(allFamilies.entries()).map(([family, data]) => ({
    family,
    weights: Array.from(data.weights).sort((a, b) => a - b),
    classification: data.monoUse ? 'mono' as const :
      (data.headingUse && allFamilies.size > 1) ? 'heading' as const :
      data.headingUse ? 'display' as const : 'body' as const,
  }))

  // Download font files
  const downloadedFontFiles: FontFile[] = []
  if (allFontFiles.size > 0) {
    const fontDir = path.join(outputDir, 'fonts')
    fs.mkdirSync(fontDir, { recursive: true })
    for (const ff of allFontFiles.values()) {
      try {
        const res = await fetch(ff.src)
        if (!res.ok) continue
        const buffer = Buffer.from(await res.arrayBuffer())
        const urlPath = decodeURIComponent(new URL(ff.src).pathname)
        const filename = path.basename(urlPath) || `${ff.family.replace(/\s+/g, '-')}-${ff.weight}-${ff.style}.${ff.format === 'unknown' ? 'bin' : ff.format}`
        const localPath = path.join(fontDir, filename)
        fs.writeFileSync(localPath, buffer)
        downloadedFontFiles.push({ ...ff, localPath })
      } catch {
        downloadedFontFiles.push({ ...ff })
      }
    }
  }

  // Download images
  const downloadedImages: ImageAsset[] = []
  const allAssetUrls = new Map<string, ImageAsset['type']>()
  for (const u of allImageUrls) allAssetUrls.set(u, 'img')
  for (const u of allBackgroundImageUrls) allAssetUrls.set(u, 'background')
  // Brand assets
  if (brand.favicon) allAssetUrls.set(brand.favicon, 'favicon')
  if (brand.ogImage) allAssetUrls.set(brand.ogImage, 'og-image')
  if (brand.appleTouchIcon) allAssetUrls.set(brand.appleTouchIcon, 'icon')
  for (const [url, rel] of allLinkAssetUrls) {
    if (/icon/i.test(rel)) allAssetUrls.set(url, 'favicon')
  }

  if (allAssetUrls.size > 0) {
    const imageDir = path.join(outputDir, 'images')
    fs.mkdirSync(imageDir, { recursive: true })
    for (const [url, type] of allAssetUrls) {
      try {
        const res = await fetch(url)
        if (!res.ok) { downloadedImages.push({ url, type }); continue }
        const buffer = Buffer.from(await res.arrayBuffer())
        const urlPath = decodeURIComponent(new URL(url).pathname)
        const filename = path.basename(urlPath) || `asset-${downloadedImages.length}.bin`
        const localPath = path.join(imageDir, filename)
        fs.writeFileSync(localPath, buffer)
        downloadedImages.push({
          url, type, localPath,
          mimeType: res.headers.get('content-type') || undefined,
          sizeBytes: buffer.length,
        })
      } catch {
        downloadedImages.push({ url, type })
      }
    }
  }

  // Download external stylesheets
  const downloadedStylesheets: Array<{ url: string; localPath?: string }> = []
  if (allExternalStylesheetUrls.size > 0) {
    const cssDir = path.join(outputDir, 'stylesheets')
    fs.mkdirSync(cssDir, { recursive: true })
    for (const url of allExternalStylesheetUrls) {
      try {
        const res = await fetch(url)
        if (!res.ok) { downloadedStylesheets.push({ url }); continue }
        const text = await res.text()
        const urlPath = decodeURIComponent(new URL(url).pathname)
        const filename = path.basename(urlPath) || `style-${downloadedStylesheets.length}.css`
        const localPath = path.join(cssDir, filename)
        fs.writeFileSync(localPath, text)
        downloadedStylesheets.push({ url, localPath })
      } catch {
        downloadedStylesheets.push({ url })
      }
    }
  }

  // Download videos
  const downloadedVideos: Array<{ url: string; type: 'video' | 'video-source'; poster?: string; localPath?: string; mimeType?: string; sizeBytes?: number }> = []
  if (allVideoUrls.size > 0) {
    const videoDir = path.join(outputDir, 'videos')
    fs.mkdirSync(videoDir, { recursive: true })
    for (const url of allVideoUrls) {
      try {
        const res = await fetch(url)
        if (!res.ok) { downloadedVideos.push({ url, type: 'video' }); continue }
        const buffer = Buffer.from(await res.arrayBuffer())
        const urlPath = decodeURIComponent(new URL(url).pathname)
        const filename = path.basename(urlPath) || `video-${downloadedVideos.length}.mp4`
        const localPath = path.join(videoDir, filename)
        fs.writeFileSync(localPath, buffer)
        downloadedVideos.push({
          url, type: 'video', localPath,
          mimeType: res.headers.get('content-type') || undefined,
          sizeBytes: buffer.length,
        })
      } catch {
        downloadedVideos.push({ url, type: 'video' })
      }
    }
  }

  const tokens: DesignTokens = {
    url: opts.url,
    extractedAt: new Date().toISOString(),
    viewportsAudited: viewports.map(v => v.name),
    customProperties: allCustomProps,
    colors: clusteredColors,
    typography: { families, scale: Array.from(scaleMap.values()).sort((a, b) => b.count - a.count) },
    brand,
    logos: allLogos,
    icons: allIcons.slice(0, 50),
    fontFiles: downloadedFontFiles,
    images: downloadedImages,
    videos: downloadedVideos,
    stylesheets: downloadedStylesheets,
    responsive: responsiveTokens,
    detectedLibraries: Array.from(allDetectedLibraries),
  }

  const tokenPath = path.join(outputDir, 'tokens.json')
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2))

  return { tokens, outputDir, screenshotPaths }
}

// ---------------------------------------------------------------------------
// Zip packaging
// ---------------------------------------------------------------------------

async function createZipBundle(outputDir: string, tokens: DesignTokens): Promise<string> {
  const { execSync } = await import('node:child_process')
  const zipPath = `${outputDir}.zip`
  // Use system zip (available on macOS/Linux)
  execSync(`cd "${path.dirname(outputDir)}" && zip -r "${path.basename(zipPath)}" "${path.basename(outputDir)}"`, { stdio: 'pipe' })
  return zipPath
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
