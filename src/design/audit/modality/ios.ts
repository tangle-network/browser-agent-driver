/**
 * Layer 8 — iOS modality adapter (stub).
 *
 * XCUITest + accessibility-tree capture. Not yet implemented.
 * Ship the interface so CLI dispatch and type-checking work; native
 * bridging will be added once the HTML adapter's abstraction is validated.
 *
 * TODO Layer 8: XCUITest bridge, simulator management, ax-tree capture.
 */

import type { ModalityAdapter, ModalityInput, Evidence } from '../v2/types.js'

export class IosModalityAdapter implements ModalityAdapter {
  readonly modality = 'ios' as const

  async capture(_input: ModalityInput): Promise<Evidence> {
    throw new Error(
      'iOS modality adapter is not yet implemented. ' +
        'See RFC-002 Layer 8 for the implementation plan. ' +
        'Use --modality html for web audits.',
    )
  }
}

export const iosAdapter = new IosModalityAdapter()
