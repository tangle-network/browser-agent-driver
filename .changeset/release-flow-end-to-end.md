---
'@tangle-network/browser-agent-driver': patch
---

Release flow now publishes end-to-end in a single workflow run with zero manual steps. The Changesets workflow opens the version PR, then on merge runs build + tag + npm publish via OIDC trusted publishing in the same job. No more manual `git push origin browser-agent-driver-vX.Y.Z` after merging the release PR. publish-npm.yml stays as a manual fallback for re-publishing failed releases via workflow_dispatch.
