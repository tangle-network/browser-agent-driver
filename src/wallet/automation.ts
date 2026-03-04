import type { BrowserContext, Page } from 'playwright';

export const DEFAULT_WALLET_ACTION_SELECTORS = [
  '[data-testid="unlock-submit"]',
  '[data-testid="page-container-footer-next"]',
  '[data-testid="page-container-footer-confirm"]',
  '[data-testid="confirmation-submit-button"]',
  '[data-testid="confirm-button"]',
  '[data-testid="confirm-btn"]',
  '[data-testid="confirm-footer-button"]',
  '[data-testid="request-signature__sign"]',
  '[data-testid="request-signature__sign-button"]',
  '[data-testid="onboarding-complete-done"]',
  '[data-testid="pin-extension-next"]',
  '[data-testid="pin-extension-done"]',
  'button:has-text("Connect")',
  '[role="button"]:has-text("Connect")',
  'button:has-text("Approve")',
  '[role="button"]:has-text("Approve")',
  'button:has-text("Confirm")',
  '[role="button"]:has-text("Confirm")',
  'button:has-text("Sign")',
  '[role="button"]:has-text("Sign")',
  'button:has-text("Switch network")',
  '[role="button"]:has-text("Switch network")',
  'button:has-text("Switch Network")',
  '[role="button"]:has-text("Switch Network")',
  'button:has-text("Add network")',
  '[role="button"]:has-text("Add network")',
  'button:has-text("Add Network")',
  '[role="button"]:has-text("Add Network")',
  'button:has-text("Open wallet")',
  '[role="button"]:has-text("Open wallet")',
  'button:has-text("Done")',
  '[role="button"]:has-text("Done")',
  'button:has-text("Got it")',
  '[role="button"]:has-text("Got it")',
  'button:has-text("Next")',
  '[role="button"]:has-text("Next")',
  'button:has-text("No thanks")',
  '[role="button"]:has-text("No thanks")',
  'button:has-text("No Thanks")',
  '[role="button"]:has-text("No Thanks")',
];

export const DEFAULT_CONNECT_SELECTORS = [
  'button:text-matches("^\\s*Connect Wallet\\s*$", "i")',
  '[role="button"]:text-matches("^\\s*Connect Wallet\\s*$", "i")',
  'button:text-matches("^\\s*Connect\\s*$", "i")',
  '[role="button"]:text-matches("^\\s*Connect\\s*$", "i")',
];

export const DEFAULT_CONNECTOR_SELECTORS = [
  '[data-testid^="evm-wallet-option-"]',
  'button[data-wallet-name*="MetaMask" i]',
  '[role="button"][data-wallet-name*="MetaMask" i]',
  'button:text-matches("meta\\s*mask", "i")',
  '[role="button"]:text-matches("meta\\s*mask", "i")',
  'button:text-matches("injected", "i")',
  '[role="button"]:text-matches("injected", "i")',
  'button:has-text("Browser Wallet")',
  '[role="button"]:has-text("Browser Wallet")',
];

export const DEFAULT_PROMPT_PATHS = [
  'popup-init.html',
  'popup.html',
  'notification.html',
  'home.html',
];

export interface WalletAutomationOptions {
  password?: string;
  extensionId?: string;
  tickMs?: number;
  actionSelectors?: string[];
  promptPaths?: string[];
  log?: (message: string) => void;
}

export interface WalletPreflightChainTarget {
  id?: number;
  hex?: string;
  rpcUrl?: string;
  name?: string;
  nativeCurrency?: {
    name: string;
    symbol: string;
    decimals: number;
  };
}

export interface WalletPreflightOptions extends WalletAutomationOptions {
  seedUrls: string[];
  connectSelectors?: string[];
  connectorSelectors?: string[];
  requestAccounts?: boolean;
  clearStorage?: boolean;
  accountsTimeoutMs?: number;
  maxChainSwitchAttempts?: number;
  chain?: WalletPreflightChainTarget;
}

export interface WalletOriginPreflightResult {
  url: string;
  ready: boolean;
  accounts: string[];
  chainId: string | null;
  details?: string;
}

export interface WalletPreflightResult {
  ok: boolean;
  failedUrl?: string;
  results: WalletOriginPreflightResult[];
}

const DEFAULT_PASSWORD = 'TangleLocal123!';
const DEFAULT_RPC_URL = 'http://127.0.0.1:8545';
const DEFAULT_CHAIN_NAME = 'Local Chain';

