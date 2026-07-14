---
"@tangle-network/browser-agent-driver": patch
---

Fix a browser startup stall under managed egress isolation. When routed through the sandbox's TLS-intercepting egress proxy, Chromium's own internal service requests (component update, GCM, sign-in probes, variations seed) validate TLS against Chrome's built-in trust store — which does not contain the proxy's MITM CA — and are not covered by the per-context `ignoreHTTPSErrors` that only applies to page traffic. Those requests fail `ERR_CERT_AUTHORITY_INVALID` (`net_error -202`) and Chromium retries them for minutes, wedging the first navigation long past the sandbox's `terminals/commands` budget and surfacing to callers as `orchestrator connect timeout`. Accept the proxy's certificate browser-wide (`--ignore-certificate-errors`) when — and only when — the managed egress proxy is auto-wired (`EGRESS_PROXY_IP` present). Explicit user proxies (`--proxy`/`BAD_PROXY_URL`) keep full certificate validation.
