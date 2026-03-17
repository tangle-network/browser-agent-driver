/**
 * Site rip — download a full working local copy of a website.
 *
 * Uses Playwright network interception to capture every request/response,
 * then rewrites HTML/CSS references to point to local paths.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { chromium, type Page, type BrowserContext, type Route } from 'playwright'
import chalk from 'chalk'
import { revealHiddenContent } from './page-interaction.js'
import type { RipOptions, RipResult, CapturedAsset, RevealStats } from './types.js'

// ── Asset classification ──

const FONT_EXT = /\.(woff2?|ttf|otf|eot)(\?|$)/i
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp)(\?|$)/i
const VIDEO_EXT = /\.(mp4|webm|mov|ogg|avi|m3u8)(\?|$)/i
const CSS_EXT = /\.css(\?|$)/i
const JS_EXT = /\.js(\?|$)/i

function classifyAsset(url: string, contentType: string): CapturedAsset['category'] {
  const ct = contentType.toLowerCase()
  if (ct.includes('text/html')) return 'html'
  if (ct.includes('text/css') || CSS_EXT.test(url)) return 'css'
  if (ct.includes('javascript') || JS_EXT.test(url)) return 'js'
  if (ct.includes('font') || FONT_EXT.test(url)) return 'font'
  if (ct.includes('image') || IMAGE_EXT.test(url)) return 'image'
  if (ct.includes('video') || ct.includes('audio') || VIDEO_EXT.test(url)) return 'video'
  return 'other'
}

function safeFilename(urlStr: string): string {
  try {
    const u = new URL(urlStr)
    let pathname = decodeURIComponent(u.pathname).replace(/^\/+/, '')
    if (!pathname || pathname.endsWith('/')) pathname += 'index.html'
    // Sanitize path components
    return pathname.split('/').map(p => p.replace(/[<>:"|?*]/g, '_')).join('/')
  } catch {
    return `asset-${Date.now()}`
  }
}

// ── CSS url() rewriting ──

function rewriteCssUrls(css: string, cssUrl: string, urlMap: Map<string, string>): string {
  return css.replace(/url\(\s*(['"]?)([^'"()]+)\1\s*\)/g, (_match, _quote, rawUrl) => {
    if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) return _match
    try {
      const resolved = new URL(rawUrl, cssUrl).href
      const local = urlMap.get(resolved)
      if (local) return `url("${local}")`
    } catch { /* bad URL */ }
    return _match
  })
}

// ── HTML attribute rewriting ──

const URL_ATTRS = ['src', 'href', 'poster', 'srcset', 'data-src', 'data-bg', 'data-background-image', 'action']

function rewriteHtml(html: string, pageUrl: string, urlMap: Map<string, string>): string {
  let result = html

  for (const attr of URL_ATTRS) {
    if (attr === 'srcset') {
      // srcset has special format: "url 1x, url 2x"
      const srcsetRegex = new RegExp(`(${attr}=")([^"]+)(")`, 'gi')
      result = result.replace(srcsetRegex, (_m, pre, val, post) => {
        const rewritten = val.split(',').map((entry: string) => {
          const parts = entry.trim().split(/\s+/)
          if (parts[0]) {
            try {
              const resolved = new URL(parts[0], pageUrl).href
              const local = urlMap.get(resolved)
              if (local) parts[0] = local
            } catch { /* bad URL */ }
          }
          return parts.join(' ')
        }).join(', ')
        return pre + rewritten + post
      })
    } else {
      const attrRegex = new RegExp(`(${attr}=")([^"]+)(")`, 'gi')
      result = result.replace(attrRegex, (_m, pre, val, post) => {
        if (val.startsWith('data:') || val.startsWith('blob:') || val.startsWith('#') || val.startsWith('javascript:')) return _m
        try {
          const resolved = new URL(val, pageUrl).href
          const local = urlMap.get(resolved)
          if (local) return pre + local + post
        } catch { /* bad URL */ }
        return _m
      })
      // Also handle single-quoted attributes
      const attrRegexSingle = new RegExp(`(${attr}=')([^']+)(')`, 'gi')
      result = result.replace(attrRegexSingle, (_m, pre, val, post) => {
        if (val.startsWith('data:') || val.startsWith('blob:') || val.startsWith('#') || val.startsWith('javascript:')) return _m
        try {
          const resolved = new URL(val, pageUrl).href
          const local = urlMap.get(resolved)
          if (local) return pre + local + post
        } catch { /* bad URL */ }
        return _m
      })
    }
  }

  // Rewrite CSS url() inside <style> blocks
  result = result.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_m, cssBlock) => {
    return _m.replace(cssBlock, rewriteCssUrls(cssBlock, pageUrl, urlMap))
  })

  return result
}

