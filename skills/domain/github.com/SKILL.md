---
host: github.com
aliases: [www.github.com]
title: GitHub navigation, repo discovery, and PR/issue extraction
---

On github.com:

- The top search bar is `role="combobox"` with `aria-label="Search GitHub"`. Typing a query and pressing Enter runs the global search. For in-repo search, use the "Go to file" shortcut: press `t` on a repo page and type the filename.
- Repo pages have stable URL structure: `/OWNER/REPO`, `/OWNER/REPO/pulls`, `/OWNER/REPO/issues`, `/OWNER/REPO/blob/BRANCH/PATH`. Prefer direct URL navigation over clicking through the UI when the owner/repo is known — it's faster and avoids sidebar ambiguity.
- PR and issue lists use infinite scroll but the first ~25 fit on one page. Don't scroll unless the task requires more than 25 results.
- PR/issue counts: the tab badges ("Pull requests 42", "Issues 7") carry the exact number. Extract from the tab's accessible name, not from scrolling the list.
- File browsing: blob pages render the code inside a `<table>` with `role="presentation"`. Line numbers are in a separate column; use the `#L<n>` URL fragment to jump to a specific line rather than scrolling.
- For star/fork counts on a repo, the values are in the top-right action bar with accessible labels like "42 stars" and "3 forks".
- Login state matters: logged-in users see private repos in search; logged-out users don't. Don't assume visibility equals existence.
