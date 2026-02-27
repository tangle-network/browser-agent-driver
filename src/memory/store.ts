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

export class TrajectoryStore {
  private storePath: string;
  private cache: Trajectory[] | null = null;
  private similarityThreshold: number;

  constructor(storePath?: string, similarityThreshold = 0.5) {
    this.storePath = storePath || join(process.cwd(), '.trajectories');
    this.similarityThreshold = similarityThreshold;
    if (!existsSync(this.storePath)) {
      mkdirSync(this.storePath, { recursive: true });
    }
  }

  /** Save a trajectory from a completed agent run */
  save(goal: string, turns: Turn[], success: boolean, model: string): Trajectory {
    const trajectory: Trajectory = {
      id: `traj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      goal,
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
  findBestMatch(goal: string): Trajectory | null {
    const trajectories = this.loadAll().filter((t) => t.success);
    if (trajectories.length === 0) return null;

    // Score each trajectory by goal similarity
    const scored = trajectories.map((t) => ({
      trajectory: t,
      score: goalSimilarity(goal, t.goal),
    }));

    scored.sort((a, b) => b.score - a.score);

    if (scored[0].score > this.similarityThreshold) {
      return scored[0].trajectory;
    }

    return null;
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
