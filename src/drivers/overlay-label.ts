/**
 * Cursor-overlay label builder.
 *
 * The overlay renders a single short label string next to the animated
 * cursor. The label is the PRIMARY channel of agent intent visible to
 * anyone watching a recorded video — it needs to read like a human
 * narrator, not like a debug log.
 *
 * Examples:
 *   `type "JOHN SMITH" · Last Name: insert criteria` becomes
 *   `Typing "JOHN SMITH" into Last Name`
 *
 * Design rules:
 *   - Labels MUST fit on one line at ~13px. Target max 56 chars rendered.
 *   - Truncate with an ellipsis; never wrap.
 *   - Verb-only is the SAFE FALLBACK — never throw, never return empty.
 *   - Target names get aggressive cleanup: strip trailing punctuation,
 *     drop generic role-restatements, drop verbose suffixes like
 *     "insert criteria" / "search input" that ARIA labels carry but
 *     viewers don't need.
 *   - Start every action with a verb-in-progress ("Typing", "Clicking",
 *     "Pressing") for readability. Status-bar shorthand ("click · X")
 *     was good for devs; bad for anyone else.
 */
import type { Action } from '../types.js'

const MAX_LABEL_LEN = 56
const MAX_TEXT_PREVIEW = 32
const MAX_NAME_PREVIEW = 28

/**
 * Role names that are generic; including them in the label adds no info.
 * NOTE: "Search" is NOT here — a button labeled "Search" is informative.
 */
const GENERIC_NAMES = new Set([
  'button', 'link', 'textbox', 'input', 'field', 'searchbox',
  'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch',
])

/**
 * Noise ARIA labels / placeholders often carry. Stripped iteratively at
 * both ends until the string stabilizes. Goal: recover the semantic
 * noun ("Name", "Email", "Last Name") from verbose wrappers like
 * "Enter name as search criteria" or "Last Name: insert criteria".
 */
const NOISE_SUFFIXES = [
  /\s+as search (?:criteria|input|query|keyword|term)s?\s*$/i,
  /\s+for search(?:ing)?\s*$/i,
  /\s*[:,]?\s*insert (?:criteria|name|value|text)\s*$/i,
  /\s*[:,]?\s*search (?:input|field|criteria)\s*$/i,
  /\s*[:,]?\s*(?:input|text) (?:field|input)\s*$/i,
  /\s*[:,]?\s*enter (?:text|value|name|keyword|query)\s*$/i,
  /\s*[:,]?\s*type (?:here|name|text)\s*$/i,
  /\s*[:,]?\s*required\s*$/i,
  /\s*[*]\s*$/,   // trailing asterisks from "Required *" fields
  /[:;,]\s*$/,    // any trailing punctuation
]

/**
 * Leading imperative prefixes that tell the user what to do ("Enter
 * name…", "Type your email…", "Fill in first name…"). Strip them so
 * the NOUN that follows becomes the clean label. Applied AFTER suffix
 * cleanup because suffixes may carry their own verbs.
 */
const NOISE_PREFIXES = [
  /^\s*please\s+enter\s+(?:your\s+)?/i,
  /^\s*please\s+provide\s+(?:your\s+)?/i,
  /^\s*please\s+/i,
  /^\s*enter\s+(?:your\s+|a\s+|the\s+)?/i,
  /^\s*type\s+(?:your\s+|a\s+|the\s+)?/i,
  /^\s*input\s+(?:your\s+|a\s+|the\s+)?/i,
  /^\s*fill\s+in\s+(?:your\s+|a\s+|the\s+)?/i,
  /^\s*fill\s+(?:your\s+|a\s+|the\s+)?/i,
  /^\s*provide\s+(?:your\s+|a\s+|the\s+)?/i,
]

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return collapsed.slice(0, max - 1).trimEnd() + '…'
}

