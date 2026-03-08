/**
 * Override producers — post-decision action overrides for the runner pipeline.
 */

import type { Action, PageState } from '../types.js';
import type { OverrideProducer, OverrideContext } from '../override-pipeline.js';
import {
  getVisibleLinkRecommendation,
  isFirstPartyContentHub,
} from './search-guidance.js';
import {
  findElementForRef,
  findLinkRefByExactText,
  findLinkRefContainingText,
  requiresSearchWorkflowEvidence,
  requiresPressReleaseLikeContent,
  looksLikeSearchResultsPage,
} from './utils.js';

/**
 * Build the ordered list of override producers for the post-decision pipeline.
 * Each producer wraps one of the existing choose* functions and returns a scored
 * OverrideCandidate, or undefined if the override does not apply.
 */
export function buildOverrideProducers(): OverrideProducer[] {
  return [
    // 1. Search query correction (score 50)
    (ctx: OverrideContext) => {
      const result = chooseSearchQueryOverride(ctx.state, ctx.goal, ctx.action);
      if (!result) return undefined;
      return {
        name: 'searchQueryOverride',
        action: { action: 'type', selector: result.selector, text: result.query },
        expectedEffect: `The search box should contain the exact task query "${result.query}".`,
        feedback: result.feedback,
        score: 50,
        reasoningTag: 'POLICY OVERRIDE',
      };
    },

    // 2. News tab override (score 40)
    (ctx: OverrideContext) => {
      const result = chooseSearchResultsNewsTabOverride(ctx.state, ctx.goal, ctx.action);
      if (!result) return undefined;
      return {
        name: 'newsTabOverride',
        action: { action: 'click', selector: result.ref },
        expectedEffect: 'The search results page should switch to the News tab or news-filtered results.',
        feedback: result.feedback,
        score: 40,
        reasoningTag: 'POLICY OVERRIDE',
      };
    },

    // 3. News releases hub override (score 38)
    (ctx: OverrideContext) => {
      const result = chooseNewsReleasesHubOverride(ctx.state, ctx.goal, ctx.action);
      if (!result) return undefined;
      return {
        name: 'newsReleasesHubOverride',
        action: { action: 'click', selector: result.ref },
        expectedEffect: 'The browser should open the News Releases hub page where the site-specific release search is available.',
        feedback: result.feedback,
        score: 38,
        reasoningTag: 'POLICY OVERRIDE',
      };
    },

    // 4. Visible news release result override (score 36)
    (ctx: OverrideContext) => {
      const result = chooseVisibleNewsReleaseResultOverride(ctx.state, ctx.goal, ctx.action);
      if (!result) return undefined;
      return {
        name: 'visibleNewsReleaseResultOverride',
        action: { action: 'click', selector: result.ref },
        expectedEffect: 'The matching visible release result should open directly from the News Releases hub.',
        feedback: result.feedback,
        score: 36,
        reasoningTag: 'POLICY OVERRIDE',
      };
    },

    // 5. Visible search result override (score 34)
    (ctx: OverrideContext) => {
      const result = chooseVisibleSearchResultOverride(ctx.state, ctx.goal, ctx.allowedDomains, ctx.action);
      if (!result) return undefined;
      return {
        name: 'visibleSearchResultOverride',
        action: { action: 'click', selector: result.ref },
        expectedEffect: 'The strongest visible search result should open directly.',
        feedback: result.feedback,
        score: 34,
        reasoningTag: 'POLICY OVERRIDE',
      };
    },

    // 6. Visible link override (score = match.score * 3)
    (ctx: OverrideContext) => {
      const result = chooseVisibleLinkOverride(ctx.state, ctx.action, ctx.visibleLinkMatch);
      if (!result) return undefined;
      return {
        name: 'visibleLinkOverride',
        action: { action: 'click', selector: result.ref },
        expectedEffect: 'URL should change',
        feedback: result.feedback,
        score: (ctx.visibleLinkMatch?.score ?? 10) * 3,
        reasoningTag: 'POLICY OVERRIDE',
      };
    },

    // 7. Scout link override (score = confidence * 30)
    (ctx: OverrideContext) => {
      const result = chooseScoutLinkOverride(ctx.state, ctx.action, ctx.scoutLinkRecommendation);
      if (!result) return undefined;
      return {
        name: 'scoutLinkOverride',
        action: { action: 'click', selector: result.ref },
        expectedEffect: 'URL should change',
        feedback: result.feedback,
        score: (ctx.scoutLinkRecommendation?.confidence ?? 0.7) * 30,
        reasoningTag: 'SCOUT OVERRIDE',
      };
    },

    // 8. Branch link override (score = confidence * 28)
    (ctx: OverrideContext) => {
      const result = chooseBranchLinkOverride(ctx.state, ctx.action, ctx.branchLinkRecommendation);
      if (!result) return undefined;
      return {
        name: 'branchLinkOverride',
        action: { action: 'click', selector: result.ref },
        expectedEffect: 'URL should change',
        feedback: result.feedback,
        score: (ctx.branchLinkRecommendation?.confidence ?? 0.72) * 28,
        reasoningTag: 'BRANCH OVERRIDE',
      };
    },

    // 9. AI Tangle partner completion (score 100 — terminal, highest)
    (ctx: OverrideContext) => {
      if (!ctx.aiTanglePartnerCompletion) return undefined;
      if (ctx.action.action === 'complete' || ctx.action.action === 'abort') return undefined;
      return {
        name: 'aiTanglePartnerCompletion',
        action: { action: 'complete', result: ctx.aiTanglePartnerCompletion.result },
        expectedEffect: 'Run should terminate after verifying the partner template page.',
        feedback: ctx.aiTanglePartnerCompletion.feedback,
        score: 100,
        reasoningTag: 'POLICY OVERRIDE',
      };
    },

    // 10. AI Tangle output completion (score 95 — terminal)
    (ctx: OverrideContext) => {
      if (!ctx.aiTangleOutputCompletion) return undefined;
      if (ctx.action.action === 'complete' || ctx.action.action === 'abort') return undefined;
      return {
        name: 'aiTangleOutputCompletion',
        action: { action: 'complete', result: ctx.aiTangleOutputCompletion.result },
        expectedEffect: 'Run should terminate with a verified visible output state.',
        feedback: ctx.aiTangleOutputCompletion.feedback,
        score: 95,
        reasoningTag: 'POLICY OVERRIDE',
      };
    },

    // 11. Expandable list gate (score 20 — lowest)
    (ctx: OverrideContext) => {
      const result = chooseExpandableListCompletionOverride(ctx.state, ctx.goal, ctx.action);
      if (!result) return undefined;
      return {
        name: 'expandableListGate',
        action: { action: 'click', selector: result.ref },
        expectedEffect: 'The remaining list items should become visible.',
        feedback: result.feedback,
        score: 20,
        reasoningTag: 'POLICY OVERRIDE',
      };
    },
  ];
}

