import { describe, expect, it } from 'vitest';
import {
  findElementForRef,
  safeHostname,
  requiresSearchWorkflowEvidence,
  requiresPressReleaseLikeContent,
  looksLikeSearchResultsPage,
  normalizeLooseText,
  extractRelevantSnapshotExcerpt,
  findLinkRefByExactText,
  findLinkRefContainingText,
  pushGoalVerificationEvidence,
  hasFullDate,
  PRESS_RELEASE_RE,
  NON_RELEASE_CONTENT_RE,
  NON_RELEASE_URL_RE,
} from '../src/runner/utils.js';

// ---------------------------------------------------------------------------
// findElementForRef
// ---------------------------------------------------------------------------

describe('findElementForRef', () => {
  it('finds a button by ref', () => {
    const snapshot = '- button "Submit" [ref=b1]\n- link "Home" [ref=l2]';
    expect(findElementForRef(snapshot, '@b1')).toBe('button "Submit"');
  });

  it('finds a link by ref', () => {
    const snapshot = '- button "Submit" [ref=b1]\n- link "Home" [ref=l2]';
    expect(findElementForRef(snapshot, '@l2')).toBe('link "Home"');
  });

  it('returns undefined when ref is not found', () => {
    const snapshot = '- button "Submit" [ref=b1]';
    expect(findElementForRef(snapshot, '@z99')).toBeUndefined();
  });

  it('returns undefined when selector does not start with @', () => {
    const snapshot = '- button "Submit" [ref=b1]';
    expect(findElementForRef(snapshot, 'b1')).toBeUndefined();
  });

  it('handles refs with mixed characters', () => {
    const snapshot = '- textbox "Email" [ref=t1f2a]';
    expect(findElementForRef(snapshot, '@t1f2a')).toBe('textbox "Email"');
  });
});

// ---------------------------------------------------------------------------
// safeHostname
// ---------------------------------------------------------------------------

