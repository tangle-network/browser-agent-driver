import type { Page, CDPSession } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactSink } from '../artifacts/types.js';
import type { PresentedFrameOptions } from '../types/config.js';

interface Input { sequence: number; epochMs: number; timeOrigin: number; eventTimestamp: number; receivedEpochMs: number; trusted: boolean; event: string; selector: string; }
interface Frame { sequence: number; nativeEpochSeconds: number | null; epochMs: number | null; receivedEpochMs: number; metadata: Record<string, unknown>; width: number; height: number; feedback: boolean; sha256: string; uri: string; decodeMs: number; }
interface ClockSample { phase: 'start' | 'stop'; nodeBeforeEpochMs: number; nodeAfterEpochMs: number; nodeElapsedMs: number; renderer: { dateNowMs: number; timeOrigin: number; performanceNowMs: number; epochMs: number } | null; rendererEpochMinusNodeRangeMs?: [number, number]; error?: string; }
export interface PresentedFrameReport {
  schemaVersion: 1;
  status: 'NATIVE_FRAMES_OBSERVED' | 'UNKNOWN';
  calibration: 'UNCHECKED';
  provenance: Record<string, unknown>;
  clockRelation: { status: 'DIAGNOSTIC_ONLY'; samples: ClockSample[]; metadataEpochMinusArrivalRangeMs: [number, number] | null; actualPresentation: 'UNKNOWN' };
  config: PresentedFrameOptions;
  inputs: Input[];
  frames: Frame[];
  attempts: Array<{ input: number; status: 'BRACKETED' | 'NO_FEEDBACK_OBSERVED' | 'UNKNOWN'; reason?: string; lastNegative?: number; firstPositive?: number; intervalMs?: [number, number]; captureGapMs?: number }>;
  cadence: { intervalsMs: number[]; maxGapMs: number | null };
  errors: string[];
  limits: string[];
}
export interface PresentedFrameCapture { stop(): Promise<PresentedFrameReport>; }

