/** Types for design rip, compare, and page interaction modules */

// ── Video Asset ──

export interface VideoAsset {
  url: string
  type: 'video' | 'video-source'
  poster?: string
  localPath?: string
  mimeType?: string
  sizeBytes?: number
}

// ── Page Interaction ──

export interface RevealStats {
  accordions: number
  tabs: number
  carousels: number
  hovers: number
  menus: number
  modals: number
}

// ── Rip ──

export interface RipOptions {
  url: string
  pages?: number
  headless?: boolean
  outputDir?: string
  interactiveReveal?: boolean
}

export interface RipResult {
  outputDir: string
  pageCount: number
  assets: CapturedAsset[]
  totalSizeBytes: number
  revealStats?: RevealStats
}

export interface CapturedAsset {
  url: string
  contentType: string
  localPath: string
  sizeBytes: number
  category: 'html' | 'css' | 'js' | 'font' | 'image' | 'video' | 'other'
}

// ── Compare ──

export interface CompareOptions {
  urlA: string
  urlB: string
  headless?: boolean
  outputDir?: string
  viewports?: Array<{ name: string; width: number; height: number }>
  interactiveReveal?: boolean
}

export interface CompareResult {
  outputDir: string
  viewportDiffs: ViewportDiff[]
  tokenDiff: TokenDiff
  reportPath: string
}

export interface ViewportDiff {
  viewport: string
  width: number
  height: number
  screenshotA: string
  screenshotB: string
  diffImage: string
  diffPercent: number
  interactionScreenshots: InteractionScreenshots
}

export interface InteractionScreenshots {
  tabsA: string[]
  tabsB: string[]
  accordionsA: string[]
  accordionsB: string[]
  carouselA: string[]
  carouselB: string[]
  menuA?: string
  menuB?: string
}

export interface TokenDiff {
  colors: {
    added: Array<{ hex: string; cluster?: string }>
    removed: Array<{ hex: string; cluster?: string }>
  }
  fonts: { added: string[]; removed: string[] }
  cssVariables: {
    added: string[]
    removed: string[]
    changed: Array<{ name: string; from: string; to: string }>
  }
  spacing: { gridUnitA?: number; gridUnitB?: number }
  brand: Record<string, { from?: string; to?: string }>
  videos: { added: string[]; removed: string[] }
  images: { countA: number; countB: number }
  components: {
    buttonsA: number; buttonsB: number
    inputsA: number; inputsB: number
    cardsA: number; cardsB: number
  }
}