describe('safeHostname', () => {
  it('extracts hostname from valid URL', () => {
    expect(safeHostname('https://www.example.com/page')).toBe('www.example.com');
  });

  it('lowercases the hostname', () => {
    expect(safeHostname('https://WWW.EXAMPLE.COM')).toBe('www.example.com');
  });

  it('returns undefined for invalid URL', () => {
    expect(safeHostname('not-a-url')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(safeHostname('')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// requiresSearchWorkflowEvidence
// ---------------------------------------------------------------------------

describe('requiresSearchWorkflowEvidence', () => {
  it('detects "site\'s search feature"', () => {
    expect(requiresSearchWorkflowEvidence("use the site's search feature to find products")).toBe(true);
  });

  it('detects right single quote variant', () => {
    expect(requiresSearchWorkflowEvidence("use the site\u2019s search feature")).toBe(true);
  });

  it('detects "site search"', () => {
    expect(requiresSearchWorkflowEvidence('use site search to locate items')).toBe(true);
  });

  it('returns false for unrelated goals', () => {
    expect(requiresSearchWorkflowEvidence('navigate to the homepage')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requiresPressReleaseLikeContent
// ---------------------------------------------------------------------------

describe('requiresPressReleaseLikeContent', () => {
  it('detects "press release"', () => {
    expect(requiresPressReleaseLikeContent('Find the latest press release')).toBe(true);
  });

  it('detects "news release"', () => {
    expect(requiresPressReleaseLikeContent('Open the news release about the merger')).toBe(true);
  });

  it('returns false for unrelated goals', () => {
    expect(requiresPressReleaseLikeContent('Navigate to the blog')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PRESS_RELEASE_RE / NON_RELEASE_CONTENT_RE / NON_RELEASE_URL_RE
// ---------------------------------------------------------------------------

describe('regex constants', () => {
  it('PRESS_RELEASE_RE matches press release text', () => {
    expect(PRESS_RELEASE_RE.test('Latest Press Release')).toBe(true);
    expect(PRESS_RELEASE_RE.test('News Release from CEO')).toBe(true);
    expect(PRESS_RELEASE_RE.test('Blog post')).toBe(false);
  });

  it('NON_RELEASE_CONTENT_RE matches non-release content signals', () => {
    expect(NON_RELEASE_CONTENT_RE.test('NIH Research Matters article')).toBe(true);
    expect(NON_RELEASE_CONTENT_RE.test('News in Health newsletter')).toBe(true);
    expect(NON_RELEASE_CONTENT_RE.test('fact sheet about diabetes')).toBe(true);
    expect(NON_RELEASE_CONTENT_RE.test('press release about new drug')).toBe(false);
  });

  it('NON_RELEASE_URL_RE matches non-release URL patterns', () => {
    expect(NON_RELEASE_URL_RE.test('/nih-research-matters/article-123')).toBe(true);
    expect(NON_RELEASE_URL_RE.test('/health/diabetes')).toBe(true);
    expect(NON_RELEASE_URL_RE.test('/blog/post-1')).toBe(true);
    expect(NON_RELEASE_URL_RE.test('/press-releases/2026')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// looksLikeSearchResultsPage
// ---------------------------------------------------------------------------

describe('looksLikeSearchResultsPage', () => {
  it('detects search keyword in URL', () => {
    const state = { url: 'https://example.com/search?q=test', title: 'Page', snapshot: '' };
    expect(looksLikeSearchResultsPage(state)).toBe(true);
  });

  it('detects "search results" in title', () => {
    const state = { url: 'https://example.com', title: 'Search Results', snapshot: '' };
    expect(looksLikeSearchResultsPage(state)).toBe(true);
  });

  it('detects query= in URL', () => {
    const state = { url: 'https://example.com?query=hello', title: 'Page', snapshot: '' };
    expect(looksLikeSearchResultsPage(state)).toBe(true);
  });

  it('returns false for non-search pages', () => {
    const state = { url: 'https://example.com/about', title: 'About', snapshot: 'company info' };
    expect(looksLikeSearchResultsPage(state)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeLooseText
// ---------------------------------------------------------------------------

describe('normalizeLooseText', () => {
  it('lowercases and removes non-alphanumeric characters', () => {
    expect(normalizeLooseText('Hello, World!')).toBe('hello world');
  });

  it('trims whitespace', () => {
    expect(normalizeLooseText('  foo  bar  ')).toBe('foo bar');
  });

  it('handles empty string', () => {
    expect(normalizeLooseText('')).toBe('');
  });

  it('preserves digits', () => {
    expect(normalizeLooseText('Item #42 (v2.0)')).toBe('item 42 v2 0');
  });
});

// ---------------------------------------------------------------------------
// extractRelevantSnapshotExcerpt
// ---------------------------------------------------------------------------

describe('extractRelevantSnapshotExcerpt', () => {
  const snapshot = [
    'line 0: header',
    'line 1: navigation',
    'line 2: search box',
    'line 3: results',
    'line 4: footer',
    'line 5: copyright',
  ].join('\n');

  it('extracts context around matching terms', () => {
    const excerpt = extractRelevantSnapshotExcerpt(snapshot, ['search']);
    expect(excerpt).toContain('search box');
    // Should include context before and after
    expect(excerpt).toContain('line 1: navigation');
    expect(excerpt).toContain('line 4: footer');
  });

  it('returns first 12 lines when no terms match', () => {
    const excerpt = extractRelevantSnapshotExcerpt(snapshot, ['nonexistent']);
    expect(excerpt).toContain('line 0: header');
  });

  it('filters empty terms', () => {
    const excerpt = extractRelevantSnapshotExcerpt(snapshot, ['', 'results']);
    expect(excerpt).toContain('results');
  });

  it('handles multiple matching terms', () => {
    const excerpt = extractRelevantSnapshotExcerpt(snapshot, ['header', 'footer']);
    // Should span from before first match to after last match
    expect(excerpt).toContain('line 0: header');
    expect(excerpt).toContain('line 4: footer');
  });
});

// ---------------------------------------------------------------------------
// findLinkRefByExactText
// ---------------------------------------------------------------------------

describe('findLinkRefByExactText', () => {
  it('finds a link with exact matching text', () => {
    const snapshot = '- link "Home" [ref=l1]\n- link "About Us" [ref=l2]';
    expect(findLinkRefByExactText(snapshot, 'About Us')).toBe('@l2');
  });

  it('returns undefined when text does not match exactly', () => {
    const snapshot = '- link "About Us" [ref=l2]';
    expect(findLinkRefByExactText(snapshot, 'About')).toBeUndefined();
  });

  it('returns undefined when no links exist', () => {
    const snapshot = '- button "Submit" [ref=b1]';
    expect(findLinkRefByExactText(snapshot, 'Submit')).toBeUndefined();
  });

  it('escapes regex special characters in search text', () => {
    const snapshot = '- link "Price ($)" [ref=l1]';
    expect(findLinkRefByExactText(snapshot, 'Price ($)')).toBe('@l1');
  });
});

// ---------------------------------------------------------------------------
// findLinkRefContainingText
// ---------------------------------------------------------------------------

describe('findLinkRefContainingText', () => {
  it('finds a link containing the search text', () => {
    const snapshot = '- link "About Us - Company Info" [ref=l2]';
    expect(findLinkRefContainingText(snapshot, 'About')).toBe('@l2');
  });

  it('is case-insensitive', () => {
    const snapshot = '- link "About Us" [ref=l2]';
    expect(findLinkRefContainingText(snapshot, 'about')).toBe('@l2');
  });

  it('returns undefined when no match', () => {
    const snapshot = '- link "Home" [ref=l1]';
    expect(findLinkRefContainingText(snapshot, 'Contact')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pushGoalVerificationEvidence
// ---------------------------------------------------------------------------

describe('pushGoalVerificationEvidence', () => {
  it('adds evidence to the array', () => {
    const evidence: string[] = [];
    pushGoalVerificationEvidence(evidence, 'Evidence 1');
    expect(evidence).toEqual(['Evidence 1']);
  });

  it('caps at 5 entries', () => {
    const evidence: string[] = [];
    for (let i = 1; i <= 7; i++) {
      pushGoalVerificationEvidence(evidence, `Evidence ${i}`);
    }
    expect(evidence).toHaveLength(5);
    expect(evidence[0]).toBe('Evidence 3');
    expect(evidence[4]).toBe('Evidence 7');
  });

  it('removes oldest entries when exceeding cap', () => {
    const evidence = ['A', 'B', 'C', 'D', 'E'];
    pushGoalVerificationEvidence(evidence, 'F');
    expect(evidence).toHaveLength(5);
    expect(evidence[0]).toBe('B');
    expect(evidence[4]).toBe('F');
  });
});

// ---------------------------------------------------------------------------
// hasFullDate
// ---------------------------------------------------------------------------

describe('hasFullDate', () => {
  it('detects a full date like "January 15, 2026"', () => {
    expect(hasFullDate('Published on January 15, 2026')).toBe(true);
  });

  it('detects various months', () => {
    expect(hasFullDate('December 1, 2025')).toBe(true);
    expect(hasFullDate('February 28, 2024')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(hasFullDate('MARCH 5, 2026')).toBe(true);
  });

  it('returns false for partial dates', () => {
    expect(hasFullDate('January 2026')).toBe(false);
    expect(hasFullDate('15, 2026')).toBe(false);
  });

  it('returns false for no date', () => {
    expect(hasFullDate('Just some text')).toBe(false);
  });
});
