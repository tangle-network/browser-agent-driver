// Quickstart: drive a browser with the SDK.
// Run with: npx tsx examples/quickstart-sdk.ts
// Requires: playwright (`npx playwright install chromium`) and an LLM
// credential — e.g. GEMINI_API_KEY for provider 'google', or no key at all
// with the default credential-aware provider (falls back to claude-code).

import { chromium } from 'playwright'
import { PlaywrightDriver, BrowserAgent } from '@tangle-network/browser-agent-driver'

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage()
const driver = new PlaywrightDriver(page)

const agent = new BrowserAgent({
  driver,
  config: {
    model: 'gemini-2.5-flash',   // bench-validated default
    provider: 'google',
    observationMode: 'hybrid',   // vision + DOM
    plannerEnabled: true,        // plan-then-execute
  },
})

const result = await agent.run({
  goal: 'Find the top 3 trending repositories on GitHub',
  startUrl: 'https://github.com/trending',
})

console.log(result.success, result.reason)
await browser.close()
