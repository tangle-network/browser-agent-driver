/**
 * Design-audit task for the Brain decision engine: uses vision to analyze
 * layout, typography, spacing, contrast, and UX, returning structured findings
 * with categories, severities, and optional ROI / patch passthrough.
 *
 * Extracted from brain/index.ts via the delegate + host-interface pattern.
 * Brain.auditDesign keeps a thin delegator; the body lives here verbatim and
 * reads Brain state through {@link BrainDesignAuditHost}, which Brain
 * `implements` so tsc proves the host surface is complete.
 */

import type { ModelMessage, SystemModelMessage } from 'ai';
import type { PageState, DesignFinding } from '../../types.js';
import { DESIGN_AUDIT_PROMPT } from '../prompts.js';
import type { UserContent } from '../types.js';
import type { ModelSelection, GenerateResult } from '../model-client.js';

/**
 * The slice of Brain state `auditDesign` reads. All members are public on Brain
 * by construction; `implements BrainDesignAuditHost` makes a missing/mistyped
 * member a compile error.
 */
export interface BrainDesignAuditHost {
  debug: boolean;
  buildUserContent(text: string, screenshot?: string, forceVision?: boolean): UserContent;
  generate(
    system: string | SystemModelMessage[],
    messages: ModelMessage[],
    selection?: ModelSelection,
    maxOutputTokens?: number,
  ): Promise<GenerateResult>;
}

export async function auditDesignImpl(
  self: BrainDesignAuditHost,
  state: PageState,
  goal: string,
  checkpoints: string[],
  systemPrompt?: string,
): Promise<{ score: number; findings: DesignFinding[]; raw: string; tokensUsed?: number; designSystemScore?: Record<string, unknown>; parseError?: string }> {
  const textContent = `GOAL: ${goal}

CHECKPOINTS to verify:
${checkpoints.map((c, i) => `${i + 1}. ${c}`).join('\n')}

CURRENT PAGE:
URL: ${state.url}
Title: ${state.title}

ELEMENTS:
${state.snapshot}

Audit this page for design quality, UX issues, and visual bugs.`;

  const userContent = self.buildUserContent(textContent, state.screenshot, true);

  const result = await self.generate(
    systemPrompt ?? DESIGN_AUDIT_PROMPT,
    [{ role: 'user', content: userContent }],
    undefined,
    8000,
  );

  const raw = result.text;
  const tokensUsed = result.tokensUsed;

  if (self.debug) {
    console.log('[Brain] Design audit:', raw.slice(0, 300));
  }

  try {
    let text = raw.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    // Extract JSON object if surrounded by non-JSON text or truncated
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        parsed = JSON.parse(text.slice(start, end + 1));
      } else {
        throw new Error('No JSON object found');
      }
    }

    const VALID_CATEGORIES = new Set(['visual-bug', 'layout', 'contrast', 'alignment', 'spacing', 'typography', 'accessibility', 'ux']);
    const VALID_SEVERITIES = new Set(['critical', 'major', 'minor']);

    const VALID_BLAST = new Set(['page', 'section', 'component', 'system']);
    const clampScore = (n: unknown): number | undefined =>
      typeof n === 'number' ? Math.max(1, Math.min(10, n)) : undefined;

    const findings: DesignFinding[] = Array.isArray(parsed.findings)
      ? parsed.findings.map((f: Record<string, unknown>) => ({
          category: (VALID_CATEGORIES.has(f.category as string) ? f.category : 'ux') as DesignFinding['category'],
          severity: (VALID_SEVERITIES.has(f.severity as string) ? f.severity : 'minor') as DesignFinding['severity'],
          description: String(f.description ?? ''),
          location: String(f.location ?? ''),
          suggestion: String(f.suggestion ?? ''),
          ...(f.cssSelector ? { cssSelector: String(f.cssSelector) } : {}),
          ...(f.cssFix ? { cssFix: String(f.cssFix) } : {}),
          // Optional ROI fields.
          ...(clampScore(f.impact) !== undefined ? { impact: clampScore(f.impact) } : {}),
          ...(clampScore(f.effort) !== undefined ? { effort: clampScore(f.effort) } : {}),
          ...(VALID_BLAST.has(f.blast as string)
            ? { blast: f.blast as DesignFinding['blast'] }
            : {}),
          // Layer 2 — preserve raw patches array (untyped passthrough). The
          // parsePatches/validatePatch pipeline in build-result.ts converts
          // these into typed, validated Patch objects.
          ...(Array.isArray(f.patches) ? { rawPatches: f.patches as unknown[] } : {}),
        }))
      : [];

    const designSystemScore = parsed.designSystemScore && typeof parsed.designSystemScore === 'object'
      ? parsed.designSystemScore as Record<string, unknown>
      : undefined;

    const rawScore = typeof parsed.score === 'number' ? parsed.score : 5;
    return {
      score: Math.max(1, Math.min(10, rawScore)),
      findings,
      raw,
      tokensUsed,
      designSystemScore,
    };
  } catch (err) {
    return {
      score: 5,
      findings: [],
      raw,
      tokensUsed,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}
