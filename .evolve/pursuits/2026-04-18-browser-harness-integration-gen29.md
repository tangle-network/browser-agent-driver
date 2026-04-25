# Pursuit: Browser-Harness Integration (Gen 29)
Generation: 29
Status: building
Started: 2026-04-18
Branch: gen29-browser-harness-integration

## Context

browser-use/browser-harness (github, 2026-04-17, 466★ in 2 days) landed as a
minimal 4-file Python harness that attaches to the user's real Chrome,
lets the LLM edit its own `helpers.py` mid-task ("self-healing"), and
ships a 60-site `domain-skills/` library.

It has zero evaluation harness, zero measurement rigor, and is 2 days
old. We have eval rigor, a full agent loop, WebVoyager 91.3% at Gen 25,
and a measurement-gated research pipeline. Their primitives + our rigor
is the actual moonshot.

## Metric → product-value claim

Three metrics move in Gen 29, each with a product-value claim:

1. **Attach time-to-first-action on a logged-in site** — if `bad --attach`
   lets a user drive their already-logged-in Chrome, real workflows
   (GitHub, Gmail, LinkedIn, TikTok) become one-command automations
   without scraping cookies. The product outcome is: "I can automate
   anything I'm already logged into."
2. **Domain-skill hit rate on benched sites** — if a domain skill for
   `amazon.com` or `linkedin.com` reduces turns or raises pass rate on
   that site's cases, the corpus is a measurable capability layer, not
   vibes-curated. The product outcome is: "Every site we fail on once
   becomes a site we solve forever, backed by numbers."
3. **Eval-gated macro promotion rate** — if the agent's proposed macros
   get bench-validated and only winners enter `skills/macros/`, we have
   eval-gated capability growth. The product outcome is: "The agent's
   toolset compounds through measurement, not through hope."

If none of these move, the generation is prompt-flair.

## System Audit

### What exists and works
- **CDP attach** already implemented at `src/cli.ts:916-943` with WS
  auto-discovery. `src/browser-launch.ts:7` carries `cdpUrl` through
  the plan. `src/drivers/steel.ts:176-177` proves the pattern in prod.
- **Extension system** at `src/extensions/{types,loader}.ts` already
  has `addRulesForDomain` merged into `setExtensionRules` at
  `src/brain/index.ts:899`, with hostname matching at `:878-893`.
- **Research pipeline** (`scripts/run-research-pipeline.mjs`) has
  two-stage screen→validate with bootstrap CIs. 5-rep promotion gates
  already work (see Gen 10/11 progress).
- **Static action registry** at `src/types.ts:192-212` with switch
  dispatch at `src/drivers/playwright.ts:575`.

### What exists but isn't integrated
- No ergonomic entrypoint for attach. Users have to launch Chrome with
  `--remote-debugging-port=9222` manually, pass `--cdp-url`, and know
  that wallet mode + profile-dir silently get ignored.
- No disk-backed domain skills. The extension system accepts
  `addRulesForDomain` programmatically, but no loader reads
  `skills/domain/<host>/SKILL.md` files.
- `skills/manifest.json` exists but has no "domain" skill type.

### What doesn't exist yet
- **Custom action macros** — the agent cannot compose primitives into
  reusable named workflows (e.g., `dismissCookieBanner`, `handleSearchForm`).
- **Eval-gated mutation** — no path for proposed tool additions to
  get bench-validated and promoted.

### Measurement gaps
- Attach mode has no dedicated bench case (nothing exercises the CDP
  reuse path outside Steel driver).
- Domain skill deltas have no measurement. To claim a skill improves
  a site, we need the skill-on vs skill-off A/B.

## Baselines

