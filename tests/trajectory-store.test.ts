import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TrajectoryStore } from '../src/memory/store.js';
import type { Trajectory } from '../src/types.js';

function writeTrajectory(dir: string, t: Trajectory): void {
  fs.writeFileSync(path.join(dir, `${t.id}.json`), JSON.stringify(t, null, 2));
}

function makeTrajectory(input: {
  id: string;
  goal: string;
  durationMs: number;
  timestamp: string;
  verified: boolean[];
}): Trajectory {
  return {
    id: input.id,
    goal: input.goal,
    success: true,
    durationMs: input.durationMs,
    model: 'gpt-5.2',
    timestamp: input.timestamp,
    steps: input.verified.map((v, i) => ({
      url: `https://example.com/step-${i}`,
      action: { action: 'wait', ms: 100 },
      snapshotHash: `${i}`,
      verified: v,
    })),
  };
}

describe('TrajectoryStore scoring', () => {
  it('prefers fresher/faster trajectories when scoring is enabled', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abd-traj-score-'));
    const now = new Date();
    const staleTs = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const freshTs = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();

    writeTrajectory(tmpDir, makeTrajectory({
      id: 'old-slow',
      goal: 'create coinbase trading bot flow',
      durationMs: 240_000,
      timestamp: staleTs,
      verified: [true, false, false, false],
    }));
    writeTrajectory(tmpDir, makeTrajectory({
      id: 'new-fast',
      goal: 'create coinbase trading bot flow',
      durationMs: 20_000,
      timestamp: freshTs,
      verified: [true, true, true, true],
    }));

    const store = new TrajectoryStore(tmpDir, {
      similarityThreshold: 0.1,
      enableScoring: true,
      ttlDays: 365,
    });

    const match = store.findBestMatch('create coinbase trading bot flow');
    expect(match?.id).toBe('new-fast');
  });

  it('filters stale trajectories beyond ttlDays', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abd-traj-ttl-'));
    const now = new Date();
    const staleTs = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const freshTs = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

    writeTrajectory(tmpDir, makeTrajectory({
      id: 'very-old',
      goal: 'coinbase flow',
      durationMs: 10_000,
      timestamp: staleTs,
      verified: [true, true],
    }));
    writeTrajectory(tmpDir, makeTrajectory({
      id: 'fresh',
      goal: 'coinbase partner flow',
      durationMs: 30_000,
      timestamp: freshTs,
      verified: [true, true],
    }));

    const store = new TrajectoryStore(tmpDir, {
      similarityThreshold: 0.1,
      enableScoring: true,
      ttlDays: 30,
    });

    const match = store.findBestMatch('coinbase partner flow');
    expect(match?.id).toBe('fresh');
  });
});
