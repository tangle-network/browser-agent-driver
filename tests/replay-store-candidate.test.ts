import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TrajectoryStore } from '../src/memory/store.js';
import type { Trajectory } from '../src/types.js';

function writeTrajectory(dir: string, t: Trajectory): void {
  fs.writeFileSync(path.join(dir, `${t.id}.json`), JSON.stringify(t, null, 2));
}

function tmpStoreDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'abd-replay-cand-'));
}

function successTrajectory(input: { id: string; goal: string; origin: string }): Trajectory {
  return {
    id: input.id,
    goal: input.goal,
    origin: input.origin,
    success: true,
    durationMs: 12_000,
    model: 'gpt-5.4',
    timestamp: new Date().toISOString(),
    steps: [
      { url: `${input.origin}/x`, action: { action: 'click', selector: '@a1' }, snapshotHash: '1', verified: true },
    ],
  };
}

describe('TrajectoryStore.findReplayCandidate', () => {
  it('returns the trajectory + similarity + normalized origin for a strict match', () => {
    const dir = tmpStoreDir();
    writeTrajectory(dir, successTrajectory({
      id: 'm1',
      goal: 'search the docs for rate limits',
      origin: 'https://example.com',
    }));
    const store = new TrajectoryStore(dir);

    const candidate = store.findReplayCandidate('search the docs for rate limits', {
      origin: 'https://example.com/start',
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.trajectory.id).toBe('m1');
    expect(candidate?.similarity).toBe(1);
    expect(candidate?.origin).toBe('https://example.com');
  });

  it('rejects a cross-origin trajectory even at perfect goal similarity', () => {
    const dir = tmpStoreDir();
    writeTrajectory(dir, successTrajectory({
      id: 'other-origin',
      goal: 'search the docs for rate limits',
      origin: 'https://other.example.org',
    }));
    const store = new TrajectoryStore(dir);

    const candidate = store.findReplayCandidate('search the docs for rate limits', {
      origin: 'https://example.com',
    });

    expect(candidate).toBeNull();
  });

  it('rejects a below-threshold goal match', () => {
    const dir = tmpStoreDir();
    writeTrajectory(dir, successTrajectory({
      id: 'weak',
      goal: 'completely unrelated booking flow for flights',
      origin: 'https://example.com',
    }));
    const store = new TrajectoryStore(dir);

    const candidate = store.findReplayCandidate('search the docs for rate limits', {
      origin: 'https://example.com',
    });

    expect(candidate).toBeNull();
  });

  it('persists expectedEffect into saved steps so replay can re-assert it', () => {
    const dir = tmpStoreDir();
    const store = new TrajectoryStore(dir);
    store.save(
      'fill the contact form',
      [
        {
          turn: 1,
          state: { url: 'https://example.com/c', title: 'Contact', snapshot: '- textbox "Email" [ref=t1]' },
          action: { action: 'type', selector: '@t1', text: 'a@b.com' },
          expectedEffect: 'the email field shows the typed value',
          verified: true,
          durationMs: 50,
        },
      ],
      true,
      'gpt-5.4',
      { origin: 'https://example.com' },
    );

    const candidate = store.findReplayCandidate('fill the contact form', {
      origin: 'https://example.com',
    });
    expect(candidate?.trajectory.steps[0].expectedEffect).toBe('the email field shows the typed value');
  });
});
