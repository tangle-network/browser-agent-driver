/**
 * Cursor + element highlight overlay.
 *
 * Injected into every page so screenshots and screencasts show what bad is
 * doing — an animated cursor sprite that travels to click targets, a pulse
 * ring on click, and a highlight box around the target element.
 *
 * The overlay is a thin DOM widget added via `page.addInitScript`. It exposes
 * a global `__bad_overlay` object that the driver invokes from
 * `page.evaluate` calls before each action. Everything happens in the page
 * context — the cursor is real DOM, so it shows up in screenshots without
 * any extra plumbing.
 *
 * Toggle via `PlaywrightDriverOptions.showCursor`.
 */

/**
 * The init script that runs in every page. Returned as a string so it can be
 * passed to `page.addInitScript`. Pure DOM/CSS — no dependencies.
 */
export const CURSOR_OVERLAY_INIT_SCRIPT = `
(() => {
  if (window.__bad_overlay_installed) return;
  window.__bad_overlay_installed = true;

  const NS = 'http://www.w3.org/2000/svg';
  const Z = 2147483647; // max i32

  // ── Root container (absolute, ignores pointer events) ──────────────────
  const root = document.createElement('div');
  root.id = '__bad_overlay_root';
  Object.assign(root.style, {
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    pointerEvents: 'none',
    zIndex: String(Z),
  });

  // ── Cursor sprite (SVG arrow) ──────────────────────────────────────────
  const cursor = document.createElementNS(NS, 'svg');
  cursor.setAttribute('width', '24');
  cursor.setAttribute('height', '24');
  cursor.setAttribute('viewBox', '0 0 24 24');
  cursor.setAttribute('fill', 'none');
  Object.assign(cursor.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    transform: 'translate(-100px, -100px)',
    transition: 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
    pointerEvents: 'none',
    filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.4))',
  });
  cursor.innerHTML = \`
    <path d="M3 2 L21 12 L13 14 L9 22 Z" fill="#ffffff" stroke="#0b1220" stroke-width="1.5" stroke-linejoin="round"/>
  \`;

  // ── Pulse ring (animated on click) ─────────────────────────────────────
  const ring = document.createElement('div');
  Object.assign(ring.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '0',
    height: '0',
    borderRadius: '9999px',
    border: '3px solid rgba(79, 70, 229, 0.95)',
    transform: 'translate(-100px, -100px)',
    pointerEvents: 'none',
    opacity: '0',
    transition: 'all 500ms ease-out',
  });

  // ── Highlight box (drawn around the target element) ────────────────────
  const box = document.createElement('div');
  box.id = '__bad_overlay_box';
  Object.assign(box.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '0',
    height: '0',
    border: '2px solid rgba(34, 197, 94, 0.95)',
    borderRadius: '6px',
    background: 'rgba(34, 197, 94, 0.08)',
    boxShadow: '0 0 0 4px rgba(34, 197, 94, 0.18)',
    transform: 'translate(-100px, -100px)',
    pointerEvents: 'none',
    transition: 'all 180ms ease-out',
    opacity: '0',
  });

  // ── Action label (shows "click" / "type" / etc next to cursor) ─────────
  const label = document.createElement('div');
  Object.assign(label.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    padding: '4px 10px',
    background: 'rgba(11, 18, 32, 0.92)',
    color: '#ffffff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: '12px',
    fontWeight: '600',
    borderRadius: '6px',
    transform: 'translate(-200px, -200px)',
    pointerEvents: 'none',
    opacity: '0',
    transition: 'all 220ms cubic-bezier(0.22, 1, 0.36, 1)',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    whiteSpace: 'nowrap',
  });

  // Append to documentElement (not body) so the overlay is not affected by
  // body's stacking context — many modern sites apply transform/will-change
  // to body which would clip a max-z-index child appended to body.
  // Bound the retry loop so a body-less doc (XML, PDF viewer, chrome://)
  // doesn't spin requestAnimationFrame forever.
  let attachAttempts = 0;
  function attach() {
    const host = document.documentElement || document.body;
    if (!host) {
      if (++attachAttempts > 60) return; // ~1 second of attempts
      requestAnimationFrame(attach);
      return;
    }
    host.appendChild(root);
    root.appendChild(box);
    root.appendChild(ring);
    root.appendChild(cursor);
    root.appendChild(label);
  }
  attach();

  // ── Public API ─────────────────────────────────────────────────────────
  window.__bad_overlay = {
    /**
     * Highlight a target element by CSS selector. Returns the rect or null.
     * Used when the caller has a stable CSS selector.
     */
    highlight(selector) {
      try {
        const el = typeof selector === 'string'
          ? document.querySelector(selector)
          : null;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        Object.assign(box.style, {
          width: rect.width + 'px',
          height: rect.height + 'px',
          transform: \`translate(\${rect.left}px, \${rect.top}px)\`,
          opacity: '1',
        });
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
      } catch { return null; }
    },

    /**
     * Highlight an arbitrary rect at given page coordinates. Used when the
     * caller already computed the rect via Playwright's boundingBox (i.e.,
     * the @ref selector isn't a real CSS selector).
     */
    highlightRect(x, y, width, height) {
      try {
        Object.assign(box.style, {
          width: width + 'px',
          height: height + 'px',
          transform: \`translate(\${x}px, \${y}px)\`,
          opacity: '1',
        });
      } catch { /* never let cosmetic overlay break a run */ }
    },

    /**
     * Move the cursor to (x, y) and show a label.
     */
    moveTo(x, y, labelText) {
      cursor.style.transform = \`translate(\${x - 4}px, \${y - 4}px)\`;
      if (labelText) {
        label.textContent = labelText;
        Object.assign(label.style, {
          transform: \`translate(\${x + 16}px, \${y + 16}px)\`,
          opacity: '1',
        });
      }
    },

    /**
     * Pulse a click ring at (x, y).
     */
    pulseClick(x, y) {
      // reset
      Object.assign(ring.style, {
        width: '0',
        height: '0',
        transform: \`translate(\${x}px, \${y}px)\`,
        opacity: '1',
      });
      // expand
      requestAnimationFrame(() => {
        Object.assign(ring.style, {
          width: '60px',
          height: '60px',
          transform: \`translate(\${x - 30}px, \${y - 30}px)\`,
          opacity: '0',
        });
      });
    },

    /**
     * Hide all overlay elements.
     */
    hide() {
      box.style.opacity = '0';
      label.style.opacity = '0';
      ring.style.opacity = '0';
    },

    /**
     * Hide just the highlight box (cursor + label stay).
     */
    clearHighlight() {
      box.style.opacity = '0';
    },
  };
})();
`

/**
 * Wait time after `moveTo` so the cursor animation finishes before the
 * actual action fires. Tuned to match the CSS transition duration.
 */
export const CURSOR_ANIMATION_MS = 240
