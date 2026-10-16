# Presented-frame observability

`observability.presentedFrames` opts existing TestRunner observability into native
Chromium frame observation. Defaults are unchanged. Existing `TestResult` / JSON
reports and `runtime-log.json` include `presentedFrames`; raw PNGs and
`presented-frames.json` use the existing ArtifactSink. The exported
`startPresentedFrameCapture(page, options, sink, testId)` is the same owner for
maintained consumer browser scripts, not a separate CLI or service.

Declare input selector/event, frozen feedback pixel ROI/RGBA/tolerance/fraction,
observation window and frame retention bound. Coordinates must match actual raw
viewport pixels; mismatched scale is UNKNOWN. Use an isolated context and reset
feedback before each attempt. Overlapping inputs, pre-existing feedback, missing
baseline/frame epochs, out-of-order frames and retention loss invalidate brackets.
The capture starts only after a raw baseline frame is retained; stop it before
closing the page. It owns a private Chromium CDP session and cleans it up.

Native provenance comes directly from `Page.screencastFrame.metadata.timestamp`
(epoch seconds) with raw metadata/browser revision/protocol retained. Missing
metadata never falls back to Date.now. This works independently of whether a
Playwright-compatible public screencast callback exposes provenance. Unsupported
backends remain UNKNOWN. Input uses trusted top-frame event timeOrigin+timeStamp;
Node arrivals and PNG decode cost are diagnostic, not substitute clocks.

Each fixed-predicate attempt retains last-negative / first-positive frame IDs,
interval bounds, capture gap and all observed cadence intervals. A no-feedback
observation needs coverage through its declared window and is not proof of absence
between captured frames. Raw PNGs preserve exact pixels and hashes. Recorder frames retain screencast pixels and revision-specific protocol metadata;
these do not acknowledge actual presentation.
Producer quantization and input/frame clock accuracy remain explicit unknowns;
no precise point estimate or latency conformance is inferred.

The real integration fixture in `scripts/prove-presented-frames.mjs` runs actual
Playwright and patchright Chromium, with immediate/delayed/never feedback and an
unrelated cadence heartbeat outside the ROI. Its structured `report.json` checks
native/input/pixel provenance and delayed-feedback discrimination. This is bounded
fixture discrimination, not a2x40 live application claim. Consumer-specific predicates,
conditions, capture overhead/quantization/clock uncertainty and all unresolved
attempts still need qualification. An independent second reference is optional
stricter analysis. Never reinterpret rAF, DOM mutation or execute-duration as a
presented-feedback timestamp. Read JSON fields; do not parse human stdout.

## Exact producer endpoint and clock diagnostics

Native protocol metadata is not necessarily an actual presented-frame timestamp. The checked Chromium156 revision [`f842f52`](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/content/browser/devtools/protocol/page_handler.cc#153) uses an **expected display** reference, falling back to current monotonic time when absent, and converts that to epoch. Chromium148 [`8625e06`](https://chromium.googlesource.com/chromium/src/+/8625e066febc721e015ea99842da12901eb7ed73/content/browser/devtools/protocol/page_handler.cc#155) stamps metadata-build wall time. These meanings are recorded for exact audited browser revisions; other revisions remain UNKNOWN. Neither endpoint proves actual presentation, regardless of successful pixel discrimination. Previously retained raw reports remain immutable; their generic frame-swap description does not qualify presentation.

`clockRelation` retains two bounded Runtime clock roundtrips, raw renderer Date/performance epoch fields, Node send/receive epochs and elapsed duration, plus metadata-minus-arrival range. Renderer-minus-Node ranges are causal diagnostic brackets conditional on stable clocks, not a fitted correction or accuracy guarantee. No value is subtracted from frame/input epochs. Actual presentation, clock quantization and overall measurement overhead remain UNKNOWN.

The existing proof script accepts `--clock-and-runner` for two real delayed controls plus the existing TestRunner/PlaywrightDriver report seam. It disables model warmup and intentionally stops using the maintained beforeTurn hook, verifying zero turns/tokens and equal TestResult, runtime-log and native report fields. This proves serialization/lifecycle integration, not agent task success.

Next endpoint owner check is Chromium's existing [Tracing/FramePresented instrumentation](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/docs/speed/debug-janks.md): establish actual presentation feedback provenance, clock and a join from presentation frame tokens to retained feedback pixels on the actual headless runtime before extending this observer. A trace event name alone is not that contract. No new service or parallel measuring command is required.
