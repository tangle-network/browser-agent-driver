# Browser Bridges & CDP Connection

Connect `bad` to existing browser instances — use their logged-in sessions, extensions, and AI agent capabilities.

## CDP Connection (`--cdp-url`)

Attach to any running Chromium-based browser with a debug port:

```bash
# Launch browser with debug port (one-time)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222

# Connect bad to it
bad run --cdp-url ws://127.0.0.1:9222 --goal "..." --url https://example.com
```

Works with: Chrome, Brave, Edge, Atlas, Arc, and any Chromium fork.

The `BROWSER_ENDPOINT` env var is also supported for backwards compatibility.

### CDP Caveats

- **Chromium-only** — Firefox and Safari do not implement CDP
- **Lower fidelity** — Playwright warns that CDP connections have "significantly lower fidelity" than native Playwright connections. Our snapshot pipeline works fine (raw CDP commands), but some Playwright features (network interception, request routing) may behave differently.
- **Use existing context** — `browser.contexts()[0]` accesses the user's session. `browser.newContext()` creates a fresh incognito-like context *without* the user's cookies.
- **Extensions must be pre-loaded** — cannot side-load extensions via CDP; they must be loaded when the browser was launched
- **Close competing tabs** — some browsers may conflict if you have many tabs open

## Browser-Specific Guide

### ChatGPT Atlas

Atlas is a Chromium-based browser (v143.0.7499.110) with an internal AI agent system.

**Architecture:**
- Outer app: SwiftUI host (101KB) — tab management, voice, agent UI
- IPC bridge: `OwlBridge.framework` (5.2MB) — Mojo IPC with `OwlBridge_GetMojoAPI`, `OwlBridge_LaunchHost`, `OwlBridge_Initialize`
- Inner Chromium: `ChatGPT Atlas Framework.framework` (205MB) at `Contents/Support/`
- User data: `~/Library/Application Support/com.openai.atlas/browser-data/host/`
- Profile dir: `~/Library/Application Support/com.openai.atlas/browser-data/host/Default`

**Agent system internals:**
- `AgentWebSocketService` — WebSocket connection to OpenAI backend
- `ComputerUseActionHandler` — screenshot-based CUA actions
- `DOMActionHandler` — DOM-level structured actions
- `RemoteBrowserCommandHandler` — receives remote commands via WebSocket
- `AgentWindowManager` / `AgentTabGroupService` — agent session management
- `AgentWebContentWatchdog` — monitors web content state

**Internal pages:**
- `chrome://agentviewer` — agent viewing/debugging interface
- `atlas://diagnostics` — browser diagnostics
- `chatgpt://new-conversation` — deep link to new chat
- `chatgpt://new-voice-conversation` — deep link to voice

**Connecting:**
```bash
# Option 1: Use Atlas's Chromium profile directly (close Atlas first)
bad run --profile-dir ~/Library/Application\ Support/com.openai.atlas/browser-data/host \
  --goal "..." --url https://example.com

# Option 2: CDP (if Atlas can be launched with debug port)
# The inner Chromium supports --remote-debugging-port but the outer
# Swift app may not forward CLI args. Needs testing.
```

**Agent bridge API** (`kaur1br5` — via Mojo IPC on `*.chatgpt.com`/`*.openai.com`):

| Tool | Function |
|------|----------|
| `kaur1br5.open_tabs` | Open URLs in new tabs |
| `kaur1br5.navigate_current_tab` | Navigate active tab |
| `kaur1br5.close_tabs` | Close tabs by ID |
| `kaur1br5.list_tabs` | Enumerate all open tabs + URLs |
| `kaur1br5.focus_tab` | Switch active tab |
| `kaur1br5.search_browsing_history` | Search history |
| `kaur1br5.add_bookmark` | Modify bookmarks |
| `kaur1br5.set_preference` | Change browser settings |

Accessed via `mojomStart()` → `LocalToolHandler.callLocalTool()`. Only available on OpenAI-owned domains.

