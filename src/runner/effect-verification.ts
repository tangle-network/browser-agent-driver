import type { PageState } from '../types.js';
import { normalizeLooseText } from './utils.js';

const GENERIC_EFFECT_TOKENS = new Set([
  'a',
  'an',
  'and',
  'be',
  'become',
  'browser',
  'change',
  'contain',
  'continue',
  'directly',
  'effect',
  'exact',
  'have',
  'include',
  'into',
  'it',
  'its',
  'list',
  'page',
  'query',
  'remaining',
  'result',
  'results',
  'run',
  'search',
  'should',
  'site',
  'state',
  'switch',
  'task',
  'that',
  'the',
  'their',
  'them',
  'to',
  'visible',
]);

export interface EffectVerificationInput {
  expectedEffect: string;
  preActionState: PageState;
  postActionState: PageState;
}

export interface EffectVerificationResult {
  verified: boolean;
  reason?: string;
}

function hasStateChanged(pre: PageState, post: PageState): boolean {
  return (
    pre.url !== post.url
    || pre.title !== post.title
    || pre.snapshot !== post.snapshot
  );
}

function getAddedLines(preSnapshot: string, postSnapshot: string): string[] {
  const prior = new Set(
    preSnapshot.split('\n').map((line) => line.trim()).filter(Boolean),
  );
  return postSnapshot
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !prior.has(line));
}

function getRemovedLines(preSnapshot: string, postSnapshot: string): string[] {
  const next = new Set(
    postSnapshot.split('\n').map((line) => line.trim()).filter(Boolean),
  );
  return preSnapshot
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !next.has(line));
}

function includesLoose(haystack: string, needle: string): boolean {
  const normalizedHaystack = normalizeLooseText(haystack);
  const normalizedNeedle = normalizeLooseText(needle);
  return normalizedNeedle.length > 0 && normalizedHaystack.includes(normalizedNeedle);
}

function getCandidateKeywords(expectedEffect: string): string[] {
  const normalized = normalizeLooseText(expectedEffect);
  return normalized
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !GENERIC_EFFECT_TOKENS.has(token));
}

function matchesKeywordDelta(expectedEffect: string, pre: PageState, post: PageState): boolean {
  const keywords = getCandidateKeywords(expectedEffect);
  if (keywords.length === 0) return false;

  const preText = `${pre.url}\n${pre.title}\n${pre.snapshot}`;
  const postText = `${post.url}\n${post.title}\n${post.snapshot}`;
  return keywords.some((keyword) => includesLoose(postText, keyword) && !includesLoose(preText, keyword));
}

export function verifyExpectedEffect({
  expectedEffect,
  preActionState,
  postActionState,
}: EffectVerificationInput): EffectVerificationResult {
  if (/url\s+should/i.test(expectedEffect)) {
    const currentUrl = postActionState.url;
    const quotedVal = expectedEffect.match(/['"]([^'"]+)['"]/);
    const verbVal = expectedEffect.match(/url\s+should\s+(?:contain|include|have)\s+(\S+)/i);
    const expected = quotedVal?.[1] ?? verbVal?.[1];

    if (expected) {
      if (currentUrl.includes(expected)) {
        return { verified: true };
      }
      return {
        verified: false,
        reason: `Expected URL to contain "${expected}" but got "${currentUrl}"`,
      };
    }

    if (currentUrl !== preActionState.url) {
      return { verified: true };
    }
    return {
      verified: false,
      reason: `Expected URL to change but it stayed at "${currentUrl}"`,
    };
  }

  const changed = hasStateChanged(preActionState, postActionState);
  const effectLower = expectedEffect.toLowerCase();
  const quotedMatch = expectedEffect.match(/["']([^"']+)["']/);
  const addedLines = getAddedLines(preActionState.snapshot, postActionState.snapshot);
  const removedLines = getRemovedLines(preActionState.snapshot, postActionState.snapshot);
  const postText = `${postActionState.url}\n${postActionState.title}\n${postActionState.snapshot}`;

  if (quotedMatch) {
    const searchText = quotedMatch[1];
    if (includesLoose(postText, searchText)) {
      return { verified: true };
    }
    return {
      verified: false,
      reason: `Expected "${searchText}" to appear in the updated page state`,
    };
  }

  if (/(close|dismiss|hide|disappear|go away)/i.test(effectLower)) {
    if (/\bmodal\b|\bdialog\b|\balertdialog\b/.test(effectLower)) {
      const preHasDialog = /\b(dialog|alertdialog)\b/i.test(preActionState.snapshot);
      const postHasDialog = /\b(dialog|alertdialog)\b/i.test(postActionState.snapshot);
      if (preHasDialog && !postHasDialog) {
        return { verified: true };
      }
    }
    if (removedLines.length > 0 && changed) {
      return { verified: true };
    }
    return {
      verified: false,
      reason: `Expected "${expectedEffect}" but the prior UI state still appears present`,
    };
  }

  if (/(visible|appear|show|open|reveal|expand)/i.test(effectLower)) {
    if (matchesKeywordDelta(expectedEffect, preActionState, postActionState)) {
      return { verified: true };
    }
    if (addedLines.length > 0) {
      return { verified: true };
    }
    return {
      verified: false,
      reason: `Expected "${expectedEffect}" but no new visible UI evidence appeared`,
    };
  }

  if (/(switch|load|navigate|redirect)/i.test(effectLower)) {
    if (postActionState.url !== preActionState.url || postActionState.title !== preActionState.title) {
      return { verified: true };
    }
    if (matchesKeywordDelta(expectedEffect, preActionState, postActionState)) {
      return { verified: true };
    }
    return {
      verified: false,
      reason: `Expected "${expectedEffect}" but the page identity did not materially change`,
    };
  }

  if (matchesKeywordDelta(expectedEffect, preActionState, postActionState)) {
    return { verified: true };
  }

  if (changed) {
    return { verified: true };
  }

  return {
    verified: false,
    reason: `Expected effect "${expectedEffect}" — page did not change`,
  };
}
