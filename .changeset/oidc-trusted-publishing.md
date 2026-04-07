---
'@tangle-network/browser-agent-driver': patch
---

Switch npm publish to OIDC trusted publishing. Each release is now authenticated via a short-lived GitHub OIDC token instead of a long-lived `NPM_TOKEN` secret, validated against the trusted publisher configured on npmjs.com. Every publish is cryptographically tied to the exact GitHub commit + workflow run that built it, with provenance attestation visible on the npm package page. Also fixes the `release-tag` script to push the prefixed `browser-agent-driver-v*` tag the existing publish workflow expects, so the next release runs end-to-end with zero manual intervention.
