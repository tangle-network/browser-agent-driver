# Wave-7 delta: corpus expansion 5 → 10 tasks (credibility wave)

**Date:** 2026-10-11 · **Model:** gemini-2.5-flash · **Corpus:** 10 tasks × 3 reps (bad + browser-use, same-day same-machine same-key) · **Oracle:** external per-task · **Headless throughout**

**Wave-7 goal:** credibility. The six-wave program closed on a 5-task corpus (3 fixture + 2 real-web); every aggregate carried an n=5-tasks asterisk. This wave doubles the corpus with five adversarially-chosen tasks and re-runs the head-to-head unchanged (`agent-results/competitive-wave7`, runner `pnpm bench:compete`, baseline `bad`).

## Corpus diff (5 → 10)

Kept unchanged: `form-fill-multi-step`, `dashboard-extract`, `dashboard-edit-export`, `wikipedia-fact-lookup`, `hn-top-story-score`.

Added:

| task | kind | adversarial coverage added |
|---|---|---|
| `modal-stack-dismissal` | fixture (`modal-gauntlet.html`, new) | **Overlay stacking before the goal is reachable.** Three stacked blockers (cookie bar, notification-permission bar, newsletter modal) physically intercept pointer events on the target button; the newsletter modal's primary CTA is a trap (`Subscribe` with an empty/invalid email shows a validation error and keeps the modal open — the dismissal path is a small "No thanks" link), and `Manage preferences` opens a *fourth* overlay. Tests blocker-recovery. |
| `checkout-validation-traps` | fixture (`checkout-validation.html`, new) | **Form validation traps.** Required-field interdependency (Business account type reveals a required VAT field) plus strict format validators that reject the buyer's shorthand values the goal provides: phone `4155550132` must become `+1 (415) 555-0132`, card with spaces must become 16 bare digits, expiry `9/28` must become `09/28`. Error messages name the exact format; the agent must read them and reformat. |
| `reports-cross-view-extract` | fixture (`reports-combine.html`, new) | **Two-view extraction.** The answer (West-region order total $6,075.75 across 5 orders) requires combining the Customers tab (regions) with the Orders tab (amounts) — neither view alone suffices, and only one tab is visible at a time. The Orders tab shows a decoy `Grand total (all regions) $14,404.25`; the oracle rejects it. Tests extraction turn-count discipline (bad's known 2–7 turn weakness vs browser-use's 2). |
| `pypi-project-metadata` | real-web (`pypi.org/project/requests/`) | **Drift-proof real-web extraction**, patterned after `hn-top-story-score`: the oracle regex-checks structure (`name` = `^requests$`, `latest_version` = semver shape, `requires_python` = `>=?3…`) so the answer can drift with releases without invalidating the task. |
| `wikipedia-disambiguation-trap` | real-web (`en.wikipedia.org/wiki/Mercury`) | **Trap task: the naive first result is wrong.** `Mercury` is a disambiguation page whose first link is the *planet*; the goal requires the *element* article (atomic number 80, symbol Hg — historically stable values, safe to hardcode). The planet article has no atomic number, so an agent that takes the first link and confabulates fails the oracle. |

Every new oracle was verified before corpus admission: (a) `evaluateOracle` passes on a known-good final state per task, (b) the trap answers (grand-total decoy, planet-article answer, case/format variants) are correctly rejected, and (c) each new fixture was driven end-to-end with headless Playwright to prove the success state is reachable by real clicks/keystrokes (naive checkout values rejected → reformatted → `Order confirmed!`; overlays dismissed → report opens; tab switch reveals regions).

## Smoke gate (bad only, 1 rep, `--allow-quick-check` — plumbing only, not cited)

8/10 pass. `dashboard-extract` failed on the known `resultText is not valid JSON` variance class (recovered in the 3-rep run). `checkout-validation-traps` failed on a genuine agent error: bad read the format error (its own `runScript` of the error summary returned "phone, expiry") yet never produced `+1 (415) 555-0132` — it tried `4155550132`, `415-555-0132`, `(415) 555-0132`, then regressed expiry from the correct `09/28` (turn 22 fill) to `09/2028` (turn 24). Oracle correctly missed; task kept as a discriminator.

## Headline results (10 tasks × 3 reps, gemini-2.5-flash)

| task | bad pass | bad $/run | bad wall | bu pass | bu $/run | bu wall |
|---|---|---|---|---|---|---|
| form-fill-multi-step | 3/3 | $0.0246 | 17.5s | 3/3 | $0.0228 | 42.5s |
| dashboard-extract | 2/3 | $0.0228 | 19.5s | 3/3 | $0.0218 | 34.9s |
| dashboard-edit-export | 3/3 | $0.0211 | 13.9s | 3/3 | $0.0159 | 27.9s |
| wikipedia-fact-lookup | 3/3 | $0.0140 | 7.3s | 0/3 | $0.0045 | 15.0s |
| hn-top-story-score | 3/3 | $0.0120 | 10.5s | 2/3 | $0.0364 | 48.4s |
| **modal-stack-dismissal** *(new)* | 3/3 | $0.0183 | 107.2s | 3/3 | $0.0278 | 48.3s |
| **checkout-validation-traps** *(new)* | **0/3** | $0.1116 | 80.4s | **3/3** | $0.0263 | 44.4s |
| **reports-cross-view-extract** *(new)* | 3/3 | $0.0443 | 38.2s | 1/3 | $0.0287 | 49.7s |
| **pypi-project-metadata** *(new)* | 1/3 | $0.0509 | 57.2s | 0/3 | $0.0046 | 15.8s |
| **wikipedia-disambiguation-trap** *(new)* | 3/3 | $0.0371 | 19.8s | 0/3 | $0.0128 | 32.0s |
| **aggregate (10 tasks)** | **24/30 (80%)** | **$0.0357** | **37.2s** | **18/30 (60%)** | **$0.0202** | **35.9s** |

