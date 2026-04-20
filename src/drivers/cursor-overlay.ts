/**
 * Agent overlay — cursor + reasoning + verdict badges + progress bar.
 *
 * Injected into every page so recordings and screenshots show the agent
 * narrating its own work. Five concerns, one DOM widget:
 *
 *   1. Cursor arrow that animates to click targets
 *   2. Highlight box around the target element
 *   3. Single-line action label next to cursor ("click · Search")
 *   4. Reasoning panel (translucent, top-right) with the agent's own
 *      words for the current turn — "Clicking Search to submit C-003"
 *   5. Verdict badges (stacked, bottom-left) that fade in when a
 *      conclusion is reached — "✓ C-003 PUTIN → POSITIVE MATCH"
 *   6. Progress timeline bar (top edge) — thin strip with a dot per
 *      completed action and a highlighted current position
 *
 * All primitives are DOM. They show up in screenshots, video frames, and
 * the replayer without extra plumbing. The overlay exposes a single
 * `window.__bad_overlay` API so the driver can drive everything in one
 * `page.evaluate` round-trip per turn.
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
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  });

  // ── Keyframes ──────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = \`
    @keyframes __bad_cursor_bob {
      0%, 100% { margin-top: 0px; }
      50% { margin-top: -3px; }
    }
    @keyframes __bad_badge_in {
      from { transform: translateX(-20px); opacity: 0; }
      to   { transform: translateX(0); opacity: 1; }
    }
    @keyframes __bad_badge_out {
      from { transform: translateX(0); opacity: 1; }
      to   { transform: translateX(20px); opacity: 0; }
    }
  \`;
  (document.head || document.documentElement).appendChild(style);

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
    transition: 'transform 400ms cubic-bezier(0.34, 1.56, 0.64, 1)',
    pointerEvents: 'none',
    filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))',
    animation: '__bad_cursor_bob 1.8s ease-in-out infinite',
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
    transition: 'all 350ms cubic-bezier(0.34, 1.56, 0.64, 1)',
    opacity: '0',
  });

  // ── Action label (shows "click" / "type" / etc next to cursor) ─────────
  const label = document.createElement('div');
  Object.assign(label.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    padding: '5px 12px',
    background: 'rgba(11, 18, 32, 0.95)',
    color: '#ffffff',
    fontSize: '13px',
    fontWeight: '600',
    letterSpacing: '0.01em',
    borderRadius: '8px',
    transform: 'translate(-200px, -200px)',
    pointerEvents: 'none',
    opacity: '0',
    transition: 'transform 400ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 200ms ease',
    boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
    whiteSpace: 'nowrap',
  });

  // ── Progress timeline bar (top edge, thin strip) ───────────────────────
  const progress = document.createElement('div');
  progress.id = '__bad_overlay_progress';
  Object.assign(progress.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    right: '0',
    height: '3px',
    background: 'rgba(11, 18, 32, 0.6)',
    pointerEvents: 'none',
    opacity: '0',
    transition: 'opacity 300ms ease',
  });
  const progressFill = document.createElement('div');
  Object.assign(progressFill.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    height: '100%',
    width: '0%',
    background: 'linear-gradient(90deg, #4f46e5 0%, #7aa2ff 100%)',
    transition: 'width 500ms cubic-bezier(0.4, 0, 0.2, 1)',
    boxShadow: '0 0 8px rgba(79, 70, 229, 0.6)',
  });
  progress.appendChild(progressFill);

  // ── Progress label (turn counter, top-left) ────────────────────────────
  const progressLabel = document.createElement('div');
  Object.assign(progressLabel.style, {
    position: 'fixed',
    top: '10px',
    left: '14px',
    padding: '4px 10px',
    background: 'rgba(11, 18, 32, 0.88)',
    color: '#ffffff',
    fontSize: '11px',
    fontWeight: '700',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    borderRadius: '6px',
    pointerEvents: 'none',
    opacity: '0',
    transition: 'opacity 300ms ease',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
  });

  // ── Reasoning panel (top-right, translucent; agent's own words) ────────
  const reasoning = document.createElement('div');
  reasoning.id = '__bad_overlay_reasoning';
  Object.assign(reasoning.style, {
    position: 'fixed',
    top: '40px',
    right: '14px',
    maxWidth: '360px',
    minWidth: '220px',
    padding: '12px 14px',
    background: 'rgba(11, 18, 32, 0.92)',
    color: '#e6ebf5',
    fontSize: '12px',
    lineHeight: '1.5',
    borderRadius: '10px',
    borderLeft: '3px solid #7aa2ff',
    pointerEvents: 'none',
    opacity: '0',
    transform: 'translateY(-6px)',
    transition: 'opacity 250ms ease, transform 250ms ease',
    boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
    backdropFilter: 'blur(4px)',
  });
  const reasoningHeader = document.createElement('div');
  Object.assign(reasoningHeader.style, {
    fontSize: '10px',
    fontWeight: '700',
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: '#7aa2ff',
    marginBottom: '6px',
  });
  reasoningHeader.textContent = 'Agent reasoning';
  const reasoningBody = document.createElement('div');
  Object.assign(reasoningBody.style, { whiteSpace: 'pre-wrap' });
  reasoning.appendChild(reasoningHeader);
  reasoning.appendChild(reasoningBody);

  // ── Verdict badges (bottom-left, stacked) ──────────────────────────────
  const badges = document.createElement('div');
  badges.id = '__bad_overlay_badges';
  Object.assign(badges.style, {
    position: 'fixed',
    bottom: '14px',
    left: '14px',
    display: 'flex',
    flexDirection: 'column-reverse',
    gap: '6px',
    pointerEvents: 'none',
    maxHeight: '60vh',
    overflow: 'hidden',
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
    root.appendChild(progress);
    root.appendChild(progressLabel);
    root.appendChild(reasoning);
    root.appendChild(badges);
    root.appendChild(box);
    root.appendChild(ring);
    root.appendChild(cursor);
    root.appendChild(label);
  }
  attach();

  // ── Badge factory ─────────────────────────────────────────────────────
  const BADGE_COLORS = {
    positive: { fg: '#fb7185', bg: 'rgba(251,113,133,0.15)', border: 'rgba(251,113,133,0.5)' },
    cleared:  { fg: '#4ade80', bg: 'rgba(74,222,128,0.15)',  border: 'rgba(74,222,128,0.5)'  },
    review:   { fg: '#fbbf24', bg: 'rgba(251,191,36,0.15)',  border: 'rgba(251,191,36,0.5)'  },
    info:     { fg: '#7aa2ff', bg: 'rgba(122,162,255,0.15)', border: 'rgba(122,162,255,0.5)' },
  };
  const MAX_BADGES = 6;

  function makeBadge(kind, text) {
    const palette = BADGE_COLORS[kind] || BADGE_COLORS.info;
    const el = document.createElement('div');
    Object.assign(el.style, {
      padding: '8px 14px',
      background: 'rgba(11, 18, 32, 0.92)',
      color: palette.fg,
      fontSize: '12px',
      fontWeight: '700',
      letterSpacing: '0.02em',
      borderRadius: '8px',
      border: '1px solid ' + palette.border,
      boxShadow: '0 4px 16px rgba(0,0,0,0.35), inset 0 0 0 9999px ' + palette.bg,
      animation: '__bad_badge_in 300ms cubic-bezier(0.34, 1.56, 0.64, 1) both',
      whiteSpace: 'nowrap',
      maxWidth: '480px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    });
    el.textContent = text;
    return el;
  }

  // ── Public API ─────────────────────────────────────────────────────────
  window.__bad_overlay = {
    /**
     * Highlight a target element by CSS selector. Returns the rect or null.
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

    pulseClick(x, y) {
      Object.assign(ring.style, {
        width: '0',
        height: '0',
        transform: \`translate(\${x}px, \${y}px)\`,
        opacity: '1',
      });
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
     * Show the agent's reasoning for the current turn. Multi-line text,
     * word-wrapped, in the top-right panel. Pass empty string or null to
     * hide the panel.
     */
    setReasoning(text) {
      try {
        const t = (text || '').trim();
        if (!t) {
          Object.assign(reasoning.style, { opacity: '0', transform: 'translateY(-6px)' });
          return;
        }
        reasoningBody.textContent = t;
        Object.assign(reasoning.style, { opacity: '1', transform: 'translateY(0)' });
      } catch { /* cosmetic */ }
    },

    /**
     * Update the progress strip: "current" of "total" actions done.
     * progressText is optional (e.g., "Turn 27 · C-003").
     */
    setProgress(current, total, progressText) {
      try {
        const c = Math.max(0, Number(current) || 0);
        const tot = Math.max(1, Number(total) || 1);
        const pct = Math.min(100, (c / tot) * 100);
        progressFill.style.width = pct + '%';
        progress.style.opacity = '1';
        if (progressText) {
          progressLabel.textContent = progressText;
          progressLabel.style.opacity = '1';
        }
      } catch { /* cosmetic */ }
    },

    /**
     * Push a verdict badge onto the bottom-left stack. Auto-trims to the
     * most recent MAX_BADGES. kind is one of "positive" | "cleared" |
     * "review" | "info".
     */
    pushBadge(kind, text) {
      try {
        const el = makeBadge(kind, text);
        badges.appendChild(el);
        // Trim oldest if over cap (column-reverse means first child = bottom)
        while (badges.children.length > MAX_BADGES) {
          const first = badges.firstChild;
          if (!first) break;
          badges.removeChild(first);
        }
      } catch { /* cosmetic */ }
    },

    clearBadges() {
      try {
        while (badges.firstChild) badges.removeChild(badges.firstChild);
      } catch { /* cosmetic */ }
    },

    hide() {
      box.style.opacity = '0';
      label.style.opacity = '0';
      ring.style.opacity = '0';
    },

    clearHighlight() {
      box.style.opacity = '0';
    },
  };
})();
`

