import type { VoiceProvider } from '@shared/lib/config/settings'
import type { SttProtocol } from '@shared/lib/voice/stt-protocol'
import { voiceMessagesFor } from '@shared/lib/voice/openai-voice-messages'
import type { SttAdapter } from '../contracts/stt'
import { DeepgramSttAdapter } from '../providers/deepgram/transcription'
import { OpenAISttAdapter } from '../providers/openai/transcription'

// Exhaustive by protocol: a new STT protocol without an entry here is a compile
// error, not a throw on the first mic press.
const adapters = {
  deepgram: (_owner: VoiceProvider) => new DeepgramSttAdapter(),
  'openai-realtime': (owner: VoiceProvider) => new OpenAISttAdapter(voiceMessagesFor(owner).quotaExceeded),
} satisfies Record<SttProtocol, (owner: VoiceProvider) => SttAdapter>

export function createSttAdapter(protocol: SttProtocol, owner: VoiceProvider = 'openai'): SttAdapter {
  const create = adapters[protocol] as ((owner: VoiceProvider) => SttAdapter) | undefined
  if (!create) throw new Error(`Unknown STT protocol: ${protocol}`)
  return create(owner)
}
