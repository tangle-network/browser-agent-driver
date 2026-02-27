/**
 * Trajectory Analyzer — extracts failure patterns and optimization hints from test runs.
 *
 * Examines TestSuiteResult traces to identify:
 * - Wasted turns (errors, retries, repeated actions, stuck loops)
 * - Failure patterns (which selectors, action types, and goals fail)
 * - Verification gaps (agent says success, ground-truth says failure)
 * - Turn efficiency (how many turns are productive vs wasted)
 *
 * Produces RunAnalysis with structured findings and generateHints() for
 * injecting optimization context into the Brain's system prompt.
 */

import type { TestSuiteResult, TestResult, Turn, Action } from '../types.js';

export interface ActionPattern {
  action: string;
  selector?: string;
  occurrences: number;
  failures: number;
  failureRate: number;
}

export interface GoalPattern {
  goalPrefix: string;
  attempts: number;
  successes: number;
  avgTurns: number;
  avgDurationMs: number;
  commonFailures: string[];
}

export interface TurnWaste {
  category: 'stale-ref' | 'repeated-action' | 'stuck-loop' | 'error' | 'unnecessary-wait';
  turnNumbers: number[];
  description: string;
}

export interface RunAnalysis {
  timestamp: string;
  suiteModel: string;
  totalTests: number;
  passRate: number;

  turnEfficiency: {
    totalTurns: number;
    productiveTurns: number;
    wastedTurns: number;
    efficiencyRate: number;
  };

  verificationGaps: {
    agentSaysSuccess: number;
    groundTruthConfirms: number;
    falsePositiveRate: number;
  };

  actionPatterns: ActionPattern[];
  goalPatterns: GoalPattern[];
  wasteBreakdown: TurnWaste[];
  topFailureReasons: string[];
}

export class TrajectoryAnalyzer {
  analyze(suite: TestSuiteResult): RunAnalysis {
    const nonSkipped = suite.results.filter(r => !r.skipped);

    const turnEfficiency = this.analyzeTurnEfficiency(nonSkipped);
    const verificationGaps = this.analyzeVerificationGaps(nonSkipped);
    const actionPatterns = this.analyzeActionPatterns(nonSkipped);
    const goalPatterns = this.analyzeGoalPatterns(nonSkipped);
    const wasteBreakdown = this.analyzeWaste(nonSkipped);
    const topFailureReasons = this.extractFailureReasons(nonSkipped);

    return {
      timestamp: new Date().toISOString(),
      suiteModel: suite.model,
      totalTests: suite.results.length,
      passRate: suite.summary.passRate,
      turnEfficiency,
      verificationGaps,
      actionPatterns,
      goalPatterns,
      wasteBreakdown,
      topFailureReasons,
    };
  }

