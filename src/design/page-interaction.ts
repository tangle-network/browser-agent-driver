/**
 * Page interaction — reveal hidden content before screenshots.
 *
 * Expands accordions, clicks tabs, scrolls carousels, opens menus,
 * dismisses modals. Each function is fault-tolerant.
 */

import type { Page } from 'playwright'
import type { RevealStats } from './types.js'

export async function revealHiddenContent(page: Page, opts?: { mobile?: boolean }): Promise<RevealStats> {
  const stats: RevealStats = { accordions: 0, tabs: 0, carousels: 0, hovers: 0, menus: 0, modals: 0 }

  await dismissModals(page, stats)
  await expandAccordions(page, stats)
  await clickAllTabs(page, stats)
  await scrollCarousels(page, stats)
  if (opts?.mobile) await openMobileMenu(page, stats)

  return stats
}

/**
 * Take screenshots of each interactive state (tabs, accordion panels, carousel slides).
 * Returns arrays of screenshot buffers keyed by interaction type.
 */
export async function captureInteractionScreenshots(
  page: Page,
  opts?: { mobile?: boolean },
): Promise<{
  tabs: Buffer[]
  accordions: Buffer[]
  carousel: Buffer[]
  menu?: Buffer
}> {
  const tabs: Buffer[] = []
  const accordions: Buffer[] = []
  const carousel: Buffer[] = []
  let menu: Buffer | undefined

  // Tabs: click each tab and screenshot the tab panel
  const tabLists = await page.locator('[role="tablist"]').all()
  for (const tabList of tabLists) {
    const tabButtons = await tabList.locator('[role="tab"]').all()
    for (const tab of tabButtons) {
      try {
        await tab.click({ timeout: 2000 })
        await page.waitForTimeout(400)
        // Screenshot the nearest tabpanel
        const panelId = await tab.getAttribute('aria-controls')
        if (panelId) {
          const panel = page.locator(`#${panelId}`)
          if (await panel.isVisible({ timeout: 500 }).catch(() => false)) {
            tabs.push(await panel.screenshot())
          }
        } else {
          tabs.push(await page.screenshot({ fullPage: false }))
        }
      } catch { /* tab not clickable */ }
    }
  }

  // Accordions: expand each and screenshot
  const detailsEls = await page.locator('details:not([open])').all()
  for (const det of detailsEls) {
    try {
      const summary = det.locator('summary').first()
      await summary.click({ timeout: 2000 })
      await page.waitForTimeout(300)
      accordions.push(await det.screenshot())
    } catch { /* not clickable */ }
  }

  // Carousel: click next buttons
  const carouselNextSelectors = [
    'button[aria-label*="next" i]',
    'button[aria-label*="Next" i]',
    '.swiper-button-next',
    '.slick-next',
    '[data-carousel-next]',
  ]
  for (const sel of carouselNextSelectors) {
    const nextBtn = page.locator(sel).first()
    if (await nextBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      for (let i = 0; i < 5; i++) {
        try {
          await nextBtn.click({ timeout: 2000 })
          await page.waitForTimeout(600)
          carousel.push(await page.screenshot({ fullPage: false }))
        } catch { break }
      }
      break
    }
  }

  // Mobile menu
  if (opts?.mobile) {
    const menuSelectors = [
      'button[aria-label*="menu" i]',
      'button[aria-label*="Menu" i]',
      '.hamburger',
      '[data-toggle="navbar"]',
      'nav button[aria-expanded="false"]',
      'header button[aria-expanded="false"]',
    ]
    for (const sel of menuSelectors) {
      const btn = page.locator(sel).first()
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        try {
          await btn.click({ timeout: 2000 })
          await page.waitForTimeout(500)
          menu = await page.screenshot({ fullPage: false })
          // Close it back
          await btn.click({ timeout: 2000 }).catch(() => null)
          await page.waitForTimeout(300)
        } catch { /* menu click failed */ }
        break
      }
    }
  }

  return { tabs, accordions, carousel, menu }
}

