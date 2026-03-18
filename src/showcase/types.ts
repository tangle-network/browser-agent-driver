/** Types for the `bad showcase` walkthrough capture system. */

// ── Walkthrough Steps ──

export type ShowcaseAction = 'navigate' | 'click' | 'type' | 'scroll' | 'wait' | 'hover' | 'screenshot'

export interface CaptureConfig {
  /** Output filename stem (no extension). */
  name: string
  /** Capture full page or viewport only. Default: false (viewport). */
  fullPage?: boolean
  /** Crop to a specific element. */
  crop?: {
    selector: string
    /** Padding in px around the element bounding box. Default: 0. */
    padding?: number
  }
  /** Draw a highlight rectangle on an element. */
  highlight?: {
    selector: string
    /** CSS color. Default: rgba(142, 89, 255, 0.5). */
    color?: string
    /** Optional text label above the highlight. */
    label?: string
  }
  /** Delay in ms before capture (let animations settle). Default: 0. */
  delay?: number
}

export interface ShowcaseStep {
  action: ShowcaseAction
  /** CSS selector (for click, type, hover). */
  selector?: string
  /** Text to type (for type action). */
  text?: string
  /** URL (for navigate action). */
  url?: string
  /** Pixels to scroll (scroll action) or ms to wait (wait action). */
  amount?: number
  /** Scroll direction. Default: 'down'. */
  direction?: 'up' | 'down'
  /** Capture a screenshot after this step completes. */
  capture?: CaptureConfig
}

// ── Showcase Config ──

export interface ShowcaseConfig {
  /** Human name for this showcase (used in output directory). */
  name: string
  /** Starting URL. */
  url: string
  /** Browser viewport. Default: { width: 1440, height: 900 }. */
  viewport?: { width: number; height: number }
  /** Ordered steps to execute. */
  steps: ShowcaseStep[]
  /** Output options. */
  output?: {
    dir?: string
    /** Which formats to generate. Default: ['png']. */
    formats?: Array<'png' | 'webp' | 'gif' | 'webm' | 'demo'>
    /** Image quality 1-100. Default: 90. */
    quality?: number
    /** Device scale factor. Default: 2 (retina). */
    scale?: number
  }
  /** Run headless. Default: true. */
  headless?: boolean
  /** Playwright storage state for auth. */
  storageState?: string
  /** Force color scheme. */
  colorScheme?: 'dark' | 'light'
  /** Dismiss cookie banners and modals before starting. Default: true. */
  dismissModals?: boolean
}

// ── Quick Capture (no script) ──

export interface QuickCaptureConfig {
  url: string
  /** Named capture positions. 'hero' = viewport, 'full' = full page, 'scroll:N' = scroll N px. */
  captures: string[]
  /** Crop all captures to this element. */
  cropSelector?: string
  /** Highlight this element in all captures. */
  highlightSelector?: string
  viewport?: { width: number; height: number }
  output?: ShowcaseConfig['output']
  headless?: boolean
  storageState?: string
  colorScheme?: 'dark' | 'light'
  dismissModals?: boolean
}

// ── Output ──

export interface ShowcaseFrame {
  name: string
  buffer: Buffer
  width: number
  height: number
  step: number
}

export interface ShowcaseResult {
  name: string
  outputDir: string
  frames: Array<{
    name: string
    path: string
    width: number
    height: number
    step: number
  }>
  gif?: string
  video?: string
  demo?: string
  durationMs: number
}