Spend: **$2.04 Gemini across 70 wave-7 runs** (10-task smoke + 60-run corpus). Zero blocked runs (no anti-bot weather). Kept-5 subset: bad 14/15, browser-use 11/15. New-5 subset: bad 10/15, browser-use 7/15.

## What the new tasks revealed

1. **`checkout-validation-traps` is the wave's finding: bad 0/3 vs browser-use 3/3 — a serializer observability gap, proven end-to-end.** All four bad attempts (smoke + 3 reps) followed the same script: correct initial fill → submit → validation errors → ~20 turns of blind format guessing. Root cause isolated from retained artifacts: the page announces per-field format requirements in `<p class="field-error">` paragraphs and the failure summary in a `role="alert"` div. bad's CDP snapshot (`src/drivers/cdp-snapshot.ts`) drops both channels — `paragraph` and `StaticText` are in `SKIP_ROLES`, and the alert node renders as a bare `- alert` because the div has no accessible *name* (its message lives in a skipped StaticText child). The agent recovered the failing *field names* by `runScript`-ing the alert every other turn, but never saw the format text ("Phone must use the exact format +1 (555) 123-4567"). It got as close as `(415) 555-0132` — missing only the `+1` prefix — and regressed a previously-correct `09/28` expiry to `09/2028` in two reps. browser-use's visible-text serializer carries the error paragraphs, and it passed 3/3 in 8 turns. **No driver change shipped:** the obvious fix (surface paragraph/static text) has unbounded token-cost blast radius on prose-heavy pages (Wikipedia articles are all paragraphs — the skip is deliberate, snapshot's job is actionability, and extraction tasks already go through `runScript`); a bounded variant (fold descendant text into live-region `alert`/`status` lines) would not have flipped this cell, since the alert summary names fields but not formats. This is a real structural gap to attack with a measured serializer experiment, not a cheap guard.
2. **The disambiguation trap didn't trap browser-use — its 0/3 is the known prose-result class.** All three browser-use reps reached `Mercury_(element)` (finalUrl correct) and narrated the answer ("Successfully extracted the atomic number and chemical symbol") instead of emitting the demanded JSON. bad passed 3/3 (5.0 turns), including one rep that went planet → recovered → element. The cell still discriminates — just on output-format discipline, not navigation. The trap mechanism itself was validated in the smoke run and by the oracle's rejection of planet-article answers.
3. **Extraction turn-count gap: closed on the incumbent tasks, real but earned on the new one.** bad hit 2.0 turns on hn (browser-use 5.3) and 2.7 on wikipedia — the wave-2→6 work holds. On `reports-cross-view-extract` bad needed 9.7 turns (3/3) vs browser-use 7.7 (1/3) — the two-view combine is genuinely multi-turn for both, and bad's extra turns bought 3/3 accuracy against the grand-total decoy while browser-use's two failures were again invalid-JSON results.
4. **`pypi-project-metadata` is drift-proof as designed but partially weather-y for bad (1/3):** rep1 clean (`{"name":"requests","latest_version":"2.34.2","requires_python":">=3.10"}` — oracle verified against the live page at run time, nothing hardcoded but the package name); rep2 returned `requires_python: ""` (agent found the header version but not the Meta-section specifier — extraction coverage slip); rep3 emitted no JSON. browser-use 0/3, all prose results. Kept; regex oracle correctly rejected the empty-string and prose answers.
5. **`modal-stack-dismissal` passes both frameworks (3/3 each) but exposes a wall-clock anomaly:** bad 107.2s at 6.3 turns (~17s/turn LLM latency) vs browser-use 48.3s at 9.7 turns. Both navigated the overlay stack including the `Subscribe` trap; worth watching whether bad's per-turn latency on overlay-heavy pages is DOM-size related (snapshot rebuilds per dismissal).

## Aggregate vs the wave-6 5-task baseline

| | wave-6 (5 tasks × 3) | wave-7 kept-5 subset | wave-7 full 10 |
|---|---|---|---|
| bad pass | 15/15 | 14/15 (dx 2/3, invalid-JSON rep) | **24/30 (80%)** |
| bad $/run | $0.0223 | $0.0189 | $0.0357 |
| bad wall/run | 17.9s | 13.7s | 37.2s |
| browser-use pass | 12/15 | 11/15 | **18/30 (60%)** |
| browser-use $/run | $0.0126 | $0.0203 | $0.0202 |
| browser-use wall/run | — | 33.7s | 35.9s |

The kept-5 subset reproduces the wave-6 verdict (bad ahead on pass, cheaper and faster than its own wave-6 numbers, cost ratio vs browser-use 0.93× this window — browser-use's hn rep2 74s/$0.09 outlier inflated its kept-5 mean). The full-10 aggregate is dominated by bad's two adversarial cells (checkout $0.1116/24 turns, modal 107s wall): **bad's 80% vs 60% lead is real but the cost ratio widens to 1.77×** — exactly the credibility signal a 5-task corpus was too small to show.

## Honest caveats

- n=3 per cell is the repo minimum — Wilson intervals at n=3 are wide; treat per-task pass deltas as directional.
- The two new real-web tasks carry site-variance risk like the existing two; `pypi-project-metadata`'s regex oracle is drift-proof by construction, and `wikipedia-disambiguation-trap` hardcodes only historically stable facts (atomic number/symbol).
- The smoke run's 1-rep numbers are plumbing evidence only and are not cited anywhere above.
- Corpora: `agent-results/competitive-wave7-smoke` (smoke), `agent-results/competitive-wave7` (cited) — gitignored artifacts, retained locally.
