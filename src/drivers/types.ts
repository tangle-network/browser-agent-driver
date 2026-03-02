/**
 * Driver interface - abstraction over browser automation
 */

import type { Action, PageState } from '../types.js';

export interface ActionResult {
  success: boolean;
  error?: string;
  /** Data returned by the action (e.g., runScript result) */
  data?: string;
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

  /** Take a screenshot on demand */
  screenshot?(): Promise<Buffer>;

  /** Close/cleanup the driver */
  close?(): Promise<void>;
}
