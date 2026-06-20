/**
 * The canonical responsive viewports for multi-viewport design capture, shared
 * by token extraction and the compare tool so the two never drift out of sync.
 */
export const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
] as const