// ── Internals ──

async function dismissModals(page: Page, stats: RevealStats): Promise<void> {
  // Cookie banners
  const cookieSelectors = [
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    'button:has-text("Reject all")',
    'button:has-text("Got it")',
    'button:has-text("Agree")',
    'button:has-text("I understand")',
  ]
  for (const sel of cookieSelectors) {
    const btn = page.locator(sel).first()
    if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
      await btn.click({ timeout: 2000 }).catch(() => null)
      await page.waitForTimeout(400)
      stats.modals++
      break
    }
  }

  // Generic modals/dialogs
  const closeSelectors = [
    '[role="dialog"] button[aria-label="Close"]',
    '[role="dialog"] button:has-text("Close")',
    '[role="dialog"] button:has-text("Dismiss")',
    '[role="dialog"] button:has-text("No thanks")',
    '[role="dialog"] button:has-text("Maybe later")',
  ]
  for (const sel of closeSelectors) {
    const btn = page.locator(sel).first()
    if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
      await btn.click({ timeout: 2000 }).catch(() => null)
      await page.waitForTimeout(400)
      stats.modals++
    }
  }
}

async function expandAccordions(page: Page, stats: RevealStats): Promise<void> {
  // HTML5 <details> elements
  const detailsEls = await page.locator('details:not([open])').all()
  for (const det of detailsEls) {
    try {
      const summary = det.locator('summary').first()
      await summary.click({ timeout: 2000 })
      await page.waitForTimeout(300)
      stats.accordions++
    } catch { /* not clickable */ }
  }

  // ARIA accordions
  const ariaAccordions = await page.locator('[aria-expanded="false"]').all()
  for (const el of ariaAccordions) {
    // Only click elements that look like accordion triggers
    const role = await el.getAttribute('role')
    const tag = await el.evaluate(e => e.tagName.toLowerCase())
    if (role === 'tab') continue // handled by clickAllTabs
    if (tag === 'button' || role === 'button') {
      try {
        await el.click({ timeout: 2000 })
        await page.waitForTimeout(300)
        stats.accordions++
      } catch { /* not clickable */ }
    }
  }
}

async function clickAllTabs(page: Page, stats: RevealStats): Promise<void> {
  const tabLists = await page.locator('[role="tablist"]').all()
  for (const tabList of tabLists) {
    const tabs = await tabList.locator('[role="tab"]').all()
    for (const tab of tabs) {
      const selected = await tab.getAttribute('aria-selected')
      if (selected === 'true') continue
      try {
        await tab.click({ timeout: 2000 })
        await page.waitForTimeout(400)
        stats.tabs++
      } catch { /* not clickable */ }
    }
  }
}

async function scrollCarousels(page: Page, stats: RevealStats): Promise<void> {
  const nextSelectors = [
    'button[aria-label*="next" i]',
    'button[aria-label*="Next" i]',
    '.swiper-button-next',
    '.slick-next',
    '[data-carousel-next]',
  ]

  for (const sel of nextSelectors) {
    const btns = await page.locator(sel).all()
    for (const btn of btns) {
      if (!await btn.isVisible({ timeout: 300 }).catch(() => false)) continue
      for (let i = 0; i < 8; i++) {
        try {
          await btn.click({ timeout: 2000 })
          await page.waitForTimeout(500)
          stats.carousels++
        } catch { break }
      }
    }
  }
}

async function openMobileMenu(page: Page, stats: RevealStats): Promise<void> {
  const menuSelectors = [
    'button[aria-label*="menu" i]',
    'button[aria-label*="Menu" i]',
    '.hamburger',
    '[data-toggle="navbar"]',
    'nav button[aria-expanded="false"]',
    'header button[aria-expanded="false"]',
  ]

  for (const sel of menuSelectors) {
    const btn = page.locator(sel).first()
    if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
      try {
        await btn.click({ timeout: 2000 })
        await page.waitForTimeout(500)
        stats.menus++
      } catch { /* click failed */ }
      break
    }
  }
}