### Google Chrome

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
bad run --cdp-url ws://127.0.0.1:9222 --goal "..."
```

Profile: `~/Library/Application Support/Google/Chrome/Default`

### Brave

Chromium-based, full CDP support. Brave Shields may interfere — consider `--disable-brave-shields`.

```bash
"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" --remote-debugging-port=9222
bad run --cdp-url ws://127.0.0.1:9222 --goal "..."
```

Profile: `~/Library/Application Support/BraveSoftware/Brave-Browser/Default`

### Microsoft Edge

```bash
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" --remote-debugging-port=9222
bad run --cdp-url ws://127.0.0.1:9222 --goal "..."
```

Profile: `~/Library/Application Support/Microsoft Edge/Default`

### Arc

Chromium-based. Arc's custom UI (Spaces, Easels, Boosts) is not exposed via CDP — only standard page targets.

```bash
"/Applications/Arc.app/Contents/MacOS/Arc" --remote-debugging-port=9222
bad run --cdp-url ws://127.0.0.1:9222 --goal "..."
```

Profile: `~/Library/Application Support/Arc/User Data/Default`

### Firefox

Firefox uses its own Remote Debugging Protocol, not CDP. Playwright `connectOverCDP` does not work. Mozilla's CDP implementation is frozen ("no further APIs might be added") — they are pivoting to WebDriver BiDi.

**`--cdp-url` is not supported.** Use `--profile-dir` to launch Firefox with an existing profile via Playwright directly (requires removing the Chromium gate — not yet implemented).

Profile: `~/Library/Application Support/Firefox/Profiles/*.default-release`

### Safari / WebKit

No CDP support. Safari has its own Web Inspector Protocol (proprietary, undocumented). `safaridriver` exists but creates isolated sessions without the user's cookies. Playwright's WebKit engine is a custom build, not Safari.

**Not supported** for `--cdp-url` or `--profile-dir`.

## Profile Directory Connection (`--profile-dir`)

Use a browser's existing profile (cookies, local storage, extensions) without CDP:

```bash
# Chrome
bad run --profile-dir ~/Library/Application\ Support/Google/Chrome/Default \
  --goal "..." --url https://example.com

# Atlas
bad run --profile-dir ~/Library/Application\ Support/com.openai.atlas/browser-data/host \
  --goal "..." --url https://example.com

# Brave
bad run --profile-dir ~/Library/Application\ Support/BraveSoftware/Brave-Browser/Default \
  --goal "..." --url https://example.com
```

**Important:** Close the source browser first — Chromium locks the profile directory.

## Capability Matrix

| Browser | CDP | `--profile-dir` | Agent API | Profile Path (macOS) |
|---------|-----|-----------------|-----------|---------------------|
| Chrome | `--remote-debugging-port=9222` | Yes | — | `~/Library/Application Support/Google/Chrome/Default` |
| Atlas | Needs testing | Yes | `kaur1br5.*` via Mojo | `~/Library/Application Support/com.openai.atlas/browser-data/host` |
| Brave | `--remote-debugging-port=9222` | Yes | — | `~/Library/Application Support/BraveSoftware/Brave-Browser/Default` |
| Edge | `--remote-debugging-port=9222` | Yes | — | `~/Library/Application Support/Microsoft Edge/Default` |
| Arc | `--remote-debugging-port=9222` | Yes | — | `~/Library/Application Support/Arc/User Data/Default` |
| Firefox | Not supported | Not yet | — | `~/Library/Application Support/Firefox/Profiles/*.default-release` |
| Safari | Not supported | Not supported | — | `~/Library/Safari/` |

## How It Works

```
┌─────────────────────────────────────────────────┐
│              bad (browser-agent-driver)           │
│                                                   │
│  --cdp-url         --profile-dir       (default)  │
│      │                  │                  │      │
│      ▼                  ▼                  ▼      │
│  connectOverCDP   launchPersistent     launch     │
│  (attach to        Context             (fresh     │
│   running          (use existing       browser)   │
│   browser)          profile)                      │
└─────────────────────────────────────────────────┘
```

Priority: `--cdp-url` > `--profile-dir` > `--wallet` > default launch.
