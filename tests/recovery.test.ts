import { describe, expect, it } from 'vitest';
import type { Action, Turn } from '../src/types.js';
import {
  analyzeRecovery,
  detectBlockingModal,
  detectTerminalBlocker,
  parseSnapshotElements,
} from '../src/recovery.js';

function makeTurn(snapshot: string, idx: number, action: Action = { action: 'wait', ms: 500 }): Turn {
  return {
    turn: idx,
    state: {
      url: 'https://app.example.com',
      title: 'Test',
      snapshot,
    },
    action,
    durationMs: 100,
  };
}

describe('recovery blocker handling', () => {
  it('parses snapshot elements with refs', () => {
    const snapshot = `
- dialog "Project limit reached" [ref=d1]:
  - button "Manage projects" [ref=b1]
  - button "Delete project" [ref=b2]
  - link "Billing" [ref=l1]
`;

    const parsed = parseSnapshotElements(snapshot);
    expect(parsed).toEqual([
      { role: 'dialog', name: 'Project limit reached', ref: 'd1' },
      { role: 'button', name: 'Manage projects', ref: 'b1' },
      { role: 'button', name: 'Delete project', ref: 'b2' },
      { role: 'link', name: 'Billing', ref: 'l1' },
    ]);
  });

  it('detects quota modal and prefers management path', () => {
    const snapshot = `
- dialog "Project limit reached" [ref=d1]:
  - text "You reached your project limit."
  - button "Manage projects" [ref=b1]
  - button "Delete project" [ref=b2]
`;

    const detection = detectBlockingModal(snapshot);
    expect(detection?.strategy).toBe('quota-limit-manage');
    expect(detection?.action).toEqual({ action: 'click', selector: '@b1' });
  });

  it('falls back to cleanup path when no manage button exists', () => {
    const snapshot = `
- dialog "Project limit reached" [ref=d1]:
  - text "Maximum projects reached."
  - button "Delete project" [ref=b2]
`;

    const detection = detectBlockingModal(snapshot);
    expect(detection?.strategy).toBe('quota-limit-cleanup');
    expect(detection?.action).toEqual({ action: 'click', selector: '@b2' });
  });

  it('detects generic modal and chooses a dismiss button', () => {
    const snapshot = `
- dialog "Welcome back" [ref=d1]:
  - text "Here is what changed"
  - button "Got it" [ref=b9]
`;

    const detection = detectBlockingModal(snapshot);
    expect(detection?.strategy).toBe('modal-dismiss-click');
    expect(detection?.action).toEqual({ action: 'click', selector: '@b9' });
  });

  it('detects delete confirmation modal and confirms cleanup', () => {
    const snapshot = `
- dialog "Delete 1 item?" [ref=d2]:
  - text "Are you sure you want to delete this project?"
  - button "Cancel" [ref=b3]
  - button "Delete" [ref=b4]
`;

    const detection = detectBlockingModal(snapshot);
    expect(detection?.strategy).toBe('modal-confirm-delete');
    expect(detection?.action).toEqual({ action: 'click', selector: '@b4' });
  });

  it('analyzeRecovery prioritizes blocker modal over stuck reload', () => {
    const blockedSnapshot = `
- dialog "Project limit reached" [ref=d1]:
  - text "Project limit reached"
  - button "Manage projects" [ref=b1]
`;

    const recentTurns = [
      makeTurn(blockedSnapshot, 1, { action: 'click', selector: '@x1' }),
      makeTurn(blockedSnapshot, 2, { action: 'click', selector: '@x1' }),
      makeTurn(blockedSnapshot, 3, { action: 'click', selector: '@x1' }),
    ];

    const recovery = analyzeRecovery({
      recentTurns,
      currentState: recentTurns[2].state,
      consecutiveErrors: 0,
    });

    expect(recovery?.strategy).toBe('quota-limit-manage');
    expect(recovery?.forceBrowserAction).toEqual({ action: 'click', selector: '@b1' });
    expect(recovery?.forceAction).toBeUndefined();
  });

  it('does not force escape when modal has no clear dismiss action', () => {
    const snapshot = `
- dialog "Action required" [ref=d1]:
  - text "Please resolve this issue"
`;

    const recovery = analyzeRecovery({
      recentTurns: [makeTurn(snapshot, 1), makeTurn(snapshot, 2)],
      currentState: {
        url: 'https://app.example.com',
        title: 'Blocked',
        snapshot,
      },
      consecutiveErrors: 0,
    });

    expect(recovery?.strategy).toBe('modal-present-no-force');
    expect(recovery?.forceAction).toBeUndefined();
    expect(recovery?.forceBrowserAction).toBeUndefined();
  });
});

describe('terminal blocker detection', () => {
  it('detects unreachable network states', () => {
    const detection = detectTerminalBlocker({
      url: 'chrome-error://chromewebdata/',
      title: 'This site can’t be reached',
      snapshot: '- heading "This site can’t be reached"',
    });

    expect(detection?.kind).toBe('network-unreachable');
    expect(detection?.strategy).toBe('terminal-network-error');
    expect(detection?.evidence.length).toBeGreaterThan(0);
  });

  it('detects bot challenge states', () => {
    const detection = detectTerminalBlocker({
      url: 'https://example.com/challenge',
      title: 'Attention required',
      snapshot: '- heading "Verify you are human"\n- text "Checking your browser before accessing"',
    });

    expect(detection?.kind).toBe('bot-challenge');
    expect(detection?.strategy).toBe('terminal-bot-challenge');
    expect(detection?.evidence.length).toBeGreaterThan(0);
  });

  it('detects cloudflare interstitial phrasing', () => {
    const detection = detectTerminalBlocker({
      url: 'https://www.crunchyroll.com/',
      title: 'Just a moment...',
      snapshot: '- text "Performing security verification"\n- text "Checking if the site connection is secure"',
    });

    expect(detection?.kind).toBe('bot-challenge');
    expect(detection?.evidence).toContain('cloudflare-security-verification');
  });

  it('does not trigger on normal application pages', () => {
    const detection = detectTerminalBlocker({
      url: 'https://ai.tangle.tools/dashboard',
      title: 'Dashboard',
      snapshot: '- heading "Runs"\n- text "Cloudflare docs are linked in help center"',
    });

    expect(detection).toBeNull();
  });
});
