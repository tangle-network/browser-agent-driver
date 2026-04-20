# Pursuit: CLI unification + rich cursor overlay labels

Generation: 31
Status: designing
Branch: gen31-cli-ux-polish

## Metric → product-value claim

**Metric**: overlay-label-information-density (bytes of actionable context per frame).
**Claim**: every demo video is a CRO/AML analyst's first impression of the agent's reasoning. Terse `"click"`/`"type"` labels leave 90% of the agent's intent on the floor — viewers have to infer from the cursor position what's happening. Rich labels (`click · Search`, `type · "IVANOV ALEKSANDR"`) turn the cursor into a readable narrative. **If this lands, the same 10-min demo video becomes self-explanatory without voiceover.**

**Metric**: CLI onboarding friction (keystrokes from `bad --help` to first successful `attach`).
**Claim**: `bad run --attach --goal "..."` is three concepts stacked under `run`. Graduating to `bad attach --goal "..."` matches how operators think about modes (attach vs headless vs wallet). **If operators stop typing `--attach` as a flag, we've validated the mental model.**

## System Audit

### What exists and works
- `bad run` — main command with rich flag surface (--attach, --resume-run, --fork-run, --cases, --cases-json, --mode, --model, --provider, --base-url, --api-key, --show-cursor)
- `bad runs` — list recent runs
- `bad view <run-dir>` — static HTTP server + self-contained viewer HTML (good!)
- `bad chrome-debug` — launch system Chrome on :9222 for attach
- `bad showcase` — exists, purpose TBD from audit
- `bad design-audit` — design audit (seems orphaned but shipped)
- `bad auth save/login/check` — storage-state management
- Cursor overlay (src/drivers/cursor-overlay.ts) — DOM widget injected into every page, exposes `window.__bad_overlay.moveTo(x, y, label)`
- Framenavigated re-injection (gen 30) — overlay survives goto-from-blank-page
- `BAD_DEBUG_CURSOR=1` — console-log forward for overlay diagnostics

