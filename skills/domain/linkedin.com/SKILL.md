---
host: linkedin.com
aliases: [www.linkedin.com]
title: LinkedIn navigation and profile extraction
---

On linkedin.com:

- The site aggressively detects automation. If you see an authwall ("Join now to see"), the account is not logged in — abort unless the task explicitly expects this. Do not try to sign up programmatically.
- Profile pages use dynamic React rendering. Wait for `heading` role with the person's name to appear before extracting — snapshot on first load is often skeleton UI.
- The search bar is `role="combobox"` with placeholder "Search". After typing, press Enter; the dropdown suggestions can lead to unrelated pages if clicked.
- Job listings: use `extractWithIndex` on the search results container (class `jobs-search-results-list` or role `list`). Each item's title, company, and location are distinct children — don't flatten them into a single blob.
- LinkedIn rate-limits heavy scraping. If the page shows "You've reached the weekly limit", abort the run — retries will not help.
- When logged in via attach mode, respect the user's real account: never send connection requests, InMails, or messages unless the task explicitly requests it.
