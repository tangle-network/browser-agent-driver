/**
 * Scout / branch preview — visible link scouting and bounded branch exploration.
 */

import type { PageState } from '../types.js';
import { buildSearchResultsGuidance, extractGoalSignals, isFirstPartyContentHub } from './search-guidance.js';
import { safeHostname } from './utils.js';

export interface BranchPreview {
  finalUrl: string;
  title: string;
  text: string;
}

export function shouldUseVisibleLinkScout(
  candidates: Array<{ ref: string; text: string; score: number }>,
  config: { minTopScore?: number; maxScoreGap?: number },
): boolean {
  if (candidates.length < 2) return false;

  const [top, second] = candidates;
  const minTopScore = config.minTopScore ?? 12;
  const maxScoreGap = config.maxScoreGap ?? 4;
  const scoreGap = top.score - second.score;

  return top.score < minTopScore || scoreGap <= maxScoreGap;
}

export function shouldUseVisibleLinkScoutPage(
  state: PageState,
  goal: string,
  allowedDomains?: string[],
): boolean {
  return buildSearchResultsGuidance(state, goal, allowedDomains).length > 0 || isFirstPartyContentHub(state);
}

export function shouldUseBoundedBranchExplorer(
  candidates: Array<{ ref: string; text: string; score: number }>,
  config: { minTopScore?: number; maxScoreGap?: number },
): boolean {
  if (candidates.length < 2) return false;
  const [top, second] = candidates;
  const minTopScore = config.minTopScore ?? 12;
  const maxScoreGap = config.maxScoreGap ?? 4;
  return top.score < minTopScore || top.score - second.score <= maxScoreGap;
}

export async function inspectBranchPreview(
  currentPage: import('playwright').Page,
  href: string,
  timeoutMs: number,
): Promise<BranchPreview | undefined> {
  const branchPage = await currentPage.context().newPage();
  try {
    await branchPage.goto(href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const preview = await branchPage.evaluate(() => ({
      finalUrl: window.location.href,
      title: document.title,
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2500),
    }));
    return preview;
  } catch {
    return undefined;
  } finally {
    await branchPage.close().catch(() => {});
  }
}

export function scoreBranchPreview(
  goal: string,
  preview: BranchPreview,
  allowedDomains?: string[],
): number {
  const signals = extractGoalSignals(goal);
  const haystack = `${preview.finalUrl} ${preview.title} ${preview.text}`.toLowerCase();
  let score = 0;
  const host = safeHostname(preview.finalUrl);
  const allowedHosts = new Set((allowedDomains ?? []).map((domain) => domain.toLowerCase()));

  for (const keyword of signals.keywords) {
    if (haystack.includes(keyword)) score += 2;
  }
  for (const phrase of signals.exactPhrases) {
    if (haystack.includes(phrase)) score += 4;
  }
  if (signals.wantsPressRelease && /\bpress release\b|\bnews release\b|\/news-releases?\//.test(haystack)) {
    score += 10;
  }
  if (signals.wantsPressRelease && /\bpress room\b|\brecent news releases\b|\bnews events\b/.test(haystack)) {
    score += 5;
  }
  if (/\berror\b|\baccess denied\b|\brequest could not be satisfied\b|\b403\b/.test(haystack)) {
    score -= 12;
  }
  if (signals.wantsPressRelease && /\bnih research matters\b|\bnews in health\b|\bfact sheet\b|\bwhat causes\b|\bwhat are the signs\b/.test(haystack)) {
    score -= 10;
  }
  if (signals.wantsPressRelease && /\/nih-research-matters\/|\/health\/|\/research\/|\/blog\//.test(haystack)) {
    score -= 8;
  }
  if (allowedHosts.size > 0) {
    if (host && allowedHosts.has(host)) score += 5;
    else if (host) score -= 8;
  }
  return score;
}
