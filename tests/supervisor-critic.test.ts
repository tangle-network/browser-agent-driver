import { describe, expect, it } from 'vitest';
import { buildSupervisorUserContent } from '../src/supervisor/critic.js';
import type { PageState } from '../src/types.js';

function makeState(overrides: Partial<PageState> = {}): PageState {
  return {
    url: 'https://example.com',
    title: 'Example',
    snapshot: '- button "Run" [ref=b1]',
    ...overrides,
  };
}

describe('buildSupervisorUserContent', () => {
  it('returns text-only content when vision is disabled', () => {
    const content = buildSupervisorUserContent('hello', makeState({ screenshot: 'abc123' }), false);
    expect(content).toBe('hello');
  });

  it('returns text-only content when no screenshot is available', () => {
    const content = buildSupervisorUserContent('hello', makeState(), true);
    expect(content).toBe('hello');
  });

  it('returns multimodal content when vision is enabled and a screenshot exists', () => {
    const content = buildSupervisorUserContent('hello', makeState({ screenshot: 'abc123' }), true);
    expect(content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image', image: 'abc123', mediaType: 'image/jpeg' },
    ]);
  });
});
