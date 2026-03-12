# Wallet & EVM Application Testing

Test wallet-connected flows on EVM dApps — DeFi swaps, token approvals, lending, NFT mints — using a real browser extension (MetaMask or Rabby) against a local Anvil fork.

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  Chromium (persistent context)                          │
│  ┌──────────────┐  ┌─────────────────────────────────┐  │
│  │  MetaMask     │  │  DeFi App (Aave, Uniswap, etc) │  │
│  │  extension    │  │                                 │  │
│  │  ↕ service    │  │  page-level RPC calls ──────────│──│──→ Anvil (user queries)
│  │    worker     │  │                                 │  │     ↓ fallback
│  └──────┬───────┘  └─────────────────────────────────┘  │  real RPC (pool data)
│         │                                               │
│         └── host-resolver-rules ── HTTPS proxy ─────────│──→ Anvil
└─────────────────────────────────────────────────────────┘
```

Two interception layers ensure the dApp and wallet both see your local fork:

1. **Page-level** — `context.route('**/*')` intercepts JSON-RPC POST requests from the dApp. Only user-specific calls (containing your wallet address) are forwarded to Anvil. Protocol/pool data goes to real endpoints for reliability.
2. **Extension-level** — MetaMask's service worker calls Infura directly (not through page context). An HTTPS reverse proxy on localhost:8443, combined with Chromium `--host-resolver-rules`, redirects Infura traffic to Anvil.

## Quick Start

### 1. Install MetaMask

```bash
pnpm wallet:setup              # downloads from GitHub releases
# or: pnpm wallet:setup --wallet rabby
```

Requires `gh` CLI. If unavailable, manually download the Chrome extension zip from [MetaMask releases](https://github.com/MetaMask/metamask-extension/releases) and extract to `./extensions/metamask/`.

### 2. Onboard (one-time)

```bash
pnpm wallet:onboard
```

Automates the MetaMask first-run wizard: imports the test SRP, sets password, skips analytics. Uses CDP to bypass LavaMoat restrictions on the extension's UI.

Default test wallet:
- Mnemonic: `test test test test test test test test test test test junk`
- Address: `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`
- Password: `TangleLocal123!` (override with `AGENT_WALLET_PASSWORD`)

### 3. Start Local Fork

```bash
pnpm wallet:anvil              # Anvil mainnet fork + seed balances
```

Seeds the test wallet with 100 ETH, 10 WETH, and 10,000 USDC. Uses `drpc.org` as the fork RPC (most reliable free endpoint). Pre-warms Aave contract state to avoid upstream timeouts.

### 4. Run Tests

```bash
pnpm wallet:validate           # run all DeFi cases (auto-restarts Anvil)
```

Or run against your own app:

```bash
bad run \
  --goal "Connect wallet and swap 0.01 ETH for USDC" \
  --url http://localhost:3000 \
  --wallet \
  --extension ./extensions/metamask \
  --user-data-dir ./.agent-wallet-profile \
  --wallet-auto-approve \
  --wallet-preflight \
  --wallet-chain-id 1 \
  --wallet-chain-rpc-url http://127.0.0.1:8545 \
  --no-headless
```

## Configuration

```typescript
import { defineConfig } from '@tangle-network/browser-agent-driver'

