import { describe, expect, it } from 'vitest';
import { buildSearchResultsGuidance, rankSearchCandidates } from '../src/runner.js';

describe('buildSearchResultsGuidance', () => {
  it('returns structured extraction guidance on search result pages for extraction goals', () => {
    const guidance = buildSearchResultsGuidance(
      {
        url: 'https://search.usa.gov/search?affiliate=nih&query=alzheimers',
        title: 'Search Results | NIH',
        snapshot: '- link "NIH News Releases"\n- link "Press release about Alzheimer\'s disease"',
      },
      'Use the site search to extract the title and date of the first related press release.',
      ['www.nih.gov'],
    );

    expect(guidance).toContain('SEARCH RESULTS HEURISTIC');
    expect(guidance).toContain('use runScript to extract');
    expect(guidance).toContain('press release');
    expect(guidance).toContain('www.nih.gov');
  });

  it('returns empty string for non-search pages', () => {
    const guidance = buildSearchResultsGuidance(
      {
        url: 'https://www.nih.gov/news-events',
        title: 'News & Events',
        snapshot: '- heading "News & Events"',
      },
      'Find the Alzheimer press release.',
    );

    expect(guidance).toBe('');
  });

  it('ranks press releases ahead of weaker science-update matches', () => {
    const ranked = rankSearchCandidates('Find the first related press release about Alzheimer disease.', [
      {
        title: 'Suppressing protein may stem Alzheimer disease process',
        href: 'https://www.nimh.nih.gov/news/science-updates/2013/suppressing-protein-may-stem-alzheimers-disease-process',
      },
      {
        title: 'NIH News Release: New findings on Alzheimer disease',
        href: 'https://www.nih.gov/news-events/news-releases/new-findings-alzheimer-disease',
      },
    ], ['www.nih.gov']);

    expect(ranked[0]?.href).toContain('/news-events/news-releases/');
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });

  it('penalizes candidates outside the explicit allowlist', () => {
    const ranked = rankSearchCandidates('Find the first related press release about Alzheimer disease.', [
      {
        title: 'Press release on Alzheimer disease',
        href: 'https://www.nimh.nih.gov/news/press-release-alzheimer',
      },
      {
        title: 'NIH News Release: New findings on Alzheimer disease',
        href: 'https://www.nih.gov/news-events/news-releases/new-findings-alzheimer-disease',
      },
    ], ['www.nih.gov']);

    expect(ranked[0]?.href).toBe('https://www.nih.gov/news-events/news-releases/new-findings-alzheimer-disease');
    expect(ranked[1]?.href).toBe('https://www.nimh.nih.gov/news/press-release-alzheimer');
  });
});
