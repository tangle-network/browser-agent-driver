/**
 * Interactive demo player generator.
 *
 * Takes showcase walkthrough results (screenshots + step metadata) and produces
 * a self-contained HTML file with an interactive step-by-step player.
 *
 * Features:
 * - Click-through slideshow of annotated screenshots
 * - Pulsing hotspot circles at click targets
 * - Step description tooltips
 * - Progress bar and step counter
 * - Keyboard navigation (← →)
 * - Self-contained — single HTML file, images base64-inlined
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ShowcaseStep } from './types.js'

export interface DemoStep {
  /** Screenshot as base64 PNG. */
  imageBase64: string
  /** Width of the screenshot. */
  width: number
  /** Height of the screenshot. */
  height: number
  /** Description shown as tooltip. */
  description?: string
  /** Click hotspot position (percentage of image dimensions). */
  hotspot?: {
    xPercent: number
    yPercent: number
    label?: string
  }
  /** Action that was taken at this step. */
  action: string
}

export interface DemoConfig {
  title: string
  steps: DemoStep[]
  /** Brand color for hotspots and UI. Default: #8e59ff */
  accentColor?: string
  /** Auto-advance interval in ms. 0 = manual only. Default: 0 */
  autoAdvance?: number
}

/**
 * Generate a self-contained HTML demo player.
 */
export function generateDemoHtml(config: DemoConfig): string {
  const accent = config.accentColor ?? '#8e59ff'
  const steps = JSON.stringify(config.steps.map(s => ({
    image: s.imageBase64,
    description: s.description ?? '',
    hotspot: s.hotspot ?? null,
    action: s.action,
  })))

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(config.title)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0a;
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 1rem;
  }

  .demo-container {
    position: relative;
    max-width: 1200px;
    width: 100%;
    border-radius: 12px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,0.1);
    background: #111;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }

  /* Browser chrome */
  .demo-chrome {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    background: #1a1a1a;
    border-bottom: 1px solid rgba(255,255,255,0.06);
  }
  .demo-dot { width: 12px; height: 12px; border-radius: 50%; }
  .demo-dot.r { background: rgba(255,95,87,0.8); }
  .demo-dot.y { background: rgba(254,188,46,0.8); }
  .demo-dot.p { background: ${accent}cc; }
  .demo-title {
    margin-left: 12px;
    font-size: 13px;
    color: rgba(255,255,255,0.4);
    font-family: monospace;
  }

  /* Image viewport */
  .demo-viewport {
    position: relative;
    width: 100%;
    overflow: hidden;
    cursor: pointer;
  }
  .demo-viewport img {
    width: 100%;
    display: block;
    transition: opacity 0.3s ease;
  }

  /* Hotspot */
  .hotspot {
    position: absolute;
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: 10;
  }
  .hotspot-ring {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 2px solid ${accent};
    animation: pulse 2s ease-in-out infinite;
  }
  .hotspot-dot {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: ${accent};
  }
  .hotspot-label {
    position: absolute;
    top: -32px;
    left: 50%;
    transform: translateX(-50%);
    background: ${accent};
    color: white;
    font-size: 12px;
    font-weight: 600;
    padding: 4px 12px;
    border-radius: 6px;
    white-space: nowrap;
    font-family: -apple-system, sans-serif;
  }

  @keyframes pulse {
    0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
    50% { transform: translate(-50%, -50%) scale(1.5); opacity: 0.5; }
  }

  /* Controls */
  .demo-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: #1a1a1a;
    border-top: 1px solid rgba(255,255,255,0.06);
  }

  .demo-step-info {
    font-size: 13px;
    color: rgba(255,255,255,0.5);
  }

  .demo-description {
    font-size: 14px;
    color: rgba(255,255,255,0.8);
    text-align: center;
    flex: 1;
    padding: 0 1rem;
  }

  .demo-nav {
    display: flex;
    gap: 8px;
  }
  .demo-nav button {
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.1);
    color: white;
    padding: 6px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    transition: background 0.2s;
  }
  .demo-nav button:hover {
    background: ${accent}33;
    border-color: ${accent}66;
  }
  .demo-nav button:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  /* Progress bar */
  .demo-progress {
    height: 3px;
    background: rgba(255,255,255,0.06);
    position: relative;
  }
  .demo-progress-fill {
    height: 100%;
    background: ${accent};
    transition: width 0.3s ease;
  }
