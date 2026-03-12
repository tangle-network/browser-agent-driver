import { defineConfig } from '@tangle-network/browser-agent-driver'

// Only proxy Ethereum mainnet RPC endpoints to the local fork.
// L2 chains (Linea, Base, Polygon, etc.) must reach real endpoints
// or MetaMask will detect chain ID mismatch and enter an error state.
const RPC_PROXY_PORT = 8443
const mainnetRpcDomains = [
  'mainnet.infura.io',
]
const hostRules = mainnetRpcDomains.map(d => `MAP ${d} 127.0.0.1:${RPC_PROXY_PORT}`).join(',')

export default defineConfig({
  model: 'gpt-5.4',
  headless: false,
  concurrency: 1,
  maxTurns: 20,
  timeoutMs: 300_000,
  outputDir: './agent-results/wallet',
  reporters: ['json', 'markdown'],
  browserArgs: [
    `--host-resolver-rules=${hostRules}`,
    '--ignore-certificate-errors',
  ],
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
