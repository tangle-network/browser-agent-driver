# @tangle-network/browser-agent-driver

## 0.14.4

### Patch Changes

- [`36027b9`](https://github.com/tangle-network/browser-agent-driver/commit/36027b95cbde08a62c869617c90f188967fa896e) Thanks [@drewstone](https://github.com/drewstone)! - Release flow now publishes end-to-end in a single workflow run with zero manual steps. The Changesets workflow opens the version PR, then on merge runs build + tag + npm publish via OIDC trusted publishing in the same job. No more manual `git push origin browser-agent-driver-vX.Y.Z` after merging the release PR. publish-npm.yml stays as a manual fallback for re-publishing failed releases via workflow_dispatch.

## 0.14.3

### Patch Changes

- [`60a6c44`](https://github.com/tangle-network/browser-agent-driver/commit/60a6c4487a35ded8943d8c6fd73f7a7dbb69972e) Thanks [@drewstone](https://github.com/drewstone)! - Switch the publish workflow to `npx -y npm@11` and drop the NPM_TOKEN fallback. Node 22's bundled npm 10.x has incomplete OIDC trusted-publisher support for scoped packages and silently 404s the publish PUT. npm 11.5+ has the full OIDC publish path. Each release is now authenticated purely via short-lived GitHub OIDC tokens validated against the trusted publisher on npmjs.com — no long-lived secrets in the repo.

## 0.14.2

### Patch Changes

- [`59b296d`](https://github.com/tangle-network/browser-agent-driver/commit/59b296d470c813940616c7923431eb1cb7899554) Thanks [@drewstone](https://github.com/drewstone)! - Switch npm publish to OIDC trusted publishing. Each release is now authenticated via a short-lived GitHub OIDC token instead of a long-lived `NPM_TOKEN` secret, validated against the trusted publisher configured on npmjs.com. Every publish is cryptographically tied to the exact GitHub commit + workflow run that built it, with provenance attestation visible on the npm package page. Also fixes the `release-tag` script to push the prefixed `browser-agent-driver-v*` tag the existing publish workflow expects, so the next release runs end-to-end with zero manual intervention.

## 0.14.1

### Patch Changes

- [`7c8e2cd`](https://github.com/tangle-network/browser-agent-driver/commit/7c8e2cde5197d8b756cb241523a8cd2e96d7d64d) Thanks [@drewstone](https://github.com/drewstone)! - Fix `provider.chat()` routing for OpenAI-compatible endpoints (Z.ai, LiteLLM, vLLM, Together, OpenRouter, Fireworks). `@ai-sdk/openai` v3+ defaults to the OpenAI Responses API which most third-party endpoints don't implement, causing 404s. Both the new `zai-coding-plan` provider and the default `openai` provider now explicitly use the chat-completions path.
