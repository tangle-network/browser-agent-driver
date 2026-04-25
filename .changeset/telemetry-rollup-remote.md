---
'@tangle-network/browser-agent-driver': patch
---

`bench/telemetry/rollup.ts` learns a `--remote` mode. When `BAD_TELEMETRY_API`
is set the rollup queries the fleet collector at `${BAD_TELEMETRY_API}/api/telemetry/v1/rollup`
(authenticated with `BAD_TELEMETRY_ADMIN_BEARER`) instead of reading local
NDJSON. The default file-path mode is unchanged. `--raw` streams envelopes
through the collector's paginated `/v1/envelopes` endpoint.
