/**
 * Shared accessibility tree snapshot helper.
 *
 * Uses Playwright's `locator.ariaSnapshot()` to produce a YAML-like tree,
 * assigns STABLE ref IDs to interactive elements (deterministic hash of
 * role+name), and resolves @ref selectors back to Playwright locators via
 * getByRole().
 *
 * Stable refs mean the same element (e.g. button "Send") gets the SAME ref ID
 * across observations. Only elements that truly disappear produce invalid refs.
 * Duplicates (multiple elements with same role+name) get index suffixes.
 *
 * Used by PlaywrightDriver.
 */

import type { Page, Locator } from 'playwright';

interface RefEntry {
  role: string;
  name: string;
}

/** Parsed element with value for diffing */
export interface ParsedElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
}

/** Structured diff between two snapshots */
export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchangedCount: number;
}

function diffSnapshots(
  prev: Map<string, ParsedElement>,
  curr: Map<string, ParsedElement>,
): SnapshotDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [ref, el] of curr) {
    const prevEl = prev.get(ref);
    if (!prevEl) {
      added.push(`+ ${el.role} "${el.name}" [ref=${ref}]`);
    } else if (prevEl.value !== el.value) {
      changed.push(`~ ${el.role} "${el.name}" [ref=${ref}] value: "${prevEl.value ?? ''}" → "${el.value ?? ''}"`);
    }
  }
  for (const [ref, el] of prev) {
    if (!curr.has(ref)) {
      removed.push(`- ${el.role} "${el.name}" [ref=${ref}]`);
    }
  }

  return { added, removed, changed, unchangedCount: curr.size - added.length - changed.length };
}

/** Format a SnapshotDiff as compact text for brain injection */
function formatDiff(diff: SnapshotDiff): string {
  const lines: string[] = [];
  if (diff.added.length) lines.push('ADDED:', ...diff.added);
  if (diff.removed.length) lines.push('REMOVED:', ...diff.removed);
  if (diff.changed.length) lines.push('CHANGED:', ...diff.changed);
  lines.push(`(${diff.unchangedCount} elements unchanged)`);
  return lines.join('\n');
}

export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio',
  'combobox', 'listbox', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'searchbox', 'slider',
  'spinbutton', 'switch', 'tab', 'treeitem',
]);

/**
 * Generate a short deterministic hash from role+name.
 * Produces a 3-4 char hex string (e.g. "b3f", "1a2c").
 */
export function stableHash(role: string, name: string): string {
  const str = `${role}:${name}`;
  let h = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  // Take lower 14 bits -> 0-16383 -> 1-4 hex chars, prefix with role initial
  const hex = ((h >>> 0) & 0x3fff).toString(16);
  return `${role[0]}${hex}`;
}

export class AriaSnapshotHelper {
  private refMap = new Map<string, RefEntry>();
  /** Track how many times each base hash has been seen (for duplicate disambiguation) */
  private hashCounts = new Map<string, number>();

  /** Previous snapshot's parsed elements for diffing */
  private prevElements = new Map<string, ParsedElement>();
  /** Current snapshot's parsed elements (populated during parseAriaSnapshot) */
  private currElements = new Map<string, ParsedElement>();
  /** Last computed diff (undefined on first observe) */
  private lastDiff: SnapshotDiff | undefined;

  /** Clear refs -- call at the start of each observe() cycle */
  reset(): void {
    this.refMap.clear();
    this.hashCounts.clear();
  }

  /**
   * Import refs and elements from an external source (e.g., CDP snapshot).
   *
   * Populates the internal refMap and currElements so that resolveLocator()
   * and getDiff() work identically to the Playwright ariaSnapshot path.
   */
  importCdpRefs(
    refMap: Map<string, { role: string; name: string }>,
    elements: Map<string, ParsedElement>,
  ): void {
    // Save previous elements for diffing
    this.prevElements = this.currElements;
    this.currElements = new Map(elements);

    // Import refs into our refMap
    for (const [refId, entry] of refMap) {
      this.refMap.set(refId, { role: entry.role, name: entry.name });
    }

    // Compute diff
    if (this.prevElements.size > 0) {
      this.lastDiff = diffSnapshots(this.prevElements, this.currElements);
    } else {
      this.lastDiff = undefined;
    }
  }