</style>
</head>
<body>

<div class="demo-container">
  <div class="demo-chrome">
    <div class="demo-dot r"></div>
    <div class="demo-dot y"></div>
    <div class="demo-dot p"></div>
    <span class="demo-title">${escapeHtml(config.title)}</span>
  </div>

  <div class="demo-progress">
    <div class="demo-progress-fill" id="progress"></div>
  </div>

  <div class="demo-viewport" id="viewport" onclick="next()">
    <img id="screenshot" alt="Demo step" />
    <div class="hotspot" id="hotspot" style="display:none;">
      <div class="hotspot-ring"></div>
      <div class="hotspot-dot"></div>
      <div class="hotspot-label" id="hotspot-label"></div>
    </div>
  </div>

  <div class="demo-controls">
    <div class="demo-step-info" id="step-info">Step 1 of N</div>
    <div class="demo-description" id="description"></div>
    <div class="demo-nav">
      <button onclick="prev()" id="prev-btn">&larr; Back</button>
      <button onclick="next()" id="next-btn">Next &rarr;</button>
    </div>
  </div>
</div>

<script>
const steps = ${steps};
let current = 0;

function render() {
  const step = steps[current];
  document.getElementById('screenshot').src = 'data:image/png;base64,' + step.image;
  document.getElementById('step-info').textContent = 'Step ' + (current + 1) + ' of ' + steps.length;
  document.getElementById('description').textContent = step.description || '';
  document.getElementById('progress').style.width = ((current + 1) / steps.length * 100) + '%';
  document.getElementById('prev-btn').disabled = current === 0;
  document.getElementById('next-btn').disabled = current === steps.length - 1;
  document.getElementById('next-btn').textContent = current === steps.length - 1 ? 'Done ✓' : 'Next →';

  const hotspot = document.getElementById('hotspot');
  const label = document.getElementById('hotspot-label');
  if (step.hotspot) {
    hotspot.style.display = 'block';
    hotspot.style.left = step.hotspot.xPercent + '%';
    hotspot.style.top = step.hotspot.yPercent + '%';
    if (step.hotspot.label) {
      label.textContent = step.hotspot.label;
      label.style.display = 'block';
    } else {
      label.style.display = 'none';
    }
  } else {
    hotspot.style.display = 'none';
  }
}

function next() {
  if (current < steps.length - 1) { current++; render(); }
}
function prev() {
  if (current > 0) { current--; render(); }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); next(); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
});

render();
</script>

</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Build DemoSteps from showcase results + original walkthrough steps.
 *
 * Reads screenshot PNGs from disk, converts to base64, and maps
 * step actions to hotspot positions.
 */
export async function buildDemoSteps(
  screenshotDir: string,
  walkthroughSteps: ShowcaseStep[],
  page?: import('playwright').Page,
): Promise<DemoStep[]> {
  const demoSteps: DemoStep[] = []

  const pngFiles = fs.readdirSync(screenshotDir)
    .filter(f => f.endsWith('.png') && !f.includes('full-page'))
    .sort()

  for (let i = 0; i < pngFiles.length; i++) {
    const filePath = path.join(screenshotDir, pngFiles[i])
    const buffer = fs.readFileSync(filePath)
    const base64 = buffer.toString('base64')

    const step = walkthroughSteps[i]
    let hotspot: DemoStep['hotspot'] = undefined

    // If the next step has a click action with a selector, calculate hotspot position
    const nextStep = walkthroughSteps[i + 1]
    if (nextStep?.action === 'click' && nextStep.selector && page) {
      try {
        const el = page.locator(nextStep.selector).first()
        const box = await el.boundingBox()
        const viewport = page.viewportSize()
        if (box && viewport) {
          hotspot = {
            xPercent: ((box.x + box.width / 2) / viewport.width) * 100,
            yPercent: ((box.y + box.height / 2) / viewport.height) * 100,
            label: nextStep.capture?.name ?? `Click ${nextStep.selector}`,
          }
        }
      } catch { /* element not found — skip hotspot */ }
    }

    demoSteps.push({
      imageBase64: base64,
      width: 1200, // Will be overridden by actual image dimensions if available
      height: 800,
      description: step?.capture?.name?.replace(/-/g, ' ').replace(/^\d+-/, '') ?? `Step ${i + 1}`,
      hotspot,
      action: step?.action ?? 'screenshot',
    })
  }

  return demoSteps
}
