/**
 * Cursor-overlay label builder.
 *
 * The overlay renders a single short label string next to the animated
 * cursor. A bare verb (`click`, `type`) leaves 90% of the agent's intent
 * invisible to anyone watching the recording. Rich labels turn the cursor
 * into a readable narrative — `click · Search`, `type · "IVANOV ALEKSANDR"`,
 * `press · Enter`, `nav · sanctionssearch.ofac.treas.gov`.
 *
 * Design rules:
 *   - Labels MUST fit on one line at ~13px. Target max 48 chars rendered.
 *   - Truncate with an ellipsis; never wrap.
 *   - Verb-only is the SAFE FALLBACK — never throw, never return empty.
 *   - Target accessible name goes in the label only when it's short and
 *     informative. Skip generic names ('button', 'link', 'textbox') that
 *     restate the role the viewer already sees from context.
 */
import type { Action } from '../types.js'

const MAX_LABEL_LEN = 48
const MAX_TEXT_PREVIEW = 30
const MAX_NAME_PREVIEW = 30

/**
 * Role names that are generic; including them in the label adds no info.
 * NOTE: "Search" is NOT here — a button labeled "Search" is informative
 * (OFAC, Google, etc.). "searchbox" IS here — that's the role spilling
 * through as a name when an input has no label, which just restates what
 * the viewer already sees from the cursor's position on the textbox.
 */
const GENERIC_NAMES = new Set([
  'button', 'link', 'textbox', 'input', 'field', 'searchbox',
  'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch',
])

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return collapsed.slice(0, max - 1).trimEnd() + '…'
}

function cleanName(name: string | undefined): string | undefined {
  if (!name) return undefined
  const c = name.replace(/\s+/g, ' ').trim()
  if (!c) return undefined
  if (GENERIC_NAMES.has(c.toLowerCase())) return undefined
  return truncate(c, MAX_NAME_PREVIEW)
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
 * Always returns a non-empty string. Falls back to the bare verb on any
 * missing context.
 */
export function formatOverlayLabel(action: Action, ctx: OverlayLabelContext = {}): string {
  const name = cleanName(ctx.targetName)
  switch (action.action) {
    case 'click': {
      return truncate(name ? `click · ${name}` : 'click', MAX_LABEL_LEN)
    }
    case 'type': {
      const text = truncate(action.text ?? '', MAX_TEXT_PREVIEW)
      if (text && name) return truncate(`type "${text}" · ${name}`, MAX_LABEL_LEN)
      if (text) return truncate(`type · "${text}"`, MAX_LABEL_LEN)
      return name ? truncate(`type · ${name}`, MAX_LABEL_LEN) : 'type'
    }
    case 'press': {
      const key = action.key ?? ''
      if (key && name) return truncate(`press ${key} · ${name}`, MAX_LABEL_LEN)
      return truncate(key ? `press · ${key}` : 'press', MAX_LABEL_LEN)
    }
    case 'hover': {
      return truncate(name ? `hover · ${name}` : 'hover', MAX_LABEL_LEN)
    }
    case 'select': {
      const val = truncate(action.value ?? '', MAX_TEXT_PREVIEW)
      if (val && name) return truncate(`select ${val} · ${name}`, MAX_LABEL_LEN)
      if (val) return truncate(`select · ${val}`, MAX_LABEL_LEN)
      return name ? truncate(`select · ${name}`, MAX_LABEL_LEN) : 'select'
    }
    case 'scroll': {
      return truncate(`scroll ${action.direction}`, MAX_LABEL_LEN)
    }
    case 'navigate': {
      return truncate(`nav · ${displayHost(action.url)}`, MAX_LABEL_LEN)
    }
    case 'wait': {
      return truncate(`wait ${action.ms}ms`, MAX_LABEL_LEN)
    }
    default:
      return action.action
  }
}
