/**
 * Runner barrel — backwards-compatible re-export from src/runner/ modules.
 *
 * All existing imports from './runner.js' or '../src/runner.js' continue to work.
 */
export {
  // Core
  BrowserAgent,
  runBrowserAgent,

  // Utilities
  withRetry,

  // Search guidance
  buildSearchResultsGuidance,
  rankSearchCandidates,
  buildVisibleLinkRecommendation,
  getVisibleLinkRecommendation,
  getRankedVisibleLinkCandidates,

  // Goal verification
  buildGoalVerificationClaim,
  collectSearchWorkflowEvidence,
  shouldAcceptSearchWorkflowCompletion,
  shouldAcceptScriptBackedCompletion,
  detectCompletionContentTypeMismatch,

  // Effect verification
  verifyExpectedEffect,

  // Page analysis
  detectAiTangleVerifiedOutputState,
  detectAiTanglePartnerTemplateVisibleState,

  // Scout
  shouldUseVisibleLinkScout,
  shouldUseVisibleLinkScoutPage,
  shouldUseBoundedBranchExplorer,
  scoreBranchPreview,

  // Overrides
  chooseVisibleLinkOverride,
  chooseScoutLinkOverride,
  chooseBranchLinkOverride,
  chooseSearchResultsNewsTabOverride,
  chooseSearchQueryOverride,
  chooseNewsReleasesHubOverride,
  chooseVisibleNewsReleaseResultOverride,
  chooseVisibleSearchResultOverride,
  chooseExpandableListCompletionOverride,
} from './runner/index.js';

export type { BrowserAgentOptions } from './runner/index.js';
