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

  // Gen 7.2: when the planner emits runScript→complete with placeholder
  // values in the complete result, the runner substitutes the runScript's
  // actual output as the final result. Without this, extraction tasks
  // would always return the planner's fabricated values (null, etc.) and
  // fail their oracles. See task #108 / docs/COMPETITIVE-EVAL.md.
  it('Gen 7.2: substitutes runScript output when complete.result has placeholder pattern', async () => {
    const setup = await setupAgent()
    const internals = setup.agent as unknown as AgentInternals
    const plan: Plan = {
      steps: [
        {
          action: {
            action: 'runScript',
            script: '(() => JSON.stringify({totalUsers: "12,847", activeSessions: "3,421", revenue: "$48,290"}))()',
          },
          expectedEffect: 'JSON string returned with the three metric values',
          rationale: 'extract metrics',
        },
        {
          action: {
            action: 'complete',
            // Planner-fabricated placeholders — totalUsers/activeSessions/revenue are null
            // because at planning time the planner couldn't know the runScript output.
            result: '{"totalUsers":null,"activeSessions":null,"revenue":null}',
          },
          expectedEffect: 'task complete',
          rationale: 'finish',
        },
      ],
    }
    const turns: Turn[] = []
    const result = await internals.executePlan(plan, SCENARIO, 'run_test_substitute', turns, new RunState(10), 0)
    expect(result.kind).toBe('completed')
    if (result.kind !== 'completed') throw new Error('narrow')
    // The substituted finalResult should be the runScript output (real values),
    // NOT the planner's placeholder JSON.
    expect(result.finalResult).toContain('12,847')
    expect(result.finalResult).toContain('3,421')
    expect(result.finalResult).toContain('$48,290')
    expect(result.finalResult).not.toMatch(/:\s*null\b/)
    // The complete-step turn should be flagged as substituted in its reasoning
    // for forensics.
    const completeTurn = turns[turns.length - 1]
    expect(completeTurn.action.action).toBe('complete')
    expect(completeTurn.reasoning).toMatch(/Gen 7.2 substituted/)
    await setup.browser.close()
  })

  // Gen 7.2: when the planner correctly emits ONLY runScript (no complete)
  // for an extraction task, the runner should auto-emit a complete with the
  // runScript output instead of falling through to the per-action loop.
  // This is the supply side of the planner-prompt rule #7 in src/brain/index.ts.
  it('Gen 7.2: auto-completes with runScript output when plan ends with successful runScript', async () => {
    const setup = await setupAgent()
    const internals = setup.agent as unknown as AgentInternals
    const plan: Plan = {
      steps: [
        {
          action: {
            action: 'runScript',
            script: '(() => JSON.stringify({totalUsers: "12,847", revenue: "$48,290"}))()',
          },
          expectedEffect: 'extracted JSON values',
          rationale: 'extract metrics — no complete step per Gen 7.2 prompt rule',
        },
      ],
    }
    const turns: Turn[] = []
    const result = await internals.executePlan(plan, SCENARIO, 'run_test_auto_complete', turns, new RunState(10), 0)
    // Should be completed (not deviated), with the runScript output as the result.
    expect(result.kind).toBe('completed')
    if (result.kind !== 'completed') throw new Error('narrow')
    expect(result.finalResult).toContain('12,847')
    expect(result.finalResult).toContain('$48,290')
    // turnsConsumed should be plan.steps.length + 1 (the synthesized complete turn)
    expect(result.turnsConsumed).toBe(2)
    // The synthesized complete turn should be in the shared turns array with
    // a Gen 7.2 marker for forensics.
    const lastTurn = turns[turns.length - 1]
    expect(lastTurn.action.action).toBe('complete')
    expect(lastTurn.reasoning).toMatch(/Gen 7.2 auto-complete/)
    await setup.browser.close()
  })

  // Negative: if a runScript-only plan returns empty output, we should NOT
  // auto-complete. Fall through to the per-action loop (deviated).
  // Gen 9: the deviation reason now mentions "no meaningful output" so the
  // per-action loop's [REPLAN] context can act on it.
  it('Gen 7.2/9: does NOT auto-complete when runScript output is empty', async () => {
    const setup = await setupAgent()
    const internals = setup.agent as unknown as AgentInternals
    const plan: Plan = {
      steps: [
        {
          action: { action: 'runScript', script: '(() => "")()' },
          expectedEffect: 'noop',
        },
      ],
    }
    const turns: Turn[] = []
    const result = await internals.executePlan(plan, SCENARIO, 'run_test_no_auto_empty', turns, new RunState(10), 0)
    expect(result.kind).toBe('deviated')
    if (result.kind !== 'deviated') throw new Error('narrow')
    // Gen 9: empty runScript output produces a "no meaningful output" reason
    // (not "exhausted"), so the per-action loop's [REPLAN] context names
    // the actual failure mode.
    expect(result.reason).toMatch(/no meaningful output|exhausted/)
    await setup.browser.close()
  })

  // Gen 9: when runScript returns a placeholder JSON like {"x": null},
  // the auto-complete should DECLINE and fall through with a "no meaningful
  // output" reason. This is the npm/mdn/w3c failure mode that browser-use
  // recovers from via per-action iteration.
  it('Gen 9: declines auto-complete when runScript returns {"x": null} placeholder', async () => {
    const setup = await setupAgent()
    const internals = setup.agent as unknown as AgentInternals
    const plan: Plan = {
      steps: [
        {
          action: {
            action: 'runScript',
            script: '(() => JSON.stringify({weekly_downloads: null}))()',
          },
          expectedEffect: 'extract failed',
        },
      ],
    }
    const turns: Turn[] = []
    const result = await internals.executePlan(plan, SCENARIO, 'run_test_gen9_placeholder', turns, new RunState(10), 0)
    expect(result.kind).toBe('deviated')
    if (result.kind !== 'deviated') throw new Error('narrow')
    expect(result.reason).toMatch(/no meaningful output/)
    await setup.browser.close()
  })

  // Gen 9: when runScript returns the literal string "null", same fall-through.
  it('Gen 9: declines auto-complete when runScript returns the literal string "null"', async () => {
    const setup = await setupAgent()
    const internals = setup.agent as unknown as AgentInternals
    const plan: Plan = {
      steps: [
        {
          action: { action: 'runScript', script: '(() => "null")()' },
          expectedEffect: 'extract failed',
        },
      ],
    }
    const turns: Turn[] = []
    const result = await internals.executePlan(plan, SCENARIO, 'run_test_gen9_null_string', turns, new RunState(10), 0)
    expect(result.kind).toBe('deviated')
    if (result.kind !== 'deviated') throw new Error('narrow')
    expect(result.reason).toMatch(/no meaningful output/)
    await setup.browser.close()
  })

  // Positive control: meaningful output still auto-completes correctly.
  it('Gen 9: auto-completes when runScript output IS meaningful (positive control)', async () => {
    const setup = await setupAgent()
    const internals = setup.agent as unknown as AgentInternals
    const plan: Plan = {
      steps: [
        {
          action: {
            action: 'runScript',
            script: '(() => JSON.stringify({weekly_downloads: "25,847,392"}))()',
          },
          expectedEffect: 'extracted weekly downloads',
        },
      ],
    }
    const turns: Turn[] = []
    const result = await internals.executePlan(plan, SCENARIO, 'run_test_gen9_meaningful', turns, new RunState(10), 0)
    expect(result.kind).toBe('completed')
    if (result.kind !== 'completed') throw new Error('narrow')
    expect(result.finalResult).toContain('25,847,392')
    await setup.browser.close()
  })

  // Negative test: a complete with a clean (non-placeholder) result should
  // pass through unchanged even if there was a runScript earlier.
  it('Gen 7.2: leaves complete.result unchanged when there are no placeholders', async () => {
    const setup = await setupAgent()
    const internals = setup.agent as unknown as AgentInternals
    const plan: Plan = {
      steps: [
        {
          action: { action: 'runScript', script: '(() => "ignored")()' },
          expectedEffect: 'noop',
        },
        {
          action: {
            action: 'complete',
            // Planner already knew the answer (e.g. a fixed-text task)
            result: 'Form was submitted successfully and the success banner is visible.',
          },
          expectedEffect: 'done',
        },
      ],
    }
    const turns: Turn[] = []
    const result = await internals.executePlan(plan, SCENARIO, 'run_test_no_substitute', turns, new RunState(10), 0)
    expect(result.kind).toBe('completed')
    if (result.kind !== 'completed') throw new Error('narrow')
    expect(result.finalResult).toBe('Form was submitted successfully and the success banner is visible.')
    await setup.browser.close()
  })

  // Gen 10: extractWithIndex in a plan should run the extraction (capturing
  // the formatted match list as turn data), then deviate with the match list
  // in the reason so the per-action loop can pick by index.
  it('Gen 10: extractWithIndex plan step captures matches and deviates with the list', async () => {
    const setup = await setupAgent()
    const { agent: localAgent, page: localPage, browser: localBrowser } = setup
    // Use a content-rich page so extractWithIndex has something to find
    await localPage.setContent(`
      <h1>Array.prototype.flatMap</h1>
      <dl>
        <dt><code>flatMap(callbackFn)</code></dt>
        <dd>Returns a new array formed by applying a function to each element.</dd>
      </dl>
      <p data-testid="weekly">Weekly downloads: 26,543,821</p>
    `)
    await new PlaywrightDriver(localPage, { showCursor: false }).observe()
    const internals = localAgent as unknown as AgentInternals
    const plan: Plan = {
      steps: [
        {
          action: { action: 'extractWithIndex', query: 'p, dd, code', contains: 'downloads' },
          expectedEffect: 'extracted matches for the downloads paragraph',
          rationale: 'Gen 10: pick by content',
        },
      ],
    }
    const turns: Turn[] = []
    const result = await internals.executePlan(plan, SCENARIO, 'run_test_extract', turns, new RunState(10), 0)
    expect(result.kind).toBe('deviated')
    if (result.kind !== 'deviated') throw new Error('narrow')
    expect(result.reason).toMatch(/extractWithIndex/i)
    expect(result.reason).toContain('Weekly downloads: 26,543,821')
    expect(result.reason).toContain('[0]')
    // The extract step should appear as a turn artifact
    expect(turns).toHaveLength(1)
    expect(turns[0].action.action).toBe('extractWithIndex')
    expect(turns[0].verified).toBe(true)
    await localBrowser.close()
  })

  // Gen 10: when extractWithIndex returns zero matches, the plan still
  // deviates (the per-action loop must observe and try a wider query)
  it('Gen 10: extractWithIndex with no matches deviates with empty match list', async () => {
    const setup = await setupAgent()
    await setup.page.setContent('<h1>Empty page with no matching content</h1>')
    await new PlaywrightDriver(setup.page, { showCursor: false }).observe()
    const internals = setup.agent as unknown as AgentInternals
    const plan: Plan = {
      steps: [
        {
          action: { action: 'extractWithIndex', query: 'p, dd, code', contains: 'nonexistent' },
          expectedEffect: 'no matches',
        },
      ],
    }
    const turns: Turn[] = []
    const result = await internals.executePlan(plan, SCENARIO, 'run_test_extract_empty', turns, new RunState(10), 0)
    // Zero matches → no lastExtractOutput → falls into "plan exhausted" branch
    expect(result.kind).toBe('deviated')
    if (result.kind !== 'deviated') throw new Error('narrow')
    expect(result.reason).toMatch(/exhausted|no matches/i)
    await setup.browser.close()
  })

  // Gen 10: cost cap fires when totalTokensUsed exceeds tokenBudget
  it('Gen 10 cost cap: RunState reports exhausted when tokens exceed budget', () => {
    const state = new RunState(20, 1000)
    state.recordTokens(800)
    expect(state.isTokenBudgetExhausted).toBe(false)
    state.recordTokens(300) // total = 1100 > 1000
    expect(state.isTokenBudgetExhausted).toBe(true)
    expect(state.totalTokensUsed).toBe(1100)
  })
})

