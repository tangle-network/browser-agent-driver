import { describe, it, expect } from 'vitest';
import { AriaSnapshotHelper, StaleRefError } from '../src/drivers/snapshot.js';

/**
 * Since AriaSnapshotHelper.parseAriaSnapshot is private, we test it
 * indirectly via the public interface: feed raw snapshot text into a
 * helper that exposes the internal parsing through reset() + the
 * ref map side-effects visible in resolveLocator's StaleRefError.
 *
 * For the FNV-1a hash, we test stability and determinism by parsing
 * the same input twice and checking that refs match.
 */

// We can't call private methods directly, but we can extract the stableHash
// function behavior by observing the refs produced from known inputs.
// Instead, we'll test the helper's public interface end-to-end.

// Minimal mock Page that just provides ariaSnapshot() and getByRole()
function mockPage(snapshotYaml: string) {
  const locators = new Map<string, { first: () => unknown }>();

  return {
    locator: (selector: string) => ({
      ariaSnapshot: async () => snapshotYaml,
      first: () => ({ click: async () => {} }),
    }),
    getByRole: (role: string, opts?: { name?: string; exact?: boolean }) => {
      const key = `${role}:${opts?.name ?? ''}`;
      if (!locators.has(key)) {
        locators.set(key, { first: () => ({ click: async () => {} }) });
      }
      return locators.get(key)!;
    },
    evaluate: async () => [],
  } as unknown as import('playwright').Page;
}

describe('AriaSnapshotHelper', () => {
  describe('buildSnapshot', () => {
    it('assigns [ref=...] to interactive elements', async () => {
      const helper = new AriaSnapshotHelper();
      const page = mockPage(
        '- button "Sign in"\n- textbox "Email"\n- paragraph "Hello"',
      );

      const result = await helper.buildSnapshot(page);

      expect(result).toContain('[ref=');
      expect(result).toContain('button "Sign in"');
      expect(result).toContain('textbox "Email"');
    });

    it('produces deterministic refs for same input', async () => {
      const helper1 = new AriaSnapshotHelper();
      const helper2 = new AriaSnapshotHelper();
      const yaml = '- button "Submit"\n- link "Home"';

      const result1 = await helper1.buildSnapshot(mockPage(yaml));
      const result2 = await helper2.buildSnapshot(mockPage(yaml));

      expect(result1).toBe(result2);
    });

    it('handles duplicate elements with index suffixes', async () => {
      const helper = new AriaSnapshotHelper();
      const page = mockPage(
        '- button "Save"\n- button "Save"\n- button "Save"',
      );

      const result = await helper.buildSnapshot(page);

      // First gets bare hash, subsequent get _1, _2
      const refMatches = result.match(/\[ref=([^\]]+)\]/g);
      expect(refMatches).toHaveLength(3);

      const refs = refMatches!.map((m) => m.slice(5, -1));
      // All refs should be unique
      expect(new Set(refs).size).toBe(3);
      // Second and third should have suffixes
      expect(refs[1]).toContain('_1');
      expect(refs[2]).toContain('_2');
    });

    it('returns "(empty page)" for empty snapshot', async () => {
      const helper = new AriaSnapshotHelper();
      const page = mockPage('');

      const result = await helper.buildSnapshot(page);
      expect(result).toBe('(empty page)');
    });

    it('preserves non-interactive elements without refs', async () => {
      const helper = new AriaSnapshotHelper();
      const page = mockPage('- heading "Title" [level=1]\n- text "plain text"');

      const result = await helper.buildSnapshot(page);

      // heading with name gets a ref (named non-text element)
      expect(result).toContain('heading "Title" [ref=');
      // text is excluded (role === 'text')
      expect(result).toContain('- text "plain text"');
      // text line should NOT have a ref
      const textLine = result.split('\n').find((l) => l.includes('text "plain text"'));
      expect(textLine).not.toContain('[ref=');
    });
  });

  describe('resolveLocator', () => {
    it('resolves @ref to a getByRole locator', async () => {
      const helper = new AriaSnapshotHelper();
      const page = mockPage('- button "Sign in"');

      // Build snapshot once to populate refMap
      const snapshot = await helper.buildSnapshot(page);
      const refMatch = snapshot.match(/\[ref=([^\]]+)\]/);
      expect(refMatch).toBeTruthy();

      const ref = refMatch![1];

      // Should not throw — ref is in the current snapshot
      const locator = helper.resolveLocator(page, `@${ref}`);
      expect(locator).toBeDefined();
    });

    it('throws StaleRefError for unknown ref', async () => {
      const helper = new AriaSnapshotHelper();
      const page = mockPage('- button "Sign in"');
      await helper.buildSnapshot(page);

      try {
        helper.resolveLocator(page, '@nonexistent');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StaleRefError);
        const staleErr = err as StaleRefError;
        expect(staleErr.staleRef).toBe('nonexistent');
        expect(staleErr.availableRefs.length).toBeGreaterThan(0);
      }
    });

    it('passes through CSS selectors without @', async () => {
      const helper = new AriaSnapshotHelper();
      const page = mockPage('');

      // Non-ref selector should just call page.locator
      const locator = helper.resolveLocator(page, '.my-button');
      expect(locator).toBeDefined();
    });
  });

  describe('reset', () => {
    it('clears all refs so old refs become stale', async () => {
      const helper = new AriaSnapshotHelper();
      const page = mockPage('- button "Sign in"');

      await helper.buildSnapshot(page);
      const snapshot = await helper.buildSnapshot(mockPage('- button "Sign in"'));
      const ref = snapshot.match(/\[ref=([^\]]+)\]/)![1];

      helper.reset();

      // After reset, the ref should be stale
      expect(() => helper.resolveLocator(page, `@${ref}`)).toThrow(StaleRefError);
    });
  });

  describe('StaleRefError', () => {
    it('includes staleRef and availableRefs', () => {
      const err = new StaleRefError('b3f', ['t1a', 'l2b']);
      expect(err.staleRef).toBe('b3f');
      expect(err.availableRefs).toEqual(['t1a', 'l2b']);
      expect(err.message).toContain('@b3f');
      expect(err.message).toContain('t1a');
      expect(err.name).toBe('StaleRefError');
    });

    it('handles empty availableRefs', () => {
      const err = new StaleRefError('xyz', []);
      expect(err.message).toContain('none');
    });
  });
});