export function chooseVisibleLinkOverride(
  state: PageState,
  action: Action,
  recommendation: { ref: string; text: string; score: number } | undefined,
): { ref: string; feedback: string } | undefined {
  if (!recommendation || recommendation.score < 10) return undefined;
  if (!isFirstPartyContentHub(state)) return undefined;
  if (!isContentHubDetourAction(state, action)) return undefined;
  if (action.action === 'click' && action.selector === recommendation.ref) return undefined;
  if (isStructuralHubAction(state, action)) return undefined;

  return {
    ref: recommendation.ref,
    feedback: `A high-confidence first-party link is already visible on this page. Do not search again; click ${recommendation.ref} (${recommendation.text}) instead.`,
  };
}

export function chooseScoutLinkOverride(
  state: PageState,
  action: Action,
  recommendation: { ref: string; text: string; confidence: number; reasoning: string } | undefined,
): { ref: string; feedback: string } | undefined {
  if (!recommendation || recommendation.confidence < 0.7) return undefined;
  if (action.action === 'click' && action.selector === recommendation.ref) return undefined;

  if (!isSearchAction(state, action) && !isContentHubDetourAction(state, action) && !isCandidateClick(state, action)) {
    return undefined;
  }

  return {
    ref: recommendation.ref,
    feedback: `Scout recommendation: click ${recommendation.ref} (${recommendation.text}) instead. ${recommendation.reasoning}`,
  };
}

