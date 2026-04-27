import { describe, it, expect } from 'vitest'
import { detectBlock, reasonFor } from '../src/jobs/anti-bot.js'

describe('reasonFor', () => {
  it('flags Cloudflare title patterns', () => {
    expect(reasonFor({ title: 'Just a moment...' })).toMatch(/anti-bot challenge/)
    expect(reasonFor({ title: 'Attention Required! | Cloudflare' })).toMatch(/anti-bot challenge/)
    expect(reasonFor({ title: 'Access Denied' })).toMatch(/anti-bot challenge/)
  })

  it('flags challenge-page intents', () => {
    expect(reasonFor({ intent: 'cloudflare challenge page' })).toMatch(/intent indicates a challenge/)
    expect(reasonFor({ intent: 'verify the user is human' })).toMatch(/intent indicates a challenge/)
  })

  it('returns null for legitimate pages', () => {
    expect(reasonFor({ title: 'Stripe — Payments Infrastructure', intent: 'sell payment APIs' })).toBeNull()
  })

  it('flags zero-finding low-confidence unknown pages as last-resort heuristic', () => {
    expect(reasonFor({ title: '', intent: '', type: 'unknown', ensembleConfidence: 0.2, findingCount: 0 })).toMatch(/likely empty\/blocked/)
  })

  it('does NOT flag a low-confidence page if there are findings', () => {
    expect(reasonFor({ title: '', intent: '', type: 'unknown', ensembleConfidence: 0.2, findingCount: 5 })).toBeNull()
  })

  it('does NOT flag a high-confidence unknown page', () => {
    expect(reasonFor({ title: '', intent: '', type: 'unknown', ensembleConfidence: 0.9, findingCount: 0 })).toBeNull()
  })
})

describe('detectBlock', () => {
  it('reads the auditResult classification path first', () => {
    const reason = detectBlock({
      pages: [{ title: 'Just a moment...', auditResult: { classification: { intent: 'normal site' } } }],
    })
    expect(reason).toMatch(/anti-bot/)
  })

  it('returns null when there are no pages', () => {
    expect(detectBlock({ pages: [] })).toBeNull()
    expect(detectBlock({})).toBeNull()
  })
})
