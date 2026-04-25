/**
 * Fixture loader. Reads `fixtures.json`, resolves local file paths to absolute
 * `file://` URLs, and exposes a query helper for the GEPA runner.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FixtureCase } from '../types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_FIXTURES_PATH = path.join(__dirname, 'fixtures.json')

export interface LoadedFixtures {
  fixtures: FixtureCase[]
  /** Absolute path the fixtures were loaded from — useful for reports. */
  source: string
}

export function loadFixtures(fixturesPath = DEFAULT_FIXTURES_PATH): LoadedFixtures {
  const raw = fs.readFileSync(fixturesPath, 'utf-8')
  const parsed = JSON.parse(raw) as { fixtures: FixtureCase[] }
  if (!Array.isArray(parsed.fixtures)) {
    throw new Error(`fixtures file is missing the \`fixtures\` array: ${fixturesPath}`)
  }
  const baseDir = path.dirname(fixturesPath)
  const resolved = parsed.fixtures.map((f) => resolveFixture(f, baseDir))
  return { fixtures: resolved, source: fixturesPath }
}

function resolveFixture(fixture: FixtureCase, baseDir: string): FixtureCase {
  if (fixture.source.type === 'file') {
    const abs = path.resolve(baseDir, fixture.source.target)
    return { ...fixture, source: { type: 'file', target: abs } }
  }
  return fixture
}

export function resolveFixtureUrl(fixture: FixtureCase): string {
  if (fixture.source.type === 'url') return fixture.source.target
  return `file://${fixture.source.target}`
}

export function selectFixtures(
  fixtures: FixtureCase[],
  ids?: string[],
): FixtureCase[] {
  if (!ids || ids.length === 0) return fixtures
  const want = new Set(ids)
  return fixtures.filter((f) => want.has(f.id))
}
