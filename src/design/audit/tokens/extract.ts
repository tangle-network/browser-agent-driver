/**
 * Design token extraction — pure DOM mining, no LLM calls.
 *
 * Leaf module: loads a page at multiple viewports, mines colours, typography,
 * spacing, components, and brand/asset references inside `page.evaluate`,
 * clusters them into a `DesignTokens` artifact, downloads referenced assets,
 * and zips the result. Imported (often lazily) by the CLI design-audit handler,
 * the design-compare diff, and the reference-DNA page adapter.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { chromium, type Page } from 'playwright'
import type { DesignTokens, ColorToken, FontFamily, TypeScaleEntry, LogoAsset, SvgIcon, ViewportTokens, SpacingToken, ComponentFingerprint, NavPattern, FontFile, ImageAsset } from '../../../types.js'
import type { RawScrollCapture } from '../reference/contracts.js'
import { createScrollCapturer } from '../reference/dna/scroll-capture.js'
import { VIEWPORTS } from '../../viewports.js'
import { dismissCookieBanners } from '../../cookie-consent.js'

// ---------------------------------------------------------------------------
// Design Token Extraction — pure DOM, no LLM calls
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Programmatic API — extractDesignTokens()
// ---------------------------------------------------------------------------

export interface ExtractDesignTokensOptions {
  url: string
  headless?: boolean
  outputDir?: string
  viewports?: Array<{ name: string; width: number; height: number }>
  onProgress?: (viewport: string, width: number, height: number, stats: { colors: number; fonts: number; buttons: number; inputs: number; cards: number }) => void
  /**
   * Opt in to the live scroll-motion capture pass (default OFF). When set, a
   * stepped top→bottom scroll runs on the desktop viewport after token
   * extraction and the observed `RawScrollCapture` is returned on
   * `ExtractionResult.scrollMotion`. Off by default — it adds page time and is
   * only meaningful for live audits / corpus authoring.
   */
  captureScrollMotion?: boolean
}

export interface ExtractionResult {
  tokens: DesignTokens
  outputDir: string
  screenshotPaths: Record<string, string>
  /**
   * Live scroll-motion observation, present only when `captureScrollMotion` was
   * set AND the desktop page was actually scrollable. `undefined` otherwise
   * (not captured) — never read its absence as "no scroll motion".
   */
  scrollMotion?: RawScrollCapture
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
/**
 * Reduce a candidate asset filename to a safe, separator-free basename so a
 * DOM-controlled value (e.g. a hostile `@font-face` family `../../../tmp/evil`)
 * can never escape the output directory when joined to it. Strips any path
 * components and leading dots (no traversal, no dotfiles); returns `fallback`
 * when nothing usable remains.
 */
export function safeAssetFilename(raw: string, fallback: string): string {
  return path.basename(raw).replace(/^[.\s]+/, '') || fallback
}

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
  let scrollMotion: RawScrollCapture | undefined

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

      // Opt-in live scroll-motion capture — runs FIRST on the freshly loaded
      // page, BEFORE the fullPage screenshot scrolls it, so one-shot scroll
      // reveals are observed as they actually fire. Desktop only (long-scroll is
      // a desktop signal); the capturer restores scroll to the top when done.
      if (opts.captureScrollMotion && vp.name === 'desktop') {
        scrollMotion = await createScrollCapturer().capture(page).catch(() => undefined)
      }

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
        const rawName = path.basename(urlPath) || `${ff.family.replace(/\s+/g, '-')}-${ff.weight}-${ff.style}.${ff.format === 'unknown' ? 'bin' : ff.format}`
        const localPath = path.join(fontDir, safeAssetFilename(rawName, 'font.bin'))
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

  return { tokens, outputDir, screenshotPaths, scrollMotion }
}

// ---------------------------------------------------------------------------
// Zip packaging
// ---------------------------------------------------------------------------

export async function createZipBundle(outputDir: string, tokens: DesignTokens): Promise<string> {
  const { execSync } = await import('node:child_process')
  const zipPath = `${outputDir}.zip`
  // Use system zip (available on macOS/Linux)
  execSync(`cd "${path.dirname(outputDir)}" && zip -r "${path.basename(zipPath)}" "${path.basename(outputDir)}"`, { stdio: 'pipe' })
  return zipPath
}
