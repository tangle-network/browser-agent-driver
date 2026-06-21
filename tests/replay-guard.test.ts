import { describe, expect, it } from 'vitest';
import { RefPerformabilityGuard, createReplayGuard } from '../src/runner/replay/guard.js';
import type { ReplayObservation, ReplayStep } from '../src/runner/replay/contracts.js';

const SNAPSHOT_WITH_REFS = [
  '- button "Sign in" [ref=b2a1]',
  '- textbox "Email" [ref=t3f0] [value=""]',
  '- link "Home" [ref=la3c]',
].join('\n');

function step(action: ReplayStep['action'], url = 'https://example.com/login'): ReplayStep {
  return { url, action, snapshotHash: '0' };
}

function obs(snapshot: string, url = 'https://example.com/login'): ReplayObservation {
  return { url, snapshot };
}

describe('RefPerformabilityGuard', () => {
  const guard = new RefPerformabilityGuard();

  it('proceeds when the @ref target is still present in the live snapshot', () => {
    const result = guard.check(
      step({ action: 'click', selector: '@b2a1' }),
      obs(SNAPSHOT_WITH_REFS),
    );
    expect(result.decision).toBe('proceed');
  });

  it('aborts when the @ref target has vanished from the live snapshot', () => {
    const result = guard.check(
      step({ action: 'click', selector: '@b2a1' }),
      obs('- heading "Logged out" [ref=h001]'),
    );
    expect(result.decision).toBe('abort');
    if (result.decision === 'abort') {
      expect(result.reason).toContain('@b2a1');
    }
  });

  it('aborts on origin drift regardless of ref presence', () => {
    const result = guard.check(
      step({ action: 'click', selector: '@b2a1' }, 'https://example.com/login'),
      // ref is present, but the live page is on a different origin
      obs(SNAPSHOT_WITH_REFS, 'https://evil.example.org/login'),
    );
    expect(result.decision).toBe('abort');
    if (result.decision === 'abort') {
      expect(result.reason).toContain('origin drift');
    }
  });

  it('proceeds when origins match exactly (different path/query is fine)', () => {
    const result = guard.check(
      step({ action: 'type', selector: '@t3f0', text: 'a@b.com' }, 'https://example.com/login'),
      obs(SNAPSHOT_WITH_REFS, 'https://example.com/login?next=%2Fdash'),
    );
    expect(result.decision).toBe('proceed');
  });

  it('defers (proceeds) for non-@ref selectors it cannot statically resolve', () => {
    const result = guard.check(
      step({ action: 'click', selector: 'button.submit' }),
      obs('- generic "nothing addressable here" [ref=z999]'),
    );
    expect(result.decision).toBe('proceed');
  });

  it('proceeds for actions with no element target (navigate) on a consistent origin', () => {
    const result = guard.check(
      step({ action: 'navigate', url: 'https://example.com/dashboard' }),
      obs(SNAPSHOT_WITH_REFS),
    );
    expect(result.decision).toBe('proceed');
  });

  it('skips the origin gate when a URL is unparseable (about:blank)', () => {
    const result = guard.check(
      step({ action: 'click', selector: '@b2a1' }, 'about:blank'),
      obs(SNAPSHOT_WITH_REFS, 'https://example.com/login'),
    );
    expect(result.decision).toBe('proceed');
  });

  it('aborts a batch fill when any targeted @ref is missing', () => {
    const result = guard.check(
      step({ action: 'fill', fields: { '@t3f0': 'x', '@missing': 'y' } }),
      obs(SNAPSHOT_WITH_REFS),
    );
    expect(result.decision).toBe('abort');
    if (result.decision === 'abort') {
      expect(result.reason).toContain('@missing');
    }
  });

  it('proceeds a batch fill when every targeted @ref is present', () => {
    const result = guard.check(
      step({ action: 'fill', fields: { '@t3f0': 'x' }, checks: ['@b2a1'] }),
      obs(SNAPSHOT_WITH_REFS),
    );
    expect(result.decision).toBe('proceed');
  });

  it('createReplayGuard returns a working guard instance', () => {
    const result = createReplayGuard().check(
      step({ action: 'click', selector: '@la3c' }),
      obs(SNAPSHOT_WITH_REFS),
    );
    expect(result.decision).toBe('proceed');
  });
});
