---
"@tangle-network/browser-agent-driver": patch
---

Follow-up to #177 from the first re-measurement run on saucedemo.

- Adjacent text nodes now share one snapshot line ("Item total: $39.98", not "Item total: $" and "39.98"), keeping the space between them, so a correct total is no longer rejected as "not on any observed page". The verifier still requires each quoted value inside one snapshot line, so it cannot stitch a value together from two separate records.
- The cookie-banner shortcut no longer fires on page buttons such as "Continue Shopping": the button's whole name must be an accept phrase, and the nearby text must mention cookies, consent or GDPR (a footer "Privacy Policy" link, now visible in snapshots, no longer counts).
- The verifier prompt says typed values are confirmed by the driver's actions and a sign-in by the page that follows it.
