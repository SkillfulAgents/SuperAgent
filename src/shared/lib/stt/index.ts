export { BaseSttProvider } from './stt-provider'
export { DeepgramSttProvider } from './deepgram-provider'
export { OpenaiSttProvider } from './openai-provider'

import type { SttProvider } from '../config/settings'
import { BaseSttProvider } from './stt-provider'
import { DeepgramSttProvider } from './deepgram-provider'
import { OpenaiSttProvider } from './openai-provider'

const providers: Record<SttProvider, BaseSttProvider> = {
  deepgram: new DeepgramSttProvider(),
  openai: new OpenaiSttProvider(),
}

export function getSttProvider(id: SttProvider): BaseSttProvider {
  const provider = providers[id]
  if (!provider) {
    throw new Error(`Unknown STT provider: ${id}`)
  }
  return provider
}
