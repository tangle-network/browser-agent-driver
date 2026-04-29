import { describe, expect, it } from 'vitest';
import { containsSelfContradictingCompletion } from '../src/runner/completion-language.js';

describe('containsSelfContradictingCompletion', () => {
  it('flags blocked Google Flights completions that should not hit the verification fast path', () => {
    expect(containsSelfContradictingCompletion(
      'Blocked from completing the requested flight search within the remaining turn budget because the Google Flights date picker is still showing April/May 2026 instead of the requested January 25, 2026.',
    )).toBe(true);
  });

  it('flags partial answers that admit exact requested data was not reached', () => {
    expect(containsSelfContradictingCompletion(
      'I do not yet have the requested cheapest round-trip fare for Feb 27, 2026 to Mar 1, 2026 with max one stop, so the goal could not be fully completed from the current state.',
    )).toBe(true);
    expect(containsSelfContradictingCompletion(
      'This does not answer the goal because the required dates are not currently reachable in the displayed state.',
    )).toBe(true);
    expect(containsSelfContradictingCompletion(
      'However, the specific requested dates February 26, 2026 to February 28, 2026 are not currently visible in the extracted calendar evidence.',
    )).toBe(true);
    expect(containsSelfContradictingCompletion(
      'Unable to fully complete the exact requested search for March 30, 2026 because the active Google Flights query remained on Wed, Apr 29, 2026.',
    )).toBe(true);
    expect(containsSelfContradictingCompletion(
      'The requested March 30, 2026 date was not available in the live fare calendar.',
    )).toBe(true);
    expect(containsSelfContradictingCompletion(
      'Google Flights does not show the exact requested date March 30, 2026 in the currently available calendar view.',
    )).toBe(true);
  });

  it('does not flag concrete successful completions', () => {
    expect(containsSelfContradictingCompletion(
      'The cheapest visible flight is Delta 123 at $214, departing at 8:10 AM with one stop in Atlanta.',
    )).toBe(false);
  });
});