### What exists but isn't integrated
- Rich action context (action.text, action.key, target element's accessible name) is available at the call site in `src/drivers/playwright.ts` but THROWN AWAY — all three call sites (click @642, type @680, press @706) pass the hardcoded string `'click' / 'type' / 'press'` to `animateCursorToSelector`.
- `action.expectedEffect` and `action.reasoning` on the decide-completed event are agent-generated narrative; neither reaches the overlay.
- Snapshot stores resolved locators with accessible names. Not currently surfaced to overlay label builder.

### What was tested and failed
- Not applicable — this is greenfield polish, no prior failed attempt documented.

### What doesn't exist yet
- Per-action label formatter
- `bad attach` as top-level command (currently only `bad run --attach`)
- `bad preview <goal>` dry-run planner — deferred to Gen 32 (needs more design; the agent doesn't have a planner separate from the runtime loop)

### Measurement gaps
- No automated test that the overlay label for a given action contains the expected substring. This generation adds one (playwright-driver integration test asserting label content).

## Diagnosis

The cursor-label terseness is **architectural**: the driver was written for correctness (did the click succeed?) without thinking of the overlay as a communication channel. The label string arg is the symptom — the deeper issue is that `animateCursorToSelector(selector, verb)` takes a verb when it should take a structured label description. Fix is one-file.

The CLI surface is coherent but suffers from **command-as-flag creep** — attach is a mode, not a flag. Promoting it matches how every other agent CLI in the market organizes surface area (browser-use has `browser-use attach`, browserbase has `sessions attach`). Fix is surgical in cli.ts.

## Generation 31 Design

### Thesis
The cursor is a communication channel. The CLI is a mental model. Gen 31 treats both as product surfaces, not afterthoughts.

### Moonshot considered (rejected)
**10x redesign**: replace the cursor overlay with a real-time picture-in-picture panel showing the agent's full reasoning stream synchronized to the video timeline. Rejected because (a) requires a re-architecture of the recording pipeline — reasoning text is in events.jsonl, video is a separate .webm, synchronizing them post-hoc is non-trivial; (b) the cursor label is already a high-bandwidth channel we're underusing — fix that first, measure the demo-polish delta, then decide if PiP is worth the architecture change. **Adopted: enrich the existing channel. Revisit PiP in Gen 33 if Gen 31 hits a ceiling.**

### Codebase conventions matched
- **Label helper location**: colocated with `animateCursorToSelector` in `src/drivers/playwright.ts` (pattern: helpers that shape data for the overlay live with the overlay integration, not in a separate utils file — see `humanMouseMove`, `gaussianOffset` at same file).
- **CLI command dispatch**: `if (command === 'X') { ... ; return }` early-return pattern matches design-audit @259, view @236, showcase @344, chrome-debug @364.
- **Help text**: `printStyledHelp` at top of cli.ts — must add `attach` to the USAGE block.
- **Tests**: new tests go in `tests/` with `.test.ts` suffix (vitest). Integration tests matching playwright behavior use `.integration.test.ts` suffix.

### Changes (ordered by impact)

#### Architectural (must ship together)
1. **Cursor label formatter** (`src/drivers/playwright.ts`)
   - New helper: `formatOverlayLabel(action, targetName?)` returning a per-action-type string.
   - Update `animateCursorToSelector(selector, labelOrVerb)` — accepts either a verb (back-compat) or a pre-formatted label; callers now pass the pre-formatted label.
   - All three call sites (click/type/press) extract target accessible name via snapshot lookup (cheap — already resolved) and pass `formatOverlayLabel(action, name)`.

2. **`bad attach` top-level command** (`src/cli.ts`)
   - New `if (command === 'attach') { ... }` branch that sets the `--attach` boolean and delegates to the existing run pipeline.
   - Accepts all the same flags as `run` that are compatible with attach (--goal, --url, --attach-port, --model, --provider, --api-key, --show-cursor, --no-memory, --mode, --max-turns, --timeout).
   - Incompatible flags (--wallet, --extension, --headless, --no-headless) warned + rejected.
   - Help block updated.

#### Measurement
3. **Label content test** (`tests/playwright-driver-cursor-label.test.ts`)
   - Unit test `formatOverlayLabel` with canonical actions:
     - `{action:'click', selector:'@b1', text:undefined}` + name `'Search'` → `'click · Search'`
     - `{action:'type', selector:'@t1', text:'IVANOV ALEKSANDR'}` → `'type · "IVANOV ALEKSANDR"'`
     - `{action:'type', ..., text:'a very long string that must be truncated for overlay'}` → truncated with ellipsis
     - `{action:'press', selector:'@t1', key:'Enter'}` → `'press · Enter'`
     - `{action:'navigate', url:'https://sanctionssearch.ofac.treas.gov/'}` → `'nav · sanctionssearch.ofac.treas.gov'`

4. **`bad attach` dispatch test** (`tests/cli-attach-command.test.ts`)
   - Test that `bad attach --goal X --url Y` invokes the same runner path as `bad run --attach --goal X --url Y`.
   - Test that incompatible flags (--wallet, --extension) are rejected.
   - Test that missing --goal triggers usage error.

#### Infrastructure
None — this is a one-file-per-concern change.

### Alternatives

- **Inject `action.reasoning` into the overlay label** — rejected because reasoning is multi-sentence, often 200+ chars, would overflow the label widget. Label should be glanceable. (Future Gen 32: attach reasoning as tooltip on hover.)
- **Promote all modes to top-level (`bad headless`, `bad wallet`)** — rejected: only `attach` has a distinct mental model worth graduating. `--wallet` is an additive flag to any mode, not a mode itself.
- **Use a third-party CLI framework (commander, cac)** — rejected: the existing dispatch is ~50 lines per command, a framework adds dependency weight without reducing complexity for this surface.

### Risk + Success criteria

**Risks**:
- Snapshot `accessibleName` lookup could throw on pages with transient DOM (A-B-A-B menu oscillation). Mitigation: catch + fallback to verb-only label. Already the pattern.
- `bad attach` could diverge from `bad run --attach` flag semantics over time. Mitigation: attach dispatches into the same code path; no forked implementation.

**Success criteria**:
- `tests/playwright-driver-cursor-label.test.ts` — PASS (5/5 label format assertions)
- `tests/cli-attach-command.test.ts` — PASS (3/3 dispatch assertions)
- Full `pnpm test` — 1101+ tests still pass
- Manual: re-run the OFAC demo with gen31, confirm video shows rich labels (`click · Search`, `type · "PUTIN VLADIMIR"`) instead of bare verbs.
- Rollback: single revert of the gen31 commit restores prior behavior — no schema changes, no migrations, no external dependencies added.

## Phase 1.5 gate

- Auth/crypto/TLS: **no**
- Billing: **no**
- Diff >5 files or >300 lines: **yes** (est 4-6 files, ~400 lines incl tests) — FLAG for self-review but not external block
- External API: **no**
- Lifecycle ops: **no**
- Concurrency / shared state: **no**

→ Single "yes" on diff size. Self-review after build via `/critical-audit --diff-only`. Not a blocker.

Phase 1.5 gate: passed with self-review deferred to Phase 3.5.
