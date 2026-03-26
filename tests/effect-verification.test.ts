import { describe, expect, it } from 'vitest';
import type { PageState } from '../src/types.js';
import { verifyExpectedEffect } from '../src/runner.js';

function makeState(overrides: Partial<PageState> = {}): PageState {
  return {
    url: 'https://example.com/start',
    title: 'Start',
    snapshot: '',
    ...overrides,
  };
}

describe('verifyExpectedEffect', () => {
  it('fails quoted-text expectations when the text never appears', () => {
    const result = verifyExpectedEffect({
      expectedEffect: 'The search box should contain the exact task query "Alzheimer\'s disease".',
      preActionState: makeState({ snapshot: '- textbox "Search" [value=""]' }),
      postActionState: makeState({
        url: 'https://example.com/search',
        title: 'Search results',
        snapshot: '- heading "Search results"',
      }),
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('Alzheimer');
  });

  it('passes quoted-text expectations when the value becomes visible in the snapshot', () => {
    const result = verifyExpectedEffect({
      expectedEffect: 'The search box should contain the exact task query "Alzheimer\'s disease".',
      preActionState: makeState({ snapshot: '- textbox "Search" [value=""]' }),
      postActionState: makeState({
        url: 'https://example.com/search',
        title: 'Search results',
        snapshot: '- textbox "Search" [value="Alzheimer\'s disease"]',
      }),
    });

    expect(result.verified).toBe(true);
  });

  it('passes reveal-style expectations when new UI lines appear', () => {
    const result = verifyExpectedEffect({
      expectedEffect: 'The remaining list items should become visible.',
      preActionState: makeState({
        snapshot: '- listitem "Item 1"\n- button "Show more"',
      }),
      postActionState: makeState({
        snapshot: '- listitem "Item 1"\n- listitem "Item 2"\n- listitem "Item 3"\n- button "Show more"',
      }),
    });

    expect(result.verified).toBe(true);
  });

  it('passes dismiss-style expectations when dialog state disappears', () => {
    const result = verifyExpectedEffect({
      expectedEffect: 'The modal should close.',
      preActionState: makeState({
        snapshot: '- dialog "Cookie preferences"\n  - button "Accept"',
      }),
      postActionState: makeState({
        snapshot: '- heading "Welcome back"',
      }),
    });

    expect(result.verified).toBe(true);
  });

  it('fails switch-style expectations when the page identity does not change', () => {
    const state = makeState({
      snapshot: '- link "News"\n- heading "Home"',
    });
    const result = verifyExpectedEffect({
      expectedEffect: 'The search results page should switch to the News tab or news-filtered results.',
      preActionState: state,
      postActionState: state,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('did not materially change');
  });

  it('passes URL expectations only when the URL target is present', () => {
    const result = verifyExpectedEffect({
      expectedEffect: 'URL should contain "/dashboard"',
      preActionState: makeState(),
      postActionState: makeState({ url: 'https://example.com/dashboard' }),
    });

    expect(result.verified).toBe(true);
  });
});
