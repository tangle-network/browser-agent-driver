import { defineConfig } from '@tangle-network/browser-agent-driver'

export default defineConfig({
  model: 'gpt-5.4',
  headless: false,
  concurrency: 1,
  maxTurns: 20,
  timeoutMs: 300_000,
  outputDir: './agent-results/wallet',
  reporters: ['json', 'markdown'],
  memory: { enabled: true, dir: '.agent-memory/wallet' },
  wallet: {
    enabled: true,
    extensionPaths: ['./extensions/metamask'],
    userDataDir: './.agent-wallet-profile',
    autoApprove: true,
    password: process.env.AGENT_WALLET_PASSWORD ?? 'TangleLocal123!',
    preflight: {
      enabled: true,
      chain: {
        id: 1,
        rpcUrl: process.env.ANVIL_RPC ?? 'http://127.0.0.1:8545',
      },
    },
  },
})
