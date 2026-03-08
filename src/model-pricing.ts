/**
 * Model pricing — fetched from LiteLLM's community-maintained pricing database.
 *
 * Source: https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
 *
 * Pricing is fetched once on first use, cached in memory and on disk (24h TTL).
 * Falls back to a minimal hardcoded table if the fetch fails.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const CACHE_PATH = join(tmpdir(), 'agent-browser-driver-model-pricing.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface ModelPricing {
  /** Cost per token (USD) */
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken?: number;
}

/**
 * Context-length-based tiered pricing overrides.
 * Some models (e.g., gpt-5.4) charge more above a context threshold.
 * LiteLLM's database only has the base tier, so we handle overrides here.
 * Pricing is per 1M tokens.
 */
const TIERED_PRICING: Record<string, { threshold: number; input: number; output: number }> = {
  'gpt-5.4':           { threshold: 272_000, input: 5.00, output: 22.50 },
  'gpt-5.4-2026-03-05': { threshold: 272_000, input: 5.00, output: 22.50 },
  'gpt-5.2':           { threshold: 200_000, input: 3.50, output: 21.00 },
};

/** Parsed pricing map: model name → pricing */
let pricingCache: Map<string, ModelPricing> | null = null;

/**
 * Minimal fallback pricing (per 1M tokens) for when the fetch fails.
 * These are last-known-good values — always prefer the fetched database.
 */
const FALLBACK_PRICING: Record<string, { input: number; output: number; cacheRead?: number }> = {
  'gpt-5.4':           { input: 2.50,  output: 15.00, cacheRead: 0.25 },
  'gpt-5.2':           { input: 1.75,  output: 14.00, cacheRead: 0.175 },
  'gpt-5.1':           { input: 1.25,  output: 10.00, cacheRead: 0.125 },
  'gpt-5.3-codex':     { input: 1.75,  output: 14.00, cacheRead: 0.175 },
  'gpt-4.1':           { input: 2.00,  output: 8.00,  cacheRead: 0.20 },
  'gpt-4.1-mini':      { input: 0.40,  output: 1.60,  cacheRead: 0.04 },
  'gpt-4.1-nano':      { input: 0.10,  output: 0.40,  cacheRead: 0.01 },
  'gpt-4o':            { input: 2.50,  output: 10.00, cacheRead: 1.25 },
  'gpt-4o-mini':       { input: 0.15,  output: 0.60,  cacheRead: 0.075 },
  'claude-opus-4-6':   { input: 5.00,  output: 25.00, cacheRead: 0.50 },
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00, cacheRead: 0.30 },
  'claude-haiku-4-5':  { input: 1.00,  output: 5.00,  cacheRead: 0.10 },
};

function parseLiteLLMPricing(raw: Record<string, unknown>): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'sample_spec') continue;
    const entry = value as Record<string, unknown>;
    const inputCost = entry.input_cost_per_token;
    const outputCost = entry.output_cost_per_token;
    if (typeof inputCost !== 'number' || typeof outputCost !== 'number') continue;
    map.set(key, {
      inputCostPerToken: inputCost,
      outputCostPerToken: outputCost,
      cacheReadCostPerToken: typeof entry.cache_read_input_token_cost === 'number'
        ? entry.cache_read_input_token_cost
        : undefined,
    });
  }
  return map;
}

function loadDiskCache(): Map<string, ModelPricing> | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
    if (Date.now() - raw.fetchedAt > CACHE_TTL_MS) return null;
    return parseLiteLLMPricing(raw.data);
  } catch {
    return null;
  }
}

function saveDiskCache(data: Record<string, unknown>): void {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), data }));
  } catch {
    // Best-effort
  }
}

function buildFallbackMap(): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const [key, { input, output, cacheRead }] of Object.entries(FALLBACK_PRICING)) {
    map.set(key, {
      inputCostPerToken: input / 1_000_000,
      outputCostPerToken: output / 1_000_000,
      cacheReadCostPerToken: cacheRead != null ? cacheRead / 1_000_000 : undefined,
    });
  }
  return map;
}

/**
 * Load the pricing database. Tries (in order):
 * 1. In-memory cache
 * 2. Disk cache (24h TTL)
 * 3. Fetch from GitHub
 * 4. Hardcoded fallback
 */
export async function loadPricing(): Promise<Map<string, ModelPricing>> {
  if (pricingCache) return pricingCache;

  // Try disk cache
  const diskCached = loadDiskCache();
  if (diskCached && diskCached.size > 50) {
    pricingCache = diskCached;
    return pricingCache;
  }

  // Fetch from GitHub
  try {
    const response = await fetch(LITELLM_PRICING_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const data = await response.json() as Record<string, unknown>;
      const parsed = parseLiteLLMPricing(data);
      if (parsed.size > 50) {
        pricingCache = parsed;
        saveDiskCache(data);
        return pricingCache;
      }
    }
  } catch {
    // Network failure — fall through to fallback
  }

  // Fallback
  pricingCache = buildFallbackMap();
  return pricingCache;
}

/** Synchronous version — returns fallback if not yet loaded */
export function getPricingSync(): Map<string, ModelPricing> {
  if (pricingCache) return pricingCache;
  // Try disk cache synchronously
  const diskCached = loadDiskCache();
  if (diskCached && diskCached.size > 50) {
    pricingCache = diskCached;
    return pricingCache;
  }
  pricingCache = buildFallbackMap();
  return pricingCache;
}

/**
 * Look up pricing for a model. Tries exact match, then prefix match.
 */
export function getModelPricing(model: string): ModelPricing | null {
  const pricing = getPricingSync();

  // Exact match
  if (pricing.has(model)) return pricing.get(model)!;

  // Prefix match (e.g., "gpt-5.4-turbo" matches "gpt-5.4")
  for (const [key, value] of pricing) {
    if (model.startsWith(key) || key.startsWith(model)) {
      return value;
    }
  }

  return null;
}

/**
 * Calculate estimated cost in USD for a set of tokens.
 *
 * @param model - Model name
 * @param inputTokens - Total input tokens (summed across all calls)
 * @param outputTokens - Total output tokens
 * @param cacheReadTokens - Tokens served from cache (discounted rate)
 * @param maxInputPerCall - Largest single-call input context size.
 *   Used to determine tiered pricing (e.g., gpt-5.4 charges 2x above 272K context).
 *   If not provided, uses base tier pricing.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  maxInputPerCall = 0,
): number {
  let pricing = getModelPricing(model);
  if (!pricing) return 0;
  if (inputTokens === 0 && outputTokens === 0) return 0;

  // Check for context-length tiered pricing override
  const tiered = TIERED_PRICING[model];
  if (tiered && maxInputPerCall > tiered.threshold) {
    pricing = {
      ...pricing,
      inputCostPerToken: tiered.input / 1_000_000,
      outputCostPerToken: tiered.output / 1_000_000,
    };
  }

  const nonCachedInput = Math.max(0, inputTokens - cacheReadTokens);
  const cacheReadCost = pricing.cacheReadCostPerToken ?? pricing.inputCostPerToken;

  return (
    nonCachedInput * pricing.inputCostPerToken +
    cacheReadTokens * cacheReadCost +
    outputTokens * pricing.outputCostPerToken
  );
}
