---
'@tangle-network/browser-agent-driver': patch
---

fix(discover/wayback): use CDX `collapse=timestamp:6` instead of `limit` so longitudinal jobs span the requested window

Symptom: a job with `since: 2012-01-01, until: 2024-01-01, snapshotsPerUrl: 4` against a popular site returned four snapshots all clustered in 2012-2013 instead of evenly across 2012-2024.

Cause: the CDX call passed `limit: max(count*4, 50)`, which caps how many captures CDX returns *before* `sampleEvenly` runs. For sites with thousands of captures (Stripe, Linear, GitHub, etc.) the first 50 in chronological order are all from the start of the window, so even sampling could only produce early-window snapshots.

Fix: drop `limit`, use `collapse=timestamp:6` (one capture per month). The row count is now bounded by the window length in months, which keeps payloads sane while ensuring captures are spread across the whole window.

Verified: `discoverWaybackSnapshots('https://stripe.com/', { count: 5, since: '2012-01-01', until: '2024-01-01' })` now returns snapshots at 2012-02, 2015-03, 2018-03, 2021-02, 2024-01.