const defaultLogger = (_message: string) => {};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallbackValue: T,
): Promise<T> => {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeoutId = setTimeout(() => resolve(fallbackValue), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const readWalletAccounts = async (page: Page): Promise<string[]> => {
  const result = await withTimeout(
    page
      .evaluate(async () => {
        const provider = (window as Window & { ethereum?: { request?: (args: unknown) => Promise<unknown> } }).ethereum;
        if (!provider?.request) {
          return [];
        }
        try {
          const accounts = await provider.request({ method: 'eth_accounts' });
          return Array.isArray(accounts)
            ? accounts.filter((value): value is string => typeof value === 'string')
            : [];
        } catch {
          return [];
        }
      })
      .catch(() => []),
    10_000,
    [],
  );

  return Array.isArray(result) ? result : [];
};

const readWalletChainId = async (page: Page): Promise<string | null> => {
  const result = await withTimeout(
    page
      .evaluate(async () => {
        const provider = (window as Window & { ethereum?: { request?: (args: unknown) => Promise<unknown> } }).ethereum;
        if (!provider?.request) {
          return null;
        }
        try {
          const chainId = await provider.request({ method: 'eth_chainId' });
          return typeof chainId === 'string' ? chainId : null;
        } catch {
          return null;
        }
      })
      .catch(() => null),
    10_000,
    null,
  );

  return typeof result === 'string' || result === null ? result : null;
};

const clickFirstEnabled = async (
  page: Page,
  selectors: string[],
  timeoutMs = 4_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        const visible = await candidate.isVisible({ timeout: 250 }).catch(() => false);
        if (!visible) continue;
        const enabled = await candidate.isEnabled().catch(() => false);
        if (!enabled) continue;
        const clicked = await candidate
          .click({ timeout: 1_500, force: true })
          .then(() => true)
          .catch(() => false);
        if (clicked) {
          return true;
        }
      }
    }
    await page.waitForTimeout(200).catch(() => {});
  }

  return false;
};

const closeWalletModalIfOpen = async (page: Page): Promise<boolean> => {
  return clickFirstEnabled(
    page,
    [
      'button:text-matches("^\\s*Close\\s*$", "i")',
      '[role="button"]:text-matches("^\\s*Close\\s*$", "i")',
      '[aria-label="Close"]',
    ],
    2_000,
  );
};

const hasConnectingButton = async (page: Page): Promise<boolean> => {
  const result = await page
    .evaluate(() => {
      const labels = [...document.querySelectorAll('button,[role="button"]')]
        .map((node) => (node.textContent ?? '').trim())
        .filter(Boolean);
      return labels.some((label) => /connecting/i.test(label));
    })
    .catch(() => false);
  return Boolean(result);
};

const waitForNoConnectingState = async (
  page: Page,
  timeoutMs = 15_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connecting = await hasConnectingButton(page);
    if (!connecting) {
      return true;
    }
    await page.waitForTimeout(300).catch(() => {});
  }
  return false;
};

const fillWalletUnlockIfNeeded = async (page: Page, password: string): Promise<boolean> => {
  const unlockField = page
    .locator('[data-testid="unlock-password"], input[type="password"]')
    .first();
  const visible = await unlockField.isVisible({ timeout: 200 }).catch(() => false);
  if (!visible) {
    return false;
  }
  await unlockField.fill(password, { timeout: 1_500 }).catch(() => {});
  return true;
};

export const resolveWalletExtensionId = async (
  context: BrowserContext,
): Promise<string | undefined> => {
  try {
    const workers = context.serviceWorkers();
    if (workers.length > 0) {
      return new URL(workers[0].url()).host;
    }
  } catch {
    // Fall through to event-based detection.
  }

  try {
    const worker = await context.waitForEvent('serviceworker', { timeout: 5_000 });
    return new URL(worker.url()).host;
  } catch {
    return undefined;
  }
};

const isWalletExtensionPage = (url: string, extensionId?: string): boolean => {
  if (!url.startsWith('chrome-extension://')) {
    return false;
  }
  if (!extensionId) {
    return true;
  }
  return url.includes(extensionId);
};

export const startWalletAutoApprover = async (
  context: BrowserContext,
  options: WalletAutomationOptions = {},
): Promise<() => void> => {
  const {
    password = DEFAULT_PASSWORD,
    tickMs = 750,
    actionSelectors = DEFAULT_WALLET_ACTION_SELECTORS,
    log = defaultLogger,
  } = options;
  const extensionId = options.extensionId ?? (await resolveWalletExtensionId(context));

  if (extensionId) {
    log(`wallet:auto-approve extension=${extensionId}`);
  } else {
    log('wallet:auto-approve extension id not detected; scanning all extension pages');
  }

  let active = true;

  const tick = async (): Promise<void> => {
    if (!active) return;
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      const url = page.url();
      if (!isWalletExtensionPage(url, extensionId)) continue;
      await fillWalletUnlockIfNeeded(page, password);
      await clickFirstEnabled(page, actionSelectors, 1_200);
    }
  };

  const interval = setInterval(() => {
    tick().catch(() => {});
  }, tickMs);

  context.on('page', (page) => {
    page.once('domcontentloaded', () => {
      tick().catch(() => {});
    });
  });

  await tick();

  return () => {
    active = false;
    clearInterval(interval);
  };
};

