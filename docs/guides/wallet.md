# Wallet Automation

For browser extension flows (MetaMask, Rabby, etc.), use persistent Chromium context mode.

## Config

```typescript
import { defineConfig } from '@tangle-network/browser-agent-driver'

export default defineConfig({
  headless: false,
  concurrency: 1,
  wallet: {
    enabled: true,
    extensionPaths: ['./extensions/metamask'],
    userDataDir: './.agent-wallet-profile',
    autoApprove: true,
    password: process.env.AGENT_WALLET_PASSWORD,
    preflight: {
      enabled: true,
      chain: { id: 31337, rpcUrl: 'http://127.0.0.1:8545' },
    },
  },
})
```

## CLI

```bash
bad run \
  --cases ./wallet-cases.json \
  --wallet \
  --extension ./extensions/metamask \
  --user-data-dir ./.agent-wallet-profile \
  --wallet-auto-approve \
  --wallet-password "$AGENT_WALLET_PASSWORD" \
  --wallet-preflight \
  --wallet-chain-id 31337 \
  --wallet-chain-rpc-url http://127.0.0.1:8545 \
  --no-headless
```

## Constraints

- Activated by `wallet.enabled` or `wallet.extensionPaths` — not by `userDataDir` alone.
- Uses `chromium.launchPersistentContext(...)`.
- Concurrency forced to 1, headless forced off.
- `--storage-state` works in both wallet and non-wallet modes.
- Auto-approval handles unlock and approve prompts across popup/notification/home pages.
- Preflight authorizes accounts and switches/adds chains before test turns begin.
- Use a dedicated automation profile directory.
