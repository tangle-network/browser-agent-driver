# WebVoyager Full 590-Task Benchmark — Gen 15 Results
Date: 2026-04-10
Status: evaluated
Config: hybrid (unified vision+DOM prompt), gpt-5.4, 1024×768 viewport

## Headline

**435/590 (73.7%)** agent pass rate on the full WebVoyager benchmark.
Total cost: $145.11 ($0.246/task mean). Total wall: ~90 min at concurrency 5.

## Per-Site Results

| Site | Pass | Rate | $/task | Wall | Turns | Tokens | Failure mode |
|------|------|------|--------|------|-------|--------|-------------|
| Wolfram Alpha | 46/46 | 100% | $0.17 | 40s | 7.7 | 63k | — |
| Cambridge Dict | 41/43 | 95% | $0.14 | 36s | 5.9 | 52k | 2 wrong answer |
| ESPN | 39/41 | 95% | $0.24 | 55s | 8.3 | 87k | 2 cost cap |
| BBC News | 31/34 | 91% | $0.24 | 55s | 8.0 | 86k | 3 cost cap |
| GitHub | 35/39 | 90% | $0.26 | 70s | 9.4 | 96k | 3 cost cap, 1 timeout |
| Apple | 30/34 | 88% | $0.21 | 67s | 8.2 | 79k | 3 timeout, 1 cost cap |
| Coursera | 35/40 | 88% | $0.27 | 67s | 10.5 | 98k | 5 cost cap |
| ArXiv | 36/42 | 86% | $0.19 | 47s | 7.9 | 69k | 2 cost cap, 4 wrong |
| Google Search | 32/40 | 80% | $0.16 | 49s | 7.6 | 56k | 5 wrong, 1 cost cap |
| Google Map | 29/38 | 76% | $0.21 | 92s | 9.4 | 75k | 5 timeout, 4 cost cap |
| HuggingFace | 27/36 | 75% | $0.25 | 77s | 9.8 | 91k | 4 cost cap, 3 wrong |
| Amazon | 25/38 | 66% | $0.32 | 103s | 11.5 | 119k | 8 cost cap, 3 timeout |
| Allrecipes | 10/40 | 25% | $0.22 | 147s | 8.9 | 81k | 15 timeout, 14 wrong |
| Booking | 10/40 | 25% | $0.41 | 83s | 12.8 | 152k | 29 cost cap, 1 turns |
| Google Flights | 9/39 | 23% | $0.44 | 94s | 16.5 | 162k | 23 cost cap, 4 turns |

## Failure Mode Breakdown (155 failures)

| Mode | Count | % | Root cause |
|------|-------|---|-----------|
| **Cost cap (150k tokens)** | **86** | **55%** | Image tokens accumulate too fast over many turns |
| Timeout (180s) | 31 | 20% | Complex multi-step tasks need more time |
| Wrong answer/abort | 33 | 21% | Agent completes but with incorrect result |
| Turn budget exhausted | 5 | 3% | 20 turns not enough |

## Diagnosis

### The #1 problem: cost cap kills 55% of failures

86 of 155 failures are cost_cap_exceeded. The 150k token budget runs out after ~12-15 turns with vision (each turn costs ~10k tokens for the image). This hits hardest on:
- **Booking** (29 cost caps): complex hotel search with filters, date pickers, modal overlays
- **Google Flights** (23 cost caps): multi-step flight search with trip type, dates, airports
- **Amazon** (8 cost caps): product search with filters, sorting, pagination

These sites require 15-20+ turns to complete. At ~10k tokens/turn, that's 150-200k — right at or above the cap.

### The #2 problem: Allrecipes timeouts (15 of 30 failures)

Allrecipes tasks time out at 180s because the site is slow to load and the agent needs many page navigations. Mean wall time is 147s — the highest of any site. Even successful tasks barely finish in time.

### The #3 problem: wrong answers (33 failures)

The agent completes but with incorrect information. This hits Google Search (5), Allrecipes (14), ArXiv (4). The agent finds SOMETHING but not the right thing — it lacks the ability to verify its own answer against the goal criteria.

## Architecture Hypotheses for Next Generation

### H1: DOM-first planner with vision fallback (highest ROI)
**Thesis**: Use the fast DOM planner (1 LLM call → N deterministic steps) for the first attempt. Only escalate to vision per-action loop when the planner fails or stalls.
**Expected impact**: Reduces token usage 3-5× on passing tasks (fewer LLM calls). The 86 cost-cap failures need fewer tokens per turn — DOM planner uses ~2k tokens/turn vs ~10k for vision.
**Risk**: Planner may miss things vision catches. Need to measure regression on the 12 sites where vision already works (85%+ pass rate).

### H2: Aggressive snapshot compression for vision (medium ROI)
**Thesis**: The 16k DOM budget in hybrid mode is wasteful — most of it is decorative. Cut to 4k (only interactive elements) to save ~12k tokens per turn. Over 15 turns, that's 180k saved — enough to stay under the cost cap.
**Expected impact**: Fixes cost-cap failures by reducing per-turn overhead.
**Risk**: May lose information the model needs. Test on the 86 cost-cap failures.

### H3: Multi-phase execution (medium ROI)
**Thesis**: For complex tasks (Booking, Google Flights), split into phases: (1) navigate to the right page (DOM planner, fast), (2) interact with forms (vision, accurate), (3) extract results (DOM runScript, fast). Each phase uses the optimal observation mode.
**Expected impact**: Reduces total turns by using the planner for navigation, saving vision for the hard parts.
**Risk**: Complexity — needs a meta-planner to decide phase boundaries.

### H4: Self-verification before completion (low-medium ROI)
**Thesis**: Before emitting "complete", the agent re-reads the goal and checks if its result actually matches. The 33 wrong-answer failures suggest the agent is completing prematurely.
**Expected impact**: Converts some wrong-answer failures to additional turns (which may then complete correctly or hit the cap).
**Risk**: Adds 1 turn per task (more token cost). May push borderline tasks over the cap.

### H5: Site-specific prompt hints (low ROI, high specificity)
**Thesis**: Allrecipes, Booking, and Google Flights have predictable UI patterns. Add site-specific hints to the prompt when the URL matches known domains.
**Expected impact**: Helps the agent navigate known-hard UIs faster.
**Risk**: Overfitting to the benchmark. These hints won't generalize to new sites.

## Priority Ranking

1. **H1 (DOM planner + vision fallback)** — architectural, fixes the cost problem at its root
2. **H2 (snapshot compression)** — quick win, reduces per-turn cost
3. **H4 (self-verification)** — fixes wrong-answer failures
4. **H3 (multi-phase)** — high complexity, defer
5. **H5 (site hints)** — avoid overfitting

## Competitive Position

| Agent | WebVoyager | Notes |
|-------|-----------|-------|
| Surfer-2 | 97.1% | 4-model stack, $1-5/task, closed source |
| Magnitude | 93.9% | Claude Sonnet 4, vision-first, open source |
| **bad Gen 15** | **73.7%** | gpt-5.4, hybrid vision+DOM, open source |
| browser-use | ~40-50% | Published estimate |

We're 20pp behind Magnitude. The gap is concentrated in 3 sites (Booking, Google Flights, Allrecipes = 29/120 = 24% combined). On the other 12 sites we average 85%.
