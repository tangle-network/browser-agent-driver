import type { BrowserContext, Route } from 'playwright';

export interface WalletRpcInterceptionOptions {
  rpcUrl: string;
  walletAddress?: string;
}

/**
 * Route page-level JSON-RPC so dApps observe wallet balances from the local
 * Anvil fork. Only user-specific calls (eth_getBalance for the wallet,
 * eth_call/eth_estimateGas/eth_getTransactionCount touching the wallet
 * address) are forwarded to the fork; pool/protocol reads pass through to the
 * real endpoint for reliability. Calls from chrome-extension frames (the
 * wallet itself) are never intercepted.
 */
export async function installWalletRpcInterception(
  context: BrowserContext,
  opts: WalletRpcInterceptionOptions,
): Promise<void> {
  const walletRpcUrl = opts.rpcUrl;
  // Default to Anvil's first derived address if no wallet address configured
  const walletAddrFull = (opts.walletAddress ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266').toLowerCase()
  const walletAddrHex = walletAddrFull.replace('0x', '')
  await context.route('**/*', async (route: Route) => {
    try {
      const frame = route.request().frame()
      if (frame && frame.url().startsWith('chrome-extension://')) { await route.continue(); return }
    } catch {
      await route.continue()
      return
    }
    if (route.request().method() !== 'POST') { await route.continue(); return }
    const ct = route.request().headers()['content-type'] ?? ''
    if (!ct.includes('json')) { await route.continue(); return }
    const postData = route.request().postData()
    if (!postData) { await route.continue(); return }
    try {
      const body = JSON.parse(postData)
      const items: Record<string, unknown>[] = Array.isArray(body) ? body : [body]
      // Check if any item involves the wallet (balance, contract call, simulation)
      const isUserQuery = items.some((item) => {
        const method = item.method as string | undefined
        if (!method) return false
        if (method === 'eth_getBalance') {
          const params = item.params as string[] | undefined
          return params?.[0]?.toLowerCase() === walletAddrFull
        }
        if (method === 'eth_call' || method === 'eth_estimateGas') {
          const params = item.params as Record<string, string>[] | undefined
          const txObj = params?.[0]
          if (!txObj) return false
          const from = txObj.from?.toLowerCase() ?? ''
          const data = txObj.data?.toLowerCase() ?? ''
          return from === walletAddrFull || data.includes(walletAddrHex)
        }
        if (method === 'eth_getTransactionCount') {
          const params = item.params as string[] | undefined
          return params?.[0]?.toLowerCase() === walletAddrFull
        }
        return false
      })
      if (!isUserQuery) { await route.continue(); return }
      // Normalize: some dApps (Aave) omit jsonrpc/id — Anvil requires them
      let nextId = 1
      const normalized = items.map((item) => {
        const out: Record<string, unknown> = { ...item, jsonrpc: '2.0', id: item.id ?? nextId++ }
        delete out.chainId
        return out
      })
      const payload = Array.isArray(body) ? normalized : normalized[0]
      const res = await fetch(walletRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      await route.fulfill({
        status: res.status,
        contentType: 'application/json',
        body: await res.text(),
      })
    } catch { await route.continue() }
  })
}
