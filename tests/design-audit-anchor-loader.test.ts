import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  loadAnchors,
  parseAnchorFile,
  renderAnchor,
} from '../src/design/audit/rubric/anchor-loader.js'
import type { PageType } from '../src/design/audit/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ANCHORS_DIR = path.resolve(__dirname, '..', 'src', 'design', 'audit', 'rubric', 'anchors')

const REQUIRED_TYPES: PageType[] = [
  'saas-app',
  'marketing',
  'dashboard',
  'docs',
  'ecommerce',
  'social',
  'tool',
  'blog',
  'utility',
]

describe('anchor-loader — Layer 1', () => {
  it('all 9 builtin anchor files exist', () => {
    for (const t of REQUIRED_TYPES) {
      expect(fs.existsSync(path.join(ANCHORS_DIR, `${t}.yaml`))).toBe(true)
    }
  })

  it('loadAnchors() returns one anchor per page type', () => {
    const anchors = loadAnchors(ANCHORS_DIR)
    for (const t of REQUIRED_TYPES) {
      const anchor = anchors.get(t)
      expect(anchor).toBeDefined()
      expect(anchor?.type).toBe(t)
    }
  })

  it('every band has at least 3 criteria and at least 1 fixture', () => {
    const anchors = loadAnchors(ANCHORS_DIR)
    for (const anchor of anchors.values()) {
      for (const band of ['score_9_10', 'score_7_8', 'score_5_6', 'score_3_4'] as const) {
        const b = anchor[band]
        expect(b.criteria.length).toBeGreaterThanOrEqual(3)
        expect(b.fixtures.length).toBeGreaterThanOrEqual(1)
        for (const c of b.criteria) {
          expect(typeof c).toBe('string')
          expect(c.length).toBeGreaterThan(8)
        }
        for (const f of b.fixtures) {
          expect(typeof f).toBe('string')
          expect(f.startsWith('fixture:')).toBe(true)
        }
      }
    }
  })

  it('saas-app anchor cites Linear app + Figma + Notion + Superhuman + GitHub PR view', () => {
    const a = parseAnchorFile(path.join(ANCHORS_DIR, 'saas-app.yaml'))
    const refs = a.score_9_10.fixtures.join(' ')
    expect(refs).toContain('linear-app')
    expect(refs).toContain('figma-file-ui')
    expect(refs).toContain('notion-editor')
    expect(refs).toContain('superhuman')
    expect(refs).toContain('github-pr-view')
  })

  it('marketing anchor cites Stripe / Linear / Vercel / Apple', () => {
    const a = parseAnchorFile(path.join(ANCHORS_DIR, 'marketing.yaml'))
    const refs = a.score_9_10.fixtures.join(' ')
    expect(refs).toContain('stripe-marketing')
    expect(refs).toContain('linear-marketing')
    expect(refs).toContain('vercel-marketing')
    expect(refs).toContain('apple-marketing')
  })

  it('docs anchor cites Stripe Docs / Tailwind Docs / MDN / Vercel Docs', () => {
    const a = parseAnchorFile(path.join(ANCHORS_DIR, 'docs.yaml'))
    const refs = a.score_9_10.fixtures.join(' ')
    expect(refs).toContain('stripe-docs')
    expect(refs).toContain('tailwind-docs')
    expect(refs).toContain('mdn-docs')
    expect(refs).toContain('vercel-docs')
  })

  it('renderAnchor produces injectable markdown', () => {
    const a = parseAnchorFile(path.join(ANCHORS_DIR, 'saas-app.yaml'))
    const md = renderAnchor(a)
    expect(md).toContain('Score 9-10')
    expect(md).toContain('Score 7-8')
    expect(md).toContain('Score 5-6')
    expect(md).toContain('Score 3-4')
    expect(md).toContain('References:')
    // contains an actual fixture reference
    expect(md).toContain('fixture:linear-app')
  })

  it('returns empty Map for nonexistent dir', () => {
    expect(loadAnchors('/nonexistent/anchors/dir').size).toBe(0)
  })

  it('throws on malformed file (missing band)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-'))
    const file = path.join(tmp, 'bad.yaml')
    fs.writeFileSync(
      file,
      `type: saas-app
score_9_10:
  criteria:
    - one criterion
  fixtures:
    - fixture:x
score_7_8:
  criteria:
    - one criterion
  fixtures:
    - fixture:x
score_5_6:
  criteria:
    - one criterion
  fixtures:
    - fixture:x
`,
    )
    expect(() => parseAnchorFile(file)).toThrow(/score_3_4/)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('throws on malformed file (missing type)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-'))
    const file = path.join(tmp, 'bad.yaml')
    fs.writeFileSync(file, 'score_9_10:\n  criteria:\n    - x\n  fixtures:\n    - fixture:x\n')
    expect(() => parseAnchorFile(file)).toThrow(/type/)
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
