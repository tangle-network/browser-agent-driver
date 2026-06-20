/**
 * Scout recommendation builders: the glue the runner loop calls each turn to
 * surface search-result candidates, a single visible-link pick, and a bounded
 * two-branch preview challenger.
 *
 * Extracted from runner.ts via the delegate + host-interface pattern. The
 * BrowserAgent class keeps thin delegators (`buildSearchResultsScoutFeedback`,
 * `buildVisibleLinkScoutRecommendation`, `buildBranchLinkRecommendation`);
 * these free functions hold the method bodies verbatim and read runner state
 * through {@link RunnerScoutHost}, which BrowserAgent `implements` so tsc
 * proves the host surface is complete. Behavior is byte-identical to the
 * inlined versions — same ordering, thresholds, selectors, and prompt text.
 */

import type { Brain } from '../brain/index.js';
import type { Driver } from '../drivers/types.js';
import type { AgentConfig, PageState } from '../types.js';

import { buildSearchResultsGuidance, getRankedVisibleLinkCandidates, rankSearchCandidates } from './search-guidance.js';
import { shouldUseVisibleLinkScout, shouldUseVisibleLinkScoutPage, shouldUseBoundedBranchExplorer, inspectBranchPreview, scoreBranchPreview } from './scout.js';
import type { BranchPreview } from './scout.js';

/**
 * The slice of runner state the scout recommendation builders read. The
 * BrowserAgent class declares `implements RunnerScoutHost`, so a missing or
 * mistyped member is a compile error — this interface IS the safety gate for
 * the extraction. All members are public on BrowserAgent by construction.
 */
export interface RunnerScoutHost {
  driver: Driver;
  config: AgentConfig;
  brain: Brain;
  filterScoutCandidatesByAllowedDomains(
    candidates: Array<{ ref: string; text: string; score: number }>,
    allowedDomains: string[] | undefined,
  ): Promise<Array<{ ref: string; text: string; score: number }>>;
  attachDecisionScreenshot(state: PageState): Promise<PageState>;
}

