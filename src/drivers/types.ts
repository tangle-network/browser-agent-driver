/**
 * Driver interface - abstraction over browser automation
 */

import type { Action, PageState } from '../types.js';

export interface ActionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ActionResult {
  success: boolean;
  error?: string;
  /** Data returned by the action (e.g., runScript result) */
  data?: string;
  /** Non-fatal warning (e.g., form fields didn't retain values after fill) */
  warning?: string;
  /** Bounding box of the target element at action time (for replay overlays) */
  bounds?: ActionBounds;
}

export interface ResourceBlockingOptions {
  /** Block image loading (png, jpg, gif, svg, webp, ico, etc.) */
  blockImages?: boolean;
  /** Block media loading (video, audio) */
  blockMedia?: boolean;
  /** Block analytics/tracking scripts */
  blockAnalytics?: boolean;
  /** Custom URL patterns to block (matched via url.includes()) */
  blockPatterns?: string[];
}

export interface Driver {
  /** Get current page state (DOM snapshot, optionally screenshot) */
  observe(): Promise<PageState>;

  /** Execute an action */
  execute(action: Action): Promise<ActionResult>;

  /** Get the underlying Playwright page (if available) */
  getPage?(): import('playwright').Page | undefined;

  /** Get current page URL without rebuilding the AX tree */
  getUrl?(): string;

  /** Take a screenshot on demand */
  screenshot?(): Promise<Buffer>;

  /** Best-effort href inspection for a selector before executing a click */
  inspectSelectorHref?(selector: string): Promise<string | undefined>;

  /** Optional run-time diagnostics for startup and browser/session setup */
  getDiagnostics?(): Record<string, unknown>;

  /** Gen 29: expose the driver's construction options so the runner can
   * hand them to sub-drivers (compound-goal parallel tabs). Drivers that
   * don't support compound goals can omit this. Return shape is driver-
   * specific (cast at the caller). */
  getDriverOptions?(): unknown;

  /** Close/cleanup the driver */
  close?(): Promise<void>;

  /**
   * Gen 32 — overlay narration hooks. No-op when the overlay is off.
   * Drivers without a cursor overlay can omit these entirely; callers
   * check for presence and skip when absent.
   */
  setOverlayReasoning?(text: string): Promise<void>;
  setOverlayProgress?(current: number, total: number, label?: string): Promise<void>;
  pushOverlayBadge?(kind: 'positive' | 'cleared' | 'review' | 'info', text: string): Promise<void>;
}
