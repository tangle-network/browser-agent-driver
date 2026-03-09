---
name: stealth-tuning
description: Use when configuring browser stealth profiles, anti-bot evasion, WebDriver detection suppression, JA3 fingerprinting, or CDP leak patches.
---

# Stealth Tuning

Use this skill when working on browser stealth configuration, anti-bot evasion, or detection resistance for the agent browser driver.

## Stealth Stack

The stealth system operates at multiple layers:

### Layer 1: WebDriver Detection Suppression
- `navigator.webdriver` must return `undefined`, not `false`
- Chrome DevTools Protocol (CDP) connection indicators must be hidden
- `window.chrome.runtime` must exist with expected properties
- Patchright handles most CDP leak fixes automatically

### Layer 2: TLS / JA3 Fingerprinting
- System Chrome integration provides real TLS fingerprints (not Chromium-default)
- JA3 hash must match a known browser version, not a headless/automation signature
- TLS extension order and cipher suites must match the declared User-Agent

### Layer 3: Browser Behavior Signals
- Mouse movement, scroll patterns, and timing must appear human-like
- Cookie consent dialogs must be dismissed naturally (click, not inject)
- Page load timing should include realistic network waterfall patterns

### Layer 4: Environment Consistency
- User-Agent string must match the actual browser version and OS
- `navigator.platform`, `navigator.vendor`, screen dimensions must be consistent
- WebGL renderer and vendor strings must match expected GPU for the platform
- Canvas fingerprint must not be blocked (returns consistent, valid data)

## Benchmark Profiles

| Profile | Use Case | Stealth Level |
|---------|----------|---------------|
| `default` | Development, local testing | None |
| `stealth` | General stealth browsing | Medium |
| `webbench` | Benchmark runs, no stealth | None |
| `webbench-stealth` | Benchmark with stealth enabled | Full |
| `webvoyager` | WebVoyager benchmark compat | Medium |

## Anti-Bot Detection Patterns

### Known Detection Methods
1. **Cloudflare Turnstile**: JS challenge + behavioral analysis. Mitigation: real browser + human-like timing.
2. **DataDome**: Device fingerprinting + behavioral. Mitigation: consistent environment signals.
3. **PerimeterX/HUMAN**: Canvas/WebGL fingerprinting. Mitigation: don't block canvas, return consistent data.
4. **Akamai Bot Manager**: TLS fingerprint + JS challenges. Mitigation: System Chrome for real TLS.
5. **reCAPTCHA v3**: Behavioral scoring. Mitigation: natural interaction patterns.

### Known Unbeatable Cases (Don't Waste Time)
- Cambridge University Press: aggressive bot detection, not worth solving
- Some banking sites with hardware token requirements

## Configuration

### Enabling Stealth
```bash
# Via CLI flag
agent-driver run --benchmark-profile stealth ...

# Via environment
STEALTH_PROFILE=webbench-stealth agent-driver run ...
```

### System Chrome Setup
System Chrome uses the user's installed Chrome instead of bundled Chromium:
- macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- Provides real TLS stack, real extensions, real certificate store
- Must match the User-Agent string declared in the stealth profile

## Key Files
- Stealth profile configs: `src/profiles/`
- Browser launch with stealth: `src/browser-launch.ts`
- Detection test cases: `bench/scenarios/cases/` (anti-bot category)
- Patchright integration: `src/browser/` (CDP patching layer)

## Debugging Stealth Issues
1. Check `navigator.webdriver` value in the browser console
2. Compare JA3 hash at https://ja3er.com against known browser fingerprints
3. Run canvas fingerprint test to verify consistency
4. Check for CDP artifacts in `window.__playwright` or similar globals
5. Compare User-Agent with actual Chrome version headers
