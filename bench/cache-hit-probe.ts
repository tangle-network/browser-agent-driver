#!/usr/bin/env npx tsx
/**
 * Cache-hit probe — verify provider-agnostic prompt cache observability.
 *
 * Calls Brain.decide twice with a long stable system prompt and an identical
 * user payload. Confirms that `cacheReadInputTokens` is populated on the
 * second call. Works for any provider that supports server-side automatic
 * caching (OpenAI, ZAI/GLM) — no markers needed — and for Anthropic via the
 * cache_control markers built in `buildSystemForDecide`.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... pnpm exec tsx bench/cache-hit-probe.ts
 *   ZAI_API_KEY=... pnpm exec tsx bench/cache-hit-probe.ts --provider zai-coding-plan
 *   ANTHROPIC_API_KEY=... pnpm exec tsx bench/cache-hit-probe.ts --provider anthropic --model claude-haiku-4-5
 *
 * The first call WRITES the cache (or skips if the prefix is too small for
 * the provider's automatic caching threshold). The second call should READ
 * the cache and report cacheReadInputTokens > 0.
 */

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLocalEnvFiles } from '../scripts/lib/env-loader.mjs'
import { Brain } from '../src/brain/index.js'
import type { PageState } from '../src/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadLocalEnvFiles(path.resolve(__dirname, '..'))

const args = process.argv.slice(2)
function arg(name: string, fallback?: string): string | undefined {
  const idx = args.indexOf(`--${name}`)
  if (idx === -1) return fallback
  return args[idx + 1]
}

const provider = (arg('provider', 'openai') ?? 'openai') as
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'zai-coding-plan'

const model = arg('model', undefined)

// Build a long enough snapshot that the cached prefix exceeds OpenAI's
// 1024-token automatic-cache threshold and ZAI's similar floor. The CORE_RULES
// system prompt alone is ~1500 tokens, so we don't need an extra padded body —
// but we do need 2+ identical calls.
const SNAPSHOT = `
[ref=h1] heading "Account Settings"
[ref=t1] textbox "First name"
[ref=t2] textbox "Last name"
[ref=t3] textbox "Email"
[ref=b1] button "Save changes"
[ref=l1] link "Privacy policy"
[ref=l2] link "Terms of service"
[ref=h2] heading "Notification Preferences"
[ref=c1] checkbox "Email notifications"
[ref=c2] checkbox "SMS notifications"
[ref=c3] checkbox "Push notifications"
[ref=h3] heading "Security"
[ref=b2] button "Change password"
[ref=b3] button "Enable two-factor authentication"
[ref=l3] link "View account activity"
`.trim()

const STATE: PageState = {
  url: 'https://example.com/settings',
  title: 'Account Settings',
  snapshot: SNAPSHOT,
}

async function probeOnce(brain: Brain, label: string) {
  const start = performance.now()
  const decision = await brain.decide(
    'Click the Save changes button.',
    STATE,
    undefined,
    { current: 1, max: 5 },
    { forceVision: false },
  )
  const elapsed = performance.now() - start
  console.log(`  ${label}:`)
  console.log(`    elapsed:                  ${elapsed.toFixed(0)}ms`)
  console.log(`    inputTokens:              ${decision.inputTokens ?? '-'}`)
  console.log(`    outputTokens:             ${decision.outputTokens ?? '-'}`)
  console.log(`    cacheReadInputTokens:     ${decision.cacheReadInputTokens ?? 0}`)
  console.log(`    cacheCreationInputTokens: ${decision.cacheCreationInputTokens ?? 0}`)
  console.log(`    action:                   ${decision.action.action}`)
  return decision
}

async function debugRawUsage(brain: Brain) {
  // Bypass Brain.decide and call generateText directly to inspect the raw
  // usage shape — useful when figuring out where a provider stashes its
  // cache fields. Only runs when --debug is passed.
  type BrainInternals = { getModel(sel?: { provider?: string; model?: string }): Promise<unknown> }
  const internals = brain as unknown as BrainInternals
  const model = await internals.getModel()
  const { generateText } = await import('ai')
  const result = await generateText({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: model as any,
    system: 'You are a helpful assistant. Reply with a single JSON object.',
    messages: [{ role: 'user', content: 'Say {"hello":"world"}' }],
  })
  console.log('  raw usage:', JSON.stringify(result.usage, null, 2))
  console.log('  raw providerMetadata:', JSON.stringify(result.providerMetadata, null, 2))
}

async function main() {
  console.log(`Cache-hit probe — provider=${provider} model=${model ?? '<default>'}`)
  console.log('')

  // Brain.decide doesn't accept arbitrary prefix injection, so we can't bust
  // the cache by modifying the system prompt directly. Instead we tag the
  // user content via an extraContext header that's stable across our two
  // calls but unique per process run — call 1 misses, call 2 hits.
  const sessionTag = `[session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}]`
  ;(STATE as { url: string }).url = `https://example.com/settings?probe=${sessionTag}`

  const brain = new Brain({
    provider,
    model,
    // Identical history for both calls so the prompt is byte-stable.
    maxHistoryTurns: 1,
  })

  if (args.includes('--debug')) {
    console.log('Debug: dumping raw usage shape from one call')
    await debugRawUsage(brain)
    console.log('')
  }

  const first = await probeOnce(brain, 'Call 1 (cache miss expected)')
  // Reset history so call 2 sends the EXACT same payload as call 1 — otherwise
  // the new assistant turn invalidates the prefix.
  brain.reset()
  const second = await probeOnce(brain, 'Call 2 (cache hit expected)')

  console.log('')
  const cachedFirst = first.cacheReadInputTokens ?? 0
  const cachedSecond = second.cacheReadInputTokens ?? 0
  if (cachedSecond > cachedFirst && cachedSecond > 0) {
    console.log(`✓ Cache hit verified: call 2 reused ${cachedSecond} cached input tokens`)
    process.exit(0)
  } else if (cachedSecond > 0) {
    console.log(`✓ Cache hit on call 2 (${cachedSecond} tokens), but call 1 already had ${cachedFirst} cached — both calls hit a pre-warmed cache`)
    process.exit(0)
  } else {
    console.log('✗ No cache hit detected on call 2')
    console.log('  Possible causes:')
    console.log('    - Provider does not auto-cache (Gemini, codex-cli, claude-code, sandbox-backend)')
    console.log('    - Prompt prefix too small (OpenAI: <1024 tokens; ZAI: similar floor)')
    console.log('    - Cache TTL expired between calls (run them back-to-back)')
    console.log('    - Anthropic without explicit markers (we set them; verify provider=anthropic)')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Probe failed:', err.message ?? err)
  process.exit(1)
})
