# Current-source delayed controls and TestRunner report proof

Gate `beelink1-f02ec80a283dfba2e9a3f17b539f0832` passed at 2026-10-16T17:40:29Z on source `3d764f17321322689ecb71f13192ca5c03129798`, executable `e3a468dcb16edd36ee9a581cce234ba2afdbf0d3`, unchanged default base `616e54b3d0d8c09edec7b4a5ac1fc520e28b2aee`. The docs-only delta has no executable/package/lock/helper changes. Normal pinned Beelink1 admission is a distinct host input after the preserved historical Beelink2 pre-command reserve refusal. No capacity override or independent reclaim. Actual receipt records a cold checkout.

Frozen install and prepare, changeset plan, boundary check and typechecked build passed. Node v22.23.3; pnpm10.33.3. Wait0/run74/command23 seconds. See [raw gate log](gate.log.raw.txt) and [exact terminal watcher/receipt](terminal-watch.json.raw.txt). Normal gate-owned cache maintenance remained enabled. Both managed launcher and exact remote watcher settled terminal; notification succeeded.

The maintained `scripts/prove-presented-frames.mjs --clock-and-runner` executes two real delayed controls and the actual TestRunner/PlaywrightDriver seam. Warmup is disabled; the maintained beforeTurn hook intentionally aborts before inference. Zero model requests, turns and tokens. Intentional abort is not agent task success.

| Case | Native PNGs | Trusted inputs | Conditional brackets |
| --- | ---: | ---: | ---: |
| Playwright1.64 / Chromium156 delayed | 69 | 1 | 1 |
| patchright1.60.2 / Chromium148 delayed | 67 | 1 | 1 |
| Real TestRunner / PlaywrightDriver | 72 | 1 | 1 |

Independent retained-artifact inspection verifies all208 PNG SHA256 hashes,480x300 geometry, fixed ROI predicates, native metadata timestamp equality, trusted input epoch arithmetic, conditional bracket arithmetic, and raw diagnostic clock ranges. TestResult, runtime-log and native report fields are structurally equal. The two original uncut recordings fully decode106video frames; chronological6fps contact sheets and native negative/positive frame pairs were inspected. No native full-speed playback claim. No full six-control repeat, full suite, model inference, wallet or served production proof.

Original machine outputs: [report](originals/report.json.raw.txt), [TestRunner result](originals/test-runner-seam/test-result.json.raw.txt), [runtime log](originals/test-runner-seam/runtime-log.json.raw.txt), [native TestRunner report](originals/test-runner-seam/presented-frames.json.raw.txt). All218 original files are retained without byte changes. JSON snapshots use `.json.raw.txt` so normal formatting hooks preserve original bytes; [manifest](manifest.json) maps original to retained names and records SHA256/size. The raw file URIs point to the capture host's retained source folder; public files sit beside their case reports. [Independent audit](audit.json.raw.txt) includes the original file manifest and video decode counts.

**Actual presentation, calibrated latency and application2x40 remain UNKNOWN.** Exact Chromium156 metadata reports expected display reference or current monotonic time; exact Chromium148 metadata reports metadata-build wall time. The raw clock relation is diagnostic only. No offset is fitted or subtracted, timestamp precision/clock alignment/total overhead are unqualified, and these conditional metadata brackets do not establish actual presented-feedback latency. Prior original proof and producer qualification stay immutable in their existing directories.