  generateHints(analysis: RunAnalysis): string {
    const hints: string[] = [];

    // Turn efficiency hints
    if (analysis.turnEfficiency.efficiencyRate < 0.7) {
      hints.push(
        `EFFICIENCY WARNING: Only ${(analysis.turnEfficiency.efficiencyRate * 100).toFixed(0)}% of turns are productive. ` +
        `${analysis.turnEfficiency.wastedTurns} turns were wasted on errors, retries, or repeated actions.`
      );
    }

    // Verification gap hints
    if (analysis.verificationGaps.falsePositiveRate > 0.1) {
      hints.push(
        `ACCURACY WARNING: The agent reports success ${(analysis.verificationGaps.falsePositiveRate * 100).toFixed(0)}% more often than ground-truth confirms. ` +
        `Be more conservative with "complete" — verify the goal state thoroughly before completing.`
      );
    }

    // Action pattern hints
    const highFailureActions = analysis.actionPatterns
      .filter(p => p.failureRate > 0.3 && p.occurrences >= 3)
      .sort((a, b) => b.failureRate - a.failureRate);

    if (highFailureActions.length > 0) {
      const actionHints = highFailureActions
        .slice(0, 3)
        .map(p => {
          const selector = p.selector ? ` on "${p.selector}"` : '';
          return `"${p.action}"${selector} fails ${(p.failureRate * 100).toFixed(0)}% of the time (${p.failures}/${p.occurrences})`;
        });
      hints.push(`HIGH-FAILURE ACTIONS: ${actionHints.join('; ')}. Try alternative approaches.`);
    }

    // Waste pattern hints
    const staleRefWaste = analysis.wasteBreakdown.filter(w => w.category === 'stale-ref');
    if (staleRefWaste.length > 0) {
      const totalStaleRefs = staleRefWaste.reduce((sum, w) => sum + w.turnNumbers.length, 0);
      hints.push(
        `STALE REFS: ${totalStaleRefs} turns wasted on stale @ref selectors. ` +
        `Always use refs from the CURRENT observation, not previous turns.`
      );
    }

    const stuckWaste = analysis.wasteBreakdown.filter(w => w.category === 'stuck-loop');
    if (stuckWaste.length > 0) {
      hints.push(
        `STUCK LOOPS DETECTED: The agent repeated the same action sequence ${stuckWaste.length} time(s). ` +
        `When an action doesn't produce the expected effect after 2 attempts, try a completely different strategy.`
      );
    }

    // Goal-specific hints
    const slowGoals = analysis.goalPatterns
      .filter(p => p.avgTurns > 15 && p.attempts >= 2)
      .sort((a, b) => b.avgTurns - a.avgTurns);

    if (slowGoals.length > 0) {
      const goalHints = slowGoals
        .slice(0, 2)
        .map(p => `"${p.goalPrefix}" averages ${p.avgTurns.toFixed(0)} turns`);
      hints.push(`SLOW GOALS: ${goalHints.join('; ')}. Consider more direct navigation strategies.`);
    }

    // Top failure reasons
    if (analysis.topFailureReasons.length > 0) {
      hints.push(`COMMON FAILURES: ${analysis.topFailureReasons.slice(0, 3).join('; ')}`);
    }

    if (hints.length === 0) return '';

    return `FEEDBACK FROM PREVIOUS RUNS:\n${hints.map(h => `- ${h}`).join('\n')}`;
  }

  private analyzeTurnEfficiency(results: TestResult[]): RunAnalysis['turnEfficiency'] {
    let totalTurns = 0;
    let wastedTurns = 0;

    for (const r of results) {
      const turns = r.agentResult.turns;
      totalTurns += turns.length;

      for (const turn of turns) {
        if (this.isWastedTurn(turn)) {
          wastedTurns++;
        }
      }
    }

    const productiveTurns = totalTurns - wastedTurns;
    return {
      totalTurns,
      productiveTurns,
      wastedTurns,
      efficiencyRate: totalTurns > 0 ? productiveTurns / totalTurns : 1,
    };
  }

  private isWastedTurn(turn: Turn): boolean {
    if (turn.error) return true;
    if (turn.action.action === 'wait' && 'ms' in turn.action && turn.action.ms === 0) return true;
    if (turn.verificationFailure) return true;
    return false;
  }

  private analyzeVerificationGaps(results: TestResult[]): RunAnalysis['verificationGaps'] {
    const agentSaysSuccess = results.filter(r => r.agentSuccess).length;
    const groundTruthConfirms = results.filter(r => r.agentSuccess && r.verified).length;

    return {
      agentSaysSuccess,
      groundTruthConfirms,
      falsePositiveRate: agentSaysSuccess > 0
        ? (agentSaysSuccess - groundTruthConfirms) / agentSaysSuccess
        : 0,
    };
  }

  private analyzeActionPatterns(results: TestResult[]): ActionPattern[] {
    const patternMap = new Map<string, { occurrences: number; failures: number; selector?: string }>();

    for (const r of results) {
      for (const turn of r.agentResult.turns) {
        const action = turn.action;
        const selector = 'selector' in action ? String(action.selector) : undefined;
        const key = `${action.action}:${selector || '*'}`;

        const existing = patternMap.get(key) || { occurrences: 0, failures: 0, selector };
        existing.occurrences++;
        if (turn.error || turn.verificationFailure) {
          existing.failures++;
        }
        patternMap.set(key, existing);
      }
    }

    return [...patternMap.entries()]
      .map(([_key, v]) => ({
        action: _key.split(':')[0],
        selector: v.selector,
        occurrences: v.occurrences,
        failures: v.failures,
        failureRate: v.occurrences > 0 ? v.failures / v.occurrences : 0,
      }))
      .sort((a, b) => b.occurrences - a.occurrences);
  }

