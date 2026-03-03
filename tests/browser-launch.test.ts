import { describe, expect, it } from 'vitest';
import { buildBrowserLaunchPlan } from '../src/browser-launch.js';

describe('buildBrowserLaunchPlan', () => {
  it('uses standard launch defaults when wallet mode is disabled', () => {
    const plan = buildBrowserLaunchPlan({}, { cwd: '/repo' });

    expect(plan.walletMode).toBe(false);
    expect(plan.headless).toBe(true);
    expect(plan.concurrency).toBe(1);
    expect(plan.viewport).toEqual({ width: 1920, height: 1080 });
    expect(plan.browserArgs).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it('enables wallet mode when extension paths are provided', () => {
    const plan = buildBrowserLaunchPlan({
      headless: true,
      concurrency: 4,
      wallet: { extensionPaths: ['extensions/metamask'] },
    }, { cwd: '/repo' });

    expect(plan.walletMode).toBe(true);
    expect(plan.headless).toBe(false);
    expect(plan.concurrency).toBe(1);
    expect(plan.extensionPaths).toEqual(['/repo/extensions/metamask']);
    expect(plan.browserArgs).toContain('--disable-extensions-except=/repo/extensions/metamask');
    expect(plan.browserArgs).toContain('--load-extension=/repo/extensions/metamask');
    expect(plan.warnings).toEqual([
      'Wallet mode requires headed Chromium. Forcing headless=false.',
      'Wallet mode is single-session. Forcing concurrency=1.',
    ]);
  });

  it('enables wallet mode when userDataDir is set, even without extension paths', () => {
    const plan = buildBrowserLaunchPlan({
      headless: false,
      wallet: { userDataDir: '.wallet-profile' },
    }, { cwd: '/repo' });

    expect(plan.walletMode).toBe(true);
    expect(plan.userDataDir).toBe('/repo/.wallet-profile');
    expect(plan.browserArgs).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it('preserves browser args and appends extension args in wallet mode', () => {
    const plan = buildBrowserLaunchPlan({
      browserArgs: ['--lang=en-US'],
      wallet: {
        enabled: true,
        extensionPaths: ['/abs/ext-a', '/abs/ext-b'],
      },
    }, { cwd: '/repo' });

    expect(plan.browserArgs).toEqual([
      '--lang=en-US',
      '--disable-extensions-except=/abs/ext-a,/abs/ext-b',
      '--load-extension=/abs/ext-a,/abs/ext-b',
    ]);
  });
});
