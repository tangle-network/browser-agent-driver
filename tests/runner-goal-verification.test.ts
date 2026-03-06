import { describe, expect, it } from 'vitest';
import { buildGoalVerificationClaim, shouldAcceptScriptBackedCompletion } from '../src/runner.js';

describe('buildGoalVerificationClaim', () => {
  it('returns the raw claim when no evidence is present', () => {
    expect(buildGoalVerificationClaim('done', [])).toBe('done');
  });

  it('appends supplemental evidence for the verifier', () => {
    expect(buildGoalVerificationClaim('done', ['SCRIPT RESULT:\nmission text']))
      .toContain('SUPPLEMENTAL TOOL EVIDENCE:');
    expect(buildGoalVerificationClaim('done', ['SCRIPT RESULT:\nmission text']))
      .toContain('mission text');
  });

  it('keeps only the most recent evidence entries', () => {
    const claim = buildGoalVerificationClaim('done', [
      'evidence-1',
      'evidence-2',
      'evidence-3',
      'evidence-4',
    ]);
    expect(claim).not.toContain('evidence-1');
    expect(claim).toContain('evidence-2');
    expect(claim).toContain('evidence-3');
    expect(claim).toContain('evidence-4');
  });

  it('accepts script-backed completions when verifier only lacks visible evidence', () => {
    const accepted = shouldAcceptScriptBackedCompletion(
      'Use the site search to find the first related press release and extract the title and date.',
      {
        url: 'https://www.nih.gov/news-events/news-releases/example',
        title: 'Example',
        snapshot: '- heading "Example"',
      },
      {
        achieved: false,
        confidence: 0.73,
        evidence: ['Current page matches the claimed article, but the publication date is not visible in the accessibility tree.'],
        missing: ['Need visible publication date evidence.'],
      },
      [
        'NIH site search used: https://www.nih.gov/search/node?keys=Alzheimer%27s%20disease',
        'Publication date: February 28, 2019',
        'Article URL: https://www.nih.gov/news-events/news-releases/example',
      ].join('\n'),
      [
        'SCRIPT RESULT:\n{"date":"February 28, 2019","title":"Example"}',
      ],
    );

    expect(accepted).toBe(true);
  });

  it('rejects script-backed completions when the goal requires a press release but evidence points to another content type', () => {
    const accepted = shouldAcceptScriptBackedCompletion(
      'Use the site search to find the first related press release and extract the title and date.',
      {
        url: 'https://www.nih.gov/news-events/nih-research-matters/gene-expression-signatures-alzheimers-disease',
        title: "Gene expression signatures of Alzheimer's disease",
        snapshot: '- heading "Gene expression signatures of Alzheimer\'s disease"',
      },
      {
        achieved: false,
        confidence: 0.73,
        evidence: ['The current URL is an NIH Research Matters article, not a press release page.'],
        missing: ['Need the first related press release.'],
      },
      [
        'URL: https://www.nih.gov/news-events/nih-research-matters/gene-expression-signatures-alzheimers-disease',
        `Title: "Gene expression signatures of Alzheimer's disease"`,
        'Publication date: May 14, 2019',
      ].join('\n'),
      [
        `SCRIPT RESULT:\n{"date":"May 14, 2019","title":"Gene expression signatures of Alzheimer's disease"}`,
      ],
    );

    expect(accepted).toBe(false);
  });
});
