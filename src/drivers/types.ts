/**
 * Driver interface - abstraction over browser automation
 */

import type { Action, PageState } from '../types.js';

export interface ActionResult {
  success: boolean;
  error?: string;
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
