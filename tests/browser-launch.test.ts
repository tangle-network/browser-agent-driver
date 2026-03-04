import { describe, expect, it } from 'vitest';
import { buildBrowserLaunchPlan } from '../src/browser-launch.js';

describe('buildBrowserLaunchPlan', () => {
  it('uses standard launch defaults when wallet mode is disabled', () => {
    const plan = buildBrowserLaunchPlan({}, { cwd: '/repo', platform: 'darwin' });

    expect(plan.walletMode).toBe(false);
    expect(plan.headless).toBe(true);
    expect(plan.concurrency).toBe(1);
    expect(plan.viewport).toEqual({ width: 1920, height: 1080 });
    expect(plan.browserArgs).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.errors).toEqual([]);
  });

  it('enables wallet mode when extension paths are provided', () => {
    const plan = buildBrowserLaunchPlan({
      headless: true,
      concurrency: 4,
      wallet: { extensionPaths: ['extensions/metamask'] },
    }, { cwd: '/repo', platform: 'darwin' });

    expect(plan.walletMode).toBe(true);
    expect(plan.headless).toBe(true);
    expect(plan.concurrency).toBe(1);
    expect(plan.extensionPaths).toEqual(['/repo/extensions/metamask']);
    expect(plan.browserArgs).toContain('--disable-extensions-except=/repo/extensions/metamask');
    expect(plan.browserArgs).toContain('--load-extension=/repo/extensions/metamask');
    expect(plan.warnings).toEqual([
      'Wallet mode is running headless. Extension compatibility depends on your Chromium build; use headed mode if wallet prompts fail.',
      'Wallet mode is single-session. Overriding concurrency=4 to concurrency=1.',
    ]);
    expect(plan.errors).toEqual([]);
  });

  it('does not enable wallet mode when only userDataDir is set', () => {
    const plan = buildBrowserLaunchPlan({
      headless: false,
      wallet: { userDataDir: '.wallet-profile' },
    }, { cwd: '/repo', platform: 'darwin' });

    expect(plan.walletMode).toBe(false);
    expect(plan.userDataDir).toBe('/repo/.wallet-profile');
    expect(plan.browserArgs).toEqual([]);
    expect(plan.warnings).toEqual([
      'wallet.userDataDir is set but wallet mode is disabled; this directory is ignored unless --wallet or --extension is provided.',
    ]);
    expect(plan.errors).toEqual([]);
  });

  it('preserves browser args and appends extension args in wallet mode', () => {
    const plan = buildBrowserLaunchPlan({
      browserArgs: ['--lang=en-US'],
      wallet: {
        enabled: true,
        extensionPaths: ['/abs/ext-a', '/abs/ext-b'],
      },
    }, { cwd: '/repo', platform: 'darwin' });

    expect(plan.browserArgs).toEqual([
      '--lang=en-US',
      '--disable-extensions-except=/abs/ext-a,/abs/ext-b',
      '--load-extension=/abs/ext-a,/abs/ext-b',
    ]);
    expect(plan.errors).toEqual([]);
  });

  it('coerces wallet concurrency to 1 for non-1 values', () => {
    const plan = buildBrowserLaunchPlan({
      headless: false,
      concurrency: 0,
      wallet: { enabled: true },
    }, { cwd: '/repo', platform: 'darwin' });

    expect(plan.concurrency).toBe(1);
    expect(plan.warnings).toContain('Wallet mode is single-session. Overriding concurrency=0 to concurrency=1.');
  });

  it('emits a Linux preflight error when wallet mode has no display server env', () => {
    const plan = buildBrowserLaunchPlan({
      headless: false,
      wallet: { enabled: true },
    }, {
      cwd: '/repo',
      platform: 'linux',
      env: {},
    });

    expect(plan.errors).toEqual([
      'Wallet mode on Linux requires a display server, but neither DISPLAY nor WAYLAND_DISPLAY is set. Start an X11/Wayland session or use xvfb-run, then retry.',
    ]);
  });

  it('warns when Linux DISPLAY is set without XAUTHORITY in wallet mode', () => {
    const plan = buildBrowserLaunchPlan({
      headless: false,
      wallet: { enabled: true },
    }, {
      cwd: '/repo',
      platform: 'linux',
      env: { DISPLAY: ':0' },
    });

    expect(plan.errors).toEqual([]);
    expect(plan.warnings).toContain(
      'DISPLAY is set but XAUTHORITY is not. If Chromium cannot connect to X11, export XAUTHORITY to your active session auth file.',
    );
  });

  it('warns when Linux WAYLAND_DISPLAY is set without XDG_RUNTIME_DIR in wallet mode', () => {
    const plan = buildBrowserLaunchPlan({
      headless: false,
      wallet: { enabled: true },
    }, {
      cwd: '/repo',
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
    });

    expect(plan.errors).toEqual([]);
    expect(plan.warnings).toContain(
      'WAYLAND_DISPLAY is set but XDG_RUNTIME_DIR is not. If Chromium cannot connect to Wayland, set XDG_RUNTIME_DIR for your session.',
    );
  });
});