  /**
   * Build an accessibility tree snapshot with stable ref IDs.
   *
   * Calls `page.locator('body').ariaSnapshot()` and parses the YAML output,
   * assigning deterministic `[ref=XX]` to interactive/named elements.
   */
  async buildSnapshot(page: Page): Promise<string> {
    const rawSnapshot = await page.locator('body').ariaSnapshot({ timeout: 10_000 })
      .catch(() => '');

    if (!rawSnapshot.trim()) return '(empty page)';

    // Save previous elements before parsing new snapshot
    this.prevElements = this.currElements;
    this.currElements = new Map();

    let snapshot = this.parseAriaSnapshot(rawSnapshot);

    // Compute diff after parsing (currElements is now populated)
    if (this.prevElements.size > 0) {
      this.lastDiff = diffSnapshots(this.prevElements, this.currElements);
    } else {
      this.lastDiff = undefined;
    }

    // Augment with data-testid elements -- helps LLMs identify elements
    // that have no accessible name (e.g., icon-only buttons)
    const testIds = await page.evaluate(() => {
      const INTERACTIVE = new Set(['button', 'input', 'textarea', 'select', 'a']);
      const elements = document.querySelectorAll('[data-testid]');
      return Array.from(elements)
        .filter(el => INTERACTIVE.has(el.tagName.toLowerCase()) || el.getAttribute('role'))
        .slice(0, 30) // Limit to avoid token bloat
        .map(el => ({
          testId: el.getAttribute('data-testid') || '',
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 40),
          disabled: (el as HTMLButtonElement).disabled || false,
        }));
    }).catch(() => [] as { testId: string; tag: string; text: string; disabled: boolean }[]);

    if (testIds.length > 0) {
      snapshot += '\n\nDATA-TESTID SELECTORS (use [data-testid="..."] as selector):';
      for (const el of testIds) {
        const disabled = el.disabled ? ' [disabled]' : '';
        const text = el.text ? ` "${el.text}"` : '';
        snapshot += `\n  [data-testid="${el.testId}"] ${el.tag}${text}${disabled}`;
      }
    }

    return snapshot;
  }

  /**
   * Resolve a selector to a Playwright Locator.
   *
   * - `@b3f` -> resolved from ref map via getByRole()
   * - Standard selectors (CSS, text=, role=, [data-testid=...]) -> page.locator()
   */
  resolveLocator(page: Page, selector: string): Locator {
    if (selector.startsWith('@')) {
      const refId = selector.slice(1);
      const entry = this.refMap.get(refId);
      if (entry) {
        const roleLocator = page.getByRole(entry.role as Parameters<Page['getByRole']>[0], {
          name: entry.name,
          exact: entry.name.length > 0,
        });
        // Suffixed refs (e.g., t31b3_2) represent the Nth duplicate of a role+name combo.
        // Use nth() to target the correct instance instead of always picking first().
        const suffixMatch = refId.match(/_(\d+)$/);
        if (suffixMatch) {
          const index = parseInt(suffixMatch[1], 10);
          return roleLocator.nth(index);
        }
        return roleLocator.first();
      }
      // Ref not found in current snapshot -- throw with available refs for
      // auto-retry or Brain feedback
      throw new StaleRefError(
        refId,
        [...this.refMap.keys()],
      );
    }

    return page.locator(selector).first();
  }

  /**
   * Parse Playwright's ARIA snapshot YAML and assign stable ref IDs.
   *
   * Ref IDs are deterministic hashes of role+name, so the same element gets
   * the same ref across observations. Duplicates get index suffixes (_1, _2).
   *
   * Input:
   *   - button "Sign in"
   *   - textbox "Email" [value=""]
   *   - list "Nav":
   *     - link "Home"
   *
   * Output:
   *   - button "Sign in" [ref=b2a1]
   *   - textbox "Email" [ref=t3f0] [value=""]
   *   - list "Nav" [ref=l1b2]:
   *     - link "Home" [ref=la3c]
   */
  private parseAriaSnapshot(raw: string): string {
    const lines = raw.split('\n');
    const result: string[] = [];

    for (const line of lines) {
      const match = line.match(/^(\s*-\s+)(\w+)(?:\s+"([^"]*)")?(.*)$/);
      if (!match) {
        result.push(line);
        continue;
      }

      const [, indent, role, name, rest] = match;

      if (INTERACTIVE_ROLES.has(role) || (name && role !== 'text')) {
        const baseHash = stableHash(role, name || '');

        // Track duplicates: first occurrence gets bare hash, subsequent get _N suffix
        const count = this.hashCounts.get(baseHash) || 0;
        this.hashCounts.set(baseHash, count + 1);
        const refId = count === 0 ? baseHash : `${baseHash}_${count}`;

        this.refMap.set(refId, { role, name: name || '' });

        // Extract value for diff tracking
        const valueMatch = rest.match(/\[value="([^"]*)"\]/);
        this.currElements.set(refId, {
          ref: refId,
          role,
          name: name || '',
          value: valueMatch ? valueMatch[1] : undefined,
        });

        const cleanRest = rest.replace(/:$/, '').trim();
        const colon = rest.trimEnd().endsWith(':') ? ':' : '';
        const nameStr = name ? ` "${name}"` : '';
        const refStr = ` [ref=${refId}]`;
        const propsStr = cleanRest ? ` ${cleanRest}` : '';
        result.push(`${indent}${role}${nameStr}${refStr}${propsStr}${colon}`);
      } else {
        result.push(line);
      }
    }

    return result.join('\n');
  }

  /**
   * Get the diff from the last buildSnapshot() call.
   * Returns undefined on the first call (no previous snapshot to diff against).
   */
  getDiff(): string | undefined {
    if (!this.lastDiff) return undefined;
    return formatDiff(this.lastDiff);
  }

  /** Get the raw structured diff (for programmatic use) */
  getRawDiff(): SnapshotDiff | undefined {
    return this.lastDiff;
  }

  /**
   * Format a snapshot in compact form: one line per element, ref-first,
   * flat (no nesting), ~50-60% fewer tokens.
   *
   * Full format:
   *   - button "Sign in" [ref=b2a1]
   *   - textbox "Email" [ref=t3f0] [value=""]
   *   - list "Nav" [ref=l1b2]:
   *     - link "Home" [ref=la3c]
   *
   * Compact format:
   *   @b2a1 button "Sign in"
   *   @t3f0 textbox "Email" val=""
   *   @l1b2 list "Nav"
   *   @la3c link "Home"
   */
  static formatCompact(snapshot: string): string {
    const lines = snapshot.split('\n');
    const compact: string[] = [];

    for (const line of lines) {
      const match = line.match(/\s*-\s+(\w+)\s+"([^"]*)"?\s*\[ref=(\w+)\](.*)?$/);
      if (!match) continue;

      const [, role, name, ref, rest] = match;
      const valueMatch = rest?.match(/\[value="([^"]*)"\]/);
      const value = valueMatch ? ` val="${valueMatch[1]}"` : '';
      compact.push(`@${ref} ${role} "${name}"${value}`);
    }

    return compact.join('\n');
  }
}

