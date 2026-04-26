import type { Modality, ModalityAdapter } from './types.js'
import { htmlAdapter } from './html.js'
import { iosAdapter } from './ios.js'
import { androidAdapter } from './android.js'

const ADAPTERS: Record<Modality, ModalityAdapter> = {
  html: htmlAdapter,
  ios: iosAdapter,
  android: androidAdapter,
  terminal: { modality: 'terminal', capture: async () => { throw new Error('terminal modality not implemented') } },
  voice: { modality: 'voice', capture: async () => { throw new Error('voice modality not implemented') } },
}

export function getModalityAdapter(modality: Modality): ModalityAdapter {
  return ADAPTERS[modality]
}

export { htmlAdapter, iosAdapter, androidAdapter }
export type { Modality, ModalityAdapter }
