/**
 * App Knowledge — domain-scoped fact accumulation with confidence scoring,
 * plus rolling session history for cross-run continuity.
 *
 * Facts: structured observations (timing, selector, pattern, quirk) that
 * gain confidence with repeated confirmation and decay when contradicted.
 *
 * Sessions: ordered log of what the agent accomplished on this site.
 * Enables continuation — "now add feature X" knows what was already built.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';

export interface Fact {
  type: 'timing' | 'selector' | 'pattern' | 'quirk';
  key: string;
  value: string;
  confidence: number;
  sources: number;
  lastSeen: string;
}

export interface Session {
  /** Orchestrator-provided or auto-generated ID */
  id: string;
  /** The goal that was given */
  goal: string;
  /** Agent's own natural language result or failure reason */
  outcome: string;
  success: boolean;
  /** Where the browser ended up */
  finalUrl: string;
  timestamp: string;
  turnsUsed: number;
  durationMs: number;
}

const MAX_SESSIONS = 5;

export interface KnowledgeData {
  domain: string;
  facts: Fact[];
  sessions: Session[];
  updatedAt: string;
}

export class AppKnowledge {
  private path: string;
  private data: KnowledgeData;

  constructor(path: string, domain: string) {
    this.path = path;
    this.data = this.load(domain);
  }

  // ── Facts ──

  /** Get all facts with confidence above threshold */
  getFacts(minConfidence = 0.3): Fact[] {
    return this.data.facts.filter(f => f.confidence >= minConfidence);
  }

  /** Get facts of a specific type */
  getFactsByType(type: Fact['type'], minConfidence = 0.3): Fact[] {
    return this.data.facts.filter(f => f.type === type && f.confidence >= minConfidence);
  }

  /** Look up a specific fact by type and key */
  getFact(type: Fact['type'], key: string): Fact | undefined {
    return this.data.facts.find(f => f.type === type && f.key === key);
  }

  /**
   * Record a fact. If a matching fact exists:
   * - Same value: boost confidence and increment sources
   * - Different value: decay old fact's confidence, add new fact
   */
  recordFact(type: Fact['type'], key: string, value: string): void {
    const existing = this.data.facts.find(f => f.type === type && f.key === key);
    const now = new Date().toISOString();

    if (existing) {
      if (existing.value === value) {
        existing.confidence = Math.min(1.0, existing.confidence + (1 - existing.confidence) * 0.2);
        existing.sources++;
        existing.lastSeen = now;
      } else {
        existing.confidence *= 0.5;
        this.data.facts.push({
          type, key, value,
          confidence: 0.6,
          sources: 1,
          lastSeen: now,
        });
      }
    } else {
      this.data.facts.push({
        type, key, value,
        confidence: 0.6,
        sources: 1,
        lastSeen: now,
      });
    }

    this.data.facts = this.data.facts.filter(f => f.confidence >= 0.1);
    this.data.updatedAt = now;
  }

  /** Merge multiple facts at once (e.g., from LLM extraction) */
  recordFacts(facts: Array<{ type: Fact['type']; key: string; value: string }>): void {
    for (const f of facts) {
      this.recordFact(f.type, f.key, f.value);
    }
  }

  // ── Sessions ──

  /** Get all sessions, newest first */
  getSessions(): Session[] {
    return [...this.data.sessions].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /** Append a session to the rolling log. Keeps the last MAX_SESSIONS entries. */
  recordSession(session: Session): void {
    this.data.sessions.push(session);
    // Keep only the most recent sessions
    if (this.data.sessions.length > MAX_SESSIONS) {
      this.data.sessions = this.data.sessions
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, MAX_SESSIONS)
    }
    this.data.updatedAt = new Date().toISOString();
  }

  // ── Brain injection ──

  /** Format knowledge for injection into brain context */
  formatForBrain(): string {
    const lines: string[] = [];

    // Sessions first — most valuable for continuations
    const sessions = this.getSessions();
    if (sessions.length > 0) {
      const count = sessions.length;
      lines.push(`SESSION HISTORY (${count} previous run${count !== 1 ? 's' : ''} on this site):`)
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const icon = s.success ? '✓' : '✗';
        const ts = s.timestamp.slice(0, 16).replace('T', ' ');
        const stats = `${s.turnsUsed} turns, ${Math.round(s.durationMs / 1000)}s`;
        if (i < 2) {
          // Recent sessions: full detail
          lines.push(`[${ts}] ${icon} "${s.goal}" → ${s.outcome} (${stats})`);
          if (s.finalUrl) lines.push(`  Final URL: ${s.finalUrl}`);
        } else {
          // Older sessions: one line
          lines.push(`[${ts}] ${icon} "${s.goal}" → ${s.outcome.slice(0, 80)}${s.outcome.length > 80 ? '…' : ''} (${stats})`);
        }
      }
    }

    // Facts
    const facts = this.getFacts(0.5);
    const nonSessionFacts = facts;
    if (nonSessionFacts.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('APP KNOWLEDGE (learned from previous runs):');

      const grouped = new Map<string, Fact[]>();
      for (const f of nonSessionFacts) {
        const group = grouped.get(f.type) || [];
        group.push(f);
        grouped.set(f.type, group);
      }

      for (const [type, typeFacts] of grouped) {
        lines.push(`  ${type.toUpperCase()}:`);
        for (const f of typeFacts.sort((a, b) => b.confidence - a.confidence)) {
          const conf = (f.confidence * 100).toFixed(0);
          lines.push(`    - ${f.key}: ${f.value} (${conf}% confidence, ${f.sources} observations)`);
        }
      }
    }

    if (lines.length === 0) return '';
    return lines.join('\n');
  }

  /** Clear all learned patterns (facts). Keeps session history. */
  clearPatterns(): void {
    this.data.facts = []
    this.data.updatedAt = new Date().toISOString()
  }

  /** Clear everything — facts and sessions. Full reset. */
  reset(): void {
    this.data.facts = []
    this.data.sessions = []
    this.data.updatedAt = new Date().toISOString()
  }

  /** Number of facts stored */
  get factCount(): number {
    return this.data.facts.length
  }

  /** Persist to disk */
  save(): void {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  private load(domain: string): KnowledgeData {
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, 'utf-8'));
        // Migrate: old format may not have sessions array, or may have
        // session-type facts from the previous implementation
        if (!raw.sessions) raw.sessions = [];
        // Migrate session-type facts from previous implementation to sessions array
        if (raw.facts) {
          type RawFact = { type: string; key: string; value: string; lastSeen: string }
          const sessionFacts = (raw.facts as RawFact[]).filter(f => f.type === 'session');
          if (sessionFacts.length > 0) {
            for (const sf of sessionFacts) {
              raw.sessions.push({
                id: `migrated_${Date.now()}`,
                goal: sf.key === 'latest' ? '(previous run)' : sf.key,
                outcome: sf.value,
                success: true,
                finalUrl: '',
                timestamp: sf.lastSeen,
                turnsUsed: 0,
                durationMs: 0,
              });
            }
            raw.facts = (raw.facts as RawFact[]).filter(f => f.type !== 'session');
          }
        }
        return raw as KnowledgeData;
      } catch {
        // Corrupted file — start fresh
      }
    }
    return { domain, facts: [], sessions: [], updatedAt: new Date().toISOString() };
  }
}
