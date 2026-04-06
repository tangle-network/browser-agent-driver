/**
 * Design audit types — Generation 2.
 *
 * Core idea: classification → rubric → measurements → evaluation → findings.
 * Each stage is a pure transformation; the orchestrator (`pipeline.ts`) wires them.
 */

import type { DesignFinding, DesignSystemScore } from '../../types.js'

// Re-export the canonical Finding/Score types so consumers only import from here
export type { DesignFinding, DesignSystemScore } from '../../types.js'

// ── Classification ─────────────────────────────────────────────────────────

/**
 * Page classification — produced by a single cheap LLM call before any scoring.
 * Drives rubric composition and measurement strategy.
 */
export interface PageClassification {
  /** Primary page archetype */
  type: PageType
  /** Application domain (free-form, but canonical values preferred) */
  domain: string
  /** Detected framework, or null if undetectable */
  framework: string | null
  /** Component library / design system in use */
  designSystem: DesignSystemTag
  /** Apparent maturity level — anchors calibration */
  maturity: Maturity
  /** Free-form: what is this page trying to accomplish? */
  intent: string
  /** Classifier confidence 0-1; values < 0.7 fall back to general rubric */
  confidence: number
}

export type PageType =
  | 'marketing'    // landing, conversion-driven
  | 'saas-app'     // logged-in product surface
  | 'dashboard'    // data-dense workspace
  | 'docs'         // technical documentation
  | 'ecommerce'    // product catalog / checkout
  | 'social'       // feed-based community
  | 'tool'         // single-purpose utility
  | 'blog'         // article-driven content
  | 'utility'      // status, config, admin
  | 'unknown'

export type DesignSystemTag =
  | 'shadcn'
  | 'mui'
  | 'ant'
  | 'chakra'
  | 'tailwind-custom'
  | 'fully-custom'
  | 'unstyled'
  | 'unknown'

export type Maturity =
  | 'prototype'    // placeholder content, defaults everywhere
  | 'mvp'          // works, no polish
  | 'shipped'      // production but generic
  | 'polished'     // intentional design decisions visible
  | 'world-class'  // Linear/Stripe/Vercel tier

// ── Rubric ─────────────────────────────────────────────────────────────────

/**
 * A rubric fragment — loaded from markdown with YAML frontmatter.
 * Fragments compose into a full rubric based on classification.
 */
export interface RubricFragment {
  /** Unique fragment id (matches filename) */
  id: string
  /** Predicates that decide whether this fragment applies */
  appliesWhen: AppliesWhen
  /** Relative importance when composing */
  weight: 'low' | 'medium' | 'high' | 'critical'
  /** Human-readable title for the report */
  title: string
  /** Markdown body — gets injected into the eval prompt */
  body: string
}

export interface AppliesWhen {
  /** Match if classification.type is in this set; empty/undefined = always */
  type?: PageType[]
  /** Match if classification.domain matches any of these (substring) */
  domain?: string[]
  /** Match if classification.maturity is in this set */
  maturity?: Maturity[]
  /** Match if classification.designSystem is in this set */
  designSystem?: DesignSystemTag[]
  /** Universal fragments — always apply, no predicates needed */
  universal?: boolean
}

/**
 * A composed rubric — the full set of fragments selected for one classification,
 * ready to inject into an LLM eval prompt.
 */
export interface ComposedRubric {
  fragments: RubricFragment[]
  /** Pre-rendered markdown body, ready for prompt injection */
  body: string
  /** Calibration anchor for this rubric */
  calibration: string
}

// ── Measurements ───────────────────────────────────────────────────────────

/**
 * Bundle of deterministic measurements taken before LLM evaluation.
 * The LLM sees these as ground truth and is forbidden from inventing them.
 */
export interface MeasurementBundle {
  contrast: ContrastReport
  a11y: A11yReport
  /** Computed at gather time, used to short-circuit evaluation if too many failures */
  hasBlockingIssues: boolean
}

export interface ContrastReport {
  /** All text-bearing elements with computed text/bg colors */
  totalChecked: number
  /** Failures of WCAG 2.1 AA (4.5:1 normal, 3:1 large) */
  aaFailures: ContrastFailure[]
  /** Failures of WCAG 2.1 AAA (7:1 normal, 4.5:1 large) — informational */
  aaaFailures: ContrastFailure[]
  /** Quick stats */
  summary: {
    aaPassRate: number  // 0-1
    aaaPassRate: number // 0-1
  }
}

export interface ContrastFailure {
  /** CSS-style selector pointing to the element */
  selector: string
  /** Truncated visible text */
  text: string
  /** Computed color hex */
  color: string
  /** Computed (resolved) background hex */
  background: string
  /** Calculated WCAG ratio */
  ratio: number
  /** Required ratio for the level being checked */
  required: number
  /** Element font size in px */
  fontSize: number
  /** Whether the element qualifies as "large text" per WCAG */
  isLargeText: boolean
}

export interface A11yReport {
  /** axe-core ran successfully */
  ran: boolean
  /** Error message if axe-core failed to run */
  error?: string
  /** Violations grouped by axe impact */
  violations: A11yViolation[]
  /** axe pass count for context */
  passes: number
}

export interface A11yViolation {
  /** axe rule id */
  id: string
  /** axe impact level */
  impact: 'critical' | 'serious' | 'moderate' | 'minor'
  /** Human-readable description */
  description: string
  /** WCAG criterion (e.g. "wcag2aa") */
  tags: string[]
  /** First few affected elements */
  nodes: Array<{
    selector: string
    html: string
    failureSummary: string
  }>
  /** axe help URL */
  helpUrl: string
}

// ── Audit Result ───────────────────────────────────────────────────────────

/**
 * Per-page audit result.
 */
export interface PageAuditResult {
  url: string
  score: number
  summary: string
  strengths: string[]
  findings: DesignFinding[]
  classification?: PageClassification
  rubricFragments?: string[]  // ids of applied fragments
  measurements?: MeasurementBundle
  designSystemScore?: DesignSystemScore
  screenshotPath?: string
  tokensUsed?: number
  error?: string
}
