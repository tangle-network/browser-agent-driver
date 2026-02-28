/**
 * Selector Cache — maps element identities to their best-known selectors.
 *
 * After each successful action, records which selector worked for a given
 * element (identified by role+name from the a11y tree). On future runs,
 * known-good selectors are injected into the brain context so the agent
 * can skip trial-and-error.
 *
 * Each entry tracks:
 * - The last successful @ref (changes between page loads)
 * - The best stable selector (data-testid, aria-label, etc.)
 * - Success count and last used timestamp
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';

export interface SelectorEntry {
  /** Element identity from a11y tree (e.g., 'button "Send"') */
  element: string;
  /** Last known @ref ID (volatile — changes between sessions) */
  lastRef?: string;
  /** Best stable selector (data-testid, aria-label, etc.) */
  stableSelector?: string;
  /** Number of successful uses */
  successCount: number;
  /** Last successful use */
  lastUsed: string;
}

export interface SelectorCacheData {
  entries: Record<string, SelectorEntry>;
  updatedAt: string;
}

export class SelectorCache {
  private path: string;
  private data: SelectorCacheData;

  constructor(path: string) {
    this.path = path;
    this.data = this.load();
  }

  /** Record a successful selector use */
  recordSuccess(element: string, selector: string): void {
    const now = new Date().toISOString();
    const existing = this.data.entries[element];

    if (existing) {
      existing.successCount++;
      existing.lastUsed = now;
      if (selector.startsWith('@')) {
        existing.lastRef = selector;
      } else {
        existing.stableSelector = selector;
      }
    } else {
      const entry: SelectorEntry = {
        element,
        successCount: 1,
        lastUsed: now,
      };
      if (selector.startsWith('@')) {
        entry.lastRef = selector;
      } else {
        entry.stableSelector = selector;
      }
      this.data.entries[element] = entry;
    }

    this.data.updatedAt = now;
  }

  /** Look up the best known selector for an element */
  lookup(element: string): SelectorEntry | undefined {
    return this.data.entries[element];
  }

  /** Get all entries sorted by success count (most reliable first) */
  getAll(): SelectorEntry[] {
    return Object.values(this.data.entries)
      .sort((a, b) => b.successCount - a.successCount);
  }

  /** Get the most reliable selectors (high success count) for brain context */
  formatForBrain(limit = 20): string {
    const entries = this.getAll().slice(0, limit);
    if (entries.length === 0) return '';

    const lines: string[] = ['KNOWN SELECTORS (from previous runs):'];
    for (const e of entries) {
      const selector = e.stableSelector || e.lastRef || '(unknown)';
      lines.push(`  - ${e.element} → ${selector} (used ${e.successCount}x)`);
    }
    return lines.join('\n');
  }

  /** Persist to disk */
  save(): void {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  private load(): SelectorCacheData {
    if (existsSync(this.path)) {
      try {
        return JSON.parse(readFileSync(this.path, 'utf-8'));
      } catch {
        // Corrupted file — start fresh
      }
    }
    return { entries: {}, updatedAt: new Date().toISOString() };
  }
}
