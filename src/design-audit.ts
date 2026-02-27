/**
 * Design Audit System — systematic UI/UX flow auditing with vision.
 *
 * Navigates through UI flows, captures screenshots at checkpoints,
 * evaluates visual quality, UX patterns, accessibility, and design
 * consistency. Produces structured reports with findings.
 */

import type { Driver } from './drivers/types.js';
import { Brain } from './brain/index.js';
import { AgentRunner } from './runner.js';
import type {
  AgentConfig,
  AuditFlow,
  DesignFinding,
  FlowAuditResult,
  DesignAuditReport,
} from './types.js';

/**
 * DesignAuditor — orchestrates flow navigation + screenshot capture + evaluation.
 *
 * Usage:
 * ```ts
 * const auditor = new DesignAuditor(driver, { model: 'gpt-4o', vision: true });
 * const report = await auditor.audit([
 *   { name: 'login', startUrl: 'http://localhost:5173', goal: 'Navigate to the login page', checkpoints: ['Login form is visible'] },
 *   { name: 'chat', startUrl: 'http://localhost:5173/chat', goal: 'Send a message in chat', checkpoints: ['Chat input is visible', 'Message appears'] },
 * ]);
 * console.log(generateDesignAuditReport(report));
 * ```
 */
export class DesignAuditor {
  private driver: Driver;
  private brain: Brain;
  private config: AgentConfig;

  constructor(driver: Driver, config: AgentConfig = {}) {
    this.driver = driver;
    this.config = { ...config, vision: true }; // Vision must be on for design audit
    this.brain = new Brain(this.config);
  }

  /**
   * Audit a single flow — agent navigates toward the goal, captures
   * screenshots at checkpoints, and evaluates design quality.
   */
  async auditFlow(flow: AuditFlow): Promise<FlowAuditResult> {
    const screenshots: string[] = [];
    const allFindings: DesignFinding[] = [];

    // Use the runner to navigate the flow
    const runner = new AgentRunner({
      driver: this.driver,
      config: this.config,
      onTurn: (turn) => {
        if (turn.state.screenshot) {
          screenshots.push(turn.state.screenshot);
        }
      },
    });

    const result = await runner.run({
      goal: flow.goal,
      startUrl: flow.startUrl,
      maxTurns: flow.maxTurns ?? 15,
    });

    // Evaluate checkpoints — capture + audit at the final state
    const finalState = result.turns.length > 0
      ? result.turns[result.turns.length - 1].state
      : await this.driver.observe();

    // Run design evaluation on the final state
    const evaluation = await this.brain.auditDesign(finalState, flow.goal, flow.checkpoints);

    allFindings.push(...evaluation.findings);

    // Keep only key screenshots (first, middle, last) to avoid bloat
    const keyScreenshots: string[] = [];
    if (screenshots.length > 0) keyScreenshots.push(screenshots[0]);
    if (screenshots.length > 2) keyScreenshots.push(screenshots[Math.floor(screenshots.length / 2)]);
    if (screenshots.length > 1) keyScreenshots.push(screenshots[screenshots.length - 1]);

    return {
      flow: flow.name,
      steps: result.turns.length,
      reachedGoal: result.success,
      findings: allFindings,
      screenshots: keyScreenshots,
      score: evaluation.score,
    };
  }

  /**
   * Audit multiple flows and produce an aggregate report.
   * Individual flow failures are caught and reported, not propagated.
   *
   * Flows run sequentially by default since they share a browser page.
   * Pass `onFlowComplete` for progress reporting on long audits.
   */
  async audit(
    flows: AuditFlow[],
    options?: { onFlowComplete?: (flowName: string, index: number, total: number) => void }
  ): Promise<DesignAuditReport> {
    const flowResults: FlowAuditResult[] = [];

    for (let i = 0; i < flows.length; i++) {
      const flow = flows[i];
      try {
        const result = await this.auditFlow(flow);
        flowResults.push(result);
      } catch (err) {
        // Capture partial result for failed flows
        flowResults.push({
          flow: flow.name,
          steps: 0,
          reachedGoal: false,
          findings: [],
          screenshots: [],
          score: 1,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      options?.onFlowComplete?.(flow.name, i + 1, flows.length);
    }

    // Compute summary
    const allFindings = flowResults.flatMap(f => f.findings);
    const critical = allFindings.filter(f => f.severity === 'critical').length;
    const major = allFindings.filter(f => f.severity === 'major').length;
    const minor = allFindings.filter(f => f.severity === 'minor').length;

    // Health score: 100 - (critical * 15 + major * 5 + minor * 1), clamped to 0-100
    const deductions = critical * 15 + major * 5 + minor * 1;
    const healthScore = Math.max(0, Math.min(100, 100 - deductions));

    return {
      timestamp: new Date().toISOString(),
      flows: flowResults,
      summary: {
        healthScore,
        totalFindings: allFindings.length,
        critical,
        major,
        minor,
      },
    };
  }
}

/**
 * Generate a markdown report from a DesignAuditReport.
 */
export function generateDesignAuditReport(report: DesignAuditReport): string {
  const lines: string[] = [];

  lines.push('# Design Audit Report');
  lines.push(`**Date:** ${report.timestamp}`);
  lines.push(`**Health Score:** ${report.summary.healthScore}/100`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Findings | ${report.summary.totalFindings} |`);
  lines.push(`| Critical | ${report.summary.critical} |`);
  lines.push(`| Major | ${report.summary.major} |`);
  lines.push(`| Minor | ${report.summary.minor} |`);
  lines.push(`| Flows Audited | ${report.flows.length} |`);
  lines.push('');

  // Per-flow results
  for (const flow of report.flows) {
    lines.push(`## Flow: ${flow.flow}`);
    const goalStatus = flow.reachedGoal ? 'Reached' : 'Not reached';
    lines.push(`**Steps:** ${flow.steps} | **Score:** ${flow.score}/10 | **Goal:** ${goalStatus}`);
    if (flow.error) {
      lines.push(`**Error:** ${flow.error}`);
    }
    lines.push('');

    if (flow.findings.length === 0) {
      lines.push('No issues found.');
    } else {
      lines.push('| Severity | Category | Description | Location | Suggestion |');
      lines.push('|----------|----------|-------------|----------|------------|');
      for (const f of flow.findings) {
        const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
        lines.push(`| ${f.severity} | ${f.category} | ${esc(f.description)} | ${esc(f.location)} | ${esc(f.suggestion)} |`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
