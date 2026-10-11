---
"@tangle-network/browser-agent-driver": patch
---

Leaner page snapshots (browser-use serializer spirit): nameless structural wrappers (rows, cells, layout tables, groups, regions) and decorative images are dropped from the aria snapshot — named containers stay since their text is the data being extracted; per-node display names cap at 120 chars while ref resolution keeps the full accessible name; and added elements are marked inline with `*new*` on their snapshot lines instead of a duplicative SNAPSHOT CHANGES block (changed/removed/unmatched entries still tail-append).
