import type { VoiceProvider } from '@shared/lib/config/settings'
import type { SttAdapter } from '../contracts/stt'
import { DeepgramSttAdapter } from '../providers/deepgram/transcription'
import { OpenAISttAdapter } from '../providers/openai/transcription'

// Exhaustive by type: a new provider without an entry here is a compile
// error, not a throw on the first mic press.
const adapters = {
  deepgram: () => new DeepgramSttAdapter(),
  platform: () => new DeepgramSttAdapter(),
  openai: () => new OpenAISttAdapter(),
} satisfies Record<VoiceProvider, () => SttAdapter>

export function createSttAdapter(provider: VoiceProvider): SttAdapter {
  const create = adapters[provider] as (() => SttAdapter) | undefined
  if (!create) throw new Error(`Unknown voice provider: ${provider}`)
  return create()
}
