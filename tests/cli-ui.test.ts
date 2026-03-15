import { describe, expect, it, vi } from 'vitest'
import { fmtDuration, cliError, cliWarn, cliLog, CliRenderer } from '../src/cli-ui.js'

describe('fmtDuration', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(fmtDuration(0)).toBe('0s')
    expect(fmtDuration(500)).toBe('1s')
    expect(fmtDuration(1000)).toBe('1s')
    expect(fmtDuration(15_000)).toBe('15s')
    expect(fmtDuration(59_499)).toBe('59s')
  })

  it('formats durations over 60s as minutes + seconds', () => {
    expect(fmtDuration(60_000)).toBe('1m')
    expect(fmtDuration(90_000)).toBe('1m 30s')
    expect(fmtDuration(125_000)).toBe('2m 5s')
    expect(fmtDuration(600_000)).toBe('10m')
  })

  it('rounds to nearest second', () => {
    expect(fmtDuration(1_499)).toBe('1s')
    expect(fmtDuration(1_500)).toBe('2s')
    expect(fmtDuration(59_500)).toBe('1m')
  })
})

describe('cliError', () => {
  it('writes to stderr with error prefix', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    cliError('something broke')
    expect(spy).toHaveBeenCalledOnce()
    // Strip ANSI codes for assertion
    const output = spy.mock.calls[0][0].replace(/\x1B\[[0-9;]*m/g, '')
    expect(output).toContain('error:')
    expect(output).toContain('something broke')
    spy.mockRestore()
  })
})

describe('cliWarn', () => {
  it('writes to stderr with warn prefix', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cliWarn('heads up')
    expect(spy).toHaveBeenCalledOnce()
    const output = spy.mock.calls[0][0].replace(/\x1B\[[0-9;]*m/g, '')
    expect(output).toContain('warn:')
    expect(output).toContain('heads up')
    spy.mockRestore()
  })
})

describe('cliLog', () => {
  it('writes with bracketed prefix', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    cliLog('wallet', 'connected')
    expect(spy).toHaveBeenCalledOnce()
    const output = spy.mock.calls[0][0].replace(/\x1B\[[0-9;]*m/g, '')
    expect(output).toContain('[wallet]')
    expect(output).toContain('connected')
    spy.mockRestore()
  })
})

describe('CliRenderer', () => {
  function stripAnsi(s: string): string {
    return s.replace(/\x1B\[[0-9;]*m/g, '')
  }

  it('renders single-task pass with result on its own line', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const renderer = new CliRenderer()
    renderer.suiteStart(1)
    renderer.testStart('login', 'Login flow')
    renderer.testComplete('login', true, 'User logged in successfully', 4, 8000, 0.023)

    // Single-task: icon + name + stats on first line
    const iconLine = spy.mock.calls.find(c => stripAnsi(c[0]).includes('✓'))
    expect(iconLine).toBeDefined()
    const line1 = stripAnsi(iconLine![0])
    expect(line1).toContain('✓')
    expect(line1).toContain('login')
    expect(line1).toContain('4 turns')
    expect(line1).toContain('8s')
    expect(line1).toContain('$0.023')
    // Result text on second line
    const resultLine = spy.mock.calls.find(c => stripAnsi(c[0]).includes('User logged in'))
    expect(resultLine).toBeDefined()
    spy.mockRestore()
    renderer.destroy()
  })

  it('renders single-task fail with red result on its own line', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const renderer = new CliRenderer()
    renderer.suiteStart(1)
    renderer.testStart('checkout', 'Checkout')
    renderer.testComplete('checkout', false, 'Cart was empty', 7, 15000, 0.041)

    const iconLine = spy.mock.calls.find(c => stripAnsi(c[0]).includes('✗'))
    expect(iconLine).toBeDefined()
    const line1 = stripAnsi(iconLine![0])
    expect(line1).toContain('✗')
    expect(line1).toContain('checkout')
    expect(line1).toContain('7 turns')
    expect(line1).toContain('15s')
    // Result on second line
    const resultLine = spy.mock.calls.find(c => stripAnsi(c[0]).includes('Cart was empty'))
    expect(resultLine).toBeDefined()
    spy.mockRestore()
    renderer.destroy()
  })

  it('renders multi-test results inline', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const renderer = new CliRenderer()
    renderer.suiteStart(3)
    renderer.testStart('login', 'Login')
    renderer.testComplete('login', true, 'Logged in successfully', 4, 8000, 0.02)

    // Multi-test: verdict on same line as icon
    const resultCall = spy.mock.calls.find(c => stripAnsi(c[0]).includes('✓'))
    expect(resultCall).toBeDefined()
    const line = stripAnsi(resultCall![0])
    expect(line).toContain('✓')
    expect(line).toContain('login')
    expect(line).toContain('Logged in successfully')
    expect(line).toContain('4 turns')
    spy.mockRestore()
    renderer.destroy()
  })

  it('renders suite summary with total turns and cost', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const renderer = new CliRenderer()
    renderer.suiteStart(3)
    renderer.testStart('a', 'A')
    renderer.testComplete('a', true, 'ok', 4, 5000, 0.01)
    renderer.testStart('b', 'B')
    renderer.testComplete('b', true, 'ok', 6, 8000, 0.02)
    renderer.testStart('c', 'C')
    renderer.testComplete('c', false, 'fail', 3, 4000, 0.005)
    renderer.suiteComplete(2, 1, 0, 17000, 0.035)

    const summaryCall = spy.mock.calls.find(c => stripAnsi(c[0]).includes('passed'))
    expect(summaryCall).toBeDefined()
    const line = stripAnsi(summaryCall![0])
    expect(line).toContain('2 passed')
    expect(line).toContain('1 failed')
    expect(line).toContain('17s')
    expect(line).toContain('13 turns')
    expect(line).toContain('$0.04')
    spy.mockRestore()
    renderer.destroy()
  })

  it('renders debug turn output when debug enabled', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const renderer = new CliRenderer({ debug: true })
    renderer.suiteStart(1)
    renderer.testStart('t1', 'Test 1')
    renderer.testTurn('t1', 3, 'click', 458, 'gpt-5.4')

    const turnCall = spy.mock.calls.find(c => stripAnsi(c[0]).includes('turn 3'))
    expect(turnCall).toBeDefined()
    const line = stripAnsi(turnCall![0])
    expect(line).toContain('turn 3:')
    expect(line).toContain('click')
    expect(line).toContain('458ms')
    expect(line).toContain('[gpt-5.4]')
    spy.mockRestore()
    renderer.destroy()
  })

  it('suppresses turn output when debug disabled', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const renderer = new CliRenderer({ debug: false })
    renderer.suiteStart(1)
    renderer.testStart('t1', 'Test 1')
    renderer.testTurn('t1', 3, 'click', 458)

    const turnCall = spy.mock.calls.find(c => stripAnsi(c[0]).includes('turn 3'))
    expect(turnCall).toBeUndefined()
    spy.mockRestore()
    renderer.destroy()
  })
})
