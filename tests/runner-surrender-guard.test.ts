/**
 * Wave-6 premature-surrender guard:
 *   1. pageLooksBlocked / shouldRejectSurrender unit matrix.
 *   2. Runner-boundary regression of the wave-5 dashboard-extract weather
 *      scenario: the model aborts at turn 1 on a healthy page with the data
 *      visible ("a previous run failed"). The guard must reject the abort,
 *      re-prompt, and let the run continue to a real completion.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { pageLooksBlocked, shouldRejectSurrender } from '../src/runner/utils.js'
import { PlaywrightDriver } from '../src/drivers/playwright.js'
import { BrowserAgent } from '../src/runner/runner.js'
import { TurnEventBus } from '../src/runner/events.js'

describe('surrender guard predicates', () => {
  const healthy = { url: 'http://127.0.0.1:8123/complex.html', snapshot: '- heading "Total Users" [ref=h1]\n- text "12,418"' }

  it('rejects a turn-1 abort on a healthy page', () => {
    expect(shouldRejectSurrender({ actionType: 'abort', executedTurns: 0, evidenceCount: 0, state: healthy })).toBe(true)
  })

  it('allows aborts after genuine attempts, with evidence, or on blocked pages', () => {
    expect(shouldRejectSurrender({ actionType: 'abort', executedTurns: 2, evidenceCount: 0, state: healthy })).toBe(false)
    expect(shouldRejectSurrender({ actionType: 'abort', executedTurns: 0, evidenceCount: 1, state: healthy })).toBe(false)
    expect(shouldRejectSurrender({ actionType: 'abort', executedTurns: 0, evidenceCount: 0, state: { url: 'chrome-error://err', snapshot: '' } })).toBe(false)
    expect(shouldRejectSurrender({ actionType: 'abort', executedTurns: 0, evidenceCount: 0, state: { url: 'https://x', snapshot: 'Just a moment... Cloudflare Ray ID' } })).toBe(false)
  })

  it('does not touch non-abort actions', () => {
    expect(shouldRejectSurrender({ actionType: 'complete', executedTurns: 0, evidenceCount: 0, state: healthy })).toBe(false)
  })

  it('pageLooksBlocked fires only on hard blocks', () => {
    expect(pageLooksBlocked({ url: 'chrome-error://x' })).toBe(true)
    expect(pageLooksBlocked({ url: 'https://x', snapshot: 'Verifying you are human...' })).toBe(true)
    expect(pageLooksBlocked(healthy)).toBe(false)
  })
})

const DASHBOARD_HTML = `
<!DOCTYPE html>
<html><body>
  <h1>Dashboard</h1>
  <div class="card"><h3>Total Users</h3><div>12,418</div></div>
  <div class="card"><h3>Active Sessions</h3><div>3,892</div></div>
  <div class="card"><h3>Revenue</h3><div>$84,201</div></div>
</body></html>
`

describe('BrowserAgent premature-surrender guard (wave-5 weather scenario)', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('rejects a confabulated turn-1 abort and lets the run complete', async () => {
    const startUrl = 'data:text/html,' + encodeURIComponent(DASHBOARD_HTML)
    await page.goto(startUrl)
    const driver = new PlaywrightDriver(page, { showCursor: false })
    await driver.observe()
    const bus = new TurnEventBus()
    const agent = new BrowserAgent({
      driver,
      config: {
        model: 'gemini-2.5-flash',
        provider: 'google',
        apiKey: 'sk-test',
        goalVerification: false,
        plannerMode: 'auto',
      } as never,
      eventBus: bus,
    })

    // Stub the LLM: turn 1 the model "confabulates" (the wave-5 dx weather
    // scenario verbatim), turn 2 it completes with the visible data.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brain = (agent as any).brain
    const decisions: string[] = []
    brain.decide = async () => {
      decisions.push('decide')
      if (decisions.length === 1) {
        return {
          action: { action: 'abort', reason: 'The previous run on this exact goal stated extraction failed. I cannot proceed.' },
          raw: '{}',
          reasoning: 'The previous run on this exact goal explicitly stated that extraction of these values failed and was blocked.',
        }
      }
      return {
        action: { action: 'complete', result: '{"totalUsers":"12,418","activeSessions":"3,892","revenue":"$84,201"}' },
        raw: '{}',
        reasoning: 'The values are visible in the snapshot.',
      }
    }

    const result = await agent.run({
      goal: 'Extract Total Users, Active Sessions, and Revenue from the dashboard as JSON.',
      startUrl,
      maxTurns: 5,
      tags: ['extraction'],
    })

    // The abort must NOT have ended the run: the agent got a second decide
    // and completed with the data that was visible all along.
    expect(decisions.length).toBeGreaterThanOrEqual(2)
    expect(result.success).toBe(true)
    expect(result.turns.some((t) => t.error?.includes('premature surrender rejected'))).toBe(true)
    // The re-prompt reached the brain's history.
    const history = brain.history as { role: string; content: unknown }[]
    expect(JSON.stringify(history)).toContain('SURRENDER REJECTED')
  })
})
