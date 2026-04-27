/**
 * Layer 8 — Android modality adapter (stub).
 *
 * UI Automator + accessibility-tree capture. Not yet implemented.
 *
 * TODO Layer 8: UI Automator bridge, emulator management, ax-tree capture.
 */

import type { ModalityAdapter, ModalityInput, Evidence } from '../score-types.js'

export class AndroidModalityAdapter implements ModalityAdapter {
  readonly modality = 'android' as const

  async capture(_input: ModalityInput): Promise<Evidence> {
    throw new Error(
      'Android modality adapter is not yet implemented. ' +
        'See RFC-002 Layer 8 for the implementation plan. ' +
        'Ship iOS first per the RFC sequencing note. ' +
        'Use --modality html for web audits.',
    )
  }
}

export const androidAdapter = new AndroidModalityAdapter()
