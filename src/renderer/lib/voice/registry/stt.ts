import type { VoiceProvider } from '@shared/lib/config/settings'
import type { SttAdapter } from '../contracts/stt'
import { DeepgramSttAdapter } from '../providers/deepgram/transcription'
import { OpenAISttAdapter } from '../providers/openai/transcription'

export function createSttAdapter(provider: VoiceProvider): SttAdapter {
  switch (provider) {
    case 'deepgram':
    case 'platform': return new DeepgramSttAdapter()
    case 'openai': return new OpenAISttAdapter()
    default: throw new Error(`Unknown voice provider: ${provider}`)
  }
}