  private analyzeGoalPatterns(results: TestResult[]): GoalPattern[] {
    const goalMap = new Map<string, { attempts: number; successes: number; turns: number[]; durations: number[]; failures: string[] }>();

    for (const r of results) {
      const prefix = r.testCase.goal.split('\n')[0].slice(0, 80);

      const existing = goalMap.get(prefix) || {
        attempts: 0, successes: 0, turns: [], durations: [], failures: [],
      };
      existing.attempts++;
      if (r.verified) existing.successes++;
      existing.turns.push(r.turnsUsed);
      existing.durations.push(r.durationMs);
      if (!r.verified && r.verdict) {
        existing.failures.push(r.verdict);
      }
      goalMap.set(prefix, existing);
    }

    return [...goalMap.entries()].map(([goalPrefix, v]) => ({
      goalPrefix,
      attempts: v.attempts,
      successes: v.successes,
      avgTurns: v.turns.reduce((a, b) => a + b, 0) / v.turns.length,
      avgDurationMs: v.durations.reduce((a, b) => a + b, 0) / v.durations.length,
      commonFailures: v.failures,
    }));
  }

  private analyzeWaste(results: TestResult[]): TurnWaste[] {
    const waste: TurnWaste[] = [];

    for (const r of results) {
      const turns = r.agentResult.turns;

      // Detect stale ref errors
      const staleRefTurns = turns
        .filter(t => t.error?.includes('Stale ref'))
        .map(t => t.turn);
      if (staleRefTurns.length > 0) {
        waste.push({
          category: 'stale-ref',
          turnNumbers: staleRefTurns,
          description: `${r.testCase.name}: ${staleRefTurns.length} stale ref errors`,
        });
      }

      // Detect stuck loops (same action repeated 3+ times consecutively)
      for (let i = 2; i < turns.length; i++) {
        const a1 = this.actionKey(turns[i - 2].action);
        const a2 = this.actionKey(turns[i - 1].action);
        const a3 = this.actionKey(turns[i].action);
        if (a1 === a2 && a2 === a3) {
          waste.push({
            category: 'stuck-loop',
            turnNumbers: [turns[i - 2].turn, turns[i - 1].turn, turns[i].turn],
            description: `${r.testCase.name}: repeated "${a1}" at turns ${turns[i - 2].turn}-${turns[i].turn}`,
          });
        }
      }

      // Detect error turns
      const errorTurns = turns
        .filter(t => t.error && !t.error.includes('Stale ref'))
        .map(t => t.turn);
      if (errorTurns.length > 0) {
        waste.push({
          category: 'error',
          turnNumbers: errorTurns,
          description: `${r.testCase.name}: ${errorTurns.length} execution errors`,
        });
      }
    }

    return waste;
  }

  private extractFailureReasons(results: TestResult[]): string[] {
    const reasons: string[] = [];

    for (const r of results) {
      if (!r.verified && !r.skipped) {
        if (r.criteriaResults) {
          for (const cr of r.criteriaResults) {
            if (!cr.passed && cr.detail) {
              reasons.push(cr.detail);
            }
          }
        } else if (r.verdict) {
          reasons.push(r.verdict);
        }
      }
    }

    // Deduplicate and return top reasons
    const counts = new Map<string, number>();
    for (const reason of reasons) {
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason]) => reason);
  }

  private actionKey(action: Action): string {
    switch (action.action) {
      case 'click':
        return `click:${action.selector}`;
      case 'type':
        return `type:${action.selector}`;
      case 'press':
        return `press:${action.selector}:${action.key}`;
      case 'scroll':
        return `scroll:${action.direction}`;
      case 'navigate':
        return `navigate:${action.url}`;
      default:
        return action.action;
    }
  }
}