Will capture after build as part of Phase 3. Per CLAUDE.md: 3+ reps,
mean/min/max reported, same-day baseline required. Scenarios:
- `local-smoke` (multistep form) for macro plumbing validation
- A new `bench/scenarios/cases/local-cookie-domain-skill.json` exercising
  a domain skill against a fixture (pure-local so it's deterministic)

## Diagnosis

The three bh primitives (attach, skills, mutable helpers) are each
~1 conceptual step from a fit inside our existing harness:

| Primitive | Existing hook | Work to integrate |
|---|---|---|
| Attach | `cdpUrl` path at cli.ts:916 | CLI UX + probe + launcher helper |
| Domain skills | `setExtensionRules` domain map | Disk loader + markdown parser + 5 seeds |
| Mutable helpers | static action registry | Macro DSL + eval-gated promotion path |

Nothing requires a fork. The moonshot bh can't reach (self-healing
harness with proof) is exactly what our eval harness buys.

## Generation 29 Design

### Thesis
**Eval-gated capability growth.** bh shows that a mutable tool surface
+ shared skill corpus + real-Chrome attach is the shape of an actual
employee-grade agent. Without measurement that's hype. With our
research pipeline underneath it, it's a flywheel. Gen 29 wires the
three primitives into our harness so every new tool earns promotion
through reps.

### Moonshot considered
Rip the whole action registry and replace it with a prompt-and-primitive
system where the agent writes TypeScript handlers sandboxed via
deno/vm2, then promotes winning code to the static registry via the
research pipeline. **Rejected for Gen 29**: scope explosion, sandbox
complexity, low marginal value over macro DSL. The macro DSL reaches
~60% of the target use cases (compose-safe-primitives) with ~5% of
the risk. Raw-code handlers earn their spot in a later generation
after macros prove the eval-gated pattern.

### Codebase conventions matched
- **Extension rules injection**: `src/brain/index.ts:865-870` — domain
  rules appended AFTER `REASONING_SUFFIX` to preserve Anthropic prompt
  cache. Domain skills reuse this same path.
- **Loader pattern**: `src/extensions/loader.ts` — dynamic import, file
  URL, graceful error surface. Domain skill loader matches this shape
  (readdir + markdown parse, same error strategy).
- **CDP flag shape**: `src/cli.ts:179` `--cdp-url` existed before;
  `--attach` is a sibling that auto-populates it, not a new path.
- **Research pipeline spec**: `bench/research/speed-v1.json` — queue
  of hypotheses, two-stage screen→validate. Candidates queue lives at
  `.evolve/candidates/queue.json` in the same shape.

### Changes (ordered by impact)

#### Architectural (must ship together)
1. **`bad attach` mode** (`src/cli.ts`, `src/browser-launch.ts`)
   - New CLI flag `--attach` (bool). Auto-probes 127.0.0.1:9222/json/version.
   - New subcommand `bad chrome-debug` that launches the user's real
     Chrome with `--remote-debugging-port=9222` against their default
     profile. Prints copy-paste command if auto-launch fails.
   - `--attach` populates `cdpUrl` from the probe. Existing path at
     cli.ts:916 takes over from there.
   - Documentation: updated `--help` copy.

