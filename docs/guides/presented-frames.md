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
between captured frames. Raw PNGs preserve exact pixels and hashes. Recorder
frames are browser frame-swap observations, not hardware-to-photon timing.
Producer quantization and input/frame clock accuracy remain explicit unknowns;
no precise point estimate or latency conformance is inferred.

The real integration fixture in `scripts/prove-presented-frames.mjs` runs actual
Playwright and patchright Chromium, with immediate/delayed/never feedback and an
unrelated cadence heartbeat outside the ROI. Its structured `report.json` checks
native/input/pixel provenance and delayed-feedback discrimination. This is bounded
fixture calibration, not a2x40 live application claim. Consumer-specific predicates,
conditions, capture overhead/quantization/clock uncertainty and all unresolved
attempts still need qualification. An independent second reference is optional
stricter analysis. Never reinterpret rAF, DOM mutation or execute-duration as a
presented-feedback timestamp. Read JSON fields; do not parse human stdout.
