/**
 * `bad attach` is a top-level alias for `bad run --attach`. These tests pin
 * that the command is recognized in the dispatch table and that the help
 * output advertises it — regressions here are "why doesn't my `bad attach`
 * work anymore" bugs that only surface when someone actually runs the
 * binary, long after the offending commit lands.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(here, '../dist/cli.js')

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    })
    return { stdout, stderr: '', status: 0 }
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string }
    return {
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : '',
      status: e.status ?? 1,
    }
  }
}

describe('bad attach command', () => {
  it('--help advertises `bad attach` as a top-level command', () => {
    const { stdout, status } = runCli(['--help'])
    expect(status).toBe(0)
    // The USAGE block must name `bad attach` explicitly; regressions that
    // silently drop it from help are invisible until a user types --help.
    expect(stdout).toMatch(/bad attach /)
  })

  it('`bad attach` without --goal surfaces a usage error, not a dispatch error', () => {
    const { stderr, status } = runCli(['attach'])
    // We expect the command to dispatch into the run pipeline and then
    // error on the missing --goal — NOT to fail at "unknown command".
    expect(status).not.toBe(0)
    // Should NOT contain "Unknown command" — that would mean dispatch didn't recognize `attach`.
    expect(stderr).not.toMatch(/Unknown command/i)
  })

  it('unknown commands still fail with the standard error', () => {
    const { stderr, status } = runCli(['not-a-real-command'])
    expect(status).not.toBe(0)
    expect(stderr).toMatch(/Unknown command/i)
    // Help suggestion should now mention attach alongside run
    expect(stderr).toMatch(/attach/)
  })
})
