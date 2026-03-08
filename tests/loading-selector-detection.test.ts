import { describe, expect, it } from 'vitest';
import { detectLoadingState, detectSelectorFailures } from '../src/recovery.js';
import type { Turn } from '../src/types.js';

describe('detectLoadingState', () => {
  it('detects "Loading..." with ellipsis', () => {
    expect(detectLoadingState('- text "Loading..."')).toBe(true);
  });

  it('detects "Loading.." with two dots', () => {
    expect(detectLoadingState('- text "Loading.."')).toBe(true);
  });

  it('detects case-insensitive "loading..."', () => {
    expect(detectLoadingState('LOADING...')).toBe(true);
  });

  it('detects spinner element', () => {
    expect(detectLoadingState('- spinner [ref=s1]')).toBe(true);
  });

  it('detects "Please wait"', () => {
    expect(detectLoadingState('- text "Please wait while we process your request"')).toBe(true);
  });

  it('detects "Fetching data"', () => {
    expect(detectLoadingState('- text "Fetching data from the server"')).toBe(true);
  });

  it('detects "Processing..." with ellipsis', () => {
    expect(detectLoadingState('- text "Processing..."')).toBe(true);
  });

  it('detects "Provisioning your container"', () => {
    expect(detectLoadingState('- text "Provisioning your container"')).toBe(true);
  });

  it('detects "Provisioning the environment"', () => {
    expect(detectLoadingState('- text "Provisioning the environment"')).toBe(true);
  });

  it('detects "Creating development environment"', () => {
    expect(detectLoadingState('- text "Creating development environment"')).toBe(true);
  });

  // False-positive avoidance
  it('does not trigger on "Loading dock" (no ellipsis)', () => {
    expect(detectLoadingState('- heading "Loading dock schedule"')).toBe(false);
  });

  it('does not trigger on "Processing fees" (no ellipsis)', () => {
    expect(detectLoadingState('- text "Processing fees apply to all orders"')).toBe(false);
  });

  it('does not trigger on "downloading" as a regular word', () => {
    expect(detectLoadingState('- text "Downloading files is not allowed"')).toBe(false);
  });

  it('does not trigger on normal page content', () => {
    expect(detectLoadingState('- heading "Welcome"\n- text "Click the button to start"\n- button "Start" [ref=b1]')).toBe(false);
  });

  it('does not trigger on "Provisioning" alone without qualifying phrase', () => {
    expect(detectLoadingState('- text "Provisioning details are in the manual"')).toBe(false);
  });

  it('does not trigger on empty snapshot', () => {
    expect(detectLoadingState('')).toBe(false);
  });

  it('detects loading state embedded in larger snapshot', () => {
    const snapshot = [
      '- navigation "Main"',
      '  - link "Home" [ref=l1]',
      '  - link "About" [ref=l2]',
      '- main:',
      '  - heading "Dashboard"',
      '  - spinner [ref=s1]',
      '  - text "Loading your data"',
    ].join('\n');
    expect(detectLoadingState(snapshot)).toBe(true);
  });
});

describe('detectSelectorFailures', () => {
  function makeTurn(idx: number, error?: string): Turn {
    return {
      turn: idx,
      state: { url: 'https://example.com', title: 'Test', snapshot: 'page content' },
      action: { action: 'click', selector: '@btn' },
      durationMs: 100,
      error,
    };
  }

  it('returns false when turns are below threshold', () => {
    expect(detectSelectorFailures([makeTurn(1, 'err')], 2)).toBe(false);
  });

  it('returns false when no turns have errors', () => {
    const turns = [makeTurn(1), makeTurn(2), makeTurn(3)];
    expect(detectSelectorFailures(turns, 2)).toBe(false);
  });

  it('returns true when all recent turns have errors at default threshold', () => {
    const turns = [makeTurn(1, 'selector not found'), makeTurn(2, 'click intercepted')];
    expect(detectSelectorFailures(turns, 2)).toBe(true);
  });

  it('only checks the most recent N turns (threshold window)', () => {
    const turns = [
      makeTurn(1),                       // no error
      makeTurn(2, 'selector not found'), // error
      makeTurn(3, 'click intercepted'),  // error
    ];
    // threshold = 2 means it only looks at turns[1] and turns[2]
    expect(detectSelectorFailures(turns, 2)).toBe(true);
  });

  it('returns false when only some recent turns have errors', () => {
    const turns = [
      makeTurn(1, 'error'),
      makeTurn(2),           // success breaks the streak
      makeTurn(3, 'error'),
    ];
    // The last 2 turns are index 1 (no error) and index 2 (error)
    expect(detectSelectorFailures(turns, 2)).toBe(false);
  });

  it('returns true with higher threshold when all have errors', () => {
    const turns = [
      makeTurn(1, 'err1'),
      makeTurn(2, 'err2'),
      makeTurn(3, 'err3'),
      makeTurn(4, 'err4'),
    ];
    expect(detectSelectorFailures(turns, 4)).toBe(true);
  });

  it('handles empty turns array gracefully', () => {
    expect(detectSelectorFailures([], 2)).toBe(false);
  });
});
