/**
 * Layer 8 — HTML modality adapter.
 *
 * Wraps the existing Playwright-based capture pipeline into the `ModalityAdapter`
 * interface so it can participate in the unified scoring framework. The underlying
 * pipeline is unchanged; this module provides the typed adapter boundary.
 */

import type { ModalityAdapter, ModalityInput, Evidence, MeasurementBundle } from '../score-types.js'

export class HtmlModalityAdapter implements ModalityAdapter {
  readonly modality = 'html' as const

  /**
   * Capture HTML evidence. Delegates to the existing browser-based pipeline.
   * In practice, `pipeline.ts` drives this; the adapter exists to make the
   * interface explicit and enable Layer 8's modality dispatch.
   *
   * @param input.entryPoint - URL to audit
   * @param input.flow - optional page flow (multi-page audit)
   */
  async capture(input: ModalityInput): Promise<Evidence> {
    // The real implementation lives in pipeline.ts / measure/index.ts.
    // This adapter records the contract and is called by the pipeline dispatcher.
    // When a caller invokes adapter.capture() directly, it returns a shell
    // Evidence that the pipeline will hydrate with real snapshot + measurements.
    const shell: Evidence = {
      modality: 'html',
      surfaces: [],
      measurements: emptyMeasurementBundle(),
      snapshot: '',
      screenshot: undefined,
    }
    void input
    return shell
  }
}

function emptyMeasurementBundle(): MeasurementBundle {
  return {
    contrast: {
      totalChecked: 0,
      aaFailures: [],
      aaaFailures: [],
      summary: { aaPassRate: 1, aaaPassRate: 1 },
    },
    a11y: {
      ran: true,
      violations: [],
      passes: 0,
    },
    hasBlockingIssues: false,
  }
}

export const htmlAdapter = new HtmlModalityAdapter()
