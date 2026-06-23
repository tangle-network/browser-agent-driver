import { describe, it, expect } from 'vitest'
import { resolveAgentCommand, buildApplyPrompt } from '../src/design/audit/evolve/agent.js'
import type { PageAuditResult } from '../src/cli-design-audit.js'

const stubResult = (): PageAuditResult =>
  ({ url: 'https://app.example', score: 6, findings: [] } as unknown as PageAuditResult)

// Guards the shell-injection fix: the prompt — which contains text mined from the
// audited DOM — must reach the coding agent as a SINGLE argv element, never
// concatenated into a shell string. The dispatch uses execFileSync(cmd, args),
// so as long as the malicious prompt is one discrete arg, no shell evaluates it.
describe('resolveAgentCommand — argv safety', () => {
  const EVIL = 'Fix this: `$(touch /tmp/pwned)` && rm -rf ~ ; "><img>'

  it('claude-code passes the prompt as one discrete argv element', () => {
    const { cmd, args } = resolveAgentCommand('claude-code', EVIL, '/proj')
    expect(cmd).toBe('claude')
    // The whole prompt is exactly one element — not split, not joined into a string.
    expect(args).toContain(EVIL)
    expect(args.filter((a) => a === EVIL)).toHaveLength(1)
    // No element smuggles a shell operator by concatenation with the prompt.
    expect(args.some((a) => a !== EVIL && /\$\(|&&|;|`/.test(a))).toBe(false)
  })

  it('codex and a custom command also keep the prompt as one argv element', () => {
    expect(resolveAgentCommand('codex', EVIL, '/proj').args).toContain(EVIL)
    const custom = resolveAgentCommand('aider --message', EVIL, '/proj')
    expect(custom.cmd).toBe('aider')
    expect(custom.args).toEqual(['--message', EVIL])
  })

  it('resolves cwd to the project dir', () => {
    expect(resolveAgentCommand('claude-code', 'x', '/proj').cwd).toBe('/proj')
  })
})

// Regression: the apply prompt must forbid the coding agent from inventing
// content (data/metrics/feeds) the app does not already have — the defence-in-
// depth guardrail behind the generator/judge content-fidelity rules.
describe('buildApplyPrompt — content fidelity', () => {
  it('forbids inventing content in both the redesign and findings-only modes', () => {
    const withTarget = buildApplyPrompt([stubResult()], 'auto', '## Some redesign target\n\nbody')
    expect(withTarget).toContain('Invent content the app does not already have')
    expect(withTarget).toContain('using only the app\'s REAL content')

    const findingsOnly = buildApplyPrompt([stubResult()], 'auto')
    expect(findingsOnly).toContain('Invent content the app does not already have')
  })
})
