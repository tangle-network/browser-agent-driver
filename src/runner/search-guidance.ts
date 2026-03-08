/**
 * Search guidance — heuristics for ranking search results and visible links.
 */

import type { PageState } from '../types.js';
import { hasFullDate, safeHostname } from './utils.js';

export function buildSearchResultsGuidance(
  state: PageState,
  goal: string,
  allowedDomains?: string[],
): string {
  const url = state.url.toLowerCase();
  const title = state.title.toLowerCase();
  const snapshot = state.snapshot.toLowerCase();
  const looksLikeSearchPage =
    /\bsearch\b|\bquery=/.test(url)
    || /\bsearch results\b/.test(title)
    || /\bsearch results\b/.test(snapshot);

  if (!looksLikeSearchPage) return '';

  const needsStructuredExtraction =
    /\bfirst\b/.test(goal.toLowerCase())
    || /\bextract\b/.test(goal.toLowerCase())
    || /\btitle\b/.test(goal.toLowerCase())
    || /\bdate\b/.test(goal.toLowerCase());

  if (needsStructuredExtraction) {
    const lines = [
      'SEARCH RESULTS HEURISTIC: do not open random results one by one.',
      'Rank visible results against the requested entity and content type before clicking.',
      'If the ranking is ambiguous, use runScript to extract the top result titles and URLs first, then choose the best match.',
      'Prefer result titles or URLs that match the requested content type exactly (for example, press release, news release, pricing, docs, settings).',
    ];
    if (/\bpress release\b|\bnews release\b/.test(goal.toLowerCase())) {
      lines.push('For press-release tasks, avoid topic pages, fact sheets, and Research Matters-style articles unless no release/news hub is visible.');
    }
    if (allowedDomains && allowedDomains.length > 0) {
      lines.push(`Hard constraint: only choose results whose hostname is in this allowlist: ${allowedDomains.join(', ')}.`);
      lines.push('Strongly avoid results from sibling subdomains unless the allowlist explicitly includes them.');
    }
    return lines.join('\n');
  }

  const lines = [
    'SEARCH RESULTS HEURISTIC: prefer the highest-signal matching result rather than exploratory clicks.',
    'Use visible titles, snippets, and URLs to choose the best candidate before clicking.',
  ];
  if (allowedDomains && allowedDomains.length > 0) {
    lines.push(`Host constraint: prefer only results from ${allowedDomains.join(', ')}.`);
  }
  return lines.join('\n');
}

export function extractGoalSignals(goal: string): { keywords: string[]; exactPhrases: string[]; wantsPressRelease: boolean } {
  const lowerGoal = goal.toLowerCase();
  const exactPhrases = Array.from(
    new Set(
      [...lowerGoal.matchAll(/"([^"]{3,})"/g)]
        .map((match) => match[1]?.trim())
        .filter((phrase): phrase is string => Boolean(phrase)),
    ),
  );
  const stopwords = new Set([
    'site', 'find', 'information', 'extract', 'first', 'related', 'using', 'feature', 'their',
    'title', 'publication', 'date', 'only', 'https', 'http', 'achieve', 'task', 'other',
    'achievable', 'with', 'just', 'navigation', 'from', 'this', 'search', 'result', 'results',
    'click', 'visit', 'page', 'pages', 'requested', 'current', 'through', 'would', 'should',
  ]);
  const keywords = Array.from(
    new Set(
      lowerGoal
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter((token) => token.length >= 4)
        .filter((token) => !stopwords.has(token)),
    ),
  );
  const wantsPressRelease = /\bpress release\b|\bnews release\b/.test(lowerGoal);
  return { keywords, exactPhrases, wantsPressRelease };
}

