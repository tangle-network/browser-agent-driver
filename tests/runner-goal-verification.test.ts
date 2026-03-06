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
});
