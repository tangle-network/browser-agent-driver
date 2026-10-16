# Review corrections: immutable partial and failure proof

Source `570317ff4df073e38097605723bfd6af9881c48d` contains observer corrections from `fd846d862636004e0cc6f122eea9843279028c2f` plus profile cleanup and retained diagnostics. Base `616e54b3d0d8c09edec7b4a5ac1fc520e28b2aee`. The prior47766 merge was stopped by actual review findings. Nothing has merged or released.

**Actual a31 qualification remains FAIL. Actual presentation, calibrated latency and application2x40 remain UNKNOWN.** No native-order sorting, fitted offset, acceptance waiver or unchanged capture retry. Prior f02 originals and producer-source qualification stay in their existing directories.

## Current source results

Gate `beelink1-a31b48c1d56b3c73f741fb4b8e7cb6c7` terminal1/attach1 at 2026-10-16T18:11:34Z: wait19/run97/command48 seconds. Frozen install/prepare, release-plan/boundary checks, helper syntax and old/current typechecked builds passed. Node22.23.3/pnpm10.33.3. Current source was restored clean, current compiled artifact retained with matching runtime SHA256. [Phase summary](a31-originals/phase-summary.json.raw.txt), [raw gate log](a31-gate.log.raw.txt), [exact watcher/receipt](a31-terminal-watch.json.raw.txt).

| Current flow | PNGs | Actual trusted inputs | Actual classification |
| --- | ---: | ---: | --- |
| Playwright delayed | 77 | 1 | BRACKETED metadata interval |
| patchright delayed | 75 | 1 | BRACKETED metadata interval |
| Real TestRunner/PlaywrightDriver | 79 | 1 | BRACKETED; all five integration flags PASS |
| Overlap | 94 | 2 | Both UNKNOWN with overlap reason; positive pixels retained |
| Actual persistent Chromium context | 81 | 1 | BRACKETED; own profile removed after context close |
| Navigation plus page-world forgery/synthetic click | 79 | 1 | No main-world binding globals/calls; synthetic input excluded. Native UNKNOWN; strict case FAIL |

The forgery report fails closed: frame44→45 native epoch and monotonic reference regress16.666ms while Node arrival advances4ms. Exactly one genuine input and absent main-world bindings are measured separately from native qualification. [Actual forgery report](a31-originals/current/review-page-forgery.json.raw.txt). Source uses a named isolated world, host-validated top-frame context membership, explicit schema/epoch fields and context/navigation cleanup; randomized naming alone is not the trust boundary.

The actual persistent context returned a non-null Browser owner in this Playwright pin. The specific old null-owner failure is not reproduced. Current capability-based CDP capture is exercised without mocks or manufacturing null.

[Actual TestResult](a31-originals/current/test-runner-seam/test-result.json.raw.txt), [runtime log](a31-originals/current/test-runner-seam/runtime-log.json.raw.txt) and [native report](a31-originals/current/test-runner-seam/presented-frames.json.raw.txt) agree structurally. [Separate flags](a31-originals/current/test-runner-seam/integration-checks.json.raw.txt) all PASS. Zero model requests, turns and tokens; intentional beforeTurn abort is not task success.

## Historical failures preserved

The a31 old47766 component stopped on patchright native-order regressions before review boundaries or TestRunner; old overlap/forgery counterexamples are UNPROVEN in this run. An overall old FAIL is not evidence those findings were reproduced. Exact old/current source and compiled artifact hashes are in phase-summary.

Prior0137 gate terminal1/attach1, wait47/run84/command35 seconds, stopped on old-component runner native-order failure before boundary/current execution. Native/runtime-log agree; TestResult was not retained before the old combined assertion. Its error string does not establish serialization mismatch. [Prior original files](prior-0137-originals), [specific diagnostic](0137-failure-diagnostic.json.raw.txt), [raw log](0137-gate.log.raw.txt), [receipt](0137-terminal-watch.json.raw.txt).

## Retention

All650 a31 and246 prior0137 original files retain exact bytes. JSON snapshots append `.raw.txt` so normal hooks preserve bytes; [manifest](manifest.json) maps original/retained paths and records SHA256/size. [Independent a31 audit](a31-audit.json.raw.txt) verifies624 native PNG hashes,480x300 geometry, ROI predicates, native metadata, input epoch arithmetic and classifications. Five current original WebM fully decode; chronological5fps contacts were inspected locally. No native full-speed playback claim. Raw URI fields refer to retained capture-host paths; public media sits beside each case report.

Current observer source SHA256 `e4424f1deffb08ed55eea4d0274d575c85ad35fca6b32c16b527e2fc7b8db668`; [actual compiled artifact](current-capture-artifact.js.raw.txt) SHA256 `79b86193dffab2a927cc8661072c081a07a714332da68052d7649837e409a4aa`, read back from the owner cache and matched before retention.

Normal identity/hooks/host guards remain enabled. Prior own HTTPS client stuck in peer-closed CLOSE-WAIT was terminated only after exact PID/start-ID verification; parent ended and remote head reconciled before a new write. The bounded managed diagnostic author wrapper recorded [commit0/push0](diagnostic-author-receipt.json.raw.txt). Earlier author prewatch gap exact start unavailable; conservative bound1.09–3.61min, not0. Current runtime watchers terminal with exact remote receipts. No unit/mock/full-suite, model/account/spend, wallet or production mutation for this proof.
