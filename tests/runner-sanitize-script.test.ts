/**
 * Wave-1 runScript sanitization:
 *   1. [ref=...] selectors are rejected — refs exist only in the aria
 *      snapshot, not the DOM (phantom-ref querySelector loops killed turns).
 *   2. Scripts with a bare top-level return are IIFE-wrapped (eval semantics
 *      make a top-level return a SyntaxError); expression-style scripts keep
 *      their completion-value semantics.
 *   3. The extraction rules tell the model refs are not DOM attributes.
 */

import { describe, expect, it } from 'vitest'
import { sanitizeRunScript } from '../src/runner/utils.js'
import { DATA_EXTRACTION_RULES } from '../src/brain/prompts.js'

describe('sanitizeRunScript', () => {
  it('rejects [ref=...] selectors with an actionable error', () => {
    const out = sanitizeRunScript(`document.querySelector('[ref="l26e5"]').textContent`)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.error).toContain('aria-snapshot refs, not DOM attributes')
      expect(out.error).toContain('extractWithIndex')
    }
  })

  it('rejects ref selectors with whitespace variants', () => {
    expect(sanitizeRunScript(`document.querySelectorAll("[ref = b2"])`).ok).toBe(false)
  })

  it('wraps scripts with a bare top-level return in an IIFE', () => {
    const out = sanitizeRunScript(`const m = document.title.match(/(\\d+)/); if (m) { return m[1]; } return null;`)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.script.startsWith('(() => {')).toBe(true)
      expect(out.script.endsWith('})()')).toBe(true)
    }
  })

  it('leaves expression-style scripts untouched (completion value survives)', () => {
    const script = `document.querySelector('h1').textContent`
    const out = sanitizeRunScript(script)
    expect(out).toEqual({ ok: true, script })
  })

  it('leaves already-invoked wrappers untouched', () => {
    const script = `(function() { const t = document.title; return t; })();`
    const out = sanitizeRunScript(script)
    expect(out).toEqual({ ok: true, script })
  })

  it('does not mangle arrow-IIFEs', () => {
    const script = `(() => { return document.title; })()`
    const out = sanitizeRunScript(script)
    expect(out).toEqual({ ok: true, script })
  })
})

describe('DATA_EXTRACTION_RULES ref guidance', () => {
  it('states refs are not DOM attributes', () => {
    expect(DATA_EXTRACTION_RULES).toContain('REFS ARE NOT DOM ATTRIBUTES')
    expect(DATA_EXTRACTION_RULES).toContain('not in the page DOM')
  })
})