// Pure unit tests on the placeholder detection helper. No fixture, no driver.
describe('hasPlaceholderPattern', () => {
  // Imported lazily to keep the integration suite above the unit suite.
  let detect: (text: string) => boolean
  let isMeaningful: (out: string | null | undefined) => boolean

  beforeAll(async () => {
    const mod = await import('../src/runner/runner.js')
    detect = mod.hasPlaceholderPattern
    isMeaningful = mod.isMeaningfulRunScriptOutput
  })

  it('detects JSON null literals', () => {
    expect(detect('{"x": null, "y": 5}')).toBe(true)
    expect(detect('{"a":null}')).toBe(true)
    expect(detect('[null, 1, 2]')).toBe(true)
  })

  it('detects angle-bracket placeholder phrases', () => {
    expect(detect('result: <from prior step>')).toBe(true)
    expect(detect('value is <placeholder>')).toBe(true)
    expect(detect('<value from runScript>')).toBe(true)
    expect(detect('<extracted user count>')).toBe(true)
    expect(detect('<observed result>')).toBe(true)
  })

  it('detects double-curly templates', () => {
    expect(detect('count = {{userCount}}')).toBe(true)
    expect(detect('{"x": "{{value}}"}')).toBe(true)
  })

  it('does NOT match clean prose results', () => {
    expect(detect('Form was submitted successfully.')).toBe(false)
    expect(detect('The user has 5 active sessions.')).toBe(false)
    expect(detect('null pointer exception was caught and logged.')).toBe(false) // word "null" in prose, not JSON
    expect(detect('')).toBe(false)
  })

  it('does NOT match JSON with real values', () => {
    expect(detect('{"totalUsers": "12,847", "activeSessions": "3,421"}')).toBe(false)
    expect(detect('[1, 2, 3]')).toBe(false)
  })

  // Gen 9: isMeaningfulRunScriptOutput catches the runScript outputs that
  // SHOULD trigger a fall-through to the per-action loop.
  describe('isMeaningfulRunScriptOutput (Gen 9)', () => {
    it('rejects null / undefined / empty / whitespace', () => {
      expect(isMeaningful(null)).toBe(false)
      expect(isMeaningful(undefined)).toBe(false)
      expect(isMeaningful('')).toBe(false)
      expect(isMeaningful('   ')).toBe(false)
      expect(isMeaningful('\n\t  \n')).toBe(false)
    })

    it('rejects literal "null" / "undefined" / empty quoted strings', () => {
      expect(isMeaningful('null')).toBe(false)
      expect(isMeaningful('undefined')).toBe(false)
      expect(isMeaningful('""')).toBe(false)
      expect(isMeaningful("''")).toBe(false)
    })

    it('rejects empty JSON shells', () => {
      expect(isMeaningful('{}')).toBe(false)
      expect(isMeaningful('[]')).toBe(false)
    })

    it('rejects JSON objects where every value is null/empty/zero', () => {
      expect(isMeaningful('{"x": null}')).toBe(false)
      expect(isMeaningful('{"x": null, "y": null}')).toBe(false)
      expect(isMeaningful('{"x": "", "y": ""}')).toBe(false)
      expect(isMeaningful('{"x": null, "y": ""}')).toBe(false)
    })

    it('rejects placeholder patterns', () => {
      expect(isMeaningful('<from prior step>')).toBe(false)
      expect(isMeaningful('{"x": "{{value}}"}')).toBe(false)
    })

    it('accepts JSON with real values', () => {
      expect(isMeaningful('{"weekly_downloads": "25,847,392"}')).toBe(true)
      expect(isMeaningful('{"x": 1815}')).toBe(true)
    })

    it('rejects JSON with ANY null value (partial extraction = retry)', () => {
      // Even one null suggests the agent failed to extract that field; the
      // per-action loop should retry to get all fields. This is the cleaner
      // behavior than auto-completing with partial data.
      expect(isMeaningful('{"x": null, "y": 5}')).toBe(false)
      expect(isMeaningful('{"title": "Mistral 7B", "first_author": null}')).toBe(false)
    })

    it('accepts non-JSON real strings', () => {
      expect(isMeaningful('Mistral 7B')).toBe(true)
      expect(isMeaningful('1815')).toBe(true)
      expect(isMeaningful('Account Created!')).toBe(true)
    })

    it('accepts non-empty arrays', () => {
      expect(isMeaningful('[1,2,3]')).toBe(true)
      expect(isMeaningful('["one"]')).toBe(true)
    })
  })
})
