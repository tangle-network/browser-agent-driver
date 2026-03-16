import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { AppKnowledge } from '../src/memory/knowledge.js'
import type { Session } from '../src/memory/knowledge.js'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: `test_${Date.now()}`,
    goal: 'Build a todo app',
    outcome: 'Created project with TaskList component',
    success: true,
    finalUrl: 'https://example.com/project/123',
    timestamp: new Date().toISOString(),
    turnsUsed: 8,
    durationMs: 45000,
    ...overrides,
  }
}

describe('AppKnowledge session history', () => {
  let dir: string
  let knowledgePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bad-test-'))
    knowledgePath = join(dir, 'knowledge.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('records and persists a session', () => {
    const k = new AppKnowledge(knowledgePath, 'example.com')
    k.recordSession(makeSession())
    k.save()

    const k2 = new AppKnowledge(knowledgePath, 'example.com')
    const sessions = k2.getSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].goal).toBe('Build a todo app')
    expect(sessions[0].outcome).toBe('Created project with TaskList component')
    expect(sessions[0].success).toBe(true)
    expect(sessions[0].finalUrl).toBe('https://example.com/project/123')
  })

  it('keeps rolling history of last 5 sessions', () => {
    const k = new AppKnowledge(knowledgePath, 'example.com')
    for (let i = 0; i < 7; i++) {
      k.recordSession(makeSession({
        id: `session_${i}`,
        goal: `Goal ${i}`,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
      }))
    }
    k.save()

    const k2 = new AppKnowledge(knowledgePath, 'example.com')
    const sessions = k2.getSessions()
    expect(sessions).toHaveLength(5)
    // Should keep the 5 most recent (goals 2-6)
    expect(sessions[0].goal).toBe('Goal 6')
    expect(sessions[4].goal).toBe('Goal 2')
  })

  it('formats session history for brain injection', () => {
    const k = new AppKnowledge(knowledgePath, 'example.com')
    k.recordSession(makeSession({
      goal: 'Build the app',
      outcome: 'Created project MyTodos',
      finalUrl: 'https://example.com/project/123',
      timestamp: '2026-03-15T23:45:00.000Z',
    }))
    k.recordSession(makeSession({
      goal: 'Add auth',
      outcome: 'Added login/signup with email',
      finalUrl: 'https://example.com/login',
      timestamp: '2026-03-15T23:52:00.000Z',
    }))

    const output = k.formatForBrain()
    expect(output).toContain('SESSION HISTORY (2 previous runs')
    expect(output).toContain('✓')
    expect(output).toContain('Build the app')
    expect(output).toContain('Created project MyTodos')
    expect(output).toContain('Add auth')
    expect(output).toContain('Final URL: https://example.com/')
  })

  it('shows failure sessions with ✗', () => {
    const k = new AppKnowledge(knowledgePath, 'example.com')
    k.recordSession(makeSession({
      success: false,
      goal: 'Deploy the app',
      outcome: 'Build failed: missing dependency',
    }))

    const output = k.formatForBrain()
    expect(output).toContain('✗')
    expect(output).toContain('Deploy the app')
    expect(output).toContain('missing dependency')
  })

  it('session history appears before app knowledge', () => {
    const k = new AppKnowledge(knowledgePath, 'example.com')
    k.recordFact('timing', 'load', '2s')
    k.recordSession(makeSession())

    const output = k.formatForBrain()
    const sessionIdx = output.indexOf('SESSION HISTORY')
    const knowledgeIdx = output.indexOf('APP KNOWLEDGE')
    expect(sessionIdx).toBeGreaterThanOrEqual(0)
    expect(knowledgeIdx).toBeGreaterThan(sessionIdx)
  })

  it('coexists with other fact types', () => {
    const k = new AppKnowledge(knowledgePath, 'example.com')
    k.recordFact('quirk', 'shadow-dom', 'uses shadow DOM for forms')
    k.recordFact('selector', 'login-btn', '#login-button')
    k.recordSession(makeSession())
    k.save()

    const k2 = new AppKnowledge(knowledgePath, 'example.com')
    expect(k2.getSessions()).toHaveLength(1)
    expect(k2.getFacts(0).filter(f => f.type === 'quirk')).toHaveLength(1)
    expect(k2.getFacts(0).filter(f => f.type === 'selector')).toHaveLength(1)
    const output = k2.formatForBrain()
    expect(output).toContain('SESSION HISTORY')
    expect(output).toContain('APP KNOWLEDGE')
    expect(output).toContain('shadow DOM')
  })

  it('migrates old session-type facts to sessions array', () => {
    // Simulate old format with session facts
    const oldData = {
      domain: 'example.com',
      facts: [
        { type: 'session', key: 'latest', value: 'Built the app', confidence: 1, sources: 1, lastSeen: '2026-03-15T00:00:00.000Z' },
        { type: 'timing', key: 'load', value: '2s', confidence: 0.6, sources: 1, lastSeen: '2026-03-15T00:00:00.000Z' },
      ],
      updatedAt: '2026-03-15T00:00:00.000Z',
    }
    writeFileSync(knowledgePath, JSON.stringify(oldData))

    const k = new AppKnowledge(knowledgePath, 'example.com')
    // Session facts migrated to sessions array
    expect(k.getSessions()).toHaveLength(1)
    expect(k.getSessions()[0].outcome).toBe('Built the app')
    // Regular facts preserved, session facts removed
    expect(k.getFacts(0).filter(f => (f as { type: string }).type === 'session')).toHaveLength(0)
    expect(k.getFacts(0).filter(f => f.type === 'timing')).toHaveLength(1)
  })

  it('compresses older sessions in formatForBrain', () => {
    const k = new AppKnowledge(knowledgePath, 'example.com')
    for (let i = 0; i < 4; i++) {
      k.recordSession(makeSession({
        id: `s${i}`,
        goal: `Goal ${i}`,
        outcome: `Outcome ${i} with a lot of extra detail that should be truncated for older sessions to save context window tokens`,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
      }))
    }

    const output = k.formatForBrain()
    // Recent sessions (0, 1 from the end = goals 3, 2) should have "Final URL:"
    expect(output).toContain('Final URL:')
    // Count Final URL occurrences — should only appear for the 2 most recent
    const finalUrlCount = (output.match(/Final URL:/g) || []).length
    expect(finalUrlCount).toBe(2)
  })
})
