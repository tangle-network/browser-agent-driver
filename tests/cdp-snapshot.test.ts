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
