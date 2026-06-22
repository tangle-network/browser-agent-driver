import { bootstrapDiff95 } from './stats.mjs';

/**
 * Build the control→treatment delta block for an A/B summary. Pass-rate deltas
 * carry a bootstrap 95% CI (binary outcomes); decide-phase metrics are
 * continuous, so they are reported as plain mean differences. Returns null when
 * the arms aren't a clean two-way comparison.
 *
 * Pure (no IO) so it is unit-testable — see tests/ab-delta.test.ts.
 */
export function buildDelta(armIds, byArm, runs) {
  // Support both off/on and first/second arm naming
  let controlId = 'off';
  let treatmentId = 'on';
  if (!byArm.off || !byArm.on) {
    if (armIds.length === 2) {
      controlId = armIds[0];
      treatmentId = armIds[1];
    } else {
      return null;
    }
  }
  const onOutcomes = runs.filter((run) => run.arm === treatmentId).flatMap((run) => run.testOutcomes);
  const offOutcomes = runs.filter((run) => run.arm === controlId).flatMap((run) => run.testOutcomes);
  const onCleanOutcomes = runs.filter((run) => run.arm === treatmentId).flatMap((run) => run.cleanOutcomes);
  const offCleanOutcomes = runs.filter((run) => run.arm === controlId).flatMap((run) => run.cleanOutcomes);
  return {
    control: controlId,
    treatment: treatmentId,
    raw: {
      onMinusOff: byArm[treatmentId].rawPassRate.mean - byArm[controlId].rawPassRate.mean,
      bootstrap95: bootstrapDiff95(onOutcomes, offOutcomes, 2000, 11),
    },
    clean: {
      onMinusOff: byArm[treatmentId].cleanPassRate.mean - byArm[controlId].cleanPassRate.mean,
      bootstrap95: bootstrapDiff95(onCleanOutcomes, offCleanOutcomes, 2000, 17),
    },
    // Decide-phase efficiency delta (treatment − control). Continuous metrics,
    // so reported as mean differences (the pass-rate bootstrap is binary-only).
    decide: {
      llmCallsOnMinusOff: byArm[treatmentId].avgDecideLlmCalls - byArm[controlId].avgDecideLlmCalls,
      skipsOnMinusOff: byArm[treatmentId].avgDecideSkips - byArm[controlId].avgDecideSkips,
      msOnMinusOff: byArm[treatmentId].avgDecideMs - byArm[controlId].avgDecideMs,
    },
  };
}
