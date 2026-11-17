---
"@tangle-network/browser-agent-driver": patch
---

Goal verification (#177): a quote may now run across adjacent snapshot lines and leave out snapshot markup. "Logged in as tomsmith" matches a page that shows "Logged in as" and "tomsmith" on two lines, and a list quote copied without its `[ref=…]` tokens matches. The words of a quote are still matched with the spaces between them, so two separate records cannot be stitched into one value ("$3" + "9.98" is not "$39.98"), and each quote is still checked against the block it cites. The verifier's raw verdict is now kept on the run record (`goalVerification.raw`, and `verifierVerdict` on each turn that completed), so a rejection can be audited.
