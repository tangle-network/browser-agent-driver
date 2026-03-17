/**
 * Screenshot annotation — highlight boxes, step numbers, cropping.
 *
 * Uses pngjs for pixel manipulation. No external image editing deps.
 * All operations are pure buffer-in → buffer-out.
 */

import type { Page } from 'playwright'

// ── Highlight ──

/**
 * Draw a colored rectangle overlay on a screenshot by injecting CSS into the page,
 * then re-capturing. This avoids pixel-level drawing and handles any selector.
 */
export async function captureWithHighlight(
  page: Page,
  opts: {
    selector: string
    color?: string
    label?: string
    fullPage?: boolean
    quality?: number
  },
): Promise<Buffer> {
  const color = opts.color ?? 'rgba(142, 89, 255, 0.35)'
  const borderColor = opts.color?.replace(/[\d.]+\)$/, '0.8)') ?? 'rgba(142, 89, 255, 0.8)'

  // Inject highlight overlay via CSS + pseudo-element
  const highlightId = `__showcase_highlight_${Date.now()}`
  await page.evaluate(
    ({ selector, color, borderColor, label, id }) => {
      const el = document.querySelector(selector) as HTMLElement | null
      if (!el) return

      // Create overlay
      const overlay = document.createElement('div')
      overlay.id = id
      overlay.style.cssText = `
        position: absolute;
        pointer-events: none;
        z-index: 99999;
        background: ${color};
        border: 2px solid ${borderColor};
        border-radius: 8px;
        transition: none;
      `
      const rect = el.getBoundingClientRect()
      overlay.style.top = `${rect.top + window.scrollY - 4}px`
      overlay.style.left = `${rect.left + window.scrollX - 4}px`
      overlay.style.width = `${rect.width + 8}px`
      overlay.style.height = `${rect.height + 8}px`

      if (label) {
        const labelEl = document.createElement('div')
        labelEl.textContent = label
        labelEl.style.cssText = `
          position: absolute;
          top: -28px;
          left: 0;
          background: ${borderColor};
          color: white;
          font-family: -apple-system, sans-serif;
          font-size: 12px;
          font-weight: 600;
          padding: 3px 10px;
          border-radius: 4px;
          white-space: nowrap;
        `
        overlay.appendChild(labelEl)
      }

      document.body.appendChild(overlay)
    },
    { selector: opts.selector, color, borderColor, label: opts.label ?? null, id: highlightId },
  )

  // Capture
  const buffer = await page.screenshot({
    type: 'png',
    fullPage: opts.fullPage ?? false,
  })

  // Clean up overlay
  await page.evaluate((id) => document.getElementById(id)?.remove(), highlightId)

  return buffer
}

// ── Crop ──

/**
 * Capture a screenshot cropped to a specific element's bounding box.
 * Uses Playwright's element screenshot which handles scrolling automatically.
 */
export async function captureWithCrop(
  page: Page,
  opts: {
    selector: string
    padding?: number
    quality?: number
  },
): Promise<Buffer | null> {
  const el = page.locator(opts.selector).first()
  const visible = await el.isVisible({ timeout: 2000 }).catch(() => false)
  if (!visible) return null

  if (opts.padding && opts.padding > 0) {
    // Use bounding box + padding for a padded crop
    const box = await el.boundingBox()
    if (!box) return null

    return page.screenshot({
      type: 'png',
      clip: {
        x: Math.max(0, box.x - opts.padding),
        y: Math.max(0, box.y - opts.padding),
        width: box.width + opts.padding * 2,
        height: box.height + opts.padding * 2,
      },
    })
  }

  // No padding — use element screenshot directly
  return el.screenshot({ type: 'png' })
}
