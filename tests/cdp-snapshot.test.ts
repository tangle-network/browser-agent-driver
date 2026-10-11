import { describe, it, expect, vi } from 'vitest';
import { buildCdpSnapshot } from '../src/drivers/cdp-snapshot.js';
import { stableHash, INTERACTIVE_ROLES } from '../src/drivers/snapshot.js';
import { getPageMetadata } from '../src/drivers/cdp-page-state.js';

/**
 * Mock CDPSession that responds to CDP commands with predefined data.
 */
function mockCdpSession(responses: Record<string, unknown>) {
  return {
    send: vi.fn(async (method: string, _params?: unknown) => {
      if (method in responses) {
        return responses[method];
      }
      throw new Error(`Unhandled CDP method: ${method}`);
    }),
    detach: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as import('playwright').CDPSession;
}

describe('buildCdpSnapshot', () => {
  it('produces snapshot with refs for interactive elements', async () => {
    const cdp = mockCdpSession({
      'Accessibility.getFullAXTree': {
        nodes: [
          { nodeId: '1', role: { type: 'role', value: 'WebArea' }, name: { type: 'computedString', value: 'Test' }, childIds: ['2', '3'] },
          { nodeId: '2', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Sign in' } },
          { nodeId: '3', parentId: '1', role: { type: 'role', value: 'textbox' }, name: { type: 'computedString', value: 'Email' }, value: { type: 'computedString', value: '' } },
        ],
      },
    });

    const result = await buildCdpSnapshot(cdp);

    expect(result.snapshot).toContain('button "Sign in"');
    expect(result.snapshot).toContain('textbox "Email"');
    expect(result.snapshot).toContain('[ref=');
    expect(result.snapshot).toContain('[value=""]');
    expect(result.refMap.size).toBe(2);
    expect(result.elements.size).toBe(2);
  });

  it('produces deterministic refs matching stableHash', async () => {
    const cdp = mockCdpSession({
      'Accessibility.getFullAXTree': {
        nodes: [
          { nodeId: '1', role: { type: 'role', value: 'WebArea' }, childIds: ['2'] },
          { nodeId: '2', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Submit' } },
        ],
      },
    });

    const result = await buildCdpSnapshot(cdp);

    const expectedRef = stableHash('button', 'Submit');
    expect(result.refMap.has(expectedRef)).toBe(true);
    expect(result.snapshot).toContain(`[ref=${expectedRef}]`);
  });

  it('handles duplicate elements with index suffixes', async () => {
    const cdp = mockCdpSession({
      'Accessibility.getFullAXTree': {
        nodes: [
          { nodeId: '1', role: { type: 'role', value: 'WebArea' }, childIds: ['2', '3', '4'] },
          { nodeId: '2', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Save' } },
          { nodeId: '3', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Save' } },
          { nodeId: '4', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Save' } },
        ],
      },
    });

    const result = await buildCdpSnapshot(cdp);

    expect(result.refMap.size).toBe(3);
    const refs = [...result.refMap.keys()];
    expect(new Set(refs).size).toBe(3);
    // Second and third get suffixes
    expect(refs[1]).toContain('_1');
    expect(refs[2]).toContain('_2');
  });

  it('returns empty page for no nodes', async () => {
    const cdp = mockCdpSession({
      'Accessibility.getFullAXTree': { nodes: [] },
    });

    const result = await buildCdpSnapshot(cdp);
    expect(result.snapshot).toBe('(empty page)');
    expect(result.refMap.size).toBe(0);
  });

  it('skips ignored nodes', async () => {
    const cdp = mockCdpSession({
      'Accessibility.getFullAXTree': {
        nodes: [
          { nodeId: '1', role: { type: 'role', value: 'WebArea' }, childIds: ['2', '3'] },
          { nodeId: '2', parentId: '1', ignored: true, role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Hidden' } },
          { nodeId: '3', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Visible' } },
        ],
      },
    });

    const result = await buildCdpSnapshot(cdp);
    expect(result.snapshot).not.toContain('Hidden');
    expect(result.snapshot).toContain('Visible');
    expect(result.refMap.size).toBe(1);
  });

  it('skips generic/structural roles', async () => {
    const cdp = mockCdpSession({
      'Accessibility.getFullAXTree': {
        nodes: [
          { nodeId: '1', role: { type: 'role', value: 'WebArea' }, childIds: ['2', '3'] },
          { nodeId: '2', parentId: '1', role: { type: 'role', value: 'generic' }, childIds: ['3'] },
          { nodeId: '3', parentId: '2', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Click me' } },
        ],
      },
    });

    const result = await buildCdpSnapshot(cdp);
    expect(result.snapshot).not.toContain('generic');
    expect(result.snapshot).toContain('button "Click me"');
  });

  it('preserves tree structure with indentation', async () => {
    const cdp = mockCdpSession({
      'Accessibility.getFullAXTree': {
        nodes: [
          { nodeId: '1', role: { type: 'role', value: 'WebArea' }, childIds: ['2'] },
          { nodeId: '2', parentId: '1', role: { type: 'role', value: 'navigation' }, name: { type: 'computedString', value: 'Main' }, childIds: ['3'] },
          { nodeId: '3', parentId: '2', role: { type: 'role', value: 'link' }, name: { type: 'computedString', value: 'Home' } },
        ],
      },
    });

    const result = await buildCdpSnapshot(cdp);
    const lines = result.snapshot.split('\n');
    // navigation at depth 0
    expect(lines[0]).toMatch(/^- navigation "Main"/);
    // link at depth 1 (indented)
    expect(lines[1]).toMatch(/^\s{2}- link "Home"/);
  });

  it('does not assign ref to text role', async () => {
    const cdp = mockCdpSession({
      'Accessibility.getFullAXTree': {
        nodes: [
          { nodeId: '1', role: { type: 'role', value: 'WebArea' }, childIds: ['2'] },
          { nodeId: '2', parentId: '1', role: { type: 'role', value: 'text' }, name: { type: 'computedString', value: 'plain text' } },
        ],
      },
    });

    const result = await buildCdpSnapshot(cdp);
    expect(result.snapshot).toContain('text "plain text"');
    expect(result.snapshot).not.toContain('[ref=');
    expect(result.refMap.size).toBe(0);
  });

  it('stores backendDOMNodeId in refMap', async () => {
    const cdp = mockCdpSession({
      'Accessibility.getFullAXTree': {
        nodes: [
          { nodeId: '1', role: { type: 'role', value: 'WebArea' }, childIds: ['2'] },
          { nodeId: '2', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'OK' }, backendDOMNodeId: 42 },
        ],
      },
    });

    const result = await buildCdpSnapshot(cdp);
    const ref = [...result.refMap.keys()][0];
    expect(result.refMap.get(ref)!.backendNodeId).toBe(42);
  });
});

describe('getPageMetadata', () => {
  it('returns URL, title, and testIds from single evaluate', async () => {
    const cdp = mockCdpSession({
      'Runtime.evaluate': {
        result: {
          type: 'string',
          value: JSON.stringify({
            url: 'https://example.com/test',
            title: 'Test Page',
            testIds: [
              { testId: 'submit-btn', tag: 'button', text: 'Submit', disabled: false },
            ],
          }),
        },
      },
    });

    const meta = await getPageMetadata(cdp);
    expect(meta.url).toBe('https://example.com/test');
    expect(meta.title).toBe('Test Page');
    expect(meta.testIds).toHaveLength(1);
    expect(meta.testIds[0].testId).toBe('submit-btn');
  });

  it('handles unexpected response format gracefully', async () => {
    const cdp = mockCdpSession({
      'Runtime.evaluate': {
        result: { type: 'undefined', value: undefined },
      },
    });

    const meta = await getPageMetadata(cdp);
    expect(meta.url).toBe('');
    expect(meta.title).toBe('');
    expect(meta.testIds).toHaveLength(0);
  });
});

describe('stableHash export', () => {
  it('is accessible and deterministic', () => {
    const h1 = stableHash('button', 'Submit');
    const h2 = stableHash('button', 'Submit');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^b/); // starts with role initial
  });

  it('produces different hashes for different inputs', () => {
    const h1 = stableHash('button', 'Submit');
    const h2 = stableHash('link', 'Submit');
    const h3 = stableHash('button', 'Cancel');
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

describe('INTERACTIVE_ROLES export', () => {
  it('contains expected roles', () => {
    expect(INTERACTIVE_ROLES.has('button')).toBe(true);
    expect(INTERACTIVE_ROLES.has('link')).toBe(true);
    expect(INTERACTIVE_ROLES.has('textbox')).toBe(true);
    expect(INTERACTIVE_ROLES.has('checkbox')).toBe(true);
  });

  it('does not contain non-interactive roles', () => {
    expect(INTERACTIVE_ROLES.has('heading')).toBe(false);
    expect(INTERACTIVE_ROLES.has('paragraph')).toBe(false);
    expect(INTERACTIVE_ROLES.has('text')).toBe(false);
  });
});

describe('buildCdpSnapshot — wave-3 Date control + structural pruning', () => {
  function axNode(id: string, parentId: string | undefined, role: string, name: string, childIds?: string[], value?: string) {
    return {
      nodeId: id,
      ...(parentId ? { parentId } : {}),
      role: { type: 'role', value: role },
      name: { type: 'computedString', value: name },
      ...(childIds ? { childIds } : {}),
      ...(value !== undefined ? { value: { type: 'computedString', value } } : {}),
    };
  }

  it('rewrites a Chrome Date group to one fillable ref and drops shadow parts', async () => {
    const cdp = mockCdpSession({
      'Accessibility.getFullAXTree': {
        nodes: [
          axNode('1', undefined, 'WebArea', 'Form', ['2', '3']),
          axNode('2', '1', 'Date', 'Date of Birth', ['2a', '2b', '2c', '2d']),
          axNode('2a', '2', 'spinbutton', 'Month Month', undefined, '0'),
          axNode('2b', '2', 'spinbutton', 'Day Day', undefined, '0'),
          axNode('2c', '2', 'spinbutton', 'Year Year', undefined, '0'),
          axNode('2d', '2', 'button', 'Show date picker'),
          axNode('3', '1', 'button', 'Next'),
        ],
      },
    });
    const result = await buildCdpSnapshot(cdp);
    expect(result.snapshot).toContain('date "Date of Birth" [ref=');
    expect(result.snapshot).toContain('YYYY-MM-DD');
    expect(result.snapshot).not.toContain('spinbutton');
    expect(result.snapshot).not.toContain('Show date picker');
    expect(result.snapshot).toContain('button "Next"');
    // The ref resolves through the Date role for the getByLabel path.
    const ref = [...result.refMap.entries()].find(([, v]) => v.role === 'Date');
    expect(ref).toBeDefined();
  });

  it('drops nameless structural wrappers but keeps their children and named content', async () => {
    const longName = 'A'.repeat(180);
    const cdp = mockCdpSession({
      'Accessibility.getFullAXTree': {
        nodes: [
          axNode('1', undefined, 'WebArea', 'HN', ['2']),
          axNode('2', '1', 'table', '', ['3']),
          axNode('3', '2', 'row', '', ['4', '5']),
          axNode('4', '3', 'cell', '', ['6']),
          axNode('6', '4', 'link', longName),
          axNode('5', '3', 'cell', '247 points'),
        ],
      },
    });
    const result = await buildCdpSnapshot(cdp);
    expect(result.snapshot).not.toContain('- row');
    expect(result.snapshot).not.toContain('- table');
    // The link survives with its name capped for display…
    expect(result.snapshot).toContain('…');
    expect(result.snapshot).not.toContain(longName);
    // …while the refMap keeps the full name for getByRole resolution.
    const linkRef = [...result.refMap.values()].find((v) => v.role === 'link');
    expect(linkRef?.name).toBe(longName);
    // Named content (the extraction payload) survives.
    expect(result.snapshot).toContain('247 points');
  });
});