export default defineConfig({
  headless: false,          // required — extensions need visible browser
  concurrency: 1,          // required — single persistent context
  wallet: {
    enabled: true,
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // for RPC interception
    extensionPaths: ['./extensions/metamask'],
    userDataDir: './.agent-wallet-profile',
    autoApprove: true,      // auto-handle MetaMask popups
    password: process.env.AGENT_WALLET_PASSWORD ?? 'TangleLocal123!',
    preflight: {
      enabled: true,
      chain: {
        id: 1,              // chain ID your app expects
        rpcUrl: 'http://127.0.0.1:8545',  // local Anvil
      },
    },
  },
  // Redirect MetaMask's Infura calls to the local HTTPS proxy
  browserArgs: [
    '--host-resolver-rules=MAP mainnet.infura.io 127.0.0.1:8443',
    '--ignore-certificate-errors',
  ],
})
```

### Key Config Options

| Option | Description |
|--------|-------------|
| `wallet.address` | Wallet address (hex, 0x-prefixed). Used for RPC interception — only calls involving this address are forwarded to the local fork. Defaults to Anvil's first derived address. |
| `wallet.autoApprove` | Automatically handle MetaMask unlock, connection, and transaction approval popups. |
| `wallet.preflight.chain` | Chain to switch MetaMask to before tests start. Set `rpcUrl` to your local node. |
| `browserArgs` | Add `--host-resolver-rules` to redirect MetaMask's background RPC calls through the local proxy. |

## Testing Your Own EVM App

### Local Development Setup

If you're building a DeFi app at `localhost:3000`:

1. **Start your local node** (Anvil, Hardhat, or Ganache):
   ```bash
   anvil --fork-url https://eth.drpc.org --chain-id 1 --port 8545
   ```

2. **Seed test balances** — use `cast` or your framework's seeding:
   ```bash
   cast rpc anvil_setBalance 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 0x56BC75E2D63100000
   ```

3. **Start the RPC proxy** for MetaMask's service worker:
   ```bash
   node bench/wallet/rpc-proxy.mjs --target http://127.0.0.1:8545
   ```

4. **Write test cases**:
   ```json
   [
     {
       "id": "swap-eth-usdc",
       "name": "Swap ETH → USDC",
       "startUrl": "http://localhost:3000/swap",
       "goal": "Connect the MetaMask wallet, enter 0.01 ETH as input, select USDC as output, click Swap, and stop at the confirmation dialog.",
       "maxTurns": 20
     }
   ]
   ```

5. **Run**:
   ```bash
   bad run --cases ./my-cases.json --config ./wallet.config.ts --no-headless
   ```

### Custom Wallet Address

If you're not using the default Anvil mnemonic, set `wallet.address` in your config so RPC interception matches your wallet's calldata:

```typescript
wallet: {
  address: '0xYourWalletAddress...',
  // ...
}
```

### Custom Chain / L2

For L2s (Arbitrum, Optimism, Base, etc.), change the chain config:

```typescript
wallet: {
  preflight: {
    chain: {
      id: 42161,           // Arbitrum
      rpcUrl: 'http://127.0.0.1:8545',
      name: 'Arbitrum One',
    },
  },
},
browserArgs: [
  // Only redirect the RPC endpoints your app uses
  '--host-resolver-rules=MAP arb-mainnet.g.alchemy.com 127.0.0.1:8443',
  '--ignore-certificate-errors',
],
```

> **Note:** Only Ethereum mainnet has been validated. L2 and Solana support is untested.

## DeFi App Patterns

When wallet mode is active, the agent automatically receives DeFi-specific guidance. These patterns were learned from testing Aave, Uniswap, SushiSwap, and 1inch.

### What the Agent Knows

- **Persistent support widgets** — Many DeFi apps embed always-on chat widgets (Zendesk, Intercom) that appear as `alertdialog` in the accessibility tree. The agent ignores these after 3 turns instead of trying to dismiss them.
- **Wallet connection flow** — Click "Connect Wallet" → select MetaMask → the auto-approver handles the rest.
- **Transaction flow** — Enter amount → wait for quote → click action button → stop at review/confirmation.
- **Native ETH preference** — ETH supply/swap skips the ERC-20 spending cap approval that MetaMask v13+ shows (which has a disabled "Review alert" button).
- **Cookie/consent banners** — Dismissed immediately, not fought over multiple turns.
- **Network selector avoidance** — The agent won't accidentally open chain dropdowns.

### Writing Good Test Goals

**Do:**
```
"Connect wallet, find ETH in the supply table, click Supply,
enter 0.01, click 'Supply ETH'. Stop at the confirmation dialog."
```

**Don't:**
```
"Supply some ETH on Aave"
```

Specific goals work better because:
- They tell the agent which token to pick (ETH not WETH — avoids approval flow)
- They specify the exact amount (agents don't guess well)
- They set a clear stop point (don't confirm in MetaMask)
- They reference UI elements the agent can find ("Supply table", "Supply ETH" button)

### URL Deep-linking

Many DeFi apps accept URL params that pre-select tokens and save 3-5 agent turns:

| App | URL Pattern |
|-----|-------------|
| SushiSwap | `https://www.sushi.com/swap?chainId=1&token0=NATIVE&token1=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Uniswap | `https://app.uniswap.org/#/swap?inputCurrency=ETH&outputCurrency=0x...` |
| 1inch | `https://app.1inch.io/#/1/unified/swap/ETH/USDC` |