export function chooseBranchLinkOverride(
  state: PageState,
  action: Action,
  recommendation: { ref: string; text: string; confidence: number; reasoning: string } | undefined,
): { ref: string; feedback: string } | undefined {
  if (!recommendation || recommendation.confidence < 0.72) return undefined;
  if (action.action === 'click' && action.selector === recommendation.ref) return undefined;

  if (!isSearchAction(state, action) && !isContentHubDetourAction(state, action) && !isCandidateClick(state, action)) {
    return undefined;
  }

  return {
    ref: recommendation.ref,
    feedback: `Bounded branch preview recommends ${recommendation.ref} (${recommendation.text}) instead. ${recommendation.reasoning}`,
  };
}

export function buildScoutLinkRecommendationText(
  recommendation: { ref: string; text: string; confidence: number; reasoning: string },
): string {
  return [
    'SCOUT RECOMMENDATION:',
    `Prefer clicking ${recommendation.ref} (${recommendation.text}).`,
    `Scout confidence: ${recommendation.confidence.toFixed(2)}.`,
    `Scout reasoning: ${recommendation.reasoning}`,
  ].join('\n');
}

export function buildBranchLinkRecommendationText(
  recommendation: { ref: string; text: string; confidence: number; reasoning: string },
): string {
  return [
    'BOUNDED BRANCH RECOMMENDATION:',
    `Prefer clicking ${recommendation.ref} (${recommendation.text}).`,
    `Branch confidence: ${recommendation.confidence.toFixed(2)}.`,
    `Branch reasoning: ${recommendation.reasoning}`,
  ].join('\n');
}

export function chooseSearchResultsNewsTabOverride(
  state: PageState,
  goal: string,
  action: Action,
): { ref: string; feedback: string } | undefined {
  if (!requiresPressReleaseLikeContent(goal)) return undefined;
  if (!looksLikeSearchResultsPage(state)) return undefined;

  const newsTabRef = findLinkRefByExactText(state.snapshot, 'News');
  if (!newsTabRef) return undefined;
  if (action.action === 'click' && action.selector === newsTabRef) return undefined;

  if (!isCandidateClick(state, action) && !isSearchAction(state, action)) return undefined;

  return {
    ref: newsTabRef,
    feedback: 'For press/news-release tasks on site search results, switch to the visible News tab before opening generic results or topic pages.',
  };
}

export function chooseSearchQueryOverride(
  state: PageState,
  goal: string,
  action: Action,
): { selector: string; query: string; feedback: string } | undefined {
  if (action.action !== 'type' || !action.selector.startsWith('@')) return undefined;
  if (!requiresSearchWorkflowEvidence(goal)) return undefined;

  const element = findElementForRef(state.snapshot, action.selector)?.toLowerCase() ?? '';
  if (!element.includes('searchbox')) return undefined;

  const explicitQuery = Array.from(goal.matchAll(/"([^"]{3,})"/g))
    .map((match) => match[1]?.trim())
    .find(Boolean);
  if (!explicitQuery) return undefined;
  if (action.text.trim() === explicitQuery) return undefined;

  return {
    selector: action.selector,
    query: explicitQuery,
    feedback: `Use the exact task query "${explicitQuery}" in the site search box instead of reformulating it.`,
  };
}

export function chooseNewsReleasesHubOverride(
  state: PageState,
  goal: string,
  action: Action,
): { ref: string; feedback: string } | undefined {
  if (!requiresSearchWorkflowEvidence(goal) || !requiresPressReleaseLikeContent(goal)) return undefined;
  if (!/\/news-events\/?$/.test(state.url.toLowerCase())) return undefined;

  const hubRef = findLinkRefContainingText(state.snapshot, 'All news releases');
  if (!hubRef) return undefined;
  if (action.action === 'click' && action.selector === hubRef) return undefined;

  if (!isCandidateClick(state, action)) return undefined;

  return {
    ref: hubRef,
    feedback: 'Open the dedicated News Releases hub before choosing an article so the site-specific release search can prove the first related press release.',
  };
}

