/**
 * Trajectory Store — saves and loads successful trajectories for case-based reasoning.
 *
 * Stores trajectories as JSON files in a configurable directory (.trajectories/ by default).
 * No fine-tuning needed — successful trajectories are injected into the system prompt
 * as reference guides for similar future tasks.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { Trajectory, Turn, Action } from '../types.js';
import { snapshotHash } from '../recovery.js';

export interface TrajectoryStoreOptions {
  similarityThreshold?: number;
  enableScoring?: boolean;
  ttlDays?: number;
}

export interface TrajectorySaveOptions {
  origin?: string;
}

export interface TrajectoryMatchOptions {
  origin?: string;
}

export class TrajectoryStore {
  private storePath: string;
  private cache: Trajectory[] | null = null;
  private similarityThreshold: number;
  private enableScoring: boolean;
  private ttlDays: number;

  constructor(storePath?: string, thresholdOrOptions: number | TrajectoryStoreOptions = 0.5) {
    const opts = typeof thresholdOrOptions === 'number'
      ? { similarityThreshold: thresholdOrOptions }
      : thresholdOrOptions;

    this.storePath = storePath || join(process.cwd(), '.trajectories');
    this.similarityThreshold = opts.similarityThreshold ?? 0.5;
    this.enableScoring = opts.enableScoring === true;
    this.ttlDays = opts.ttlDays ?? 30;
    if (!existsSync(this.storePath)) {
      mkdirSync(this.storePath, { recursive: true });
    }
  }

  /** Save a trajectory from a completed agent run */
  save(goal: string, turns: Turn[], success: boolean, model: string, options: TrajectorySaveOptions = {}): Trajectory {
    const normalizedOrigin = normalizeOrigin(options.origin);
    const trajectory: Trajectory = {
      id: `traj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      goal,
      origin: normalizedOrigin,
      steps: turns
        .filter((t) => t.action.action !== 'complete' && t.action.action !== 'abort')
        .map((t) => ({
          url: t.state.url,
          action: t.action,
          snapshotHash: snapshotHash(t.state.snapshot).toString(),
          verified: t.verified,
        })),
      success,
      durationMs: turns.reduce((sum, t) => sum + t.durationMs, 0),
      model,
      timestamp: new Date().toISOString(),
    };

    const filePath = join(this.storePath, `${trajectory.id}.json`);
    writeFileSync(filePath, JSON.stringify(trajectory, null, 2));
    this.cache = null; // Invalidate cache on write
    return trajectory;
  }

  /** Load all trajectories (cached — invalidated on save) */
  loadAll(): Trajectory[] {
    if (this.cache) return this.cache;
    if (!existsSync(this.storePath)) return [];

    this.cache = readdirSync(this.storePath)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.storePath, f), 'utf-8')) as Trajectory;
        } catch {
          return null;
        }
      })
      .filter((t): t is Trajectory => t !== null);
    return this.cache;
  }

  /** Find the best matching trajectory for a goal */
  findBestMatch(goal: string, options: TrajectoryMatchOptions = {}): Trajectory | null {
    const now = Date.now();
    const maxAgeMs = this.ttlDays * 24 * 60 * 60 * 1000;
    let trajectories = this.loadAll().filter((t) => {
      if (!t.success) return false;
      const ts = Date.parse(t.timestamp);
      if (Number.isNaN(ts)) return true;
      return now - ts <= maxAgeMs;
    });

    const requestedOrigin = normalizeOrigin(options.origin);
    if (requestedOrigin) {
      trajectories = trajectories.filter((trajectory) =>
        normalizeOrigin(trajectory.origin) === requestedOrigin,
      );
    }

    if (trajectories.length === 0) return null;

    const scored = trajectories.map((trajectory) => {
      const similarity = goalSimilarity(goal, trajectory.goal);
      const score = this.enableScoring
        ? this.computeScore(similarity, trajectory, now)
        : similarity;
      return { trajectory, score, similarity };
    });

    scored.sort((a, b) => b.score - a.score);

    if (scored[0].similarity > this.similarityThreshold) {
      return scored[0].trajectory;
    }

    return null;
  }

  private computeScore(similarity: number, trajectory: Trajectory, nowMs: number): number {
    const recency = this.computeRecencyScore(trajectory.timestamp, nowMs);
    const durationScore = 1 / (1 + trajectory.durationMs / 60_000);
    const verificationScore = this.computeVerificationScore(trajectory);

    // Weighted blend tuned for stable reuse:
    // similarity dominates, then recency, then execution quality proxies.
    return (similarity * 0.6) + (recency * 0.2) + (durationScore * 0.1) + (verificationScore * 0.1);
  }

  private computeRecencyScore(timestamp: string, nowMs: number): number {
    const ts = Date.parse(timestamp);
    if (Number.isNaN(ts)) return 0.5;
    const ageDays = Math.max(0, (nowMs - ts) / (24 * 60 * 60 * 1000));
    return Math.exp(-ageDays / 14);
  }

  private computeVerificationScore(trajectory: Trajectory): number {
    if (trajectory.steps.length === 0) return 0.5;
    const verified = trajectory.steps.filter((step) => step.verified === true).length;
    return verified / trajectory.steps.length;
  }

  /** Format a trajectory as a human-readable reference for the brain */
  formatAsReference(trajectory: Trajectory): string {
    const lines: string[] = [];
    lines.push(`Goal: ${trajectory.goal}`);
    lines.push(`Steps (${trajectory.steps.length} total):`);

    for (let i = 0; i < trajectory.steps.length; i++) {
      const step = trajectory.steps[i];
      const actionStr = formatAction(step.action);
      const verified = step.verified ? ' [verified]' : '';
      lines.push(`  ${i + 1}. ${actionStr} (on ${step.url})${verified}`);
    }

    return lines.join('\n');
  }
}

function normalizeOrigin(origin?: string): string | undefined {
  if (!origin) return undefined;
  try {
    return new URL(origin).origin;
  } catch {
    return undefined;
  }
}

/**
 * Compute similarity between two goal strings.
 * Uses word overlap (Jaccard coefficient) — simple and effective.
 */
function goalSimilarity(a: string, b: string): number {
  const wordsA = new Set(tokenize(a));
  const wordsB = new Set(tokenize(b));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 1); // Skip single-char words
}

function formatAction(action: Action): string {
  switch (action.action) {
    case 'click':
      return `click ${action.selector}`;
    case 'type':
      return `type "${action.text}" into ${action.selector}`;
    case 'press':
      return `press ${action.key} on ${action.selector}`;
    case 'scroll':
      return `scroll ${action.direction}`;
    case 'navigate':
      return `navigate to ${action.url}`;
    case 'wait':
      return `wait ${action.ms}ms`;
    default:
      return JSON.stringify(action);
  }
}