/**
 * Typed error for stale ref detection -- allows runner to catch specifically
 * and auto-retry with a fresh observation.
 */
export class StaleRefError extends Error {
  readonly staleRef: string;
  readonly availableRefs: string[];

  constructor(staleRef: string, availableRefs: string[]) {
    super(
      `Ref "@${staleRef}" not found in current snapshot ` +
      `(available: ${availableRefs.join(', ') || 'none'}). ` +
      `Use a ref from the CURRENT observation.`
    );
    this.name = 'StaleRefError';
    this.staleRef = staleRef;
    this.availableRefs = availableRefs;
  }
}

/**
 * Dismiss blocking overlays (dialogs, modals, Vite errors).
 * Shared between drivers that operate on a Playwright page.
 *
 * Returns 'clicked' if a close button was found and clicked,
 * 'found' if an overlay exists but no close button was found (Escape pressed),
 * or false if no overlay was detected.
 */
export async function dismissOverlays(page: Page): Promise<'clicked' | 'found' | false> {
  const result = await page.evaluate((): 'clicked' | 'found' | false => {
    const dialog = document.querySelector('[role="dialog"]');
    if (dialog) {
      const closeByLabel = dialog.querySelector('button[aria-label="Close"]') as HTMLElement | null;
      if (closeByLabel) { closeByLabel.click(); return 'clicked'; }
      const btns = dialog.querySelectorAll('button');
      for (const btn of btns) {
        const text = (btn.textContent || '').toLowerCase().trim();
        if (text === 'close' || text.includes('cancel') || text.includes('maybe later') || text.includes('dismiss') || text.includes('skip')) {
          btn.click();
          return 'clicked';
        }
      }
      return 'found'; // Dialog found but no close button -- needs Escape
    }
    const overlay = document.querySelector('div.fixed.inset-0[class*="z-"]');
    if (overlay) {
      const closeBtn = overlay.querySelector('button[aria-label="Close"]') as HTMLElement | null;
      if (closeBtn) { closeBtn.click(); return 'clicked'; }
      return 'found';
    }
    const viteOverlay = document.querySelector('vite-error-overlay');
    if (viteOverlay) { viteOverlay.remove(); return 'clicked'; }
    return false;
  });

  if (result === 'clicked') {
    // Close button handled it -- just wait for animation, no Escape needed
    await page.waitForTimeout(300);
  } else if (result === 'found') {
    // Overlay detected but no close button -- try Escape as fallback
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  // result === false: no overlay, no action needed
  return result;
}
