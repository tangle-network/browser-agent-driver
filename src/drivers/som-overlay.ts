/**
 * Set-of-Marks (SoM) overlay — inject numbered labels on interactive elements
 * before taking a screenshot. The LLM sees labeled elements and outputs
 * "click [N]" instead of guessing pixel coordinates.
 *
 * The overlay is injected, screenshot taken, then removed; it never persists
 * in the page.
 *
 * Returns a mapping of label number → element bounding box center so the
 * runner can translate "click [3]" → mouse.click(x, y).
 */

export interface SomElement {
  label: number
  x: number
  y: number
  width: number
  height: number
  cx: number
  cy: number
  tag: string
  text: string
  role: string
}

/**
 * JavaScript to inject into the page that:
 * 1. Finds all interactive elements
 * 2. Draws numbered badges on them
 * 3. Returns the element map
 *
 * Must be run via page.evaluate() and returns SomElement[].
 */
export const SOM_INJECT_SCRIPT = `
(() => {
  const INTERACTIVE = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="searchbox"], [role="combobox"], [role="textbox"], [tabindex]';

  // Find visible interactive elements
  const elements = Array.from(document.querySelectorAll(INTERACTIVE))
    .filter(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
      if (rect.right < 0 || rect.left > window.innerWidth) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      return true;
    })
    .slice(0, 50); // Cap at 50 to avoid overwhelming the screenshot

  // Create overlay container
  const container = document.createElement('div');
  container.id = '__bad_som_overlay';
  container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483646';
  document.body.appendChild(container);

  const result = [];

  elements.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    const label = i + 1;

    // Badge
    const badge = document.createElement('div');
    badge.style.cssText = [
      'position:fixed',
      'background:#e11d48',
      'color:#fff',
      'font:bold 11px/16px system-ui',
      'padding:0 4px',
      'border-radius:3px',
      'z-index:2147483647',
      'pointer-events:none',
      'min-width:16px',
      'text-align:center',
      'box-shadow:0 1px 3px rgba(0,0,0,0.3)',
    ].join(';');
    badge.style.left = Math.max(0, rect.left - 2) + 'px';
    badge.style.top = Math.max(0, rect.top - 18) + 'px';
    badge.textContent = String(label);
    container.appendChild(badge);

    // Light border around element
    const highlight = document.createElement('div');
    highlight.style.cssText = [
      'position:fixed',
      'border:1.5px solid #e11d4880',
      'border-radius:2px',
      'pointer-events:none',
      'z-index:2147483646',
    ].join(';');
    highlight.style.left = rect.left + 'px';
    highlight.style.top = rect.top + 'px';
    highlight.style.width = rect.width + 'px';
    highlight.style.height = rect.height + 'px';
    container.appendChild(highlight);

    result.push({
      label,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      cx: Math.round(rect.left + rect.width / 2),
      cy: Math.round(rect.top + rect.height / 2),
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 40),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
    });
  });

  return result;
})()
`

/** Remove the SoM overlay after screenshotting */
export const SOM_REMOVE_SCRIPT = `
(() => {
  const el = document.getElementById('__bad_som_overlay');
  if (el) el.remove();
})()
`
