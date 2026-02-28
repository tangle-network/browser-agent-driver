/**
 * App Knowledge — domain-scoped fact accumulation with confidence scoring.
 *
 * Stores structured facts the agent discovers about a specific application,
 * persisted across runs. Facts have confidence scores that increase with
 * repeated confirmation and decay when contradicted.
 *
 * Fact types:
 * - timing: wait durations, animation timings, load times
 * - selector: reliable selectors for specific elements
 * - pattern: multi-step interaction patterns (auth flows, navigation)
 * - quirk: app-specific behaviors (shadow DOM, lazy loading, etc.)
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

export interface KnowledgeData {
  domain: string;
  facts: Fact[];
  updatedAt: string;
}

export class AppKnowledge {
  private path: string;
  private data: KnowledgeData;

  constructor(path: string, domain: string) {
    this.path = path;
    this.data = this.load(domain);
  }

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
        // Confirm — boost confidence (asymptotic toward 1.0)
        existing.confidence = Math.min(1.0, existing.confidence + (1 - existing.confidence) * 0.2);
        existing.sources++;
        existing.lastSeen = now;
      } else {
        // Contradict — decay old, add new
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

    // Prune low-confidence facts
    this.data.facts = this.data.facts.filter(f => f.confidence >= 0.1);
    this.data.updatedAt = now;
  }

  /** Merge multiple facts at once (e.g., from LLM extraction) */
  recordFacts(facts: Array<{ type: Fact['type']; key: string; value: string }>): void {
    for (const f of facts) {
      this.recordFact(f.type, f.key, f.value);
    }
  }

  /** Format knowledge for injection into brain context */
  formatForBrain(): string {
    const facts = this.getFacts(0.5); // Only high-confidence facts
    if (facts.length === 0) return '';

    const grouped = new Map<string, Fact[]>();
    for (const f of facts) {
      const group = grouped.get(f.type) || [];
      group.push(f);
      grouped.set(f.type, group);
    }

    const lines: string[] = ['APP KNOWLEDGE (learned from previous runs):'];

    for (const [type, typeFacts] of grouped) {
      lines.push(`  ${type.toUpperCase()}:`);
      for (const f of typeFacts.sort((a, b) => b.confidence - a.confidence)) {
        const conf = (f.confidence * 100).toFixed(0);
        lines.push(`    - ${f.key}: ${f.value} (${conf}% confidence, ${f.sources} observations)`);
      }
    }

    return lines.join('\n');
  }

  /** Persist to disk */
  save(): void {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  private load(domain: string): KnowledgeData {
    if (existsSync(this.path)) {
      try {
        return JSON.parse(readFileSync(this.path, 'utf-8'));
      } catch {
        // Corrupted file — start fresh
      }
    }
    return { domain, facts: [], updatedAt: new Date().toISOString() };
  }
}
