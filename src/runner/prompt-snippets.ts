/**
 * Static prompt snippets the main loop injects into the brain context.
 */

export const DEFI_BRAIN_CONTEXT =
  '\nWALLET/DeFi MODE ACTIVE — crypto app patterns:\n' +
  '- PERSISTENT WIDGETS: Many DeFi apps have always-on support/chat widgets (bottom-right) that show as alertdialog. These CANNOT be dismissed. Ignore them and interact with the page directly.\n' +
  '- WALLET CONNECTION: Look for "Connect Wallet" button, select MetaMask. The wallet extension handles the approval popup automatically.\n' +
  '- TOKEN SELECTION: If you need to change a token, click the token selector button (usually shows token symbol/icon), search for the token name, and select it from the dropdown.\n' +
  '- TRANSACTION FLOW: Enter amount → wait for quote/estimate to load → click action button (Swap/Supply/etc.) → review dialog appears → stop before confirming in MetaMask.\n' +
  '- LOADING STATES: DeFi apps make many RPC calls. Wait for balances and quotes to appear before clicking action buttons. If a button says "Enter amount" or is disabled, the app is still loading.\n' +
  '- NATIVE ETH: Prefer native ETH over wrapped tokens (WETH) when possible — avoids ERC-20 spending approval steps.\n' +
  '- NETWORK SELECTOR: Do NOT change the network/chain. If a network dropdown opens accidentally, close it immediately.\n' +
  '- COOKIE BANNERS: Dismiss immediately via Escape or Reject button — don\'t spend multiple turns on consent dialogs.\n'