export const settleWalletPrompts = async (
  context: BrowserContext,
  options: WalletAutomationOptions = {},
): Promise<boolean> => {
  const {
    password = DEFAULT_PASSWORD,
    actionSelectors = DEFAULT_WALLET_ACTION_SELECTORS,
    promptPaths = DEFAULT_PROMPT_PATHS,
    log = defaultLogger,
  } = options;
  const extensionId = options.extensionId ?? (await resolveWalletExtensionId(context));
  if (!extensionId) {
    return false;
  }

  let clickedAny = false;

  const tryApproveOnPage = async (page: Page): Promise<void> => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (page.isClosed()) return;
      await fillWalletUnlockIfNeeded(page, password);
      const clicked = await clickFirstEnabled(page, actionSelectors, 1_000);
      clickedAny = clickedAny || clicked;
      await page.waitForTimeout(150).catch(() => {});
    }
  };

  const extensionPages = context
    .pages()
    .filter((page) => !page.isClosed())
    .filter((page) => isWalletExtensionPage(page.url(), extensionId));

  if (extensionPages.length > 0) {
    log(
      `wallet:settle extension-pages=${extensionPages
        .map((page) => page.url())
        .join(', ')}`,
    );
  }

  for (const page of extensionPages) {
    await tryApproveOnPage(page);
  }

  for (const path of promptPaths) {
    const promptPage = await context.newPage();
    try {
      await promptPage
        .goto(`chrome-extension://${extensionId}/${path}`, {
          waitUntil: 'domcontentloaded',
        })
        .catch(() => {});
      await tryApproveOnPage(promptPage);
    } finally {
      await promptPage.close().catch(() => {});
    }
  }

  return clickedAny;
};

const requestWalletAccounts = async (page: Page): Promise<string> => {
  const result = await withTimeout(
    page
      .evaluate(async () => {
        const provider = (window as Window & { ethereum?: { request?: (args: unknown) => Promise<unknown> } }).ethereum;
        if (!provider?.request) return 'no-provider';
        try {
          const accounts = await provider.request({ method: 'eth_requestAccounts' });
          return Array.isArray(accounts) && accounts.length > 0
            ? `requested:${accounts.length}`
            : 'requested:0';
        } catch (error) {
          const message =
            typeof error === 'object' && error && 'message' in error
              ? String((error as { message: unknown }).message)
              : String(error);
          return `request-failed:${message}`;
        }
      })
      .catch((error) => `request-evaluate-failed:${error instanceof Error ? error.message : String(error)}`),
    15_000,
    'request-timeout',
  );

  return String(result);
};

const toChainHex = (target?: WalletPreflightChainTarget): string | undefined => {
  if (!target) return undefined;
  if (target.hex) return target.hex;
  if (typeof target.id === 'number' && Number.isFinite(target.id)) {
    return `0x${target.id.toString(16)}`;
  }
  return undefined;
};

const switchWalletChain = async (
  page: Page,
  target: WalletPreflightChainTarget,
): Promise<string> => {
  const chainHex = toChainHex(target);
  if (!chainHex) {
    return 'no-target-chain';
  }

  const rpcUrl = target.rpcUrl ?? DEFAULT_RPC_URL;
  const chainName = target.name ?? DEFAULT_CHAIN_NAME;
  const nativeCurrency = target.nativeCurrency ?? {
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
  };

  const result = await withTimeout(
    page
      .evaluate(
        async ({
          chainId,
          rpcUrl: targetRpcUrl,
          chainName: targetChainName,
          nativeCurrency: targetNativeCurrency,
        }) => {
          const provider = (window as Window & { ethereum?: { request?: (args: unknown) => Promise<unknown> } }).ethereum;
          if (!provider?.request) return 'no-provider';
          try {
            await provider.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId }],
            });
            return 'switched';
          } catch (switchError) {
            const code =
              typeof switchError === 'object' &&
              switchError &&
              'code' in switchError
                ? Number((switchError as { code: unknown }).code)
                : undefined;

            if (code !== 4902) {
              return `switch-failed:${
                typeof switchError === 'object' &&
                switchError &&
                'message' in switchError
                  ? String((switchError as { message: unknown }).message)
                  : String(switchError)
              }`;
            }

            try {
              await provider.request({
                method: 'wallet_addEthereumChain',
                params: [
                  {
                    chainId,
                    chainName: targetChainName,
                    nativeCurrency: targetNativeCurrency,
                    rpcUrls: [targetRpcUrl],
                  },
                ],
              });
              return 'added-and-switched';
            } catch (addError) {
              return `add-failed:${
                typeof addError === 'object' &&
                addError &&
                'message' in addError
                  ? String((addError as { message: unknown }).message)
                  : String(addError)
              }`;
            }
          }
        },
        {
          chainId: chainHex,
          rpcUrl,
          chainName,
          nativeCurrency,
        },
      )
      .catch((error) => `switch-evaluate-failed:${error instanceof Error ? error.message : String(error)}`),
    20_000,
    'switch-timeout',
  );

  return String(result);
};

