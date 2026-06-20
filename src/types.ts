/**
 * Core types for browser agent
 *
 * Barrel: domain modules live under `src/types/`. This file re-exports every
 * one so the canonical `./types.js` / `../types.js` import path (and the
 * `src/index.ts` re-export) keeps resolving every name unchanged.
 */

export * from './types/actions.js';
export * from './types/plan.js';
export * from './types/page.js';
export * from './types/scenario.js';
export * from './types/config.js';
export * from './types/turn.js';
export * from './types/result.js';
export * from './types/test-runner.js';
export * from './types/trajectory.js';
export * from './types/design-audit.js';
export * from './types/design-tokens.js';
export * from './types/preview.js';
