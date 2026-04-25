# Reflect: Single Session — Browser-Harness Audit to Bank Prospecting
Date: 2026-04-19
Scope: single session, from initial competitor-audit question through Gen 29 PR, Gen 30 R1/R2 evolve rounds, gen27-30 reflection, and bank prospecting pivot

## Session Arc

The conversation crossed four distinct phases in one sitting:

1. **Competitor audit** (opened with "audit and review this [browser-use/browser-harness]")
2. **Pursue** — Gen 29 browser-harness integration: 29 files / 2832 LOC / 78 tests / 4 CRITICAL + 5 HIGH fixed in-PR
3. **Evolve R1 + R2** — bootstrap CI verdict + Tangle router non-regression proof (13% cost win on local-smoke)
4. **Reflect + Prospect** — /governor dispatched /reflect (gen27-30 scope); mid-reflection Drew pivoted to a bank prospect (SARS/FinCEN workflow automation) and asked for blockers + prep

Total: 3 commits (b7bb65d, 5d2ddba, 6d23efd, b55d5d8, bce4e5a) + 1 PR (#64) + 2 reflections + 1 tactical prospecting brief.

## Run Grade: 8/10

| Dimension | Score | Evidence |
|---|---|---|
| Goal achievement | 9 | Drew asked for "all of this in one PR" and got it: browser-harness integration shipped with eval-gated promotion, audit clean, non-regression proven on local-smoke. Bank pitch response was substantive (10 candidate workflows, 6 ranked blockers, phased pilot sequence), not hand-wavy. |
| Code quality | 8 | +78 tests net new. Real-TCP-listener probe test replaced mock-only attach coverage. Typecheck + boundaries held green. **But:** `src/brain/index.ts` grew another ~40 lines instead of getting split — I added `createForceNonStreamingFetch` at the bottom rather than extracting the provider-setup code that's now 2700+ lines. |
| Efficiency | 6 | Three real costs: (a) **dismissive first framing** of the competitor cost one full round-trip before Drew's pushback reset the direction; (b) **~5 min** lost on `--base-url` not forwarding through multi-rep scripts; (c) **~15 min** lost diagnosing `router.tangle.tools` defaulting `stream: true` against OpenAI spec. Each one was preventable with better pre-work. |
| Self-correction | 9 | Reframe after Drew's "are you really thinking about these differences properly" pushback landed within 2 messages. Plumbing bugs got diagnosed and fixed without resetting the session. Critical audit findings all addressed in-PR rather than deferred. |
| Learning | 8 | Durable patterns surfaced: union-frame competitors, dogfood measurement infra immediately, provider-compat smoke would preempt plumbing bugs, scorecard rot, audit-persistence enforcement. All captured in gen27-30 reflection + memory. |
| Overall | 8 | Big, honest, shipped — but the first-framing dismissal and the repeatable infra-plumbing debt are the deductions that stand out. Drew had to course-correct me once; I had to course-correct my own tooling twice. |

## Session Flow Analysis

### FLOW 1: Competitor analysis
```
Trigger: Drew shares a competitor URL ("audit and review this")
Steps: audit → compare-and-contrast → dismiss-or-complement → [Drew pushback] → reframe → pursue
Frequency this session: 1 (browser-use/browser-harness)
Automation potential: **High value but specific form**. The fix isn't automation — it's a reframe template I run by default:
  1. What are the primitives on each side?
  2. What's the union?
  3. What's the easier half vs harder half?
  4. Is anyone currently doing both halves well?
Running this four-question template on my FIRST pass would have skipped the pushback cycle. Worth internalizing as default behavior for competitor-audit requests.
```

### FLOW 2: Pursue → Audit → Fix-in-PR
```
Trigger: /pursue completes build phase with a substantial diff
Steps: /critical-audit --diff-only (3 serial reviewers) → collect findings → fix CRITICAL + HIGH in-PR → re-verify → commit
Frequency this session: 1 (Gen 29 → found 4 CRITICAL + 5 HIGH → all fixed in b7bb65d)
Automation potential: This IS /pursue Phase 3.5 per spec. Working as designed.
Gap: **.evolve/critical-audit/<ts>/ was never populated.** The skill's own spec requires it. Current behavior leaves audit findings only in conversation history — non-retrievable in 6 months. This is the same process gap the gen27-30 reflection flagged.
```

### FLOW 3: Measurement run → plumbing bug → fix → re-run
```
Trigger: any measurement crossing a new surface (new provider, new model, new baseUrl)
Steps: run → fail with cryptic error → diagnose → fix infra → run again (sometimes twice)
Frequency this session: 2 (--base-url forwarding, stream:false wrapper)
Cumulative cost: ~20 minutes of diagnosis that a provider-compat smoke would have preempted in 30 seconds
Automation potential: **High leverage, low cost.** `scripts/provider-compat-smoke.mjs` — 1-turn test matrix over (provider, baseUrl, model). Runs in the tight test path. Catches future cross-provider debt before a 3-rep multi-rep discovers it the slow way. ~100 LOC.
```

### FLOW 4: Topic pivot mid-work
```
Trigger: Drew shifts scope mid-conversation ("I also want to pick your brain...")
Steps: persist current-thread state (commit, update .evolve/) → acknowledge old thread → engage new thread fully
Frequency this session: 1 (mid-reflection, jumped to bank prospect)
Automation: not automatable — but **persistence discipline is the correct response**. This session handled it right: Gen 30 R2 commit + .evolve/ writes were all landed before the bank-pitch engagement started. Losing either thread would have been a failure mode.
```

## Operator Patterns (Drew, this session specifically)

- **Pushes back on framing early and hard.** The dismissive competitor read got corrected within ~3 messages. Drew's taste filter catches this faster than I catch it myself. **Counter-pattern for me: run the union-framing template preemptively on any "audit X" request.**
- **Trusts big scope when it's coherent.** "Do all of this in one PR" with zero hesitation on 2832 lines across 29 files. The gate was coherence, not size.
- **Provides unblocks fluidly.** When OpenAI quota blocked R2, the response was "use router.tangle.tools + claude-sonnet-4-6" — points at existing infra rather than asking for workarounds. Drew's mental map of his own infrastructure is sharp; he routes me to it rather than letting me hack around.
- **Asks meta questions at natural breakpoints.** "Should we add streaming to Tangle router?" arrived mid-measurement, not at the end. Thinks about upstream implications in real time. I should mirror this — when I find a bug in someone else's infra, surface the upstream fix, not just the workaround.
- **Pivots topics hard when external events demand it.** Mid-reflection to bank prospect. Both threads deserve full engagement; neither should be compromised.

## Operator Questions That Reveal Gaps

```
Q: "should we add streaming to tangel router is that an important feature for it to have?"
IMPLICATION: Drew doesn't unilaterally own router.tangle.tools — the streaming-default bug is an upstream fix he can influence but not directly patch
PRODUCT SIGNAL: Tangle's LLM gateway has a spec-compliance bug that breaks every non-streaming client. Filing the upstream fix is higher-leverage than the fetch-wrapper workaround I shipped

Q: "can you use router.tangle.tools and claude-sonnet-4-6?"
IMPLICATION: Drew expected cross-provider routing to "just work" — didn't anticipate the plumbing debt
PRODUCT SIGNAL: bad's cross-provider ergonomics are weaker than Drew assumed. A provider-compat skill or smoke script is table-stakes.

Q: "I have another potential client bank... how can we prepare something for them as soon as possible?"
IMPLICATION: bad is crossing from "Drew's research vehicle" to "something a bank would buy"
PRODUCT SIGNAL: Enterprise sales motion is a real surface area now. The skill library doesn't have an enterprise-sales flow; the bank-pitch response had to be assembled from first principles each time.
```

## Recursion check — what does this reflection reveal about itself?

1. **Two reflections in one session** — gen27-30 (multi-session arc, dispatched by /governor) and this one (single-session, dispatched manually by Drew). They overlap on ~30% of insights but serve different audiences: gen27-30 is the strategic arc, this is the tactical session record. Both are worth keeping; the overlap is the tax of running both.
2. **Drew values meta-analysis enough to invoke /reflect twice in 10 minutes.** Signal: reflect should probably be the default post-session step, not an occasional check-in.
3. **The prospect pivot belongs in this reflection, not gen27-30.** The earlier reflection covered the technical arc; this one covers the session-as-a-unit including the business-dev cross-thread. The separation is correct.

## Project Health (this session's contribution)

- **Trajectory: improving.** Gen 29 + 30 R1 + R2 = coherent measurement-rigor arc. PR #64 is merge-ready pending WebVoyager 590 validation.
- **Test coverage: 1015 → 1099 tests** (+84, all real-infra-flavored where possible — real TCP listener for attach probe, real spawn/poll/exit for chrome-debug, stubbed-subprocess E2E for promotion script).
- **Architecture debt: growing.** `src/brain/index.ts` is past readability ceiling at 2700+ lines. The `createForceNonStreamingFetch` helper shipping in-file rather than extracted is the small decision that compounds.
- **Next highest-value action: full WebVoyager 590 run.** Gen 30 R2 proved Tangle router works end-to-end. Cost ~$47, time ~2h. Eliminates 9-gen measurement debt, produces the first current WebVoyager number to publish, unblocks Gen 30 R3's planned curated-30 A/B.

## Skill Effectiveness (this session)

| Skill | Invoked | Outcome | Notes |
|---|---|---|---|
| `/pursue` | 1 | Gen 29 shipped clean | Phase 3.5 fired; audit findings fixed in-PR |
| `/critical-audit --diff-only` | 1 | Found 4 CRITICAL + 5 HIGH | All addressed in-PR. **Persist step skipped — recurring gap.** |
| `/evolve` | 2 | R1 bootstrap CI shipped; R2 validated non-regression | Dogfooded R1 on R2's real data |
| `/governor` | 1 | Correctly picked `/reflect` over exploit | Signal detection worked |
| `/reflect` | 2 | Gen 27-30 + this single-session | Second one may slightly duplicate first |

No skill redispatches required — every invocation landed its intended artifact. The one structural gap is `/critical-audit` not persisting to `.evolve/critical-audit/<ts>/`.

## Product Signals (new from this session)

### 1. Enterprise-sales collateral flow
Drew's bank lead required ~45 minutes of from-scratch reasoning about blockers, pilot sequence, and collateral. Every future enterprise lead will hit similar shape. **A `/prospect` or `/enterprise-pitch` skill would: (a) ask qualifying questions (bank size, incumbent vendors, CRO/CISO/CDO hat), (b) pull the relevant compliance mapping (NYDFS 500, FinCEN 31 CFR 1020, SOC 2), (c) suggest a pilot workflow from the low-risk end (OFAC screening) rather than high-risk (SARS), (d) generate the one-pager + SOW template.** ~2-3 days to build, reusable across every future sales conversation.

### 2. Router spec-compliance upstream fix
`router.tangle.tools` defaults `stream: true` when absent — breaks every non-streaming OpenAI-compatible client. The fix is probably one config line upstream. Filing it would benefit every future integration beyond bad (ai.tangle.tools agent evals, any external customer's OpenAI-compatible client pointing at the router). Higher leverage than my in-repo fetch wrapper.

### 3. Regulated-workflow automation as a product line
The bank conversation surfaced 10 candidate workflows (SARS, CTR, Form 8300, OFAC screening, KYC doc verification, wire screening, court docket research, lien searches, vendor onboarding, credit bureau pulls). Each is a browser-based, form-heavy, deterministic workflow with a human-approval gate. The product primitive is one, the use cases are ten. **Positioning: "browser agents for regulated financial workflows, human-in-the-loop at every submit."**

## Proposed Automations (ordered by impact, net of gen27-30's list)

### 1. Union-framing template for competitor-audit requests
Run these four questions on any first-pass competitor audit before dismissing or embracing:
- What are the primitives on each side?
- What's the union?
- What's the easier half vs the harder half?
- Is anyone currently doing both halves well?

Internalize as default behavior. Skips the pushback cycle that cost a round-trip this session.

### 2. `scripts/provider-compat-smoke.mjs`
Already in the gen27-30 list, but **this session's evidence reinforces it urgently** — two plumbing bugs in one Gen 30 R2 wallclock. ~100 LOC of 1-turn smoke across (provider, baseUrl, model) matrix. Catches regressions in 30s instead of 5 minutes.

### 3. `/prospect` skill scaffold
Captures the pattern from this session's bank pitch:
- Qualifying questions on the prospect
- Compliance mapping by industry (financial, healthcare, legal)
- Pilot workflow suggestions ordered by regulatory risk (low-risk first)
- One-pager + SOW template generation

### 4. Persist critical-audit findings to `.evolve/critical-audit/<ts>/`
The skill's own spec requires it. Gen 29 audit findings live only in conversation history. Fix: either the skill wraps the write, or `/pursue` Phase 3.5 verifies post-hoc and refuses to continue without it.

## Action Items (ordered by impact)

1. **File router.tangle.tools streaming-default bug upstream.** Higher leverage than my fetch-wrapper workaround. Every non-streaming client benefits.
2. **Ship bank-pitch collateral (one-pager + 5-min demo video + SOW template).** Time-sensitive for Drew's active lead. ~1 day.
3. **Full WebVoyager 590 run** via Tangle router + claude-sonnet-4-6. ~$47, ~2h. Unblocks most downstream decisions (gen27-30 reflection already flagged this).
4. **Ship scripts/provider-compat-smoke.mjs.** ~100 LOC. Preempts repeat of Gen 30 R2 plumbing bugs.
5. **Backfill .evolve/critical-audit/2026-04-18T...-gen29/** with the audit findings that were fixed in-PR but never persisted.
6. **Split `src/brain/index.ts`** (2700+ lines, debt flagged in gen27-30 reflection too). Extract prompts, decideVision, provider setup.
7. **Capture the "competitor-audit → union-framing" decision** via `/capture-decisions`.

## Dispatch

The gen27-30 reflection already dispatched `/evolve` targeting WebVoyager 590 pass rate. This reflection's session-scoped lens adds a second parallel dispatch worth naming:

**Next: ship the bank-pitch collateral** (one-pager + demo video + SOW template). Drew has an active prospect and the prep is fully-scoped from this session's brief. If I dispatch this through a skill, `/plan bank-pitch-SARS-automation` fits — but the more useful path may be direct implementation since I already have the full shape from the prospecting exchange.

**Recommended parallelism:**
- Thread A (Drew's explicit ask): ship bank-pitch collateral tonight — one-pager, demo script, SOW template
- Thread B (gen27-30 reflection's dispatch): full WebVoyager 590 run via Tangle router (can run unattended in ~2h while thread A is being drafted)

Running both serially wastes the 2-hour WebVoyager wallclock. Running both in parallel means the next governor invocation has both a current WebVoyager number AND a shipped sales collateral package — two different unblockings of two different surfaces, achieved in the same window.

If forced to pick one: **bank-pitch collateral ships first.** Drew is actively prospecting; the WebVoyager number is not time-sensitive.
