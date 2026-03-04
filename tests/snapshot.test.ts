import { describe, it, expect } from 'vitest';
import { AriaSnapshotHelper, StaleRefError } from '../src/drivers/snapshot.js';
import { ANALYTICS_PATTERNS, IMAGE_PATTERNS, MEDIA_PATTERNS } from '../src/drivers/block-patterns.js';

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

  describe('getDiff (snapshot diffing)', () => {
    it('returns undefined on first buildSnapshot', async () => {
      const helper = new AriaSnapshotHelper();
      await helper.buildSnapshot(mockPage('- button "Sign in"'));
      expect(helper.getDiff()).toBeUndefined();
    });

    it('detects added elements', async () => {
      const helper = new AriaSnapshotHelper();
      await helper.buildSnapshot(mockPage('- button "Sign in"'));

      helper.reset();
      await helper.buildSnapshot(mockPage('- button "Sign in"\n- link "Register"'));

      const diff = helper.getDiff();
      expect(diff).toBeDefined();
      expect(diff).toContain('ADDED:');
      expect(diff).toContain('link "Register"');
    });

    it('detects removed elements', async () => {
      const helper = new AriaSnapshotHelper();
      await helper.buildSnapshot(mockPage('- button "Sign in"\n- link "Register"'));

      helper.reset();
      await helper.buildSnapshot(mockPage('- button "Sign in"'));

      const diff = helper.getDiff();
      expect(diff).toBeDefined();
      expect(diff).toContain('REMOVED:');
      expect(diff).toContain('link "Register"');
    });

    it('detects changed values', async () => {
      const helper = new AriaSnapshotHelper();
      await helper.buildSnapshot(mockPage('- textbox "Email" [value=""]'));

      helper.reset();
      await helper.buildSnapshot(mockPage('- textbox "Email" [value="test@example.com"]'));

      const diff = helper.getDiff();
      expect(diff).toBeDefined();
      expect(diff).toContain('CHANGED:');
      expect(diff).toContain('test@example.com');
    });

    it('reports unchanged count', async () => {
      const helper = new AriaSnapshotHelper();
      await helper.buildSnapshot(mockPage('- button "Save"\n- button "Cancel"'));

      helper.reset();
      await helper.buildSnapshot(mockPage('- button "Save"\n- button "Cancel"'));

      const diff = helper.getDiff();
      expect(diff).toBeDefined();
      expect(diff).toContain('2 elements unchanged');
    });

    it('returns raw structured diff via getRawDiff', async () => {
      const helper = new AriaSnapshotHelper();
      await helper.buildSnapshot(mockPage('- button "Save"'));

      helper.reset();
      await helper.buildSnapshot(mockPage('- button "Save"\n- link "Help"'));

      const raw = helper.getRawDiff();
      expect(raw).toBeDefined();
      expect(raw!.added).toHaveLength(1);
      expect(raw!.removed).toHaveLength(0);
      expect(raw!.changed).toHaveLength(0);
      expect(raw!.unchangedCount).toBe(1);
    });
  });

  describe('formatCompact', () => {
    it('produces compact format from full snapshot', async () => {
      const helper = new AriaSnapshotHelper();
      const snapshot = await helper.buildSnapshot(mockPage(
        '- button "Sign in"\n- textbox "Email" [value=""]\n- list "Nav":\n  - link "Home"',
      ));

      const compact = AriaSnapshotHelper.formatCompact(snapshot);
      const lines = compact.split('\n');

      // Should have entries for all ref'd elements
      expect(lines.length).toBeGreaterThanOrEqual(3);

      // Each line starts with @ref
      for (const line of lines) {
        expect(line).toMatch(/^@\w+ \w+ "/);
      }

      // Check ref-first format
      expect(compact).toContain('button "Sign in"');
      expect(compact).toContain('textbox "Email"');
      expect(compact).toContain('val=""');
      expect(compact).toContain('link "Home"');
    });

    it('strips tree indentation (flat output)', async () => {
      const helper = new AriaSnapshotHelper();
      const snapshot = await helper.buildSnapshot(mockPage(
        '- list "Nav":\n  - link "Home"\n  - link "About"',
      ));

      const compact = AriaSnapshotHelper.formatCompact(snapshot);

      // No indentation in compact format
      for (const line of compact.split('\n')) {
        expect(line).not.toMatch(/^\s/);
      }
    });

    it('returns empty string for snapshot with no ref elements', () => {
      const compact = AriaSnapshotHelper.formatCompact('- text "hello"\n- paragraph "world"');
      expect(compact).toBe('');
    });
  });

  describe('importCdpRefs', () => {
    it('populates refMap so resolveLocator works', async () => {
      const helper = new AriaSnapshotHelper();
      const page = mockPage('');

      const refMap = new Map([
        ['b1a2', { role: 'button', name: 'OK' }],
      ]);
      const elements = new Map([
        ['b1a2', { ref: 'b1a2', role: 'button', name: 'OK' }],
      ]);

      helper.importCdpRefs(refMap, elements);

      // Should resolve without throwing
      const locator = helper.resolveLocator(page, '@b1a2');
      expect(locator).toBeDefined();
    });

    it('throws StaleRefError for unknown refs after importCdpRefs', () => {
      const helper = new AriaSnapshotHelper();
      const page = mockPage('');

      const refMap = new Map([
        ['b1a2', { role: 'button', name: 'OK' }],
      ]);
      const elements = new Map([
        ['b1a2', { ref: 'b1a2', role: 'button', name: 'OK' }],
      ]);

      helper.importCdpRefs(refMap, elements);

      expect(() => helper.resolveLocator(page, '@missing')).toThrow(StaleRefError);
    });

    it('computes diff between CDP snapshots', () => {
      const helper = new AriaSnapshotHelper();

      // First snapshot
      const refMap1 = new Map([
        ['b1', { role: 'button', name: 'Save' }],
      ]);
      const elements1 = new Map([
        ['b1', { ref: 'b1', role: 'button', name: 'Save' }],
      ]);
      helper.importCdpRefs(refMap1, elements1);

      // No diff on first import
      expect(helper.getDiff()).toBeUndefined();

      helper.reset();

      // Second snapshot with an added element
      const refMap2 = new Map([
        ['b1', { role: 'button', name: 'Save' }],
        ['l1', { role: 'link', name: 'Help' }],
      ]);
      const elements2 = new Map([
        ['b1', { ref: 'b1', role: 'button', name: 'Save' }],
        ['l1', { ref: 'l1', role: 'link', name: 'Help' }],
      ]);
      helper.importCdpRefs(refMap2, elements2);

      const diff = helper.getDiff();
      expect(diff).toBeDefined();
      expect(diff).toContain('ADDED:');
      expect(diff).toContain('link "Help"');
    });

    it('detects value changes via importCdpRefs', () => {
      const helper = new AriaSnapshotHelper();

      // First snapshot
      helper.importCdpRefs(
        new Map([['t1', { role: 'textbox', name: 'Email' }]]),
        new Map([['t1', { ref: 't1', role: 'textbox', name: 'Email', value: '' }]]),
      );

      helper.reset();

      // Second snapshot: value changed
      helper.importCdpRefs(
        new Map([['t1', { role: 'textbox', name: 'Email' }]]),
        new Map([['t1', { ref: 't1', role: 'textbox', name: 'Email', value: 'test@example.com' }]]),
      );

      const diff = helper.getDiff();
      expect(diff).toBeDefined();
      expect(diff).toContain('CHANGED:');
      expect(diff).toContain('test@example.com');
    });
  });

  describe('resource blocking patterns', () => {
    it('exports non-empty analytics patterns', () => {
      expect(ANALYTICS_PATTERNS.length).toBeGreaterThan(50);
      expect(ANALYTICS_PATTERNS).toContain('google-analytics.com');
      expect(ANALYTICS_PATTERNS).toContain('segment.io');
      expect(ANALYTICS_PATTERNS).toContain('mixpanel.com');
    });

    it('exports image patterns', () => {
      expect(IMAGE_PATTERNS).toContain('.png');
      expect(IMAGE_PATTERNS).toContain('.jpg');
      expect(IMAGE_PATTERNS).toContain('.webp');
    });

    it('exports media patterns', () => {
      expect(MEDIA_PATTERNS).toContain('.mp4');
      expect(MEDIA_PATTERNS).toContain('.mp3');
      expect(MEDIA_PATTERNS).toContain('.webm');
    });

    it('analytics patterns match expected URLs', () => {
      const testUrls = [
        'https://www.google-analytics.com/analytics.js',
        'https://cdn.segment.com/analytics.min.js',
        'https://cdn.amplitude.com/libs/amplitude-8.js',
        'https://static.hotjar.com/c/hotjar-123.js',
      ];
      for (const url of testUrls) {
        const blocked = ANALYTICS_PATTERNS.some(p => url.includes(p));
        expect(blocked).toBe(true);
      }
    });

    it('does not block regular URLs', () => {
      const safeUrls = [
        'https://example.com/api/data',
        'https://cdn.example.com/app.js',
        'https://mysite.com/styles.css',
      ];
      for (const url of safeUrls) {
        const blocked = ANALYTICS_PATTERNS.some(p => url.includes(p));
        expect(blocked).toBe(false);
      }
    });
  });
});
