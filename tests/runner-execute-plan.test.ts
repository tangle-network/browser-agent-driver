/**
 * Integration tests for BrowserAgent.executePlan — the Gen 7 deterministic
 * step executor. We construct a synthesized Plan (no LLM call) and execute
 * it against a real Chromium page, verifying:
 *
 *   1. Happy-path: every step executes + verifies → return 'completed'
 *   2. Verification deviation: a step's post-condition doesn't hold →
 *      return 'deviated' with the failed step index and reason
 *   3. Execute deviation: a step's selector misses → return 'deviated'
 *   4. Terminal complete action mid-plan ends the plan with finalResult
 *   5. Plan steps are pushed to the shared `turns` array as Turn artifacts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { PlaywrightDriver } from '../src/drivers/playwright.js'
import { BrowserAgent } from '../src/runner/runner.js'
import { TurnEventBus, type TurnEvent } from '../src/runner/events.js'
import type { Plan, Scenario, Turn } from '../src/types.js'
import { RunState } from '../src/run-state.js'

const FORM_HTML = `
<!DOCTYPE html>
<html><body>
  <h1>Plan executor test</h1>
  <form>
    <input id="firstname" data-testid="firstname" type="text" />
    <input id="lastname" data-testid="lastname" type="text" />
    <input id="email" data-testid="email" type="email" />
    <button type="button" id="submit" data-testid="submit">Submit</button>
  </form>
  <script>
    document.getElementById('submit').addEventListener('click', (e) => {
      // Mutate the button label so the change is visible in the ARIA snapshot
      // (status <p> elements aren't included in interactive-only snapshots).
      e.target.textContent = 'Submitted!';
      e.target.disabled = true;
    });
  </script>
</body></html>
`

async function setupAgent() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.setContent(FORM_HTML)
  const driver = new PlaywrightDriver(page, { showCursor: false })
  await driver.observe() // prime the snapshot helper

  const bus = new TurnEventBus()
  const events: TurnEvent[] = []
  bus.subscribe((e) => events.push(e), false)

  const agent = new BrowserAgent({
    driver,
    config: { model: 'gpt-5.4', provider: 'openai', apiKey: 'sk-test' },
    eventBus: bus,
  })

  return { browser, page, driver, agent, events }
}

interface AgentInternals {
  executePlan(
    plan: Plan,
    scenario: Scenario,
    runId: string,
    turns: Turn[],
    runState: RunState,
    startingTurnIndex: number,
  ): Promise<
    | { kind: 'completed'; lastState: import('../src/types.js').PageState; finalResult?: string; turnsConsumed: number }
    | { kind: 'deviated'; lastState: import('../src/types.js').PageState; failedStepIndex: number; reason: string; turnsConsumed: number }
  >
}

const SCENARIO: Scenario = {
  goal: 'Fill out the form and submit',
  startUrl: 'about:blank',
  maxTurns: 10,
}

describe('BrowserAgent.executePlan', () => {
  let browser: Browser
  let page: Page
  let agent: BrowserAgent
  let events: TurnEvent[]

  beforeAll(async () => {
    const setup = await setupAgent()
    browser = setup.browser
    page = setup.page
    agent = setup.agent
    events = setup.events
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('happy path: executes every step, verifies, and returns completed', async () => {
    const plan: Plan = {
      steps: [
        {
          action: {
            action: 'fill',
            fields: {
              '[data-testid="firstname"]': 'Jordan',
              '[data-testid="lastname"]': 'Rivera',
              '[data-testid="email"]': 'jordan@example.com',
            },
          },
          expectedEffect: 'all three text fields populated',
          rationale: 'Batch fill all visible text fields in one turn',
        },
        {
          action: { action: 'click', selector: '[data-testid="submit"]' },
          expectedEffect: 'submit button label changes to "Submitted!"',
          rationale: 'Click the submit button',
        },
        {
          action: { action: 'complete', result: 'Form submitted successfully' },
          expectedEffect: 'task complete',
          rationale: 'Terminate the plan',
        },
      ],
      finalResult: 'Form submitted successfully',
    }
    const turns: Turn[] = []
    const runState = new RunState(10)
    const internals = agent as unknown as AgentInternals

    const result = await internals.executePlan(plan, SCENARIO, 'run_test', turns, runState, 0)

    expect(result.kind).toBe('completed')
    if (result.kind !== 'completed') throw new Error('narrow')
    expect(result.finalResult).toBe('Form submitted successfully')
    expect(result.turnsConsumed).toBe(3)
    expect(turns).toHaveLength(3)
    // Verify the form actually got filled and submitted in the real DOM
    expect(await page.inputValue('[data-testid="firstname"]')).toBe('Jordan')
    expect(await page.inputValue('[data-testid="lastname"]')).toBe('Rivera')
    expect(await page.textContent('[data-testid="submit"]')).toBe('Submitted!')
    // Bus events: 2 plan-step-executed, both verified=true, neither deviated
    const stepEvents = events.filter((e) => e.type === 'plan-step-executed')
    expect(stepEvents).toHaveLength(3)
    const deviationEvents = events.filter((e) => e.type === 'plan-deviated')
    expect(deviationEvents).toHaveLength(0)
  })

  it('execute deviation: a step with a missing selector returns deviated', async () => {
    // Reset page state for an isolated run
    await page.setContent(FORM_HTML)
    await new PlaywrightDriver(page, { showCursor: false }).observe()
    const setup = await setupAgent()
    const { agent: localAgent } = setup
    const internals = localAgent as unknown as AgentInternals

    const plan: Plan = {
      steps: [
        {
          action: { action: 'click', selector: '[data-testid="ghost"]' },
          expectedEffect: 'a ghost is clicked',
        },
      ],
    }
    const turns: Turn[] = []
    const result = await internals.executePlan(plan, SCENARIO, 'run_test_deviate', turns, new RunState(10), 0)

    expect(result.kind).toBe('deviated')
    if (result.kind !== 'deviated') throw new Error('narrow')
    expect(result.failedStepIndex).toBe(0)
    expect(result.reason).toMatch(/execute failed|verification failed/)
    expect(turns).toHaveLength(1)
    expect(turns[0].error).toBeTruthy()
    await setup.browser.close()
  }, 45_000)

  it('terminal complete action mid-plan ends the plan with the action result', async () => {
    const setup = await setupAgent()
    const { agent: localAgent, browser: localBrowser } = setup
    const internals = localAgent as unknown as AgentInternals

    const plan: Plan = {
      steps: [
        { action: { action: 'wait', ms: 10 }, expectedEffect: 'waited' },
        { action: { action: 'complete', result: 'all done' }, expectedEffect: 'done' },
        // This step should NEVER execute because complete is terminal
        { action: { action: 'click', selector: '[data-testid="never"]' }, expectedEffect: 'unreachable' },
      ],
    }
    const turns: Turn[] = []
    const result = await internals.executePlan(plan, SCENARIO, 'run_test_complete', turns, new RunState(10), 0)

    expect(result.kind).toBe('completed')
    if (result.kind !== 'completed') throw new Error('narrow')
    expect(result.finalResult).toBe('all done')
    expect(result.turnsConsumed).toBe(2)
    expect(turns).toHaveLength(2)
    expect(turns[1].action.action).toBe('complete')
    await localBrowser.close()
  })

  it('plan exhausted without an explicit complete returns deviated (fall-through to per-action loop)', async () => {
    const setup = await setupAgent()
    const internals = setup.agent as unknown as AgentInternals
    const plan: Plan = {
      steps: [
        { action: { action: 'wait', ms: 10 }, expectedEffect: 'waited' },
        // No complete — plan should exhaust naturally and signal deviation
        // so the caller falls through to the per-action loop instead of
        // fabricating a fake complete action.
      ],
    }
    const turns: Turn[] = []
    const result = await internals.executePlan(plan, SCENARIO, 'run_test_exhaust', turns, new RunState(10), 0)
    expect(result.kind).toBe('deviated')
    if (result.kind !== 'deviated') throw new Error('narrow')
    expect(result.reason).toMatch(/exhausted/)
    expect(result.turnsConsumed).toBe(1)
    await setup.browser.close()
  })

  it('plan steps push to shared turns array with rationale + plan metadata', async () => {
    const setup = await setupAgent()
    const internals = setup.agent as unknown as AgentInternals
    const plan: Plan = {
      steps: [
        {
          action: { action: 'wait', ms: 10 },
          expectedEffect: 'waited',
          rationale: 'wait for nothing',
        },
        {
          action: { action: 'complete', result: 'done' },
          expectedEffect: 'done',
          rationale: 'finish',
        },
      ],
    }
    const turns: Turn[] = []
    await internals.executePlan(plan, SCENARIO, 'run_test_meta', turns, new RunState(10), 0)
    expect(turns[0].reasoning).toBe('wait for nothing')
    expect(turns[0].plan).toEqual(['wait for nothing', 'finish'])
    expect(turns[0].currentStep).toBe(0)
    expect(turns[0].expectedEffect).toBe('waited')
    await setup.browser.close()
  })
})
