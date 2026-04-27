/**
 * Layer 8 — Modality adapter type contract.
 *
 * Re-exports the stable shapes from score-types.ts. Each adapter (HTML, iOS,
 * Android) implements the ModalityAdapter interface and produces an Evidence
 * record that flows into the shared Layers 1–7 scoring pipeline unchanged.
 */

export type {
  Modality,
  ModalityAdapter,
  ModalityInput,
  Evidence,
  SurfaceRecord,
  SurfaceMeasurements,
} from '../score-types.js'