export function rankSearchCandidates(
  goal: string,
  candidates: Array<{ title: string; href: string }>,
  allowedDomains?: string[],
): Array<{ title: string; href: string; score: number }> {
  const signals = extractGoalSignals(goal);

  const allowedHosts = new Set((allowedDomains ?? []).map((domain) => domain.toLowerCase()));
  return candidates
    .map((candidate) => {
      const haystack = `${candidate.title} ${candidate.href}`.toLowerCase();
      let score = 0;
      const host = safeHostname(candidate.href);
      for (const keyword of signals.keywords) {
        if (haystack.includes(keyword)) score += 2;
      }
      for (const phrase of signals.exactPhrases) {
        if (haystack.includes(phrase)) score += 4;
      }
      if (signals.wantsPressRelease && /\bpress[- ]release\b|\bnews[- ]release\b/.test(haystack)) {
        score += 6;
      }
      if (signals.wantsPressRelease && /\bnews events\b|\bnews releases\b|\bpress room\b/.test(haystack)) {
        score += 4;
      }
      if (/\/news-events\/news-releases\//.test(haystack)) {
        score += 8;
      } else if (signals.wantsPressRelease && /\/news-events\//.test(haystack)) {
        score += 3;
      }
      if (/\/science-updates\//.test(haystack)) {
        score -= 2;
      }
      if (signals.wantsPressRelease && /\bnih research matters\b|\bnews in health\b|\bcatalyst\b|\bfact sheet\b|\bwhat causes\b|\bwhat are the signs\b|\btreated\b|\bresearch centers\b/.test(haystack)) {
        score -= 12;
      }
      if (signals.wantsPressRelease && /\/nih-research-matters\/|\/science-updates\/|\/health\/|\/research\/|\/blog\//.test(haystack)) {
        score -= 8;
      }
      if (allowedHosts.size > 0) {
        if (host && allowedHosts.has(host)) {
          score += 10;
        } else if (host) {
          score -= 12;
        }
      }
      return { ...candidate, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

export function buildVisibleLinkRecommendation(
  state: PageState,
  goal: string,
  allowedDomains?: string[],
): string {
  const top = getVisibleLinkRecommendation(state, goal, allowedDomains);
  if (!top || top.score < 6) return '';

  const ranked = getRankedVisibleLinkCandidates(state, goal, allowedDomains);

  return [
    'VISIBLE LINK RECOMMENDATION:',
    `Prefer clicking ${top.ref} (${top.text}) because it is the strongest visible first-party match for the requested topic/content type.`,
    ...ranked.slice(1, 3).map((candidate, index) => `Backup ${index + 1}: ${candidate.ref} (${candidate.text})`),
  ].join('\n');
}

export function getVisibleLinkRecommendation(
  state: PageState,
  goal: string,
  allowedDomains?: string[],
): { ref: string; text: string; score: number } | undefined {
  const ranked = getRankedVisibleLinkCandidates(state, goal, allowedDomains);
  return ranked[0];
}

export function getRankedVisibleLinkCandidates(
  state: PageState,
  goal: string,
  allowedDomains?: string[],
): Array<{ ref: string; text: string; score: number }> {
  const currentHost = safeHostname(state.url);
  if (allowedDomains && allowedDomains.length > 0 && currentHost && !allowedDomains.map((domain) => domain.toLowerCase()).includes(currentHost)) {
    return [];
  }

  const candidates = extractSnapshotLinkCandidates(state.snapshot, goal);
  if (candidates.length === 0) return [];
  return rankVisibleLinkCandidates(goal, candidates, { firstPartyContentHub: isFirstPartyContentHub(state) });
}

function extractSnapshotLinkCandidates(snapshot: string, goal: string): Array<{ ref: string; text: string }> {
  const source = selectRelevantSnapshotSection(snapshot, goal);
  const candidates: Array<{ ref: string; text: string }> = [];
  const pattern = /- link "([^"]+)" \[ref=([^\]]+)\]/g;
  for (const match of source.matchAll(pattern)) {
    const text = match[1]?.replace(/\s+/g, ' ').trim();
    const ref = match[2]?.trim();
    if (!text || !ref || text.length < 12) continue;
    candidates.push({ ref: `@${ref}`, text });
    if (candidates.length >= 24) break;
  }
  return candidates;
}

function rankVisibleLinkCandidates(
  goal: string,
  candidates: Array<{ ref: string; text: string }>,
  context?: { firstPartyContentHub?: boolean },
): Array<{ ref: string; text: string; score: number }> {
  const signals = extractGoalSignals(goal);

  return candidates
    .map((candidate) => {
      const haystack = candidate.text.toLowerCase();
      let score = 0;
      for (const keyword of signals.keywords) {
        if (haystack.includes(keyword)) score += 2;
      }
      for (const phrase of signals.exactPhrases) {
        if (haystack.includes(phrase)) score += 4;
      }
      if (signals.wantsPressRelease && /\bpress release\b|\bnews release\b|\bnews releases\b/.test(haystack)) {
        score += 6;
      }
      if (signals.wantsPressRelease && context?.firstPartyContentHub && !/all news releases/.test(haystack)) {
        score += 4;
      }
      if (hasFullDate(haystack)) {
        score += 5;
      } else if (/\b\d{4}\b/.test(haystack)) {
        score += 1;
      }
      if (/all news releases/.test(haystack)) {
        score -= 3;
      }
      if (signals.wantsPressRelease && /\bnih research matters\b|\bnews in health\b|\bcatalyst\b|\bcalendar of events\b|\bsocial media\b/.test(haystack)) {
        score -= 8;
      }
      return { ...candidate, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function selectRelevantSnapshotSection(snapshot: string, goal: string): string {
  const lowerGoal = goal.toLowerCase();
  if (!/\bpress release\b|\bnews release\b/.test(lowerGoal) || !snapshot.toLowerCase().includes('recent news releases')) {
    return snapshot;
  }

  const lines = snapshot.split('\n');
  const start = lines.findIndex((line) => line.toLowerCase().includes('recent news releases'));
  if (start === -1) return snapshot;
  let end = lines.findIndex((line, index) => index > start && line.toLowerCase().includes('all news releases'));
  if (end === -1) end = Math.min(lines.length, start + 16);
  return lines.slice(start, end + 1).join('\n');
}

export function isFirstPartyContentHub(state: PageState): boolean {
  const url = state.url.toLowerCase();
  const snapshot = state.snapshot.toLowerCase();
  return (
    url.includes('/news-events') &&
    snapshot.includes('recent news releases')
  );
}
