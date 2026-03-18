/**
 * CLI handler for `bad showcase` — deterministic walkthrough capture.
 *
 * Executes a pre-scripted walkthrough and captures polished screenshots,
 * GIFs, and videos as marketing-ready assets. No LLM calls.
 *
 * Usage:
 *   bad showcase --url https://app.com --script walkthrough.json
 *   bad showcase --url https://app.com --capture hero,scroll:500,footer
 *   bad showcase --url https://app.com --capture hero --crop ".hero-section"
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { runShowcase, quickCapture } from './showcase/index.js'
import type { ShowcaseConfig } from './showcase/types.js'
import { cliError } from './cli-ui.js'

export interface ShowcaseCliArgs {
  url?: string
  script?: string
  capture?: string
  crop?: string
  highlight?: string
  format?: string
  viewport?: string
  output?: string
  headless: boolean
  colorScheme?: 'dark' | 'light'
  scale?: number
  storageState?: string
  quality?: number
}

export async function handleShowcase(args: ShowcaseCliArgs): Promise<void> {
  if (!args.url && !args.script) {
    cliError('Either --url or --script is required')
    process.exit(1)
  }

  const formats = (args.format?.split(',') ?? ['png']) as Array<'png' | 'webp' | 'gif' | 'webm' | 'demo'>
  const viewport = parseViewport(args.viewport)
  const outputDir = args.output ?? './showcase'

  // Script mode
  if (args.script) {
    const scriptPath = path.resolve(args.script)
    if (!fs.existsSync(scriptPath)) {
      cliError(`Script file not found: ${scriptPath}`)
      process.exit(1)
    }

    let config: ShowcaseConfig
    try {
      config = JSON.parse(fs.readFileSync(scriptPath, 'utf-8'))
    } catch (e) {
      cliError(`Failed to parse script: ${(e as Error).message}`)
      process.exit(1)
    }

    if (args.url) config.url = args.url
    if (viewport) config.viewport = viewport
    config.output = {
      ...config.output,
      dir: outputDir,
      formats,
      quality: args.quality ?? config.output?.quality,
      scale: args.scale ?? config.output?.scale,
    }
    config.headless = args.headless
    if (args.colorScheme) config.colorScheme = args.colorScheme
    if (args.storageState) config.storageState = args.storageState

    if (!config.steps?.length) {
      cliError('Script must have at least one step')
      process.exit(1)
    }
    if (!config.name) config.name = path.basename(scriptPath, path.extname(scriptPath))

    console.log(`\n  Showcase: ${config.name}`)
    console.log(`  URL: ${config.url}`)
    console.log(`  Steps: ${config.steps.length}`)
    console.log(`  Output: ${outputDir}\n`)

    const result = await runShowcase(config)
    printResult(result)
    return
  }

  // Quick capture mode
  if (args.url && args.capture) {
    const captures = args.capture.split(',').map((c) => c.trim())

    console.log(`\n  Quick Capture`)
    console.log(`  URL: ${args.url}`)
    console.log(`  Captures: ${captures.join(', ')}`)
    console.log(`  Output: ${outputDir}\n`)

    const result = await quickCapture({
      url: args.url,
      captures,
      cropSelector: args.crop,
      highlightSelector: args.highlight,
      viewport,
      output: { dir: outputDir, formats, quality: args.quality, scale: args.scale },
      headless: args.headless,
      storageState: args.storageState,
      colorScheme: args.colorScheme,
    })
    printResult(result)
    return
  }

  // URL only — default to hero + full capture
  if (args.url) {
    console.log(`\n  Quick Capture (default: hero + full)`)
    console.log(`  URL: ${args.url}\n`)

    const result = await quickCapture({
      url: args.url,
      captures: ['hero', 'full'],
      cropSelector: args.crop,
      viewport,
      output: { dir: outputDir, formats, quality: args.quality, scale: args.scale },
      headless: args.headless,
      storageState: args.storageState,
      colorScheme: args.colorScheme,
    })
    printResult(result)
  }
}

function printResult(result: import('./showcase/types.js').ShowcaseResult): void {
  console.log(`  ✓ ${result.frames.length} screenshots captured`)
  for (const f of result.frames) {
    console.log(`    ${f.name}.png (${f.width}×${f.height})`)
  }
  if (result.demo) console.log(`  ✓ Demo: ${result.demo}`)
  if (result.gif) console.log(`  ✓ GIF: ${result.gif}`)
  if (result.video) console.log(`  ✓ Video: ${result.video}`)
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`)
  console.log(`  Output: ${result.outputDir}/\n`)
}

function parseViewport(vp?: string): { width: number; height: number } | undefined {
  if (!vp) return undefined
  const match = vp.match(/^(\d+)x(\d+)$/)
  if (!match) {
    cliError(`Invalid viewport format: ${vp}. Expected WxH (e.g., 1440x900)`)
    process.exit(1)
  }
  return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) }
}
