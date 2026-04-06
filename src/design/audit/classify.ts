/**
 * Page classifier — single LLM call that classifies the page before evaluation.
 * Drives rubric composition and tells the eval prompt what kind of app it's looking at.
 */

import type { Brain } from '../../brain/index.js'
import type { PageState } from '../../types.js'
import type { PageClassification, PageType, DesignSystemTag, Maturity } from './types.js'

const VALID_TYPES: PageType[] = [
  'marketing',
  'saas-app',
  'dashboard',
  'docs',
  'ecommerce',
  'social',
  'tool',
  'blog',
  'utility',
  'unknown',
]

const VALID_DESIGN_SYSTEMS: DesignSystemTag[] = [
  'shadcn',
  'mui',
  'ant',
  'chakra',
  'tailwind-custom',
  'fully-custom',
  'unstyled',
  'unknown',
]

const VALID_MATURITY: Maturity[] = [
  'prototype',
  'mvp',
  'shipped',
  'polished',
  'world-class',
]

const CLASSIFY_PROMPT = `You are a senior product designer classifying web pages so a downstream auditor can apply the right evaluation rubric.

Look at the screenshot and the accessibility tree. Decide:

1. TYPE — What kind of page is this?
   - marketing: landing page selling a product, hero + CTA + social proof
   - saas-app: logged-in product surface, app shell, features
   - dashboard: data-dense workspace, charts, tables, metrics
   - docs: technical documentation, API reference, guides
   - ecommerce: product catalog, cart, checkout
   - social: feed-driven community, posts, comments
   - tool: single-purpose utility (calculator, converter, generator)
   - blog: article-driven content, long-form
   - utility: status page, settings, admin
   - unknown: unclear

2. DOMAIN — What industry/vertical? Free-form. Examples:
   fintech, finance, banking, payments, crypto, defi, devtools, dev, ai, ml, llm,
   health, education, consumer, enterprise, media, gaming, productivity, design, etc.

3. FRAMEWORK — Detected web framework, or null if unclear.
   Common: next, vite, astro, sveltekit, remix, gatsby, create-react-app, vue, angular

4. DESIGN SYSTEM — Component library in use:
   - shadcn: shadcn/ui (Tailwind + Radix)
   - mui: Material UI
   - ant: Ant Design
   - chakra: Chakra UI
   - tailwind-custom: Tailwind with custom design tokens (not shadcn defaults)
   - fully-custom: hand-built design system, no recognizable library
   - unstyled: minimal styling, raw HTML feel
   - unknown: cannot tell

5. MATURITY — How polished is this?
   - prototype: defaults everywhere, placeholder content, "looks like a template"
   - mvp: works, no polish, generic component library defaults
   - shipped: production but generic, uninspired but professional
   - polished: intentional design decisions visible, custom touches
   - world-class: Linear/Stripe/Vercel/Apple tier, exceptional craft

6. INTENT — One sentence: what is this page trying to accomplish?

7. CONFIDENCE — How confident are you in this classification? 0-1.

Respond with ONLY a JSON object:
{
  "type": "marketing",
  "domain": "fintech",
  "framework": "next",
  "designSystem": "fully-custom",
  "maturity": "world-class",
  "intent": "Convince enterprise customers to sign up for payment processing",
  "confidence": 0.95
}`

/**
 * Classify a page using a single LLM call.
 *
 * Cost: ~500-1000 output tokens. Cheap.
 * Cached on the brain instance for the duration of the audit (one call per URL).
 */
export async function classifyPage(
  brain: Brain,
  state: PageState,
): Promise<PageClassification> {
  const result = await brain.auditDesign(
    state,
    'Classify this page',
    [],
    CLASSIFY_PROMPT,
  )

  // The classifier reuses auditDesign() because it already handles vision +
  // JSON parsing. We ignore the score/findings and parse the classification
  // out of the raw response.
  let parsed: Record<string, unknown>
  try {
    let text = result.raw.trim()
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    }
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      parsed = JSON.parse(text.slice(start, end + 1))
    } else {
      throw new Error('no JSON object in classifier output')
    }
  } catch {
    return defaultClassification()
  }

  return {
    type: VALID_TYPES.includes(parsed.type as PageType) ? (parsed.type as PageType) : 'unknown',
    domain: typeof parsed.domain === 'string' ? parsed.domain : 'unknown',
    framework: typeof parsed.framework === 'string' && parsed.framework ? parsed.framework : null,
    designSystem: VALID_DESIGN_SYSTEMS.includes(parsed.designSystem as DesignSystemTag)
      ? (parsed.designSystem as DesignSystemTag)
      : 'unknown',
    maturity: VALID_MATURITY.includes(parsed.maturity as Maturity)
      ? (parsed.maturity as Maturity)
      : 'shipped',
    intent: typeof parsed.intent === 'string' ? parsed.intent : '',
    confidence: typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5,
  }
}

/**
 * Fallback classification used when the classifier fails or confidence is low.
 * Treats the page as a generic marketing/landing page with universal rubric.
 */
export function defaultClassification(): PageClassification {
  return {
    type: 'unknown',
    domain: 'unknown',
    framework: null,
    designSystem: 'unknown',
    maturity: 'shipped',
    intent: '',
    confidence: 0,
  }
}