Use these in `startUrl` to skip token picker navigation.

## RPC Interception Details

### Hybrid Strategy

Not all RPC calls go to Anvil. Only **user-specific** queries are intercepted:

| Method | Intercepted When |
|--------|-----------------|
| `eth_getBalance` | `params[0]` matches wallet address |
| `eth_call` | `from` or `data` contains wallet address |
| `eth_estimateGas` | `from` or `data` contains wallet address |
| `eth_getTransactionCount` | `params[0]` matches wallet address |

Everything else (pool reserves, protocol config, token metadata) goes to real RPC endpoints. This avoids Anvil failures when upstream fork state expires.

### JSON-RPC Normalization

Some dApps (notably Aave) send non-standard JSON-RPC:
```json
{"method": "eth_call", "params": [...], "chainId": "0x1"}
```

Missing `jsonrpc` and `id` fields. The interception layer normalizes these before forwarding to Anvil:
```json
{"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [...]}
```

### Fork Freshness

Free public RPCs retain ~128 blocks (~25 minutes) of historical state. After that, Anvil can't fetch uncached contract state from the fork block. Mitigations:

- **Always restart Anvil** before test runs (the validation runner does this automatically)
- **Pre-warm** critical contract state immediately after forking
- **Use drpc.org** as fork RPC (most reliable free endpoint)

## Troubleshooting

### "We couldn't find any assets" / wallet shows 0 balance

The dApp is reading balances from a real RPC endpoint, not Anvil. Check:
1. Is `wallet.address` set correctly? It must match the address with seeded balances.
2. Is `wallet.preflight.chain.rpcUrl` pointing to Anvil?
3. Is the RPC proxy running? (`node bench/wallet/rpc-proxy.mjs --target http://127.0.0.1:8545`)

### MetaMask shows "No Infura network client found"

Don't modify MetaMask's built-in `mainnet` Infura endpoint. Add a new custom endpoint alongside it instead. The `wallet:configure` script handles this.

### Agent stuck dismissing a dialog

Embedded support widgets (SushiSwap, etc.) render as `alertdialog` permanently. The recovery system skips these after 3 turns. If you still see loops, the dialog might be a real cookie banner — check the test artifacts for screenshots.

### Swap button disabled / "Something went wrong"

The DEX router's swap simulation (`eth_estimateGas`) failed. Common causes:
- Anvil fork state expired (restart Anvil)
- Token liquidity pool not cached (add to pre-warming)
- Amount too small for the router to quote

### Supply simulation fails

The gas estimation call needs the wallet address in the calldata. Ensure `wallet.address` matches and that `eth_estimateGas` is in the intercepted methods (it is by default).

## Validated DeFi Apps

Tested 2026-03-12 with MetaMask 13.21.0 on Ethereum mainnet fork:

| App | Flow | Result | Turns | Cost |
|-----|------|--------|-------|------|
| Uniswap | Connect wallet | Pass | 2 | $0.04 |
| Uniswap | Swap ETH → USDC | Pass | 5 | $0.14 |
| Aave | Connect wallet | Pass | 3 | $0.07 |
| Aave | Supply 0.01 ETH | Pass | 5 | $0.14 |
| 1inch | Connect wallet | Pass | 5 | $0.15 |
| SushiSwap | Connect wallet | Pass | 2 | $0.04 |
| SushiSwap | Swap ETH → USDC | Pass | 14 | $0.40 |

**Total: 7/7 pass, $0.98, 267s**
