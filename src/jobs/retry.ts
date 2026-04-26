/**
 * Retry-with-backoff helper used by the jobs queue. Deliberately not an LLM
 * decision — exponential backoff with jitter is a protocol, not a judgment
 * call. Wrapping it in prose adds latency without adding intelligence.
 *
 * Default policy:
 *   - 3 attempts total (one initial + two retries)
 *   - Base delay 500ms, doubles each attempt, capped at 5s
 *   - Adds ±20% jitter so concurrent workers don't synchronize their retries
 *   - Retries network errors, HTTP 429, HTTP 5xx, and timeouts
 *   - Does NOT retry HTTP 4xx, anti-bot blocks, or schema-validation errors
 */

export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  /** Returns true if the error is retryable. */
  isRetryable: (err: Error) => boolean
  /** Override default backoff (for tests). */
  backoffFn?: (attempt: number, base: number, cap: number) => number
  /** Hook fired before each retry — useful for telemetry. */
  onRetry?: (attempt: number, err: Error, delayMs: number) => void
}

const RETRYABLE_PATTERNS = [
  /\b429\b/, // rate limit
  /\b5\d\d\b/, // 5xx
  /timeout/i,
  /timed out/i,
  /etimedout/i,
  /econnreset/i,
  /econnrefused/i,
  /enotfound/i,
  /socket hang up/i,
  /network/i,
  /fetch failed/i,
  /CDX returned 5\d\d/i,
]

/**
 * Whitelist-only: an error is retryable iff it matches one of the patterns
 * above. Anything else (4xx, anti-bot, schema-validation, unknown errors) is
 * deterministic and we don't waste round-trips retrying it.
 */
export function isRetryableDefault(err: Error): boolean {
  return RETRYABLE_PATTERNS.some(re => re.test(err.message))
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000,
  isRetryable: isRetryableDefault,
}

function defaultBackoff(attempt: number, base: number, cap: number): number {
  const exp = Math.min(base * 2 ** attempt, cap)
  const jitter = exp * (0.8 + Math.random() * 0.4) // ±20%
  return Math.round(jitter)
}

/**
 * Run `fn` with retry-on-retryable-failure. Throws the last error after
 * `maxAttempts` exhausted, or immediately on a non-retryable error.
 */
export async function withRetry<T>(fn: () => Promise<T>, policy: RetryPolicy = DEFAULT_RETRY_POLICY): Promise<T> {
  const max = Math.max(1, policy.maxAttempts)
  const backoff = policy.backoffFn ?? defaultBackoff
  let lastErr: Error | undefined
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err as Error
      if (!policy.isRetryable(lastErr)) throw lastErr
      if (attempt === max - 1) break
      const delay = backoff(attempt, policy.baseDelayMs, policy.maxDelayMs)
      policy.onRetry?.(attempt + 1, lastErr, delay)
      await sleep(delay)
    }
  }
  // Tag the final error so callers can tell retried-and-failed apart from never-retried.
  if (lastErr) lastErr.message = `[after ${max} attempts] ${lastErr.message}`
  throw lastErr ?? new Error('withRetry: no error captured but no result returned')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
