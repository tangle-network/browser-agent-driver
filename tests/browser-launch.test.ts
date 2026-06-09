import { describe, expect, it } from 'vitest';
import { buildBrowserLaunchPlan } from '../src/browser-launch.js';

describe('buildBrowserLaunchPlan', () => {
  it('uses standard launch defaults when wallet mode is disabled', () => {
    const plan = buildBrowserLaunchPlan({}, { cwd: '/repo', platform: 'darwin' });

    expect(plan.profile).toBe('default');
    expect(plan.walletMode).toBe(false);
    expect(plan.headless).toBe(true);
    expect(plan.concurrency).toBe(1);
    expect(plan.viewport).toEqual({ width: 1920, height: 1080 });
    expect(plan.browserArgs).toContain('--disable-blink-features=AutomationControlled');
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
    expect(plan.browserArgs).toContain('--disable-blink-features=AutomationControlled');
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

    expect(plan.browserArgs).toContain('--lang=en-US');
    expect(plan.browserArgs).toContain('--disable-extensions-except=/abs/ext-a,/abs/ext-b');
    expect(plan.browserArgs).toContain('--load-extension=/abs/ext-a,/abs/ext-b');
    expect(plan.browserArgs).toContain('--disable-blink-features=AutomationControlled');
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

  it('applies stealth profile launch args without duplicating existing values', () => {
    const plan = buildBrowserLaunchPlan({
      profile: 'stealth',
      browserArgs: ['--disable-infobars'],
    }, { cwd: '/repo', platform: 'darwin' });

    expect(plan.profile).toBe('stealth');
    // Stealth args applied universally — --disable-infobars not duplicated
    expect(plan.browserArgs).toContain('--disable-infobars');
    expect(plan.browserArgs).toContain('--disable-blink-features=AutomationControlled');
    expect(plan.browserArgs).toContain('--no-first-run');
    expect(plan.browserArgs).toContain('--use-gl=desktop');
    expect(plan.browserArgs.filter(a => a === '--disable-infobars')).toHaveLength(1);
  });

  it('profileDir without wallet: persistentContext true, walletMode false', () => {
    const plan = buildBrowserLaunchPlan({ profileDir: '/tmp/my-profile' })
    expect(plan.persistentContext).toBe(true)
    expect(plan.walletMode).toBe(false)
    expect(plan.userDataDir).toBe('/tmp/my-profile')
  })

  it('profileDir with wallet.enabled: wallet takes precedence', () => {
    const plan = buildBrowserLaunchPlan({
      profileDir: '/tmp/my-profile',
      wallet: { enabled: true, userDataDir: '/tmp/wallet-profile' },
    })
    expect(plan.persistentContext).toBe(true)
    expect(plan.walletMode).toBe(true)
    expect(plan.userDataDir).toBe('/tmp/wallet-profile')
  })

  it('profileDir alone: no wallet warning', () => {
    const plan = buildBrowserLaunchPlan({ profileDir: '/tmp/my-profile' })
    expect(plan.warnings).not.toContainEqual(expect.stringContaining('wallet.userDataDir'))
  })

  it('cdpUrl is passed through to plan', () => {
    const plan = buildBrowserLaunchPlan({ cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' })
    expect(plan.cdpUrl).toBe('ws://127.0.0.1:9222/devtools/browser/abc')
    expect(plan.persistentContext).toBe(false)
    expect(plan.walletMode).toBe(false)
  })

  it('cdpUrl with profileDir warns about ignored options', () => {
    const plan = buildBrowserLaunchPlan({
      cdpUrl: 'ws://127.0.0.1:9222',
      profileDir: '/tmp/my-profile',
    })
    expect(plan.cdpUrl).toBe('ws://127.0.0.1:9222')
    expect(plan.warnings).toContainEqual(expect.stringContaining('--cdp-url'))
  })

  it('applies stealth-ish launch args for benchmark-webbench-stealth', () => {
    const plan = buildBrowserLaunchPlan({
      profile: 'benchmark-webbench-stealth',
    }, { cwd: '/repo', platform: 'darwin' });

    expect(plan.profile).toBe('benchmark-webbench-stealth');
    expect(plan.browserArgs).toContain('--disable-blink-features=AutomationControlled');
    expect(plan.browserArgs).toContain('--disable-infobars');
    expect(plan.browserArgs).toContain('--no-first-run');
    expect(plan.browserArgs).toContain('--use-gl=desktop');
  });

  // Regression: bad-app run 75e8f39c (browser.tangle.tools) — "Terminal blocker: destination is
  // unreachable from the current browser environment. (signals: chrome-error-url)". The sandbox's
  // iron-proxy egress forces all outbound through a per-sandbox MITM proxy via HTTP(S)_PROXY env,
  // but Playwright's Chromium ignores those env vars, so the browser connected directly and the
  // host egress firewall dropped it (ERR_NAME_NOT_RESOLVED). These pin the auto-wiring + the
  // narrow conditions under which we relax cert validation.
  describe('managed egress proxy (iron-proxy)', () => {
    const egressEnv = {
      EGRESS_PROXY_IP: '172.18.0.7',
      HTTPS_PROXY: 'http://172.18.0.7:1080',
      HTTP_PROXY: 'http://172.18.0.7:80',
      NO_PROXY: 'localhost,127.0.0.1',
    };

    it('auto-wires the egress proxy (CONNECT listener) and accepts its MITM cert', () => {
      const plan = buildBrowserLaunchPlan({}, { env: egressEnv });
      expect(plan.proxyServer).toBe('http://172.18.0.7:1080'); // prefers HTTPS_PROXY
      expect(plan.proxyBypass).toBe('localhost,127.0.0.1');
      expect(plan.ignoreHTTPSErrors).toBe(true);
      expect(plan.warnings).toContainEqual(expect.stringContaining('managed egress proxy'));
    });

    it('falls back to HTTP_PROXY when HTTPS_PROXY is unset', () => {
      const plan = buildBrowserLaunchPlan({}, {
        env: { EGRESS_PROXY_IP: '10.0.0.5', HTTP_PROXY: 'http://10.0.0.5:80' },
      });
      expect(plan.proxyServer).toBe('http://10.0.0.5:80');
      expect(plan.ignoreHTTPSErrors).toBe(true);
    });

    it('does NOT hijack ambient HTTP(S)_PROXY without the EGRESS_PROXY_IP sentinel', () => {
      const plan = buildBrowserLaunchPlan({}, {
        env: { HTTP_PROXY: 'http://corp-proxy:8080', HTTPS_PROXY: 'http://corp-proxy:8080' },
      });
      expect(plan.proxyServer).toBeUndefined();
      expect(plan.ignoreHTTPSErrors).toBe(false);
      expect(plan.warnings).not.toContainEqual(expect.stringContaining('managed egress proxy'));
    });

    it('explicit --proxy wins over the egress proxy and keeps cert validation on', () => {
      const plan = buildBrowserLaunchPlan(
        { proxy: 'http://user:pass@residential:9000' },
        { env: egressEnv },
      );
      expect(plan.proxyServer).toBe('http://user:pass@residential:9000');
      expect(plan.proxyBypass).toBeUndefined();
      expect(plan.ignoreHTTPSErrors).toBe(false);
    });

    it('BAD_PROXY_URL (env) wins over the egress proxy and keeps cert validation on', () => {
      const plan = buildBrowserLaunchPlan({}, {
        env: { ...egressEnv, BAD_PROXY_URL: 'http://baduser:badpass@res:7000' },
      });
      expect(plan.proxyServer).toBe('http://baduser:badpass@res:7000');
      expect(plan.proxyBypass).toBeUndefined();
      expect(plan.ignoreHTTPSErrors).toBe(false);
    });

    it('no proxy configured → no proxy, cert validation on', () => {
      const plan = buildBrowserLaunchPlan({}, { env: {} });
      expect(plan.proxyServer).toBeUndefined();
      expect(plan.proxyBypass).toBeUndefined();
      expect(plan.ignoreHTTPSErrors).toBe(false);
    });

    it('warns (and wires nothing) when EGRESS_PROXY_IP is set but HTTP(S)_PROXY is absent', () => {
      // The sentinel alone is insufficient — otherwise the browser silently connects direct and hits
      // ERR_NAME_NOT_RESOLVED, reproducing the very bug this feature prevents.
      const plan = buildBrowserLaunchPlan({}, { env: { EGRESS_PROXY_IP: '172.18.0.7' } });
      expect(plan.proxyServer).toBeUndefined();
      expect(plan.ignoreHTTPSErrors).toBe(false);
      expect(plan.warnings).toContainEqual(
        expect.stringContaining('EGRESS_PROXY_IP is set but neither HTTPS_PROXY nor HTTP_PROXY'),
      );
    });

    it('treats a whitespace-only EGRESS_PROXY_IP as absent', () => {
      const plan = buildBrowserLaunchPlan({}, {
        env: { EGRESS_PROXY_IP: '   ', HTTPS_PROXY: 'http://172.18.0.7:1080' },
      });
      expect(plan.proxyServer).toBeUndefined();
      expect(plan.ignoreHTTPSErrors).toBe(false);
      expect(plan.warnings).not.toContainEqual(expect.stringContaining('managed egress proxy'));
    });

    it('warns that --cdp-url bypasses the managed egress proxy', () => {
      const plan = buildBrowserLaunchPlan(
        { cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' },
        { env: egressEnv },
      );
      expect(plan.warnings).toContainEqual(
        expect.stringContaining('managed egress proxy is NOT applied'),
      );
    });
  });
});