/** Existing screencast observation adapter. Metadata is not actual presentation acknowledgment. */
function timestampProducer(browser: { revision?: string }): Record<string, unknown> {
  const revision = String(browser.revision ?? '').replace(/^@/, '');
  const source = `https://chromium.googlesource.com/chromium/src/+/${revision}/content/browser/devtools/protocol/page_handler.cc`;
  if (revision === 'f842f52ef39fd97b449eb27cff414bf05a98ddce') return { meaning: 'EXPECTED_DISPLAY_REFERENCE_OR_CURRENT_MONOTONIC_TIME', source: source + '#153', conversion: 'Time::Now() - (TimeTicks::Now() - reference_time)', fallback: 'reference_time absent -> TimeTicks::Now(); per-frame fallback not disclosed', actualPresentation: 'UNKNOWN' };
  if (revision === '8625e066febc721e015ea99842da12901eb7ed73') return { meaning: 'METADATA_BUILD_WALL_TIME', source: source + '#155', conversion: 'Time::Now() at metadata construction', actualPresentation: 'UNKNOWN' };
  return { meaning: 'UNKNOWN', source, actualPresentation: 'UNKNOWN', reason: 'Exact producer revision has not been source-audited; presence of metadata.timestamp does not establish its semantics.' };
}
export async function startPresentedFrameCapture(page: Page, config: PresentedFrameOptions, sink: ArtifactSink | undefined, testId: string): Promise<PresentedFrameCapture> {
  const report: PresentedFrameReport = { schemaVersion: 1, status: 'UNKNOWN', calibration: 'UNCHECKED', config, provenance: {}, clockRelation: { status: 'DIAGNOSTIC_ONLY', samples: [], metadataEpochMinusArrivalRangeMs: null, actualPresentation: 'UNKNOWN' }, inputs: [], frames: [], attempts: [], cadence: { intervalsMs: [], maxGapMs: null }, errors: [], limits: [
    'Chromium screencast pixels/native metadata; exact producer may report expected display reference or metadata-build wall time, not acknowledged actual presentation.',
    'Input uses trusted top-frame event timeOrigin + timeStamp; Node arrival is diagnostic only.',
    'Conditional metadata/input clock brackets are not actual presented latency; producer endpoint accuracy, timestamp quantization and clock alignment remain UNKNOWN.',
    'No presented-latency conformance or2x40 calibration follows from capture alone. Quantization/overhead and delayed/never controls require actual qualification.',
    'PNG predicate is fixed before capture; unrelated paint, DOM/rAF and action duration cannot satisfy feedback.',
  ] };
  const pending = new Set<Promise<void>>();
  let session: CDPSession | undefined, scriptId: string | undefined, stopped: Promise<PresentedFrameReport> | undefined;
  let accepting = true, frameSequence = 0;
  let baselineSaved!: () => void;
  const baseline = new Promise<void>(resolve => { baselineSaved = resolve; });
  const binding = `__bad_presented_${randomUUID().replaceAll('-', '')}`;
  const track = (work: Promise<void>) => { pending.add(work); work.finally(() => pending.delete(work)).catch(() => {}); };
  const sampleClock = async (phase: ClockSample['phase']) => {
    if (!session) return;
    const nodeBeforeEpochMs = Date.now(), started = performance.now();
    let renderer: ClockSample['renderer'] = null, error: string | undefined;
    try {
      const response = await session.send('Runtime.evaluate', { expression: 'JSON.stringify({dateNowMs:Date.now(),timeOrigin:performance.timeOrigin,performanceNowMs:performance.now(),epochMs:performance.timeOrigin+performance.now()})', returnByValue: true });
      if (response.exceptionDetails || typeof response.result.value !== 'string') throw new Error('Renderer clock response unavailable');
      const value = JSON.parse(response.result.value);
      if (![value.dateNowMs, value.timeOrigin, value.performanceNowMs, value.epochMs].every(Number.isFinite)) throw new Error('Renderer clock fields invalid');
      renderer = value;
    } catch (e) { error = String(e); }
    const nodeAfterEpochMs = Date.now();
    report.clockRelation.samples.push({ phase, nodeBeforeEpochMs, nodeAfterEpochMs, nodeElapsedMs: performance.now() - started, renderer, ...(renderer ? { rendererEpochMinusNodeRangeMs: [renderer.epochMs - nodeAfterEpochMs, renderer.epochMs - nodeBeforeEpochMs] as [number, number] } : {}), ...(error ? { error } : {}) });
  };
  const stop = (): Promise<PresentedFrameReport> => stopped ??= (async () => {
    if (session) {
      await sampleClock('stop');
      try { await session.send('Page.stopScreencast'); } catch (e) { report.errors.push(`stop: ${String(e)}`); }
      try {
        await session.send('Runtime.evaluate', { expression: `globalThis[${JSON.stringify(binding + '_abort')}]?.abort()` });
        if (scriptId) await session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
        await session.send('Runtime.removeBinding', { name: binding });
      } catch (e) { report.errors.push(`input cleanup: ${String(e)}`); }
      accepting = false;
      await session.detach().catch(e => report.errors.push(`detach: ${String(e)}`));
    }
    await Promise.allSettled([...pending]);
    report.frames.sort((a, b) => a.sequence - b.sequence);
    const clockDeltas = report.frames.filter(f => f.epochMs !== null).map(f => f.epochMs! - f.receivedEpochMs);
    report.clockRelation.metadataEpochMinusArrivalRangeMs = clockDeltas.length ? [Math.min(...clockDeltas), Math.max(...clockDeltas)] : null;
    const valid = report.frames.every(f => f.epochMs !== null && f.uri);
    const ordered = report.frames.every((f, i, frames) => !i || (f.epochMs !== null && frames[i - 1].epochMs !== null && f.epochMs >= frames[i - 1].epochMs!));
    if (!ordered) report.errors.push('Native frame epochs are out of capture order; no sorting away failed provenance.');
    if (valid && ordered && report.frames.length && !report.errors.length) report.status = 'NATIVE_FRAMES_OBSERVED';
    for (let i = 1; i < report.frames.length; i++) {
      const a = report.frames[i - 1].epochMs, b = report.frames[i].epochMs;
      if (a !== null && b !== null) report.cadence.intervalsMs.push(b - a);
    }
    report.cadence.maxGapMs = report.cadence.intervalsMs.length ? Math.max(...report.cadence.intervalsMs) : null;
    for (const input of report.inputs) {
      const attempt: PresentedFrameReport['attempts'][number] = { input: input.sequence, status: 'UNKNOWN' };
      report.attempts.push(attempt);
      if (report.status === 'UNKNOWN' || !input.trusted) { attempt.reason = 'Missing native provenance, retained pixels, or trusted input.'; continue; }
      const end = input.epochMs + config.observationWindowMs;
      if (report.inputs.some(other => other.sequence !== input.sequence && other.epochMs >= input.epochMs && other.epochMs <= end)) { attempt.reason = 'Overlapping input windows; feedback attribution is ambiguous.'; continue; }
      const before = report.frames.filter(f => f.epochMs! <= input.epochMs).at(-1);
      if (!before || before.feedback) { attempt.reason = 'No negative feedback frame at input boundary; pre-existing feedback is not acknowledgment.'; continue; }
      const frames = report.frames.filter(f => f.epochMs! >= input.epochMs && f.epochMs! <= end);
      const firstPositive = frames.find(f => f.feedback);
      const negative = firstPositive ? report.frames.filter(f => f.sequence < firstPositive.sequence && !f.feedback).at(-1) : frames.at(-1);
      if (firstPositive && negative) {
        attempt.status = 'BRACKETED'; attempt.lastNegative = negative.sequence; attempt.firstPositive = firstPositive.sequence;
        attempt.intervalMs = [Math.max(0, negative.epochMs! - input.epochMs), firstPositive.epochMs! - input.epochMs];
        attempt.captureGapMs = firstPositive.epochMs! - negative.epochMs!;
      } else if (report.frames.some(f => f.epochMs! >= end) && !frames.some(f => f.feedback)) {
        attempt.status = 'NO_FEEDBACK_OBSERVED'; attempt.reason = 'No predicate-positive frame observed in declared window; capture gaps remain explicit, not proof of absence between frames.';
      } else attempt.reason = 'No positive feedback bracket or frame coverage through declared window.';
    }
    if (sink) await sink.put({ type: 'report-json', testId, name: 'presented-frames.json', data: Buffer.from(JSON.stringify(report, null, 2)), contentType: 'application/json' });
    return report;
  })();
  try {
    const { roi, rgba, channelTolerance, minimumFraction } = config.feedback;
    if (![roi.x, roi.y, roi.width, roi.height, config.observationWindowMs, config.maxFrames, channelTolerance, minimumFraction, ...rgba].every(Number.isFinite)
      || roi.x < 0 || roi.y < 0 || roi.width <= 0 || roi.height <= 0 || config.observationWindowMs <= 0 || !Number.isInteger(config.maxFrames) || config.maxFrames < 2
      || channelTolerance < 0 || channelTolerance > 255 || minimumFraction <= 0 || minimumFraction > 1 || rgba.length !== 4 || rgba.some(c => c < 0 || c > 255)) throw new Error('Invalid explicit input/pixel/window/frame bounds.');
    if (!sink) throw new Error('ArtifactSink required: raw pixel retention is part of measurement.');
    if (page.context().browser()?.browserType().name() !== 'chromium') throw new Error('Native frame metadata adapter supports Chromium only.');
    const { PNG } = await import('pngjs');
    session = await page.context().newCDPSession(page);
    const browser = await session.send('Browser.getVersion');
    report.provenance = { transport: 'CDP Page.screencastFrame.metadata.timestamp (raw epoch seconds), no client Date.now fallback', timestampProducer: timestampProducer(browser), browser, viewport: page.viewportSize(), declaredBackend: config.backend ?? 'unknown', inputClock: 'performance.timeOrigin + trusted event.timeStamp', topFrameOnly: true, format: 'png', receivedClock: 'Node Date.now diagnostic only', timestampQuantizationMs: null, clockAlignmentUncertaintyMs: null };
    session.on('Runtime.bindingCalled', event => {
      if (!accepting || event.name !== binding) return;
      try { const value = JSON.parse(event.payload); report.inputs.push({ ...value, sequence: report.inputs.length + 1, receivedEpochMs: Date.now() }); }
      catch (e) { report.errors.push(`input payload: ${String(e)}`); }
    });
    session.on('Page.screencastFrame', event => {
      if (!accepting) return;
      const sequence = ++frameSequence;
      const ack = session!.send('Page.screencastFrameAck', { sessionId: event.sessionId }).then(() => {}).catch(e => { report.errors.push(`ack: ${String(e)}`); });
      track(ack);
      if (sequence > config.maxFrames) { if (sequence === config.maxFrames + 1) report.errors.push('Frame retention bound exceeded; capture is unqualified.'); return; }
      const receivedEpochMs = Date.now(), data = Buffer.from(event.data, 'base64');
      const timestamp = event.metadata.timestamp;
      const nativeEpochSeconds = typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
      if (nativeEpochSeconds === null) report.errors.push(`frame${sequence}: native metadata timestamp absent; no fallback permitted.`);
      track((async () => {
        const started = performance.now();
        const png = PNG.sync.read(data); let matched = 0;
        const viewport = page.viewportSize();
        if (!viewport || png.width !== viewport.width || png.height !== viewport.height) throw new Error('Raw PNG and declared viewport differ; ROI scale provenance unresolved.');
        if (roi.x + roi.width > png.width || roi.y + roi.height > png.height || ![roi.x,roi.y,roi.width,roi.height].every(Number.isInteger)) throw new Error('Pixel ROI must be integer and inside raw viewport.');
        for (let y = roi.y; y < roi.y + roi.height; y++) for (let x = roi.x; x < roi.x + roi.width; x++) {
          const offset = (y * png.width + x) * 4;
          if (rgba.every((value, channel) => Math.abs(png.data[offset + channel] - value) <= channelTolerance)) matched++;
        }
        const feedback = matched / (roi.width * roi.height) >= minimumFraction;
        const decodeMs = performance.now() - started;
        const uri = await sink.put({ type: 'screenshot', testId, name: `presented-frame-${String(sequence).padStart(5,'0')}.png`, data, contentType: 'image/png', metadata: { provenance: 'native-CDP-frame', nativeEpochSeconds: String(nativeEpochSeconds), feedback: String(feedback) } });
        baselineSaved();
        report.frames.push({ sequence, nativeEpochSeconds, epochMs: nativeEpochSeconds === null ? null : nativeEpochSeconds * 1000, receivedEpochMs, metadata: { ...event.metadata }, width: png.width, height: png.height, feedback, sha256: createHash('sha256').update(data).digest('hex'), uri, decodeMs });
      })().catch(e => { report.errors.push(`frame${sequence}: ${String(e)}`); }));
    });
    await session.send('Runtime.enable');
    await sampleClock('start');
    await session.send('Runtime.addBinding', { name: binding });
    const source = `(${function install(name: string, selector: string, eventType: string) {
      if (window.top !== window) return;
      const globals = globalThis as unknown as Record<string, unknown>;
      const abort = new AbortController(); globals[name + '_abort'] = abort;
      document.addEventListener(eventType, event => {
        if (!event.isTrusted || !(event.target instanceof Element) || !event.target.closest(selector)) return;
        (globals[name] as (payload: string) => void)(JSON.stringify({ epochMs: performance.timeOrigin + event.timeStamp, timeOrigin: performance.timeOrigin, eventTimestamp: event.timeStamp, trusted: event.isTrusted, event: event.type, selector }));
      }, { capture: true, signal: abort.signal });
    }.toString()})(${JSON.stringify(binding)},${JSON.stringify(config.input.selector)},${JSON.stringify(config.input.event)})`;
    scriptId = (await session.send('Page.addScriptToEvaluateOnNewDocument', { source })).identifier;
    await session.send('Runtime.evaluate', { expression: source });
    await session.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([baseline, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('No retained raw baseline frame within declared observation window.')), config.observationWindowMs); })]); }
    finally { clearTimeout(timer); }
  } catch (e) { report.errors.push(String(e)); }
  return { stop };
}