// ── Page discovery (simplified BFS) ──

async function discoverPageUrls(page: Page, startUrl: string, maxPages: number): Promise<string[]> {
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
            !href.match(/\.(png|jpg|jpeg|gif|svg|pdf|zip|css|js|mp4|webm)$/i)
          )
      }, origin)
      for (const link of [...new Set(links)]) {
        const norm = link.split('#')[0].split('?')[0].replace(/\/$/, '')
        if (!visited.has(norm)) toVisit.push(link)
      }
    } catch { /* page load failed */ }
  }

  return discovered
}

// ── Main rip function ──

export async function ripSite(opts: RipOptions): Promise<RipResult> {
  const maxPages = opts.pages ?? 5
  const outputDir = opts.outputDir ?? `./rip-results/${new URL(opts.url).hostname}-${Date.now()}`
  fs.mkdirSync(outputDir, { recursive: true })

  console.log('')
  console.log(`  ${chalk.bold('bad design-audit')} ${chalk.dim('--rip')}`)
  console.log(`  ${chalk.dim('→')} ${opts.url}`)
  console.log(`  ${chalk.dim('Max pages:')} ${maxPages}`)
  console.log('')

  const browser = await chromium.launch({ headless: opts.headless ?? true })
  const assets: CapturedAsset[] = []
  let totalSize = 0
  let revealStats: RevealStats | undefined

  // URL -> local relative path
  const urlMap = new Map<string, string>()
  // URL -> response body
  const bodyMap = new Map<string, { body: Buffer; contentType: string }>()

  // Discover pages first (without interception)
  const discoveryCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const discoveryPage = await discoveryCtx.newPage()
  const pages = await discoverPageUrls(discoveryPage, opts.url, maxPages)
  await discoveryCtx.close()
  console.log(`  Found ${chalk.bold(String(pages.length))} page${pages.length !== 1 ? 's' : ''}`)
  for (const p of pages) console.log(`  ${chalk.dim('·')} ${p}`)
  console.log('')

  // Rip each page with network interception
  for (let i = 0; i < pages.length; i++) {
    const pageUrl = pages[i]
    console.log(`  ${chalk.dim(`[${i + 1}/${pages.length}]`)} Ripping ${pageUrl}`)

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()

    // Intercept ALL requests
    await page.route('**/*', async (route: Route) => {
      try {
        const response = await route.fetch()
        const url = route.request().url()
        const contentType = response.headers()['content-type'] || ''
        const body = await response.body()

        if (!bodyMap.has(url)) {
          const localPath = safeFilename(url)
          urlMap.set(url, localPath)
          bodyMap.set(url, { body, contentType })
        }

        await route.fulfill({ response })
      } catch {
        await route.continue().catch(() => null)
      }
    })

    try {
      await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() =>
        page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      )
      await page.waitForTimeout(2000)

      // Reveal hidden content to trigger lazy-loaded assets
      if (opts.interactiveReveal !== false) {
        revealStats = await revealHiddenContent(page)
      }

      // Scroll to bottom to trigger lazy loading
      await autoScroll(page)
      await page.waitForTimeout(1000)

      // Capture final HTML (with JS-rendered content)
      const html = await page.content()
      const htmlPath = i === 0 ? 'index.html' : `pages/${safeFilename(pageUrl).replace(/\.html$/, '')}.html`
      urlMap.set(pageUrl, htmlPath)
      bodyMap.set(pageUrl, { body: Buffer.from(html, 'utf-8'), contentType: 'text/html' })

      // Extract video URLs from the rendered DOM (not caught by interception if <video> never fetched)
      const videoUrls = await page.evaluate(() => {
        const urls: string[] = []
        for (const v of document.querySelectorAll('video')) {
          if (v.src) urls.push(v.src)
          if (v.poster) urls.push(v.poster)
          for (const s of v.querySelectorAll('source')) {
            if (s.src) urls.push(s.src)
          }
        }
        // data-* attributes with media URLs
        for (const el of document.querySelectorAll('[data-src], [data-bg], [data-background-image]')) {
          for (const attr of ['data-src', 'data-bg', 'data-background-image']) {
            const val = el.getAttribute(attr)
            if (val && !val.startsWith('data:') && !val.startsWith('blob:')) {
              try { urls.push(new URL(val, location.href).href) } catch { /* bad URL */ }
            }
          }
        }
        return urls
      })

      // Fetch any video/media URLs not yet captured
      for (const vUrl of videoUrls) {
        if (!bodyMap.has(vUrl)) {
          try {
            const res = await fetch(vUrl)
            if (res.ok) {
              const body = Buffer.from(await res.arrayBuffer())
              const ct = res.headers.get('content-type') || ''
              urlMap.set(vUrl, safeFilename(vUrl))
              bodyMap.set(vUrl, { body, contentType: ct })
            }
          } catch { /* fetch failed */ }
        }
      }
    } finally {
      await context.close()
    }
  }

  await browser.close()

  // Write all assets to disk with rewritten references
  console.log('')
  console.log(`  Writing ${bodyMap.size} assets…`)

  for (const [url, { body, contentType }] of bodyMap) {
    const localPath = urlMap.get(url) || safeFilename(url)
    const fullPath = path.join(outputDir, localPath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })

    const category = classifyAsset(url, contentType)

    if (category === 'html') {
      const rewritten = rewriteHtml(body.toString('utf-8'), url, urlMap)
      fs.writeFileSync(fullPath, rewritten)
    } else if (category === 'css') {
      const rewritten = rewriteCssUrls(body.toString('utf-8'), url, urlMap)
      fs.writeFileSync(fullPath, rewritten)
    } else {
      fs.writeFileSync(fullPath, body)
    }

    const size = body.length
    totalSize += size
    assets.push({ url, contentType, localPath, sizeBytes: size, category })
  }

  // Write manifest
  const manifest = {
    rippedAt: new Date().toISOString(),
    sourceUrl: opts.url,
    pageCount: pages.length,
    assetCount: assets.length,
    totalSizeBytes: totalSize,
    pages,
    assets: assets.map(a => ({ url: a.url, localPath: a.localPath, category: a.category, sizeBytes: a.sizeBytes })),
  }
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  // Summary
  const byCategory = new Map<string, number>()
  for (const a of assets) byCategory.set(a.category, (byCategory.get(a.category) ?? 0) + 1)
  const sizeStr = totalSize > 1024 * 1024 ? `${(totalSize / 1024 / 1024).toFixed(1)} MB` : `${(totalSize / 1024).toFixed(0)} KB`

  console.log('')
  console.log(`  ${chalk.dim('─'.repeat(52))}`)
  console.log(`  ${chalk.bold(String(assets.length))} assets ${chalk.dim(`(${sizeStr})`)}`)
  for (const [cat, count] of [...byCategory.entries()].sort()) {
    console.log(`  ${chalk.dim(cat.padEnd(12))}${count}`)
  }
  if (revealStats) {
    const parts: string[] = []
    if (revealStats.accordions) parts.push(`${revealStats.accordions} accordions`)
    if (revealStats.tabs) parts.push(`${revealStats.tabs} tabs`)
    if (revealStats.carousels) parts.push(`${revealStats.carousels} carousel slides`)
    if (revealStats.modals) parts.push(`${revealStats.modals} modals dismissed`)
    if (parts.length) console.log(`  ${chalk.dim('Revealed:')} ${parts.join(', ')}`)
  }
  console.log(`  ${chalk.dim('Output →')} ${outputDir}`)
  console.log(`  ${chalk.dim('Open →')} ${path.join(outputDir, 'index.html')}`)
  console.log('')

  return { outputDir, pageCount: pages.length, assets, totalSizeBytes: totalSize, revealStats }
}

async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let totalHeight = 0
      const distance = 400
      const timer = setInterval(() => {
        window.scrollBy(0, distance)
        totalHeight += distance
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer)
          window.scrollTo(0, 0)
          resolve()
        }
      }, 100)
      // Safety: max 30 seconds of scrolling
      setTimeout(() => { clearInterval(timer); window.scrollTo(0, 0); resolve() }, 30_000)
    })
  })
}
