/**
 * Runner barrel — re-exports all public symbols from the runner submodules.
 */

// Core runner
export { BrowserAgent, runBrowserAgent } from './runner.js';
export type { BrowserAgentOptions } from './runner.js';

// Utilities
export { withRetry } from './utils.js';

// Search guidance
export {
  buildSearchResultsGuidance,
  rankSearchCandidates,
  buildVisibleLinkRecommendation,
  getVisibleLinkRecommendation,
  getRankedVisibleLinkCandidates,
} from './search-guidance.js';

// Goal verification
export {
  buildGoalVerificationClaim,
  collectSearchWorkflowEvidence,
  shouldAcceptSearchWorkflowCompletion,
  shouldAcceptScriptBackedCompletion,
  detectCompletionContentTypeMismatch,
} from './goal-verification.js';

// Effect verification
export { verifyExpectedEffect } from './effect-verification.js';

// Page analysis
export {
  detectAiTangleVerifiedOutputState,
  detectAiTanglePartnerTemplateVisibleState,
} from './page-analysis.js';

// Scout
export {
  shouldUseVisibleLinkScout,
  shouldUseVisibleLinkScoutPage,
  shouldUseBoundedBranchExplorer,
  scoreBranchPreview,
} from './scout.js';

// Overrides
export {
  chooseVisibleLinkOverride,
  chooseScoutLinkOverride,
  chooseBranchLinkOverride,
  chooseSearchResultsNewsTabOverride,
  chooseSearchQueryOverride,
  chooseNewsReleasesHubOverride,
  chooseVisibleNewsReleaseResultOverride,
  chooseVisibleSearchResultOverride,
  chooseExpandableListCompletionOverride,
} from './overrides.js';
