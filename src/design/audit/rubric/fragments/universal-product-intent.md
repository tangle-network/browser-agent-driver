---
id: universal-product-intent
title: Product Intent & Outcome Fit
weight: critical
dimension: product-clarity
applies-when:
  universal: true
---

PRODUCT INTENT AUDIT — judge the screen by the job it must do, not by generic prettiness.

Before scoring, infer these from the screenshot and classification:
- Primary audience: who is this for right now?
- Primary job: what must this page help them accomplish?
- Primary action: what should they do next?
- Stakes: what can go wrong if the UI is unclear? Money, trust, data loss, wrong deployment, wasted time, safety, legal/medical risk, brand trust, or simple confusion.
- Success path: what is the shortest believable path from landing on this screen to completing the job?

Then evaluate brutally:
- Does the page make the primary job obvious within 5 seconds?
- Is the main action visually and semantically dominant, or is it buried among equal-weight controls?
- Does the content shown match the user's intent, or is it filler, meta copy, marketing fluff, or generic component-library scaffolding?
- Are empty/loading/disconnected states still useful previews of the real product, or do they make the product look unfinished?
- Does the information architecture match the audience's mental model?
- Are trust-critical details visible before commitment: price, permissions, data source, provenance, verification, risk, status, ownership, or next steps?
- Does the design use the domain's natural artifacts? Examples: ledgers and receipts for finance, logs and deployments for devtools, product cards and checkout for ecommerce, source/code/examples for developer products, clinical clarity for health, creator/social proof for social products.

WHAT TO PUNISH:
- Vague dashboards that show containers instead of decisions.
- Copy that explains the UI rather than helping the user act.
- Equal-weight buttons for unequal actions.
- Generic empty states where real state previews, sample rows, setup checklists, or status timelines would communicate the product.
- Decorative graphics that block or distract from the job.
- Beautiful surfaces that do not clarify what the product does.
- Navigation chrome that feels more important than the workflow.

WHAT TO REWARD:
- One obvious primary action per page state.
- Real domain objects above the fold: deployments, jobs, payouts, orders, patients, tasks, files, incidents, products, conversations, etc.
- Clear state machines: draft → pending → active → failed → complete.
- Trust-building detail where risk exists.
- Progressive disclosure: simple first screen, serious detail available when needed.
- Visual hierarchy driven by the product model, not by arbitrary cards.

SCORING IMPACT:
- If users cannot tell what the product is for or what to do next, cap the page at 6 no matter how clean it looks.
- If the screen is visually polished but mostly generic scaffolding, cap it at 7.
- 8+ requires product specificity: the page must feel designed for this exact product, audience, and workflow.
