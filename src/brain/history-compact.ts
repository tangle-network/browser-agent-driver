/**
 * Conversation-history compaction. Pure functions over a ModelMessage[]; the
 * Brain class keeps a thin wrapper that passes its own `history`.
 *
 * Compact conversation history: strip ELEMENTS blocks and screenshots
 * from older observations, keeping the last 2 user messages intact.
 *
 * For older turns, replaces the full ELEMENTS block with a one-line
 * summary showing element count and the selectors the agent actually
 * used, extracted from the paired assistant response.
 *
 * Three-tier compression:
 *   Zone 1 (intact):         last 2 turns — full content
 *   Zone 2 (standard):       turns 3-5 back — ELEMENTS stripped from user msgs
 *   Zone 3 (deep compact):   turns 6+ back — both user and assistant ultra-compacted
 */

import type { ModelMessage } from 'ai';

export function compactHistory(history: ModelMessage[]): ModelMessage[] {
  if (history.length === 0) return [];

  // Find indices of the last 2 user messages to keep intact
  const userIndices: number[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      userIndices.push(i);
      if (userIndices.length === 2) break;
    }
  }
  const keepIntactFrom = userIndices.length > 0
    ? userIndices[userIndices.length - 1]
    : history.length;

  // Three-tier compression:
  //   Zone 1 (intact):         last 2 turns — full content
  //   Zone 2 (standard):       turns 3-5 back — ELEMENTS stripped from user msgs
  //   Zone 3 (deep compact):   turns 6+ back — both user and assistant ultra-compacted
  // Keep enough older history for long multi-step travel workflows.
  const deepCompactBefore = Math.max(0, history.length - 10);

  return history.map((msg, idx) => {
    // Zone 1: keep recent turns intact
    if (idx >= keepIntactFrom) return msg;

    // Zone 3: ultra-compact for very old messages (user + assistant)
    if (idx < deepCompactBefore) {
      if (msg.role === 'assistant') {
        const raw = typeof msg.content === 'string' ? msg.content : '';
        return { ...msg, content: deepCompactAssistant(raw) } as ModelMessage;
      }
      if (msg.role === 'user') {
        return { ...msg, content: deepCompactUser(msg) } as ModelMessage;
      }
      return msg;
    }

    // Zone 2: standard compact — strip ELEMENTS from user messages only
    if (msg.role !== 'user') return msg;

    const assistantMsg = idx + 1 < history.length ? history[idx + 1] : undefined;
    const selectors = assistantMsg?.role === 'assistant'
      ? extractSelectorsFromResponse(
          typeof assistantMsg.content === 'string' ? assistantMsg.content : '',
        )
      : [];

    // Handle multimodal content (array of parts)
    if (Array.isArray(msg.content)) {
      const compacted = msg.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => ({
          ...part,
          text: summarizeElements(part.text, selectors),
        }));
      return { ...msg, content: compacted } as ModelMessage;
    }

    // Handle string content
    if (typeof msg.content === 'string') {
      return { ...msg, content: summarizeElements(msg.content, selectors) } as ModelMessage;
    }

    return msg;
  });
}

function deepCompactUser(msg: ModelMessage): string {
  const text = typeof msg.content === 'string'
    ? msg.content
    : Array.isArray(msg.content)
      ? msg.content
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('\n')
      : '';
  const urlMatch = text.match(/URL:\s*(\S+)/);
  const titleMatch = text.match(/Title:\s*(.+?)(?:\n|$)/);
  const url = urlMatch?.[1] ?? 'unknown';
  const title = titleMatch?.[1]?.slice(0, 80) ?? '';
  return `[Prior turn — URL: ${url}${title ? ` | ${title}` : ''}]`;
}

function deepCompactAssistant(raw: string): string {
  try {
    let text = raw.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const parsed = JSON.parse(text);
    const action = parsed.action?.action ?? 'unknown';
    const selector = parsed.action?.selector ?? '';
    const parts = [action];
    if (selector) parts.push(selector);
    if (parsed.action?.url) parts.push(parsed.action.url.slice(0, 120));
    return `[${parts.join(' → ')}]`;
  } catch {
    return raw.slice(0, 100) + (raw.length > 100 ? '…' : '');
  }
}

/**
 * Extract @ref selectors from an assistant JSON response.
 */
function extractSelectorsFromResponse(raw: string): string[] {
  const selectors: string[] = [];
  try {
    let text = raw.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const parsed = JSON.parse(text);
    if (parsed.action?.selector) selectors.push(parsed.action.selector);
    if (Array.isArray(parsed.nextActions)) {
      for (const na of parsed.nextActions) {
        if (na?.selector) selectors.push(na.selector);
      }
    }
  } catch {
    // Best effort
  }
  return selectors;
}

/**
 * Replace the ELEMENTS block with a one-line action-only summary.
 */
function summarizeElements(text: string, selectors: string[]): string {
  return text.replace(
    /ELEMENTS[^:\n]*:\n[\s\S]*?(?=\n\n|What action should you take\?|$)/,
    (match) => {
      const snapshotStart = match.indexOf('\n');
      if (snapshotStart === -1) return 'ELEMENTS:\n[previous snapshot]';
      const snapshotText = match.slice(snapshotStart + 1);
      const elementCount = (snapshotText.match(/\[ref=\w+\]/g) || []).length;
      const selectorList = selectors.length > 0
        ? selectors.join(', ')
        : 'none';
      return `ELEMENTS:\n[Page snapshot: ${elementCount} elements | agent used: ${selectorList}]`;
    },
  );
}
