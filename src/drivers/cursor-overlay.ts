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

  // ── Gen 34 Hydra View — fan-out grid (live thumbnails of sub-tabs) ─────
  // Full-viewport dim overlay + grid of live sub-tab screenshot cells.
  // Cells lay out based on count: 1→1, 2→1x2, 3-4→2x2, 5-6→2x3, 7-8→2x4.
  // Each cell background updates via updateFanOutCell(i, dataUrl, meta).
  const hydra = document.createElement('div');
  hydra.id = '__bad_overlay_hydra';
  Object.assign(hydra.style, {
    position: 'fixed',
    inset: '0',
    display: 'none',
    background: 'radial-gradient(ellipse at center, rgba(11,18,32,0.80) 0%, rgba(11,18,32,0.95) 100%)',
    backdropFilter: 'blur(6px)',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    gap: '20px',
    transition: 'opacity 400ms ease',
    opacity: '0',
    pointerEvents: 'none',
  });
  const hydraTitle = document.createElement('div');
  Object.assign(hydraTitle.style, {
    fontSize: '11px',
    fontWeight: '700',
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    color: '#7aa2ff',
    textAlign: 'center',
  });
  hydraTitle.textContent = 'Fan-out · investigating branches in parallel';
  const hydraGrid = document.createElement('div');
  hydraGrid.id = '__bad_overlay_hydra_grid';
  Object.assign(hydraGrid.style, {
    display: 'grid',
    gap: '16px',
    maxWidth: '1200px',
    maxHeight: '70vh',
    padding: '0 40px',
  });
  const hydraCounter = document.createElement('div');
  Object.assign(hydraCounter.style, {
    fontSize: '13px',
    color: '#e6ebf5',
    fontWeight: '600',
    textAlign: 'center',
  });
  hydra.appendChild(hydraTitle);
  hydra.appendChild(hydraGrid);
  hydra.appendChild(hydraCounter);

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
    root.appendChild(hydra);
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

    // ── Gen 34 Hydra API ─────────────────────────────────────────────
    /**
     * Begin a fan-out: render the dim overlay + grid of N labeled cells.
     * Cells start in "queued" state (empty). Call updateFanOutCell(i, ...)
     * as sub-agent screenshots stream in.
     *
     * labels: human-readable label per cell, one per sub-agent.
     * originX/originY: optional viewport coord where the fan-out was
     *   initiated — cells burst outward from this point (default: center).
     */
    fanOutStart(labels, originX, originY) {
      try {
        const n = Math.max(1, Math.min(8, labels.length));
        // Layout: 1→1, 2→1x2, 3-4→2x2, 5-6→3x2, 7-8→4x2
        const cols = n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
        const rows = Math.ceil(n / cols);
        hydraGrid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
        hydraGrid.style.gridTemplateRows = 'repeat(' + rows + ', 1fr)';
        // Cell size: scale to fit. For a 1200x600 viewport budget:
        const cellW = Math.floor(1120 / cols) - 10;
        const cellH = Math.floor(Math.min(520 / rows, cellW * 0.7));
        // Clear prior cells
        while (hydraGrid.firstChild) hydraGrid.removeChild(hydraGrid.firstChild);
        const originPx = typeof originX === 'number' && typeof originY === 'number'
          ? { x: originX, y: originY }
          : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        for (let i = 0; i < n; i++) {
          const cell = document.createElement('div');
          cell.className = '__bad_hydra_cell';
          cell.dataset.index = String(i);
          Object.assign(cell.style, {
            position: 'relative',
            width: cellW + 'px',
            height: cellH + 'px',
            background: '#0b1220',
            backgroundSize: 'cover',
            backgroundPosition: 'center top',
            border: '2px solid rgba(122,162,255,0.55)',
            borderRadius: '10px',
            overflow: 'hidden',
            boxShadow: '0 10px 30px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(122,162,255,0.2)',
            opacity: '0',
            transform: 'translate(' + (originPx.x - window.innerWidth / 2) + 'px, ' + (originPx.y - window.innerHeight / 2) + 'px) scale(0.15)',
            transition: 'transform 480ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 300ms ease, border-color 300ms ease, box-shadow 300ms ease',
          });
          // Header strip: label + live elapsed
          const header = document.createElement('div');
          Object.assign(header.style, {
            position: 'absolute',
            top: '0', left: '0', right: '0',
            padding: '6px 10px',
            background: 'linear-gradient(180deg, rgba(11,18,32,0.95) 0%, rgba(11,18,32,0.0) 100%)',
            color: '#e6ebf5',
            fontSize: '11px',
            fontWeight: '700',
            letterSpacing: '0.04em',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          });
          const headerLabel = document.createElement('span');
          headerLabel.textContent = labels[i] || ('branch-' + (i + 1));
          const headerTimer = document.createElement('span');
          headerTimer.className = '__bad_hydra_timer';
          headerTimer.style.cssText = 'font-family:SF Mono,Menlo,monospace;font-size:10px;color:#9aa3b8;font-weight:500;';
          headerTimer.textContent = '0.0s';
          header.appendChild(headerLabel);
          header.appendChild(headerTimer);
          cell.appendChild(header);
          // Verdict chip (hidden until complete)
          const chip = document.createElement('div');
          chip.className = '__bad_hydra_chip';
          Object.assign(chip.style, {
            position: 'absolute',
            bottom: '8px',
            left: '8px',
            padding: '3px 10px',
            background: 'rgba(11,18,32,0.92)',
            color: '#ffffff',
            fontSize: '10px',
            fontWeight: '700',
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            borderRadius: '6px',
            opacity: '0',
            transition: 'opacity 220ms ease',
          });
          cell.appendChild(chip);
          hydraGrid.appendChild(cell);
        }
        hydra.style.display = 'flex';
        hydraCounter.textContent = '0 / ' + n + ' branches complete';
        // Next frame: fade in + animate cells to their grid positions
        requestAnimationFrame(() => {
          hydra.style.opacity = '1';
          const cells = hydraGrid.children;
          for (let i = 0; i < cells.length; i++) {
            const c = cells[i];
            // Staggered burst: 0ms, 60ms, 120ms, ...
            setTimeout(function () {
              c.style.opacity = '1';
              c.style.transform = 'translate(0, 0) scale(1)';
            }, i * 60);
          }
        });
        // Start the elapsed-time ticker
        hydra.__tickerStart = Date.now();
        if (hydra.__ticker) clearInterval(hydra.__ticker);
        hydra.__ticker = setInterval(function () {
          const elapsed = (Date.now() - hydra.__tickerStart) / 1000;
          const cells = hydraGrid.children;
          for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            if (cell.__completedAt) continue;
            const timer = cell.querySelector('.__bad_hydra_timer');
            if (timer) timer.textContent = elapsed.toFixed(1) + 's';
          }
        }, 100);
      } catch { /* cosmetic */ }
    },

    /**
     * Update cell N with a fresh screenshot (data URL) and/or metadata.
     * Call this at 2-5 FPS from the runner's screenshot streamer.
     *   meta: { action?: string, turn?: number }
     */
    fanOutUpdateCell(index, dataUrl, meta) {
      try {
        const cell = hydraGrid.children[index];
        if (!cell) return;
        if (dataUrl) {
          cell.style.backgroundImage = 'url("' + dataUrl + '")';
        }
        // eslint-disable-next-line no-empty
        if (meta) { /* reserved for future overlays inside the cell */ }
      } catch { /* cosmetic */ }
    },

    /**
     * Mark cell N as complete with a verdict. kind is one of
     * 'positive' | 'cleared' | 'review' | 'info'. Final state: border
     * recolors, chip fades in, timer freezes.
     */
    fanOutCompleteCell(index, kind, verdictText) {
      try {
        const cell = hydraGrid.children[index];
        if (!cell) return;
        cell.__completedAt = Date.now();
        const palette = (kind === 'positive' ? { c: '#fb7185', bg: 'rgba(251,113,133,0.25)' }
          : kind === 'cleared' ? { c: '#4ade80', bg: 'rgba(74,222,128,0.25)' }
            : kind === 'review' ? { c: '#fbbf24', bg: 'rgba(251,191,36,0.25)' }
              : { c: '#7aa2ff', bg: 'rgba(122,162,255,0.25)' });
        cell.style.borderColor = palette.c;
        cell.style.boxShadow = '0 10px 30px rgba(0,0,0,0.55), inset 0 0 0 1px ' + palette.c + ', 0 0 24px ' + palette.bg;
        const chip = cell.querySelector('.__bad_hydra_chip');
        if (chip) {
          chip.style.background = palette.bg;
          chip.style.color = palette.c;
          chip.style.border = '1px solid ' + palette.c;
          chip.textContent = (verdictText || kind).slice(0, 32);
          chip.style.opacity = '1';
        }
        // Update global counter
        const total = hydraGrid.children.length;
        let done = 0;
        for (let i = 0; i < total; i++) if (hydraGrid.children[i].__completedAt) done++;
        hydraCounter.textContent = done + ' / ' + total + ' branches complete';
      } catch { /* cosmetic */ }
    },

    /**
     * Collapse the grid: cells fly inward to center, merge into a result
     * tile, then dissolve. Returns after ~800ms when the animation is
     * done (but does NOT hide the overlay — caller invokes fanOutDismiss).
     */
    fanOutCollapse() {
      try {
        if (hydra.__ticker) { clearInterval(hydra.__ticker); hydra.__ticker = null; }
        const cells = hydraGrid.children;
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;
        for (let i = 0; i < cells.length; i++) {
          const c = cells[i];
          const rect = c.getBoundingClientRect();
          const dx = cx - (rect.left + rect.width / 2);
          const dy = cy - (rect.top + rect.height / 2);
          c.style.transition = 'transform 520ms cubic-bezier(0.6, 0, 0.4, 1), opacity 400ms ease';
          c.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) scale(0.2)';
          c.style.opacity = '0';
        }
        hydraTitle.style.transition = 'opacity 400ms ease';
        hydraCounter.style.transition = 'opacity 400ms ease';
        setTimeout(function () { hydraTitle.style.opacity = '0'; hydraCounter.style.opacity = '0'; }, 200);
      } catch { /* cosmetic */ }
    },

    /**
     * Hide the Hydra overlay entirely. Call after fanOutCollapse has
     * finished + the parent agent has resumed.
     */
    fanOutDismiss() {
      try {
        hydra.style.opacity = '0';
        setTimeout(function () {
          hydra.style.display = 'none';
          hydraTitle.style.opacity = '1';
          hydraCounter.style.opacity = '1';
          while (hydraGrid.firstChild) hydraGrid.removeChild(hydraGrid.firstChild);
          if (hydra.__ticker) { clearInterval(hydra.__ticker); hydra.__ticker = null; }
        }, 400);
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