function cleanName(name: string | undefined): string | undefined {
  if (!name) return undefined
  let c = name.replace(/\s+/g, ' ').trim()
  if (!c) return undefined
  // Strip noise at both ends iteratively until stable. ARIA names
  // like "Enter your last name as search criteria, required *" stack
  // three or four independent noise pieces — single-pass regex won't
  // peel them all.
  let changed = true
  let passes = 0
  while (changed && passes < 8) {
    changed = false
    passes++
    for (const re of NOISE_SUFFIXES) {
      const stripped = c.replace(re, '').trim()
      if (stripped !== c && stripped.length > 0) {
        c = stripped
        changed = true
      }
    }
    for (const re of NOISE_PREFIXES) {
      const stripped = c.replace(re, '').trim()
      if (stripped !== c && stripped.length > 0) {
        c = stripped
        changed = true
      }
    }
  }
  if (!c) return undefined
  if (GENERIC_NAMES.has(c.toLowerCase())) return undefined
  // Title-case the first word so "name" → "Name". ARIA labels often
  // carry lowercase imperative nouns which read oddly in mid-sentence.
  c = c.charAt(0).toUpperCase() + c.slice(1)
  // If after all stripping the name is still > 4 words or > 28 chars,
  // it was probably a full sentence not a field label. Drop it — the
  // bare verb phrase is cleaner than a truncated mid-sentence fragment.
  const wordCount = c.split(/\s+/).length
  if (wordCount > 4 || c.length > MAX_NAME_PREVIEW) return undefined
  return c
}

/** Host of a URL without protocol/trailing-slash. Never throws. */
function displayHost(url: string): string {
  try {
    const u = new URL(url)
    return u.host || url
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '').slice(0, MAX_NAME_PREVIEW)
  }
}

/** Press keys get friendlier names — "Enter" / "Tab" / arrow glyphs. */
function friendlyKey(key: string): string {
  const k = key.trim()
  const map: Record<string, string> = {
    'Enter': 'Enter',
    'Return': 'Enter',
    'Tab': 'Tab',
    'Escape': 'Esc',
    'Backspace': '⌫',
    'Delete': 'Del',
    'ArrowUp': '↑',
    'ArrowDown': '↓',
    'ArrowLeft': '←',
    'ArrowRight': '→',
  }
  return map[k] ?? k
}

export interface OverlayLabelContext {
  /** Accessible name of the target element (from snapshot ref lookup). */
  targetName?: string
  /** ARIA role of the target, used to filter generic names. */
  targetRole?: string
}

/**
 * Build a single-line label string for the cursor overlay given an action
 * and (optionally) the resolved target element's accessible name.
 *
 * Always returns a non-empty string. Falls back to a bare verb-phrase
 * ("Clicking", "Typing") on any missing context. Never throws.
 */
export function formatOverlayLabel(action: Action, ctx: OverlayLabelContext = {}): string {
  const name = cleanName(ctx.targetName)
  switch (action.action) {
    case 'click': {
      return truncate(name ? `Clicking ${name}` : 'Clicking', MAX_LABEL_LEN)
    }
    case 'type': {
      const text = truncate(action.text ?? '', MAX_TEXT_PREVIEW)
      if (text && name) return truncate(`Typing ${text} into ${name}`, MAX_LABEL_LEN)
      if (text) return truncate(`Typing ${text}`, MAX_LABEL_LEN)
      return name ? truncate(`Typing into ${name}`, MAX_LABEL_LEN) : 'Typing'
    }
    case 'press': {
      const key = action.key ? friendlyKey(action.key) : ''
      if (key && name) return truncate(`Pressing ${key} in ${name}`, MAX_LABEL_LEN)
      return truncate(key ? `Pressing ${key}` : 'Pressing a key', MAX_LABEL_LEN)
    }
    case 'hover': {
      return truncate(name ? `Hovering ${name}` : 'Hovering', MAX_LABEL_LEN)
    }
    case 'select': {
      const val = truncate(action.value ?? '', MAX_TEXT_PREVIEW)
      if (val && name) return truncate(`Selecting ${val} in ${name}`, MAX_LABEL_LEN)
      if (val) return truncate(`Selecting ${val}`, MAX_LABEL_LEN)
      return name ? truncate(`Selecting in ${name}`, MAX_LABEL_LEN) : 'Selecting'
    }
    case 'scroll': {
      return truncate(`Scrolling ${action.direction}`, MAX_LABEL_LEN)
    }
    case 'navigate': {
      return truncate(`Navigating to ${displayHost(action.url)}`, MAX_LABEL_LEN)
    }
    case 'wait': {
      return truncate(`Waiting ${action.ms}ms`, MAX_LABEL_LEN)
    }
    default:
      return action.action
  }
}
