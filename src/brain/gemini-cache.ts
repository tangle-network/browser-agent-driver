/**
 * Explicit Gemini context caching (v1beta cachedContents REST API).
 *
 * Why: implicit caching topped out at ~23% cached-input for bad (browser-use
 * gets ~35%). The AI SDK's google provider accepts `providerOptions.google
 * .cachedContent` (a cache resource name) but cannot CREATE caches — that
 * is a separate REST call, implemented here.
 *
 * Cost math (gemini-2.5-flash, LiteLLM rates — input $0.30/M, cached read
 * $0.03/M, cache storage $1.00/M-token/hour):
 *   - write: systemTokens × $0.30/M, once per cache lifetime
 *   - storage: systemTokens/1M × $1.00/hour × ttl
 *   - read: systemTokens × $0.03/M per call instead of $0.30/M
 * bad's decide system prompt ≈ 3-4k tokens and a run makes ~5-15 calls:
 * with a 10-minute TTL the write+storage is ~$0.0016 and the reads save
 * ~$0.009/10-call run — net ≈ +$0.007/run (~15% of the $0.047 mean), and
 * better when consecutive reps of the same task reuse the live cache
 * (identical system prompt → same cache key).
 *
 * Safety: every failure path (creation error, expiry race, API rejecting
 * the cached request) falls back to the plain uncached call. Disable with
 * BAD_GEMINI_CACHE=0 for A/B isolation.
 */

import { createHash } from 'node:crypto';

/** Gemini 2.5 Flash explicit-cache floor is 1024 tokens; ≈4 chars/token
 *  plus headroom keeps us clearly above it. */
const MIN_CACHEABLE_CHARS = 5000;

interface CacheEntry {
  name: string;
  /** Unix ms when this entry should be considered expired (TTL minus a
   *  safety margin so we never reference a dead cache). */
  expiresAt: number;
}

const caches = new Map<string, CacheEntry>();

/** Default TTL: long enough for one slow run (10 min) plus reuse by the
 *  immediate next rep of the same task. */
const DEFAULT_TTL_SECONDS = 600;
/** Re-create when this close to expiry. */
const EXPIRY_MARGIN_MS = 60_000;

export function geminiCacheEnabled(): boolean {
  return process.env.BAD_GEMINI_CACHE !== '0';
}

export function isCacheableSystemText(systemText: string): boolean {
  return systemText.length >= MIN_CACHEABLE_CHARS;
}

function cacheKey(model: string, systemText: string): string {
  return createHash('sha256').update(`${model}\n${systemText}`).digest('hex').slice(0, 32);
}

/**
 * Return a live cachedContents resource name for (model, systemText),
 * creating the cache on first use. Returns undefined on any failure —
 * callers must treat that as "proceed without a cache".
 */
export async function ensureGeminiCache(opts: {
  apiKey: string;
  model: string;
  systemText: string;
  ttlSeconds?: number;
  debug?: boolean;
}): Promise<string | undefined> {
  const { apiKey, model, systemText, debug } = opts;
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const key = cacheKey(model, systemText);
  const existing = caches.get(key);
  if (existing && Date.now() < existing.expiresAt - EXPIRY_MARGIN_MS) {
    return existing.name;
  }
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${model}`,
          systemInstruction: { parts: [{ text: systemText }] },
          ttl: `${ttl}s`,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      if (debug) console.log(`[Brain] gemini cache create failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      return undefined;
    }
    const body = await res.json() as { name?: string };
    if (!body.name) return undefined;
    caches.set(key, { name: body.name, expiresAt: Date.now() + ttl * 1000 });
    if (debug) console.log(`[Brain] gemini cache created: ${body.name} (${systemText.length} chars, ttl ${ttl}s)`);
    return body.name;
  } catch (err) {
    if (debug) console.log(`[Brain] gemini cache create error: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Test hook: forget all live cache entries. */
export function resetGeminiCachesForTest(): void {
  caches.clear();
}
