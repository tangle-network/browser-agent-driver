import { describe, expect, it } from 'vitest';
import type { Action, Turn } from '../src/types.js';
import {
  analyzeRecovery,
  detectBlockingModal,
  detectPersistentTerminalBlocker,
  detectStuck,
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

  it('detects cookie consent dialog and dismisses deterministically', () => {
    const snapshot = `
- dialog:
  - heading "Personalise your shopping experience" [ref=h3733]
  - paragraph
  - button "Allow all" [ref=b919]
  - button "Reject all" [ref=b3efd]
  - button "Manage cookies" [ref=b139d]
`;

    const detection = detectBlockingModal(snapshot);
    expect(detection?.strategy).toBe('cookie-consent-dismiss');
    expect(detection?.action).toEqual({ action: 'click', selector: '@b3efd' });
    expect(detection?.feedback).toContain('ookie');
    expect(detection?.feedback).toContain('Re-verify');
  });

  it('detects cookie consent with Accept Cookies button', () => {
    const snapshot = `
- dialog "Cookie Policy" [ref=d1]:
  - text "We use cookies to improve your experience."
  - button "Accept Cookies" [ref=b5]
  - button "Settings" [ref=b6]
`;

    const detection = detectBlockingModal(snapshot);
    expect(detection?.strategy).toBe('cookie-consent-dismiss');
    expect(detection?.action).toEqual({ action: 'click', selector: '@b5' });
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

  it('detects verification override modal and continues with personal credits', () => {
    const snapshot = `
- dialog "Verification Error" [ref=d1]:
  - text "We couldn't verify your project matches Partner's requirements."
  - button "Use personal credits" [ref=b7]
  - button "Change project" [ref=b8]
`;

    const detection = detectBlockingModal(snapshot);
    expect(detection?.strategy).toBe('modal-use-personal-credits');
    expect(detection?.action).toEqual({ action: 'click', selector: '@b7' });
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

  it('suppresses generic modal recovery after 3+ consecutive turns with dialog', () => {
    // The dialog appears on every turn but actions and URLs vary so stuck detection doesn't fire.
    const dialogSnapshotA = `
- heading "Page A" [ref=h1]
- alertdialog "Support" [ref=d1]:
  - button "Close" [ref=b1]
`;
    const dialogSnapshotB = `
- heading "Page B" [ref=h2]
- alertdialog "Support" [ref=d1]:
  - button "Close" [ref=b1]
`;
    const recentTurns = [
      makeTurn(dialogSnapshotA, 1, { action: 'click', selector: '@h1' }),
      makeTurn(dialogSnapshotB, 2, { action: 'click', selector: '@h2' }),
      makeTurn(dialogSnapshotA, 3, { action: 'click', selector: '@h1' }),
    ];

    const recovery = analyzeRecovery({
      recentTurns,
      currentState: {
        url: 'https://app.example.com',
        title: 'Test',
        snapshot: dialogSnapshotB,
      },
      consecutiveErrors: 0,
    });

    expect(recovery).toBeNull();
  });

  it('returns generic modal recovery when dialog present for fewer than 3 turns', () => {
    const noDialogSnapshot = `
- heading "Dashboard" [ref=h1]
- button "Settings" [ref=b2]
`;
    const dialogSnapshot = `
- alertdialog "Support" [ref=d1]:
  - button "Close" [ref=b1]
`;
    const recentTurns = [
      makeTurn(noDialogSnapshot, 1, { action: 'click', selector: '@b2' }),
      makeTurn(dialogSnapshot, 2, { action: 'click', selector: '@b1' }),
      makeTurn(dialogSnapshot, 3, { action: 'click', selector: '@b1' }),
    ];

    const recovery = analyzeRecovery({
      recentTurns,
      currentState: recentTurns[2].state,
      consecutiveErrors: 0,
    });

    expect(recovery).not.toBeNull();
    expect(recovery?.strategy).toBe('modal-dismiss-click');
  });

  it('always returns specific modal recovery regardless of persistence', () => {
    const cookieSnapshot = `
- dialog "Cookie Policy" [ref=d1]:
  - text "We use cookies to improve your experience."
  - button "Accept Cookies" [ref=b5]
  - button "Settings" [ref=b6]
`;
    const recentTurns = [
      makeTurn(cookieSnapshot, 1, { action: 'click', selector: '@b5' }),
      makeTurn(cookieSnapshot, 2, { action: 'click', selector: '@b5' }),
      makeTurn(cookieSnapshot, 3, { action: 'click', selector: '@b5' }),
      makeTurn(cookieSnapshot, 4, { action: 'click', selector: '@b5' }),
    ];

    const recovery = analyzeRecovery({
      recentTurns,
      currentState: recentTurns[3].state,
      consecutiveErrors: 0,
    });

    expect(recovery).not.toBeNull();
    expect(recovery?.strategy).toBe('cookie-consent-dismiss');
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

  it('detects persistent dev environment blocker loops', () => {
    const snapshot = [
      '- button "Dev environment: Reconnecting" [ref=b2130]:',
      '- dialog:',
      '  - text "Orchestrator Offline"',
      '  - text "Event Stream Connecting"',
      '  - text "Container Not Started"',
      '  - text "Not provisioned"',
      '  - button "Refresh" [ref=b2200]',
    ].join('\n');
    const turns = [1, 2, 3].map((turn) => ({
      turn,
      state: {
        url: 'https://ai.tangle.tools/chat/chat-123',
        title: 'Chat',
        snapshot,
      },
      action: { action: 'click', selector: '@b2200' as const },
      durationMs: 100,
    }));

    const detection = detectPersistentTerminalBlocker(turns, {
      url: 'https://ai.tangle.tools/chat/chat-123',
      title: 'Chat',
      snapshot,
    });

    expect(detection?.kind).toBe('dev-environment-unavailable');
    expect(detection?.strategy).toBe('terminal-dev-environment-unavailable');
    expect(detection?.evidence).toContain('not-provisioned');
  });
});

describe('URL cycle detection', () => {
  function makeTurnWithUrl(url: string, idx: number, snapshot = 'page content'): Turn {
    return {
      turn: idx,
      state: { url, title: 'Test', snapshot: snapshot + idx },
      action: { action: 'click', selector: '@link' },
      durationMs: 100,
    };
  }

  it('detects 3-state URL cycle (A→B→C→A→B→C)', () => {
    const turns = [
      makeTurnWithUrl('https://site.com/search', 1),
      makeTurnWithUrl('https://site.com/news', 2),
      makeTurnWithUrl('https://site.com/releases', 3),
      makeTurnWithUrl('https://site.com/search', 4),
      makeTurnWithUrl('https://site.com/news', 5),
      makeTurnWithUrl('https://site.com/releases', 6),
    ];
    expect(detectStuck(turns, 3)).toBe(true);
  });

  it('detects 2-state URL cycle across different URLs (A→B→A→B→A→B)', () => {
    const turns = [
      makeTurnWithUrl('https://site.com/page-a', 1),
      makeTurnWithUrl('https://site.com/page-b', 2),
      makeTurnWithUrl('https://site.com/page-a', 3),
      makeTurnWithUrl('https://site.com/page-b', 4),
      makeTurnWithUrl('https://site.com/page-a', 5),
      makeTurnWithUrl('https://site.com/page-b', 6),
    ];
    expect(detectStuck(turns, 3)).toBe(true);
  });

  it('does not trigger on normal navigation progress', () => {
    const turns = [
      makeTurnWithUrl('https://site.com/home', 1),
      makeTurnWithUrl('https://site.com/search', 2),
      makeTurnWithUrl('https://site.com/results', 3),
      makeTurnWithUrl('https://site.com/article', 4),
      makeTurnWithUrl('https://site.com/details', 5),
      makeTurnWithUrl('https://site.com/complete', 6),
    ];
    expect(detectStuck(turns, 3)).toBe(false);
  });

  it('analyzeRecovery returns stuck-url-cycle strategy', () => {
    const turns = [
      makeTurnWithUrl('https://nih.gov/search', 1),
      makeTurnWithUrl('https://nih.gov/news', 2),
      makeTurnWithUrl('https://nih.gov/releases', 3),
      makeTurnWithUrl('https://nih.gov/search', 4),
      makeTurnWithUrl('https://nih.gov/news', 5),
      makeTurnWithUrl('https://nih.gov/releases', 6),
    ];
    const recovery = analyzeRecovery({
      recentTurns: turns,
      currentState: turns[5].state,
      consecutiveErrors: 0,
    });
    expect(recovery?.strategy).toBe('stuck-url-cycle');
    expect(recovery?.feedback).toContain('navigating in circle');
  });
});
