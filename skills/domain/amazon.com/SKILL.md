---
host: amazon.com
aliases: [www.amazon.com, smile.amazon.com]
title: Amazon product search and extraction
---

On amazon.com:

- Prefer the search box at the top. It's a `searchbox` role with ref near the page header. After typing the query, press Enter rather than clicking the "Go" button — the button is often hidden behind the keyboard and Enter submits reliably.
- Cookie/consent banners only appear on EU/UK domains (`.co.uk`, `.de`). If present, click the "Accept" or "Customize" button before any other interaction — Amazon's layout shifts after consent and `@ref` values change.
- Product search results live under the "Search results" landmark. Each card has a link whose accessible name is the product title. Use `click` on the title link, not the image, to reach the product detail page.
- On product detail pages, the canonical price is inside the `#corePrice_feature_div` block. Read `#priceblock_ourprice`, `#priceblock_dealprice`, or the a-price-whole spans — the field varies by category. Extract using `extractWithIndex` with the `offscreen` filter off; Amazon renders price twice (once with aria-hidden) and the accessible version is what you want.
- Ratings appear as `4.5 out of 5 stars` in an `[aria-label]`. Parse the numeric portion before "out of".
- Be aware of sponsored vs organic results: sponsored cards have "Sponsored" in small text above the title. Most tasks want the first organic result; filter accordingly.
