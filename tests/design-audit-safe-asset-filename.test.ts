import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { safeAssetFilename } from '../src/design/audit/tokens/extract.js'

// Guards the font-download path-traversal fix: a DOM-controlled @font-face
// family must never produce a filename that escapes the output dir when joined.
describe('safeAssetFilename', () => {
  it('passes a normal filename through', () => {
    expect(safeAssetFilename('Inter-400-normal.woff2', 'font.bin')).toBe('Inter-400-normal.woff2')
  })

  it('strips path traversal from a hostile family-derived name', () => {
    const out = safeAssetFilename('../../../tmp/evil-400-normal.woff', 'font.bin')
    expect(out).toBe('evil-400-normal.woff')
    // The joined path must stay inside the directory.
    expect(path.join('/out/fonts', out).startsWith('/out/fonts/')).toBe(true)
  })

  it('strips absolute paths and separators', () => {
    expect(safeAssetFilename('/etc/passwd', 'font.bin')).toBe('passwd')
    expect(safeAssetFilename('a/b/c.woff', 'font.bin')).toBe('c.woff')
  })

  it('strips leading dots (no dotfiles)', () => {
    expect(safeAssetFilename('...hidden', 'font.bin')).toBe('hidden')
  })

  it('falls back when nothing usable remains', () => {
    expect(safeAssetFilename('../../', 'font.bin')).toBe('font.bin')
    expect(safeAssetFilename('', 'font.bin')).toBe('font.bin')
  })
})
