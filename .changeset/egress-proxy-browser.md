---
"@tangle-network/browser-agent-driver": patch
---

Route the browser through the sandbox's managed egress proxy (iron-proxy). When `EGRESS_PROXY_IP` + `HTTPS_PROXY`/`HTTP_PROXY` are present and no explicit `--proxy`/`BAD_PROXY_URL` is set, Chromium is now launched through the proxy (honoring `NO_PROXY`) and accepts its TLS-interception certificate, so browser runs work under egress isolation instead of failing every navigation with `chrome-error://`. Explicit user proxies are unchanged and keep certificate validation on.
