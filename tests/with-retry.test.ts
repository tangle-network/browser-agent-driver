import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../src/runner.js';

describe('withRetry', () => {
  it('returns on successful first attempt without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, 3, 10);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure then succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('recovered');
    const onRetry = vi.fn();

    const result = await withRetry(fn, 3, 10, onRetry);
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });

  it('throws after exhausting all retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('permanent'));
    const onRetry = vi.fn();

    await expect(withRetry(fn, 3, 10, onRetry)).rejects.toThrow('permanent');
    expect(fn).toHaveBeenCalledTimes(3);
    // onRetry called on attempts 1 and 2 (not on the final attempt)
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('throws immediately when signal is already aborted', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const controller = new AbortController();
    controller.abort('pre-cancelled');

    await expect(withRetry(fn, 3, 10, undefined, controller.signal)).rejects.toThrow('pre-cancelled');
    expect(fn).not.toHaveBeenCalled();
  });

  it('aborts during backoff delay when signal fires', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('should-not-reach');

    const controller = new AbortController();

    // Abort shortly after the first failure, while backoff is pending
    const promise = withRetry(fn, 3, 5000, undefined, controller.signal);

    // Give time for the first attempt to fail and the backoff timer to start
    await new Promise((r) => setTimeout(r, 20));
    controller.abort('user-cancelled');

    await expect(promise).rejects.toThrow('user-cancelled');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('applies increasing backoff delay (delayMs * attempt)', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail-1'))
        .mockRejectedValueOnce(new Error('fail-2'))
        .mockResolvedValueOnce('ok');

      const promise = withRetry(fn, 3, 100);

      // After first failure, backoff = 100 * 1 = 100ms
      await vi.advanceTimersByTimeAsync(100);
      // After second failure, backoff = 100 * 2 = 200ms
      await vi.advanceTimersByTimeAsync(200);

      const result = await promise;
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wraps non-Error thrown values into Error objects', async () => {
    const fn = vi.fn().mockRejectedValue('string-error');

    await expect(withRetry(fn, 1, 10)).rejects.toThrow('string-error');
  });

  it('throws "no attempts made" when retries is 0', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    await expect(withRetry(fn, 0, 10)).rejects.toThrow('withRetry: no attempts made');
    expect(fn).not.toHaveBeenCalled();
  });
});