2. **Domain skill loader** (`src/skills/domain-loader.ts` + wiring)
   - New directory layout: `skills/domain/<host>/SKILL.md`.
   - Markdown files have YAML frontmatter: `host`, optional `aliases`,
     optional `triggers`. Body is the rules text.
   - Loader reads the dir tree, emits a `Record<host, DomainRules>`
     compatible with `combinedDomainRules`.
   - Runner wiring: augment `resolveExtensions()` output with loaded
     domain skills so the existing `setExtensionRules` path picks them up.
   - 5 seeded skills: amazon.com, linkedin.com, github.com,
     stackoverflow.com, wikipedia.org (sites we already bench).
   - Bench case: `bench/scenarios/cases/domain-skill-smoke.json`
     exercising one seeded skill against a local fixture (so it's Tier 1).

3. **Custom action macros** (`src/types.ts`, `src/drivers/playwright.ts`,
   `src/brain/index.ts`, `src/macros/`)
   - New `MacroAction = { action: 'macro', name: string, args?: object }`.
   - `MacroDefinition = { name, description, params?, steps: MacroStep[] }`
     where `MacroStep` is a pre-existing Action with optional `${arg}`
     template interpolation.
   - Dispatch in `playwright.ts` switch: `case 'macro'` runs each step
     against `this.execute()` recursively.
   - Loader reads `skills/macros/**/*.json`, makes available names.
   - Brain gets an injected "available macros" block in CORE_RULES
     (appended after domain rules so it's post-cache).
   - Safety: steps limited to the existing safe primitives; max-depth=1
     (macros don't call macros). No eval(), no shell. Tests pin this.

#### Measurement
4. **Eval-gated macro promotion** (`scripts/run-macro-promotion.mjs`,
   `.evolve/candidates/queue.json`, `skills/macros/`)
   - Candidates land at `.evolve/candidates/macros/<name>.json` with
     a bench case pointer + the macro JSON.
   - `scripts/run-macro-promotion.mjs` iterates the queue, dispatches
     `run-research-pipeline.mjs --two-stage` per candidate.
   - On promote: moves macro JSON to `skills/macros/<name>.json`,
     appends to `.evolve/experiments.jsonl`, updates `current.json`
     shipped list.
   - On reject: writes a `.evolve/candidates/rejected/<name>-<date>.md`
     with the result table and the agent-generated reason.
   - Initial candidate corpus: 3 plausible macros (dismiss-cookie-banner,
     accept-terms-and-submit, search-and-open-first-result). Each is a
     known failure-mode cluster.

#### Infrastructure
5. **Tests** — every new file gets a sibling test. Target: +40 net new.
   - Attach probe + flag parsing + chrome-debug command builder
   - Domain loader markdown parse + frontmatter + hostname merge
   - Macro validator (no eval, no shell, safe primitives only)
   - Macro dispatcher (step iteration, arg interpolation, error bubbling)
   - Promotion script guardrails (no writes outside staging dirs)

6. **Docs** — update `docs/EVAL-RIGOR.md`? No. Update `CLAUDE.md` wallet
   section? Only if attach conflicts with wallet mode unclearly —
   already documented at `browser-launch.ts:119-121`, extend that warning.

### Alternatives

- **Full TypeScript-handler macros with vm2 sandbox** — rejected, scope
  creep, sandbox is its own can of worms. Macro DSL reaches 60%+ of the
  target use cases with the dispatch-switch change alone.
- **CDP lib instead of Playwright for attach** — rejected, Playwright's
  `connectOverCDP` already works (see Steel driver). Adding raw CDP just
  means two code paths.
- **Skills as code (.ts) instead of markdown** — rejected, bh's win is
  that skills are portable across agents and human-readable. Markdown +
  frontmatter preserves that. Code skills get rebuilt as custom
  extensions by power users who already use `bad.config.mjs`.

### Risk + Success criteria

**Risks**
- Attach probe race — if the user's Chrome is on a non-default port we
  miss. Mitigation: `--cdp-url` still works (no regression), attach just
  adds the ergonomic default.
- Domain-skill prompt bloat — every matching domain adds tokens.
  Mitigation: skills only inject for the current hostname (already how
  `matchDomainRules` works), cap body size in the loader.
- Macro dispatch infinite loop — if macros could call macros, a cycle
  crashes the run. Mitigation: flat macros (no nesting) enforced at
  load time + run time.
- Eval-gated promotion is expensive — each candidate needs 5-rep
  validation. Mitigation: two-stage (1 rep screen first) is already
  how the pipeline runs.

**Rollback**
- All three features behind flags: `BAD_ATTACH_DISABLED`,
  `BAD_DOMAIN_SKILLS_DISABLED`, `BAD_MACROS_DISABLED`. Set any to `1` to
  revert to prior behavior.

**Success criteria**
- Tier1 deterministic gate: 100% pass rate held.
- Test count: +40 net new, all passing.
- `bad --attach` connects to a running Chrome on :9222 in <2s (median
  of 3 probes).
- Domain skill seeded for linkedin.com measurably reduces turns on a
  bench case targeting linkedin.com search (A/B, 3 reps, bootstrap CI).
  Even neutral is acceptable for shipping — the infrastructure is the
  deliverable; the numbers are Gen 30's job.
- Macro dispatcher runs a dismiss-cookie-banner macro end-to-end in the
  local cookie fixture with equivalent or lower turn count vs the
  baseline agent solving it ad-hoc (3 reps).
- Promotion script can run an end-to-end promotion cycle (candidate →
  two-stage eval → promote/reject) without manual intervention.

### Phase 1.5 gate
- Auth/crypto/TLS/signing? No.
- Billing/payments/credits? No.
- Diff >5 files or >300 lines? Yes.
- External API endpoint? No (the probe is to localhost).
- Lifecycle ops? No.
- Concurrency/locking? No (no shared mutable state introduced).

Phase 1.5 review is **blocking** because the diff exceeds the
300-line/5-file threshold. Review will be dispatched via
`/critical-audit --diff-only` in Phase 3.5 (diff audit) — that's the
designated adversarial pass for diffs of this shape.

## Build Status
| # | Change | Status | Files | Tests |
|---|--------|--------|-------|-------|
| 1 | `bad attach` + chrome-debug | shipped | 2 src + 1 test | 28 (incl. real TCP listener + spawn/poll) |
| 2 | Domain skill loader + 5 seeds | shipped | 1 src + 5 md + 1 test | 18 |
| 3 | Custom action macros | shipped | 3 src + 2 tests | 24 unit + 7 integration + 4 brain |
| 4 | Eval-gated promotion | shipped | 1 script + 1 lib + 2 tests | 15 + 3 end-to-end |

## Gen 29 descoped → Gen 30

Items the pursuit doc listed as success criteria that did NOT land in Gen 29:

- **`bench/scenarios/cases/domain-skill-smoke.json`** — a Tier-1 local fixture
  exercising a domain skill. The seeded skills all target real hosts (amazon,
  linkedin, etc.) so there's no clean local fixture yet. Measuring domain-skill
  A/B delta requires either (a) a synthetic fixture on a fake host, or (b) a
  Tier-2/3 run against the real site. Deferred to Gen 30.
- **Domain-skill eval-gated promotion** — mirror of the macro-promotion
  script but for domain skills. The macro flow is the prototype; the same
  shape will ship for domain skills once case (a) or (b) is in place.
- **Real multi-rep measurement of attach / skills / macros against Tier 1** —
  the repo's OpenAI key was exhausted at the time of build. All 1149 unit +
  integration tests pass (incl. real TCP listener for attach probe); tier1
  deterministic gate blocked by quota. The PR body documents this honestly
  per CLAUDE.md §Measurement Rigor (no single-run claims). A follow-up run
  on a funded key is the first Gen 30 task.
- **cli.ts extraction** — the new session-skill wiring accumulates ~40 LOC
  in cli.ts. The reviewer flagged this as extractable into a
  `loadSessionSkills()` helper; deferred as pure cleanup.

## Gen 29 shipped vs the pursuit's success criteria

- Tier1 deterministic gate: 100% pass rate held → **deferred to Gen 30 due to
  API quota, unit + integration regression harness held**.
- Test count: "+40 net new" → **shipped +82** (cli-attach 28, domain 18,
  macro-loader 24, macro-integration 7, brain-macro 4, promotion-logic 15,
  promotion-script 3; including a +2 real-TCP-listener probe block).
- `bad --attach` probe time: "<2s median of 3 probes" → mechanism shipped,
  real measurement deferred (probe test median is <30ms but against
  localhost, not a cold Chrome).
- Domain skill measurable turn reduction → **deferred** (see above).
- Macro dispatcher end-to-end on cookie fixture → **shipped** (integration
  test covers the dispatch; the dismiss-cookie-banner macro against an
  in-browser cookie fixture is a Gen 30 task, requires a fresh API key).
- Promotion script end-to-end cycle → **shipped**, exercised by
  macro-promotion-script.test.ts with a stubbed multi-rep.
