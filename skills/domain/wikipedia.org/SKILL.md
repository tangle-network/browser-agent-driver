---
host: wikipedia.org
aliases: [en.wikipedia.org]
title: Wikipedia article extraction
---

On wikipedia.org:

- Article content is inside `#mw-content-text`. Infoboxes are the table at the top-right of the article — use them for structured facts (birth/death dates, coordinates, population, founding year) rather than parsing prose.
- The article lead (first paragraph after the infobox) is the highest-density summary; for one-fact queries it usually contains the answer.
- When extracting a numeric fact for a goal like "what year was X founded", emit the number in the exact shape the goal asks for. If the goal implies a JSON object, wrap: `{"year": 1815}`, not the bare string "1815". Wikipedia extraction goals are the most common site where this formatting detail decides pass/fail.
- The search box is at the top-right. Pressing Enter after typing runs the search; the dropdown suggestions lead to disambiguation pages which can be wrong — prefer pressing Enter.
- Disambiguation pages: if the search resolves to a "X may refer to:" list, the correct entry is usually the one matching the goal's context (place, person, company). Scan the list before clicking.
- References and citations use superscripts like `[1]`. Do not include them in extracted prose — strip the `<sup>` elements or their text content.
- For facts, prefer the English Wikipedia (`en.wikipedia.org`) over other language editions unless the task specifies a different language.