const waitForAccounts = async (
  page: Page,
  timeoutMs: number,
): Promise<string[]> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const accounts = await readWalletAccounts(page);
    if (accounts.length > 0) {
      return accounts;
    }
    await page.waitForTimeout(350).catch(() => {});
  }
  return [];
};

export const runWalletOriginPreflight = async (
  context: BrowserContext,
  url: string,
  options: WalletPreflightOptions,
): Promise<WalletOriginPreflightResult> => {
  const {
    requestAccounts = true,
    clearStorage = true,
    accountsTimeoutMs = 20_000,
    connectSelectors = DEFAULT_CONNECT_SELECTORS,
    connectorSelectors = DEFAULT_CONNECTOR_SELECTORS,
    maxChainSwitchAttempts = 4,
    chain,
    log = defaultLogger,
  } = options;

  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900).catch(() => {});

    if (clearStorage) {
      await page
        .evaluate(() => {
          try {
            localStorage.removeItem('wagmi.store');
            sessionStorage.clear();
          } catch {
            // Ignore storage cleanup errors.
          }
        })
        .catch(() => {});
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(900).catch(() => {});
    }

    let accounts = await readWalletAccounts(page);
    let chainId = await readWalletChainId(page);

    if (accounts.length === 0) {
      let requestResult = 'skipped';
      if (requestAccounts) {
        requestResult = await requestWalletAccounts(page);
        log(`wallet:preflight request-accounts url=${url} result=${requestResult}`);
      }

      const needsUiConnectorFlow =
        requestResult === 'no-provider' ||
        /request-failed:.*no ethereum provider/i.test(requestResult);
      if (needsUiConnectorFlow) {
        await clickFirstEnabled(page, connectSelectors, 6_000);
        await clickFirstEnabled(page, connectorSelectors, 4_000);
        if (requestAccounts) {
          requestResult = await requestWalletAccounts(page);
          log(`wallet:preflight request-accounts retry url=${url} result=${requestResult}`);
        }
      }

      await settleWalletPrompts(context, options);
      accounts = await waitForAccounts(page, accountsTimeoutMs);
      chainId = await readWalletChainId(page);
    }

    const targetChainHex = toChainHex(chain);
    if (targetChainHex && accounts.length > 0 && chainId !== targetChainHex) {
      for (let attempt = 1; attempt <= maxChainSwitchAttempts; attempt += 1) {
        const result = await switchWalletChain(page, chain as WalletPreflightChainTarget);
        log(`wallet:preflight switch-chain url=${url} attempt=${attempt}/${maxChainSwitchAttempts} result=${result}`);

        if (
          /pending|timeout/i.test(result) ||
          result.startsWith('add-failed:') ||
          result.startsWith('switch-failed:')
        ) {
          await settleWalletPrompts(context, options);
        }

        chainId = await readWalletChainId(page);
        if (chainId === targetChainHex) {
          break;
        }
        await page.waitForTimeout(400).catch(() => {});
      }
    }

    await closeWalletModalIfOpen(page);
    const clearedConnecting = await waitForNoConnectingState(page);
    if (!clearedConnecting) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(600).catch(() => {});
    }

    const ready = accounts.length > 0 && (!targetChainHex || chainId === targetChainHex);
    return {
      url,
      ready,
      accounts,
      chainId,
      details: ready
        ? 'ok'
        : `accounts=${accounts.length} chainId=${chainId ?? 'unknown'} targetChain=${targetChainHex ?? 'none'}`,
    };
  } finally {
    await page.close().catch(() => {});
  }
};

export const runWalletPreflight = async (
  context: BrowserContext,
  options: WalletPreflightOptions,
): Promise<WalletPreflightResult> => {
  const results: WalletOriginPreflightResult[] = [];
  for (const url of options.seedUrls) {
    const result = await runWalletOriginPreflight(context, url, options);
    results.push(result);
    if (!result.ready) {
      return {
        ok: false,
        failedUrl: url,
        results,
      };
    }
  }

  return { ok: true, results };
};