export async function buildSearchResultsScoutFeedbackImpl(
  self: RunnerScoutHost,
  state: PageState,
  goal: string,
  allowedDomains: string[] | undefined,
  seenUrls: Set<string>,
): Promise<string> {
  if (!buildSearchResultsGuidance(state, goal, allowedDomains)) return '';
  if (seenUrls.has(state.url)) return '';

  const page = self.driver.getPage?.();
  if (!page) return '';

  try {
    const candidates = await page.evaluate(() => {
      const items: Array<{ title: string; href: string }> = [];
      const seen = new Set<string>();
      const selectors = [
        'main a[href]',
        '[role="main"] a[href]',
        'article a[href]',
        '.search-results a[href]',
        '#search-results a[href]',
        '.results a[href]',
        'ol a[href]',
      ];
      const fallbackLinks = Array.from(document.querySelectorAll('a[href]'));
      const links = selectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .concat(fallbackLinks);
      const noisePattern = /\b(next|previous|page \d+|show more|show fewer|filter|sort|home|contact|privacy|accessibility|search)\b/i;

      for (const node of links) {
        const anchor = node as HTMLAnchorElement;
        const href = anchor.href?.trim();
        const title = (anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim();
        if (!href || !title || title.length < 12 || title.length > 220) continue;
        if (href.startsWith('javascript:') || href.startsWith('mailto:') || href.includes('#')) continue;
        if (href.includes('results.aspx') && !/open government|dataset|data|news release|press release/i.test(title)) continue;
        if (noisePattern.test(title) && !/open government|dataset|data|news release|press release/i.test(title)) continue;
        const key = `${title}::${href}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ title, href });
        if (items.length >= 24) break;
      }
      return items;
    });

    if (!Array.isArray(candidates) || candidates.length === 0) return '';
    const ranked = rankSearchCandidates(goal, candidates, allowedDomains);
    const recommendation = ranked[0];
    seenUrls.add(state.url);
    return [
      'SEARCH RESULTS CANDIDATES:',
      ...ranked.map((candidate, index) => `${index + 1}. ${candidate.title} — ${candidate.href} (score ${candidate.score})`),
      recommendation
        ? `BEST MATCH RECOMMENDATION: prefer "${recommendation.title}" because it best matches the requested entity, content type, and host constraints.`
        : '',
    ].join('\n');
  } catch {
    return '';
  }
}

export async function buildVisibleLinkScoutRecommendationImpl(
  self: RunnerScoutHost,
  state: PageState,
  goal: string,
  allowedDomains: string[] | undefined,
): Promise<{ ref: string; text: string; confidence: number; reasoning: string } | undefined> {
  const scoutConfig = self.config.scout;
  if (!scoutConfig?.enabled) return undefined;
  if (!shouldUseVisibleLinkScoutPage(state, goal, allowedDomains)) return undefined;

  const ranked = getRankedVisibleLinkCandidates(state, goal, allowedDomains);
  const maxCandidates = Math.max(2, Math.min(scoutConfig.maxCandidates ?? 3, 5));
  const candidates = await self.filterScoutCandidatesByAllowedDomains(
    ranked.slice(0, maxCandidates),
    allowedDomains,
  );
  if (!shouldUseVisibleLinkScout(candidates, scoutConfig)) return undefined;

  const scoutState = scoutConfig.useVision
    ? await self.attachDecisionScreenshot(state)
    : state;
  const extraContext = allowedDomains && allowedDomains.length > 0
    ? `Host constraint: prefer only ${allowedDomains.join(', ')}.`
    : undefined;
  const recommendation = await self.brain.recommendLinkCandidate(
    goal,
    scoutState,
    candidates,
    extraContext,
  );
  const matched = candidates.find((candidate) => candidate.ref === recommendation.selector);
  if (!matched) return undefined;

  return {
    ref: matched.ref,
    text: matched.text,
    confidence: recommendation.confidence,
    reasoning: recommendation.reasoning,
  };
}

export async function buildBranchLinkRecommendationImpl(
  self: RunnerScoutHost,
  state: PageState,
  goal: string,
  allowedDomains: string[] | undefined,
): Promise<{ ref: string; text: string; confidence: number; reasoning: string } | undefined> {
  const scoutConfig = self.config.scout;
  if (!scoutConfig?.enabled || !scoutConfig.readOnlyTop2Challenger) return undefined;
  if (!shouldUseVisibleLinkScoutPage(state, goal, allowedDomains)) return undefined;

  const ranked = getRankedVisibleLinkCandidates(state, goal, allowedDomains);
  const candidates = ranked.slice(0, 2);
  if (!shouldUseBoundedBranchExplorer(candidates, scoutConfig)) return undefined;
  if (!self.driver.inspectSelectorHref || !self.driver.getPage) return undefined;

  const page = self.driver.getPage();
  if (!page) return undefined;

  const settled = await Promise.all(
    candidates.map(async (candidate) => {
      const href = await self.driver.inspectSelectorHref!(candidate.ref).catch(() => undefined);
      if (!href) return undefined;
      const preview = await inspectBranchPreview(page, href, 8000);
      if (!preview) return undefined;
      return { ref: candidate.ref, text: candidate.text, href, score: scoreBranchPreview(goal, preview, allowedDomains), preview };
    }),
  );
  const previews = settled.filter(
    (r): r is { ref: string; text: string; href: string; score: number; preview: BranchPreview } => r !== undefined,
  );

  if (previews.length < 2) return undefined;
  previews.sort((a, b) => b.score - a.score);
  const [top, second] = previews;
  if (top.score <= second.score) return undefined;
  if (top.score < 4) return undefined;

  return {
    ref: top.ref,
    text: top.text,
    confidence: Math.min(0.95, 0.7 + Math.max(0, top.score - second.score) / 20),
    reasoning: `Branch preview favored ${top.href} (${top.preview.title || top.preview.finalUrl}) over ${second.href} based on content-type and goal-match signals.`,
  };
}
