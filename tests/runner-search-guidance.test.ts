import { describe, expect, it } from 'vitest';
import {
  buildSearchResultsGuidance,
  buildVisibleLinkRecommendation,
  chooseBranchLinkOverride,
  chooseExpandableListCompletionOverride,
  chooseNewsReleasesHubOverride,
  chooseSearchQueryOverride,
  chooseSearchResultsNewsTabOverride,
  chooseVisibleNewsReleaseResultOverride,
  chooseVisibleSearchResultOverride,
  chooseScoutLinkOverride,
  chooseVisibleLinkOverride,
  rankSearchCandidates,
  scoreBranchPreview,
  shouldUseBoundedBranchExplorer,
  shouldUseVisibleLinkScout,
  shouldUseVisibleLinkScoutPage,
} from '../src/runner.js';

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

  it('penalizes research-matters and topic pages for press-release tasks', () => {
    const ranked = rankSearchCandidates('Find the first related press release about Alzheimer disease.', [
      {
        title: "Blood tests show promise for early Alzheimer's diagnosis | National Institutes of Health (NIH)",
        href: 'https://www.nih.gov/news-events/nih-research-matters/blood-tests-show-promise-early-alzheimers-diagnosis',
      },
      {
        title: 'NIH News Releases | National Institutes of Health (NIH)',
        href: 'https://www.nih.gov/news-events/news-releases',
      },
      {
        title: "Alzheimer's Disease | National Institute on Aging",
        href: 'https://www.nia.nih.gov/health/alzheimers-disease',
      },
    ], ['www.nih.gov']);

    expect(ranked[0]?.href).toBe('https://www.nih.gov/news-events/news-releases');
    expect(ranked[ranked.length - 1]?.href).toContain('/health/alzheimers-disease');
  });

  it('recommends a visible first-party release link instead of re-searching', () => {
    const recommendation = buildVisibleLinkRecommendation(
      {
        url: 'https://www.nih.gov/news-events',
        title: 'News & Events',
        snapshot: [
          '- heading "Recent News Releases" [ref=h7dd]',
          '- link "Automated CT scan analysis could fast-track clinical assessments March 4, 2026 — NIH-funded research suggests AI-powered tool could streamline diagnoses and unveil early markers for chronic disease." [ref=lfad]:',
          '- searchbox "Search" [ref=s28e8]:',
          '- link "Study measuring changes in protein structure establishes new class of Alzheimer’s biomarkers February 27, 2026 — NIH-funded insights into Alzheimer’s biology could help with early diagnosis, future clinical trials." [ref=l1a78]:',
          '- link "All news releases »" [ref=l2baa]',
          '- link "NIH Research Matters A weekly update of research advances from the National Institutes of Health." [ref=l9e3]:',
        ].join('\n'),
      },
      'Use the site’s search feature to find information on "Alzheimer\'s disease" and extract the title and publication date of the first related press release.',
      ['www.nih.gov'],
    );

    expect(recommendation).toContain('@l1a78');
    expect(recommendation).toContain('first-party match');
    expect(recommendation).not.toContain('@l9e3');
  });

  it('does not override deliberate structural hub clicks to all news releases', () => {
    const state = {
      url: 'https://www.nih.gov/news-events',
      title: 'News & Events',
      snapshot: [
        '- heading "Recent News Releases" [ref=h7dd]',
        '- link "Study measuring changes in protein structure establishes new class of Alzheimer’s biomarkers February 27, 2026 — NIH-funded insights into Alzheimer’s biology could help with early diagnosis, future clinical trials." [ref=l1a78]:',
        '- link "All news releases »" [ref=l2baa]',
      ].join('\n'),
    };
    const override = chooseVisibleLinkOverride(
      state,
      { action: 'click', selector: '@l2baa' },
      { ref: '@l1a78', text: 'Study measuring changes in protein structure establishes new class of Alzheimer’s biomarkers', score: 17 },
    );

    expect(override).toBeUndefined();
  });

  it('uses scout on ambiguous visible link choices', () => {
    expect(shouldUseVisibleLinkScout([
      { ref: '@a1', text: 'Primary result', score: 10 },
      { ref: '@a2', text: 'Secondary result', score: 8 },
    ], { minTopScore: 12, maxScoreGap: 4 })).toBe(true);

    expect(shouldUseVisibleLinkScout([
      { ref: '@a1', text: 'Primary result', score: 18 },
      { ref: '@a2', text: 'Secondary result', score: 8 },
    ], { minTopScore: 12, maxScoreGap: 4 })).toBe(false);
  });

  it('limits scout activation to search pages and first-party content hubs', () => {
    expect(shouldUseVisibleLinkScoutPage(
      {
        url: 'https://www.alberta.ca/',
        title: 'Government of Alberta | Alberta.ca',
        snapshot: '- searchbox "Search Alberta.ca" [ref=s3e25]\n- link "About government" [ref=l1685]',
      },
      'Visit the Open Government portal and list dataset categories.',
      ['www.alberta.ca'],
    )).toBe(false);

    expect(shouldUseVisibleLinkScoutPage(
      {
        url: 'https://search.alberta.ca/alberta/Pages/results.aspx?k=Open+Government',
        title: 'Search: Open Government',
        snapshot: '- heading "Search Results"\n- link "Open Government program | Alberta.ca" [ref=l110d]',
      },
      'Visit the Open Government portal and list dataset categories.',
      ['www.alberta.ca'],
    )).toBe(true);
  });

  it('can override a search detour with a high-confidence scout recommendation', () => {
    const state = {
      url: 'https://www.nih.gov/news-events',
      title: 'News & Events',
      snapshot: [
        '- link "Search" [ref=s1]',
        '- link "Study measuring changes in protein structure establishes new class of Alzheimer’s biomarkers February 27, 2026" [ref=l1a78]:',
      ].join('\n'),
    };

    const override = chooseScoutLinkOverride(
      state,
      { action: 'click', selector: '@s1' },
      {
        ref: '@l1a78',
        text: 'Study measuring changes in protein structure establishes new class of Alzheimer’s biomarkers',
        confidence: 0.82,
        reasoning: 'This visible release link is a stronger direct match than re-opening search.',
      },
    );

    expect(override?.ref).toBe('@l1a78');
    expect(override?.feedback).toContain('Scout recommendation');
  });

  it('switches to the visible News tab before opening generic search results for press-release tasks', () => {
    const override = chooseSearchResultsNewsTabOverride(
      {
        url: 'https://search.usa.gov/search?affiliate=nih&query=alzheimers',
        title: 'Search Results | NIH',
        snapshot: [
          '- link "Everything" [ref=l12a4]',
          '- link "News" [ref=l3712]',
          '- link "Alzheimer\'s Disease | National Institute on Aging" [ref=l2e2c]',
        ].join('\n'),
      },
      'Use the site’s search feature to find information on "Alzheimer\'s disease" and extract the title and publication date of the first related press release.',
      { action: 'click', selector: '@l2e2c' },
    );

    expect(override?.ref).toBe('@l3712');
    expect(override?.feedback).toContain('News tab');
  });

  it('uses the exact quoted task query in site search boxes', () => {
    const override = chooseSearchQueryOverride(
      {
        url: 'https://www.nih.gov/',
        title: 'NIH',
        snapshot: '- searchbox "Search" [ref=s28e8]:',
      },
      'Use the site’s search feature to find information on "Alzheimer\'s disease" and extract the title and publication date of the first related press release.',
      { action: 'type', selector: '@s28e8', text: "Alzheimer's disease press release" },
    );

    expect(override?.selector).toBe('@s28e8');
    expect(override?.query).toBe("Alzheimer's disease");
    expect(override?.feedback).toContain('exact task query');
  });

  it('routes NIH news-event clicks through the news releases hub for search-backed press-release tasks', () => {
    const override = chooseNewsReleasesHubOverride(
      {
        url: 'https://www.nih.gov/news-events',
        title: 'News & Events',
        snapshot: [
          '- link "Automated CT scan analysis could fast-track clinical assessments March 4, 2026" [ref=lfad]',
          '- link "All news releases »" [ref=l2baa]',
        ].join('\n'),
      },
      'Use the site’s search feature to find information on "Alzheimer\'s disease" and extract the title and publication date of the first related press release.',
      { action: 'click', selector: '@lfad' },
    );

    expect(override?.ref).toBe('@l2baa');
    expect(override?.feedback).toContain('News Releases hub');
  });

  it('clicks the visible matching release instead of re-submitting the news releases search', () => {
    const override = chooseVisibleNewsReleaseResultOverride(
      {
        url: 'https://www.nih.gov/news-events/news-releases',
        title: 'News Releases',
        snapshot: [
          '- searchbox "Search NIH news releases" [ref=s1eec] [value="alzheimer\'s disease"]:',
          '- button "Search" [ref=b3aed_1]:',
          '- link "Study measuring changes in protein structure establishes new class of Alzheimer’s biomarkers February 27, 2026 — NIH-funded insights into Alzheimer’s biology could help with early diagnosis, future clinical trials." [ref=l2eda]',
        ].join('\n'),
      },
      'Use the site’s search feature to find information on "Alzheimer\'s disease" and extract the title and publication date of the first related press release.',
      { action: 'press', selector: '@s1eec', key: 'Enter' },
    );

    expect(override?.ref).toBe('@l2eda');
    expect(override?.feedback).toContain('already visible');
  });

  it('prefers the visible product result over help or policy links on search pages', () => {
    const override = chooseVisibleSearchResultOverride(
      {
        url: 'https://www.johnlewis.com/search?search-term=organic+cotton+towels',
        title: 'Search results',
        snapshot: [
          '- textbox "Search" [ref=t104b] [value="organic cotton towels"]',
          '- heading "\'organic cotton towels\'" [ref=h22ff]:',
          '- link "John Lewis Organic Cotton Towels" [ref=l49c]:',
          '- link "Customer services" [ref=l1533]',
          '- link "Reviews policy" [ref=l3ab8]',
        ].join('\n'),
      },
      'Use the product search function to look up "organic cotton towels" and extract the customer review section summary for the top result.',
      ['www.johnlewis.com'],
      { action: 'click', selector: '@l3ab8' },
    );

    expect(override?.ref).toBe('@l49c');
    expect(override?.feedback).toContain('stronger visible search result');
  });

  it('forces SHOW MORE expansion before completing list/category goals', () => {
    const override = chooseExpandableListCompletionOverride(
      {
        url: 'https://open.alberta.ca/opendata',
        title: 'opendata - Open Government',
        snapshot: [
          '- heading "Topic"',
          '- link "Agriculture" [ref=la1]',
          '- link "SHOW MORE (23)" [ref=l705]',
        ].join('\n'),
      },
      'Visit the Open Government portal and list dataset categories.',
      { action: 'complete', result: 'Categories listed.' },
    );

    expect(override?.ref).toBe('@l705');
    expect(override?.feedback).toContain('not fully visible');
  });

  it('uses bounded-branch override on ambiguous candidate clicks', () => {
    const override = chooseBranchLinkOverride(
      {
        url: 'https://search.usa.gov/search?affiliate=nih&query=alzheimers',
        title: 'Search Results | NIH',
        snapshot: '- link "Research Matters article" [ref=l1]\n- link "NIH News Releases" [ref=l2]',
      },
      { action: 'click', selector: '@l1' },
      {
        ref: '@l2',
        text: 'NIH News Releases',
        confidence: 0.8,
        reasoning: 'Preview of the release hub is a stronger content-type match.',
      },
    );

    expect(override?.ref).toBe('@l2');
    expect(override?.feedback).toContain('Bounded branch preview');
  });

  it('scores release pages above research-matters pages for press-release goals', () => {
    const goal = 'Use the site search to find the first related press release and extract the title and date.';
    const releaseScore = scoreBranchPreview(goal, {
      finalUrl: 'https://www.nih.gov/news-events/news-releases/example-release',
      title: 'Example release | National Institutes of Health (NIH)',
      text: 'News Releases Friday, February 27, 2026 Example release body text',
    }, ['www.nih.gov']);
    const articleScore = scoreBranchPreview(goal, {
      finalUrl: 'https://www.nih.gov/news-events/nih-research-matters/example-article',
      title: 'Example article | National Institutes of Health (NIH)',
      text: 'NIH Research Matters May 14, 2019 Example article body text',
    }, ['www.nih.gov']);

    expect(releaseScore).toBeGreaterThan(articleScore);
  });

  it('enables bounded branching only for ambiguous candidate sets', () => {
    expect(shouldUseBoundedBranchExplorer([
      { ref: '@a1', text: 'Primary result', score: 10 },
      { ref: '@a2', text: 'Secondary result', score: 9 },
    ], { minTopScore: 12, maxScoreGap: 4 })).toBe(true);

    expect(shouldUseBoundedBranchExplorer([
      { ref: '@a1', text: 'Primary result', score: 18 },
      { ref: '@a2', text: 'Secondary result', score: 8 },
    ], { minTopScore: 12, maxScoreGap: 4 })).toBe(false);
  });
});
