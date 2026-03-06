import { describe, expect, it } from 'vitest';
import { buildFirstPartyBoundaryNote, shouldAcceptFirstPartyBoundaryCompletion } from '../src/domain-policy.js';

describe('buildFirstPartyBoundaryNote', () => {
  it('allows official sibling subdomains under the same registrable domain', () => {
    const goal = 'Visit the Open Government portal on Alberta.ca. Only use www.alberta.ca for this task.';
    const note = buildFirstPartyBoundaryNote(goal, 'https://open.alberta.ca/opendata');

    expect(note).toContain('open.alberta.ca');
    expect(note).toContain('alberta.ca');
    expect(note).toContain('same product/site');
  });

  it('returns nothing for unrelated domains', () => {
    const goal = 'Only use www.alberta.ca for this task.';
    expect(buildFirstPartyBoundaryNote(goal, 'https://example.com')).toBeUndefined();
  });

  it('returns nothing when already on the allowed host', () => {
    const goal = 'Only use www.alberta.ca for this task.';
    expect(buildFirstPartyBoundaryNote(goal, 'https://www.alberta.ca/open-government-program')).toBeUndefined();
  });

  it('accepts boundary-only verification failures when substantive evidence is present', () => {
    const goal = 'Only use www.alberta.ca for this task.';
    const verification = {
      achieved: false,
      confidence: 0.86,
      evidence: ['Current URL is https://open.alberta.ca/opendata which is a different host than www.alberta.ca.'],
      missing: ['Only host-boundary compliance remains uncertain.'],
    };
    const claimedResult = [
      'Found the dataset categories:',
      '- Health and Wellness',
      '- Society and Communities',
      '- Environment',
    ].join('\n');

    expect(
      shouldAcceptFirstPartyBoundaryCompletion(
        goal,
        'https://open.alberta.ca/opendata',
        verification,
        claimedResult,
      ),
    ).toBe(true);
  });
});
