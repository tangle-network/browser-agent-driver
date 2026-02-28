/**
 * Project Memory Store — manages the `.agent-memory/` directory layout.
 *
 * Provides domain-scoped storage for knowledge, selectors, and trajectories.
 * The directory is git-committable and accumulates learning across runs.
 *
 * Layout:
 *   .agent-memory/
 *   ├── domains/
 *   │   └── localhost_5173/          # sanitized origin
 *   │       ├── knowledge.json       # accumulated facts about this app
 *   │       ├── selectors.json       # element → best selector mappings
 *   │       └── trajectories/        # successful run recordings
 *   │           └── traj_*.json
 *   ├── hints.json                   # cross-domain optimization hints
 *   └── runs/
 *       └── run_*.json               # suite result summaries
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { TestSuiteResult } from '../types.js';

export class ProjectStore {
  private root: string;

  constructor(root?: string) {
    this.root = root || join(process.cwd(), '.agent-memory');
    this.ensureDir(this.root);
    this.ensureDir(join(this.root, 'domains'));
    this.ensureDir(join(this.root, 'runs'));
  }

  /** Get the root directory path */
  getRoot(): string {
    return this.root;
  }

  /** Get the domain directory for a given URL origin */
  getDomainDir(url: string): string {
    const domain = sanitizeDomain(url);
    const dir = join(this.root, 'domains', domain);
    this.ensureDir(dir);
    return dir;
  }

  /** Get the trajectory store path for a domain */
  getTrajectoryDir(url: string): string {
    const dir = join(this.getDomainDir(url), 'trajectories');
    this.ensureDir(dir);
    return dir;
  }

  /** Get the knowledge file path for a domain */
  getKnowledgePath(url: string): string {
    return join(this.getDomainDir(url), 'knowledge.json');
  }

  /** Get the selector cache file path for a domain */
  getSelectorCachePath(url: string): string {
    return join(this.getDomainDir(url), 'selectors.json');
  }

  /** Get the cross-domain hints file path */
  getHintsPath(): string {
    return join(this.root, 'hints.json');
  }

  /** Save cross-domain optimization hints */
  saveHints(hints: string): void {
    writeFileSync(this.getHintsPath(), JSON.stringify({ hints, updatedAt: new Date().toISOString() }, null, 2));
  }

  /** Load cross-domain optimization hints */
  loadHints(): string | null {
    const path = this.getHintsPath();
    if (!existsSync(path)) return null;
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      return data.hints || null;
    } catch {
      return null;
    }
  }

  /** Save a run summary (lightweight — just metrics, no full traces) */
  saveRunSummary(suite: TestSuiteResult): void {
    const id = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const summary = {
      id,
      model: suite.model,
      timestamp: suite.timestamp,
      total: suite.summary.total,
      passed: suite.summary.passed,
      failed: suite.summary.failed,
      passRate: suite.summary.passRate,
      avgTurns: suite.summary.avgTurns,
      avgDurationMs: suite.summary.avgDurationMs,
      totalDurationMs: suite.summary.totalDurationMs,
      tests: suite.results.map(r => ({
        id: r.testCase.id,
        name: r.testCase.name,
        verified: r.verified,
        turnsUsed: r.turnsUsed,
        durationMs: r.durationMs,
      })),
    };

    writeFileSync(
      join(this.root, 'runs', `${id}.json`),
      JSON.stringify(summary, null, 2),
    );
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Sanitize a URL into a filesystem-safe domain key.
 * "http://localhost:5173/foo/bar" → "localhost_5173"
 */
function sanitizeDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host.replace(/[^a-zA-Z0-9.-]/g, '_');
  } catch {
    // Fallback: extract something useful from the string
    return url.replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 50) || 'unknown';
  }
}
