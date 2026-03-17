/**
 * Design compare — comprehensive side-by-side comparison of two URLs.
 *
 * Extracts tokens from both, captures screenshots at multiple viewports,
 * interacts with accordions/tabs/carousels, and produces pixel + structural diffs.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { chromium, type Page, type BrowserContext } from 'playwright'
import chalk from 'chalk'
import type { DesignTokens, ColorToken } from '../types.js'
import type { CompareOptions, CompareResult, ViewportDiff, TokenDiff, InteractionScreenshots } from './types.js'
import { revealHiddenContent, captureInteractionScreenshots } from './page-interaction.js'

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
] as const

// ── Pixel diff ──

async function pixelDiff(imgA: Buffer, imgB: Buffer): Promise<{ diffPercent: number; diffImage: Buffer }> {
  let PNG: typeof import('pngjs').PNG
  let pixelmatch: typeof import('pixelmatch').default
  try {
    PNG = (await import('pngjs')).PNG
    pixelmatch = (await import('pixelmatch')).default
  } catch {
    // Fallback: no diff available
    return { diffPercent: -1, diffImage: Buffer.alloc(0) }
  }

  const a = PNG.sync.read(imgA)
  const b = PNG.sync.read(imgB)

  // Use the larger dimensions
  const width = Math.max(a.width, b.width)
  const height = Math.max(a.height, b.height)

  // Pad smaller image to match dimensions
  const padImage = (img: InstanceType<typeof PNG>, w: number, h: number) => {
    if (img.width === w && img.height === h) return img
    const padded = new PNG({ width: w, height: h, fill: true })
    PNG.bitblt(img, padded, 0, 0, Math.min(img.width, w), Math.min(img.height, h), 0, 0)
    return padded
  }

  const paddedA = padImage(a, width, height)
  const paddedB = padImage(b, width, height)
  const diff = new PNG({ width, height })

  const numDiff = pixelmatch(paddedA.data, paddedB.data, diff.data, width, height, { threshold: 0.1 })
  const diffPercent = (numDiff / (width * height)) * 100

  return { diffPercent, diffImage: PNG.sync.write(diff) }
}

// ── Token diff ──

function diffTokens(a: DesignTokens, b: DesignTokens): TokenDiff {
  // Colors
  const hexA = new Set(a.colors.map(c => c.hex))
  const hexB = new Set(b.colors.map(c => c.hex))
  const addedColors = b.colors.filter(c => !hexA.has(c.hex)).map(c => ({ hex: c.hex, cluster: c.cluster }))
  const removedColors = a.colors.filter(c => !hexB.has(c.hex)).map(c => ({ hex: c.hex, cluster: c.cluster }))

  // Fonts
  const fontsA = new Set(a.typography.families.map(f => f.family))
  const fontsB = new Set(b.typography.families.map(f => f.family))
  const addedFonts = [...fontsB].filter(f => !fontsA.has(f))
  const removedFonts = [...fontsA].filter(f => !fontsB.has(f))

  // CSS variables
  const varsA = a.customProperties
  const varsB = b.customProperties
  const allVarNames = new Set([...Object.keys(varsA), ...Object.keys(varsB)])
  const addedVars: string[] = []
  const removedVars: string[] = []
  const changedVars: Array<{ name: string; from: string; to: string }> = []
  for (const name of allVarNames) {
    if (!(name in varsA)) addedVars.push(name)
    else if (!(name in varsB)) removedVars.push(name)
    else if (varsA[name] !== varsB[name]) changedVars.push({ name, from: varsA[name], to: varsB[name] })
  }

  // Spacing grid units
  const gridA = a.responsive.desktop?.gridBaseUnit
  const gridB = b.responsive.desktop?.gridBaseUnit

  // Brand
  const brand: Record<string, { from?: string; to?: string }> = {}
  const brandKeys = ['title', 'description', 'themeColor', 'favicon', 'ogImage'] as const
  for (const key of brandKeys) {
    const va = a.brand[key]
    const vb = b.brand[key]
    if (va !== vb) brand[key] = { from: va, to: vb }
  }

  // Videos
  const videosA = new Set((a as any).videos?.map((v: any) => v.url) ?? [])
  const videosB = new Set((b as any).videos?.map((v: any) => v.url) ?? [])
  const addedVideos = [...videosB].filter(v => !videosA.has(v)) as string[]
  const removedVideos = [...videosA].filter(v => !videosB.has(v)) as string[]

  // Components
  const desktop = 'desktop'
  const buttonsA = a.responsive[desktop]?.components?.buttons?.length ?? 0
  const buttonsB = b.responsive[desktop]?.components?.buttons?.length ?? 0
  const inputsA = a.responsive[desktop]?.components?.inputs?.length ?? 0
  const inputsB = b.responsive[desktop]?.components?.inputs?.length ?? 0
  const cardsA = a.responsive[desktop]?.components?.cards?.length ?? 0
  const cardsB = b.responsive[desktop]?.components?.cards?.length ?? 0

  return {
    colors: { added: addedColors, removed: removedColors },
    fonts: { added: addedFonts, removed: removedFonts },
    cssVariables: { added: addedVars, removed: removedVars, changed: changedVars },
    spacing: { gridUnitA: gridA, gridUnitB: gridB },
    brand,
    videos: { added: addedVideos, removed: removedVideos },
    images: { countA: a.images.length, countB: b.images.length },
    components: { buttonsA, buttonsB, inputsA, inputsB, cardsA, cardsB },
  }
}

// ── Load page + extract tokens in-page ──

async function loadAndExtract(
  context: BrowserContext,
  url: string,
  screenshotDir: string,
  label: string,
  vpName: string,
  interactiveReveal: boolean,
): Promise<{
  screenshot: Buffer
  html: string
  interactionScreenshots: Awaited<ReturnType<typeof captureInteractionScreenshots>>
}> {
  const page = await context.newPage()

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 25_000 }).catch(() =>
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    )
    await page.waitForTimeout(2000)

    if (interactiveReveal) {
      await revealHiddenContent(page, { mobile: vpName === 'mobile' })
    }

    // Full-page screenshot
    const screenshot = await page.screenshot({ fullPage: true }).catch(() =>
      page.screenshot({ fullPage: false })
    )
    const ssPath = path.join(screenshotDir, `${vpName}-${label}.png`)
    fs.writeFileSync(ssPath, screenshot)

    // Interaction screenshots
    type InteractionResult = Awaited<ReturnType<typeof captureInteractionScreenshots>>
    let interactionScreenshots: InteractionResult = { tabs: [], accordions: [], carousel: [] }
    if (interactiveReveal) {
      // Reload page to capture interaction screenshots from clean state
      await page.goto(url, { waitUntil: 'networkidle', timeout: 25_000 }).catch(() =>
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      )
      await page.waitForTimeout(2000)
      interactionScreenshots = await captureInteractionScreenshots(page, { mobile: vpName === 'mobile' })
    }

    const html = await page.content()
    return { screenshot, html, interactionScreenshots }
  } finally {
    await page.close()
  }
}

// ── Report generation ──

function generateHtmlReport(
  diffs: ViewportDiff[],
  tokenDiff: TokenDiff,
  urlA: string,
  urlB: string,
  screenshotDir: string,
): string {
  const sections: string[] = []

  // Viewport diffs
  for (const d of diffs) {
    const aPath = path.relative(path.dirname(screenshotDir), d.screenshotA)
    const bPath = path.relative(path.dirname(screenshotDir), d.screenshotB)
    const diffPath = path.relative(path.dirname(screenshotDir), d.diffImage)
    const pct = d.diffPercent >= 0 ? `${d.diffPercent.toFixed(1)}%` : 'N/A'
    sections.push(`
    <div class="viewport">
      <h2>${d.viewport} (${d.width}×${d.height}) — ${pct} different</h2>
      <div class="side-by-side">
        <div><h3>A: ${escHtml(urlA)}</h3><img src="${escHtml(aPath)}" /></div>
        <div><h3>B: ${escHtml(urlB)}</h3><img src="${escHtml(bPath)}" /></div>
        ${d.diffPercent >= 0 ? `<div><h3>Diff</h3><img src="${escHtml(diffPath)}" /></div>` : ''}
      </div>
    </div>`)
  }

  // Token diff summary
  const tokenRows: string[] = []
  if (tokenDiff.colors.added.length || tokenDiff.colors.removed.length) {
    tokenRows.push(`<tr><td>Colors</td><td>+${tokenDiff.colors.added.length} added, -${tokenDiff.colors.removed.length} removed</td></tr>`)
  }
  if (tokenDiff.fonts.added.length || tokenDiff.fonts.removed.length) {
    tokenRows.push(`<tr><td>Fonts</td><td>+${tokenDiff.fonts.added.length} (${tokenDiff.fonts.added.join(', ')}), -${tokenDiff.fonts.removed.length} (${tokenDiff.fonts.removed.join(', ')})</td></tr>`)
  }
  if (tokenDiff.cssVariables.added.length || tokenDiff.cssVariables.removed.length || tokenDiff.cssVariables.changed.length) {
    tokenRows.push(`<tr><td>CSS Variables</td><td>+${tokenDiff.cssVariables.added.length}, -${tokenDiff.cssVariables.removed.length}, ~${tokenDiff.cssVariables.changed.length} changed</td></tr>`)
  }
  if (tokenDiff.spacing.gridUnitA !== tokenDiff.spacing.gridUnitB) {
    tokenRows.push(`<tr><td>Grid Unit</td><td>${tokenDiff.spacing.gridUnitA ?? 'none'}px → ${tokenDiff.spacing.gridUnitB ?? 'none'}px</td></tr>`)
  }
  for (const [key, val] of Object.entries(tokenDiff.brand)) {
    tokenRows.push(`<tr><td>Brand: ${key}</td><td>${escHtml(val.from ?? '(none)')} → ${escHtml(val.to ?? '(none)')}</td></tr>`)
  }
  if (tokenDiff.videos.added.length || tokenDiff.videos.removed.length) {
    tokenRows.push(`<tr><td>Videos</td><td>+${tokenDiff.videos.added.length}, -${tokenDiff.videos.removed.length}</td></tr>`)
  }

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Design Comparison: ${escHtml(urlA)} vs ${escHtml(urlB)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 1600px; margin: 0 auto; padding: 20px; background: #0a0a0a; color: #e0e0e0; }
  h1 { border-bottom: 1px solid #333; padding-bottom: 12px; }
  h2 { color: #90caf9; }
  .side-by-side { display: flex; gap: 12px; overflow-x: auto; }
  .side-by-side > div { flex: 1; min-width: 300px; }
  .side-by-side img { max-width: 100%; border: 1px solid #333; border-radius: 4px; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; }
  th, td { text-align: left; padding: 8px 12px; border: 1px solid #333; }
  th { background: #1a1a2e; }
  .viewport { margin: 32px 0; }
  .color-swatch { display: inline-block; width: 16px; height: 16px; border-radius: 3px; border: 1px solid #555; vertical-align: middle; margin-right: 4px; }
</style>
</head><body>
<h1>Design Comparison</h1>
<p><strong>A:</strong> ${escHtml(urlA)}<br><strong>B:</strong> ${escHtml(urlB)}<br><strong>Generated:</strong> ${new Date().toISOString()}</p>

<h2>Token Differences</h2>
${tokenRows.length ? `<table><thead><tr><th>Category</th><th>Delta</th></tr></thead><tbody>${tokenRows.join('')}</tbody></table>` : '<p>No structural differences detected.</p>'}

${tokenDiff.colors.added.length ? `<h3>New Colors in B</h3><p>${tokenDiff.colors.added.map(c => `<span class="color-swatch" style="background:${c.hex}"></span>${c.hex} (${c.cluster ?? '?'})`).join(' &nbsp; ')}</p>` : ''}
${tokenDiff.colors.removed.length ? `<h3>Colors Removed from A</h3><p>${tokenDiff.colors.removed.map(c => `<span class="color-swatch" style="background:${c.hex}"></span>${c.hex} (${c.cluster ?? '?'})`).join(' &nbsp; ')}</p>` : ''}

${tokenDiff.cssVariables.changed.length ? `<h3>Changed CSS Variables</h3><table><thead><tr><th>Variable</th><th>A</th><th>B</th></tr></thead><tbody>${tokenDiff.cssVariables.changed.slice(0, 50).map(v => `<tr><td><code>${escHtml(v.name)}</code></td><td>${escHtml(v.from)}</td><td>${escHtml(v.to)}</td></tr>`).join('')}</tbody></table>` : ''}

${sections.join('')}
</body></html>`
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── Main compare function ──

export async function runDesignCompare(opts: CompareOptions): Promise<CompareResult> {
  const viewports = opts.viewports ?? [...VIEWPORTS]
  const outputDir = opts.outputDir ?? `./compare-results/${Date.now()}`
  fs.mkdirSync(outputDir, { recursive: true })
  const screenshotDir = path.join(outputDir, 'screenshots')
  fs.mkdirSync(screenshotDir, { recursive: true })
  const interactionDir = path.join(outputDir, 'interactions')
  fs.mkdirSync(interactionDir, { recursive: true })

  console.log('')
  console.log(`  ${chalk.bold('bad design-audit')} ${chalk.dim('--design-compare')}`)
  console.log(`  ${chalk.dim('A →')} ${opts.urlA}`)
  console.log(`  ${chalk.dim('B →')} ${opts.urlB}`)
  console.log('')

  const browser = await chromium.launch({ headless: opts.headless ?? true })
  const viewportDiffs: ViewportDiff[] = []
  const interactiveReveal = opts.interactiveReveal !== false

  // We need tokens for diff — import extractDesignTokens lazily to avoid circular deps
  const { extractDesignTokens } = await import('../cli-design-audit.js')

  console.log(`  ${chalk.dim('Extracting tokens from A…')}`)
  const tokensA = await extractDesignTokens({
    url: opts.urlA,
    headless: opts.headless,
    outputDir: path.join(outputDir, 'tokens-a'),
  })

  console.log(`  ${chalk.dim('Extracting tokens from B…')}`)
  const tokensB = await extractDesignTokens({
    url: opts.urlB,
    headless: opts.headless,
    outputDir: path.join(outputDir, 'tokens-b'),
  })

  // Per-viewport comparison
  for (const vp of viewports) {
    console.log(`  ${chalk.dim(`[${vp.name}]`)} ${vp.width}×${vp.height}`)

    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })

    const resultA = await loadAndExtract(context, opts.urlA, screenshotDir, 'a', vp.name, interactiveReveal)
    const resultB = await loadAndExtract(context, opts.urlB, screenshotDir, 'b', vp.name, interactiveReveal)

    // Pixel diff
    const { diffPercent, diffImage } = await pixelDiff(resultA.screenshot, resultB.screenshot)
    const diffPath = path.join(screenshotDir, `${vp.name}-diff.png`)
    if (diffImage.length > 0) fs.writeFileSync(diffPath, diffImage)

    // Save interaction screenshots
    const interactionScreenshots: InteractionScreenshots = {
      tabsA: [], tabsB: [],
      accordionsA: [], accordionsB: [],
      carouselA: [], carouselB: [],
    }

    const saveInteractions = (bufs: Buffer[], prefix: string): string[] => {
      return bufs.map((buf, i) => {
        const p = path.join(interactionDir, `${vp.name}-${prefix}-${i}.png`)
        fs.writeFileSync(p, buf)
        return p
      })
    }

    interactionScreenshots.tabsA = saveInteractions(resultA.interactionScreenshots.tabs, 'tab-a')
    interactionScreenshots.tabsB = saveInteractions(resultB.interactionScreenshots.tabs, 'tab-b')
    interactionScreenshots.accordionsA = saveInteractions(resultA.interactionScreenshots.accordions, 'accordion-a')
    interactionScreenshots.accordionsB = saveInteractions(resultB.interactionScreenshots.accordions, 'accordion-b')
    interactionScreenshots.carouselA = saveInteractions(resultA.interactionScreenshots.carousel, 'carousel-a')
    interactionScreenshots.carouselB = saveInteractions(resultB.interactionScreenshots.carousel, 'carousel-b')

    if (resultA.interactionScreenshots.menu) {
      const p = path.join(interactionDir, `${vp.name}-menu-a.png`)
      fs.writeFileSync(p, resultA.interactionScreenshots.menu)
      interactionScreenshots.menuA = p
    }
    if (resultB.interactionScreenshots.menu) {
      const p = path.join(interactionDir, `${vp.name}-menu-b.png`)
      fs.writeFileSync(p, resultB.interactionScreenshots.menu)
      interactionScreenshots.menuB = p
    }

    const pctStr = diffPercent >= 0 ? `${diffPercent.toFixed(1)}%` : 'N/A'
    const pctColor = diffPercent <= 1 ? chalk.green : diffPercent <= 10 ? chalk.yellow : chalk.red
    console.log(`    ${pctColor(pctStr)} pixel diff`)

    viewportDiffs.push({
      viewport: vp.name,
      width: vp.width,
      height: vp.height,
      screenshotA: path.join(screenshotDir, `${vp.name}-a.png`),
      screenshotB: path.join(screenshotDir, `${vp.name}-b.png`),
      diffImage: diffPath,
      diffPercent,
      interactionScreenshots,
    })

    await context.close()
  }

  await browser.close()

  // Structural token diff
  const tokenDiff = diffTokens(tokensA.tokens, tokensB.tokens)

  // Generate HTML report
  const reportHtml = generateHtmlReport(viewportDiffs, tokenDiff, opts.urlA, opts.urlB, screenshotDir)
  const reportPath = path.join(outputDir, 'report.html')
  fs.writeFileSync(reportPath, reportHtml)

  // Also write JSON report
  fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    urlA: opts.urlA,
    urlB: opts.urlB,
    viewportDiffs: viewportDiffs.map(d => ({
      viewport: d.viewport,
      width: d.width,
      height: d.height,
      diffPercent: d.diffPercent,
    })),
    tokenDiff,
  }, null, 2))

  // Summary
  console.log('')
  console.log(`  ${chalk.dim('─'.repeat(52))}`)
  const totalDiff = viewportDiffs.reduce((sum, d) => sum + (d.diffPercent >= 0 ? d.diffPercent : 0), 0) / viewportDiffs.length
  const totalColor = totalDiff <= 1 ? chalk.green : totalDiff <= 10 ? chalk.yellow : chalk.red
  console.log(`  Avg pixel diff: ${totalColor(`${totalDiff.toFixed(1)}%`)}`)
  if (tokenDiff.colors.added.length || tokenDiff.colors.removed.length) {
    console.log(`  Colors: ${chalk.green(`+${tokenDiff.colors.added.length}`)} ${chalk.red(`-${tokenDiff.colors.removed.length}`)}`)
  }
  if (tokenDiff.fonts.added.length || tokenDiff.fonts.removed.length) {
    console.log(`  Fonts: ${chalk.green(`+${tokenDiff.fonts.added.length}`)} ${chalk.red(`-${tokenDiff.fonts.removed.length}`)}`)
  }
  if (tokenDiff.cssVariables.changed.length) {
    console.log(`  CSS vars: ${chalk.yellow(`${tokenDiff.cssVariables.changed.length} changed`)}`)
  }
  console.log(`  ${chalk.dim('Report →')} ${reportPath}`)
  console.log(`  ${chalk.dim('Output →')} ${outputDir}`)
  console.log('')

  return { outputDir, viewportDiffs, tokenDiff, reportPath }
}
