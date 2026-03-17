/** Design module — rip, compare, and page interaction */

export { ripSite } from './rip.js'
export { runDesignCompare } from './compare.js'
export { revealHiddenContent, captureInteractionScreenshots } from './page-interaction.js'

export type {
  VideoAsset,
  RevealStats,
  RipOptions,
  RipResult,
  CapturedAsset,
  CompareOptions,
  CompareResult,
  ViewportDiff,
  TokenDiff,
  InteractionScreenshots,
} from './types.js'
