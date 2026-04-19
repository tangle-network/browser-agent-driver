---
host: stackoverflow.com
title: Stack Overflow question and answer extraction
---

On stackoverflow.com:

- Question pages have a stable structure: question body, then answers sorted by vote count (accepted answer floats to the top). The accepted answer has a green checkmark and `aria-label="Accepted answer"`.
- Answer count appears in the sidebar sub-header ("3 Answers"). Extract from that heading, not from counting `<article>` elements — pinned/deleted answers can throw off the DOM count.
- Code blocks inside answers are `<pre><code>` — their text content is preserved verbatim. If the task is "extract the code from the top answer", grab the first `<pre>` inside the answer body.
- Vote counts are in a `.js-vote-count` or `[itemprop="upvoteCount"]` element next to each post. Use the accessible label ("23 votes") rather than parsing the class.
- Tags appear below the question title as a list of `role="link"` with `tag` in the URL. Good proxy for topic when the question title is ambiguous.
- Stack Overflow requires JS to render vote counts and comments. Wait for the "Show X more comments" expander to resolve before extracting comment text.
