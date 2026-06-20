/**
 * Knowledge-extraction task for the Brain decision engine: distills a completed
 * trajectory into reusable timing/selector/pattern/quirk facts that help an
 * agent complete similar tasks faster next time.
 *
 * Extracted from brain/index.ts via the delegate + host-interface pattern.
 * Brain.extractKnowledge keeps a thin delegator; the body lives here verbatim
 * and reads Brain state through {@link BrainKnowledgeHost}, which Brain
 * `implements` so tsc proves the host surface is complete.
 */

import type { ModelMessage, SystemModelMessage } from 'ai';
import type { ModelSelection, GenerateResult } from '../model-client.js';

/**
 * The slice of Brain state `extractKnowledge` reads — just the transport funnel.
 * `implements BrainKnowledgeHost` makes a missing/mistyped member a compile
 * error.
 */
export interface BrainKnowledgeHost {
  generate(
    system: string | SystemModelMessage[],
    messages: ModelMessage[],
    selection?: ModelSelection,
    maxOutputTokens?: number,
  ): Promise<GenerateResult>;
}

export async function extractKnowledgeImpl(
  self: BrainKnowledgeHost,
  trajectoryText: string,
  domain: string,
): Promise<Array<{ type: 'timing' | 'selector' | 'pattern' | 'quirk'; key: string; value: string }>> {
  const result = await self.generate(
    `You are analyzing a browser automation trajectory to extract reusable knowledge.
Extract facts that would help an agent complete similar tasks faster next time.

Respond with ONLY a JSON array of facts:
[
  {"type": "timing", "key": "page-load", "value": "wait 3000ms after navigation for content to hydrate"},
  {"type": "selector", "key": "send-button", "value": "[data-testid='chat-send-button'] is the reliable send button selector"},
  {"type": "pattern", "key": "auth-flow", "value": "Click sign-in → fill email → fill password → click submit → wait for redirect"},
  {"type": "quirk", "key": "lazy-loading", "value": "File tree loads asynchronously — wait for entries before asserting"}
]

Types:
- timing: wait durations, delays that are necessary
- selector: reliable selectors for important elements
- pattern: multi-step interaction sequences
- quirk: app-specific behaviors or gotchas

Only include facts that are genuinely useful. Quality over quantity. Max 10 facts.`,
    [{
      role: 'user',
      content: `Domain: ${domain}\n\nTrajectory:\n${trajectoryText}`,
    }],
    undefined,
    800,
  );

  try {
    let text = result.text.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];

    const VALID_TYPES = new Set(['timing', 'selector', 'pattern', 'quirk']);
    return parsed
      .filter((f: Record<string, unknown>) =>
        VALID_TYPES.has(f.type as string) &&
        typeof f.key === 'string' &&
        typeof f.value === 'string'
      )
      .map((f: Record<string, unknown>) => ({
        type: f.type as 'timing' | 'selector' | 'pattern' | 'quirk',
        key: f.key as string,
        value: f.value as string,
      }));
  } catch {
    return [];
  }
}
