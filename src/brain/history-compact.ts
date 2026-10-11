/**
 * Conversation-history compaction. Pure functions over a ModelMessage[]; the
 * Brain class keeps a thin wrapper that passes its own `history`.
 *
 * Compact conversation history: strip ELEMENTS blocks and screenshots
 * from older observations, keeping only the last user message intact.
 *
 * For older turns, replaces the full ELEMENTS block with a one-line
 * summary showing element count and the selectors the agent actually
 * used, extracted from the paired assistant response.
 *
 * Three-tier compression:
 *   Zone 1 (intact):         last turn — full content
 *   Zone 2 (standard):       turns 3-5 back — ELEMENTS stripped from user msgs
 *   Zone 3 (deep compact):   turns 6+ back — both user and assistant ultra-compacted
 */

import type { ModelMessage } from 'ai';

export function compactHistory(history: ModelMessage[]): ModelMessage[] {
  if (history.length === 0) return [];

  // Find the index of the last user message to keep intact. Only the most
  // recent turn needs the full snapshot — every older turn's ELEMENTS block
  // is compressible to a selector summary (Wave-1 token bound: was 2 intact
  // user messages, which kept a second full snapshot alive every turn).
  const userIndices: number[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      userIndices.push(i);
      if (userIndices.length === 1) break;
    }
  }
  const keepIntactFrom = userIndices.length > 0
    ? userIndices[userIndices.length - 1]
    : history.length;

  // Three-tier compression:
  //   Zone 1 (intact):         last turn — full content
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

// ── Prefix-stable history (wave 2) ──────────────────────────────────────
//
// compactHistory() above rewrites older messages in place every turn as the
// zone boundaries shift — the same message mutates intact → stripped →
// deep-compacted as it ages, which busts the provider's implicit prefix
// cache on EVERY turn (bench: bad's cache-hit rate ~17% vs browser-use's
// 36%, cache hits clustering at ~1k tokens).
//
// materializeHistoryPrefix() is the append-only alternative:
//   - The tail (last HISTORY_TAIL_MESSAGES messages) is never rewritten.
//   - When the tail overflows, the oldest messages are summarized ONCE and
//     the summary lines are APPENDED to a persistent summary block that
//     lives at the front of the conversation. Prior content is never
//     re-edited, so the request prefix is byte-stable between
//     materializations (one cache bust per ~HISTORY_TAIL_MESSAGES/2 turns
//     instead of every turn), and old context is preserved as summaries
//     rather than dropped outright.

/** Tail size in messages (user+assistant pairs ×2). 8 = 4 full turns intact. */
export const HISTORY_TAIL_MESSAGES = 8;

/** Tail size in characters. The message-count cap works for interaction
 *  runs (small snapshots), but extraction runs carry 8-24k-char user
 *  messages — 4 intact turns of those is ~30k tokens of re-read history
 *  per decide call (the wave-3 top cost item; measured on wikipedia and
 *  dashboard-extract artifacts). Materialize once the tail exceeds this
 *  budget, always keeping the freshest pair intact. */
export const HISTORY_TAIL_CHARS = 20_000;

export interface MaterializingHistoryHost {
  history: ModelMessage[];
  /** Append-only compaction ledger. Mutated in place by
   *  materializeHistoryPrefix; cleared on Brain.reset(). */
  historySummary: string;
}

/**
 * Build the message list for the next decide call, materializing the
 * summary block when the tail overflows. Mutates host.history (drops
 * summarized messages) and host.historySummary (appends summary lines).
 */
export function materializeHistoryPrefix(host: MaterializingHistoryHost): ModelMessage[] {
  // Overflow is measured in BOTH messages (cap for lean turns) and chars
  // (cap for fat extraction turns). Always keep the freshest pair intact —
  // the model needs its immediately-preceding observation verbatim.
  const excessCount = (h: ModelMessage[]): number => {
    const lenOf = (m: ModelMessage): number =>
      typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
    let keep = Math.min(2, h.length);
    let chars = 0;
    for (let i = h.length - keep; i < h.length; i++) chars += lenOf(h[i]);
    while (keep < h.length && keep < HISTORY_TAIL_MESSAGES) {
      const nextLen = lenOf(h[h.length - keep - 1]);
      if (chars + nextLen > HISTORY_TAIL_CHARS) break;
      chars += nextLen;
      keep++;
    }
    return h.length - keep;
  };

  const excess = excessCount(host.history);
  if (excess > 0) {
    const olds = host.history.slice(0, excess);
    host.history = host.history.slice(excess);
    const lines = olds.map((msg) =>
      msg.role === 'assistant'
        ? deepCompactAssistant(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content))
        : deepCompactUser(msg),
    );
    host.historySummary = host.historySummary
      ? `${host.historySummary}\n${lines.join('\n')}`
      : lines.join('\n');
  }
  const messages: ModelMessage[] = [];
  if (host.historySummary) {
    messages.push({
      role: 'user',
      content: `PRIOR TURNS (compacted, oldest first):\n${host.historySummary}`,
    });
  }
  return [...messages, ...host.history];
}