export function chooseVisibleNewsReleaseResultOverride(
  state: PageState,
  goal: string,
  action: Action,
): { ref: string; feedback: string } | undefined {
  if (!requiresSearchWorkflowEvidence(goal) || !requiresPressReleaseLikeContent(goal)) return undefined;
  if (!state.url.toLowerCase().includes('/news-events/news-releases')) return undefined;

  const explicitQuery = Array.from(goal.matchAll(/"([^"]{3,})"/g))
    .map((match) => match[1]?.trim().toLowerCase())
    .find(Boolean);
  if (!explicitQuery) return undefined;
  if (!state.snapshot.toLowerCase().includes(`[value="${explicitQuery}"]`)) return undefined;

  const recommendation = getVisibleLinkRecommendation(state, goal, ['www.nih.gov']);
  if (!recommendation || recommendation.score < 6) return undefined;
  if (/all news releases/i.test(recommendation.text)) return undefined;
  if (action.action === 'click' && action.selector === recommendation.ref) return undefined;

  const shouldOverride =
    isSearchAction(state, action)
    || action.action === 'press'
    || isCandidateClick(state, action);
  if (!shouldOverride) return undefined;

  return {
    ref: recommendation.ref,
    feedback: `A matching news release is already visible for the exact query "${explicitQuery}". Click the visible release instead of re-submitting the search.`,
  };
}

export function chooseVisibleSearchResultOverride(
  state: PageState,
  goal: string,
  allowedDomains: string[] | undefined,
  action: Action,
): { ref: string; feedback: string } | undefined {
  if (!looksLikeSearchResultsPage(state)) return undefined;

  const recommendation = getVisibleLinkRecommendation(state, goal, allowedDomains);
  if (!recommendation || recommendation.score < 10) return undefined;
  if (action.action === 'click' && action.selector === recommendation.ref) return undefined;

  const candidateClick = isCandidateClick(state, action);
  if (!candidateClick && !isSearchAction(state, action)) return undefined;

  const targetText = candidateClick && action.action === 'click'
    ? (findElementForRef(state.snapshot, action.selector) ?? '').toLowerCase()
    : '';
  const lowerGoal = goal.toLowerCase();
  const wantsProductSearch =
    lowerGoal.includes('top result')
    || lowerGoal.includes('product search')
    || (lowerGoal.includes('review') && lowerGoal.includes('summary'));
  const chosenLooksDistracting = /\bcustomer services\b|\breviews policy\b|\bhelp\b|\bshopping with us\b/.test(targetText);

  if (!wantsProductSearch && !chosenLooksDistracting) return undefined;

  return {
    ref: recommendation.ref,
    feedback: `A stronger visible search result is already present. Click ${recommendation.ref} (${recommendation.text}) instead of the lower-signal search/help link you chose.`,
  };
}

export function chooseExpandableListCompletionOverride(
  state: PageState,
  goal: string,
  action: Action,
): { ref: string; feedback: string } | undefined {
  if (action.action !== 'complete') return undefined;
  if (!/\blist\b|\bcategories\b|\bcategory\b/.test(goal.toLowerCase())) return undefined;
  const lines = state.snapshot.split('\n');
  const topicIndex = lines.findIndex((line) => /\btopic\b/i.test(line));
  if (topicIndex === -1) return undefined;
  const window = lines.slice(topicIndex, Math.min(lines.length, topicIndex + 12)).join('\n');
  const match = window.match(/- link "SHOW MORE \((\d+)\)" \[ref=([^\]]+)\]/i);
  if (!match) return undefined;

  return {
    ref: `@${match[2]}`,
    feedback: `The requested category list is not fully visible yet. Expand SHOW MORE (${match[1]}) before completing.`,
  };
}

function isCandidateClick(state: PageState, action: Action): boolean {
  return (
    action.action === 'click'
    && action.selector.startsWith('@')
    && !!findElementForRef(state.snapshot, action.selector)
  );
}

function isSearchAction(state: PageState, action: Action): boolean {
  if (!('selector' in action) || !action.selector?.startsWith('@')) return false;
  const element = findElementForRef(state.snapshot, action.selector)?.toLowerCase() ?? '';
  return element.includes('searchbox') || element.includes('search');
}

function isContentHubDetourAction(state: PageState, action: Action): boolean {
  if (isSearchAction(state, action)) return true;
  if (!('selector' in action) || !action.selector?.startsWith('@')) return false;
  const element = findElementForRef(state.snapshot, action.selector)?.toLowerCase() ?? '';
  if (!element) return false;
  return (
    /\b(all news releases|all releases|news releases)\b/.test(element)
    || /\bsearch\b/.test(element)
  );
}

function isStructuralHubAction(state: PageState, action: Action): boolean {
  if (!('selector' in action) || !action.selector?.startsWith('@')) return false;
  const element = findElementForRef(state.snapshot, action.selector)?.toLowerCase() ?? '';
  return /\b(all news releases|all releases)\b/.test(element);
}
