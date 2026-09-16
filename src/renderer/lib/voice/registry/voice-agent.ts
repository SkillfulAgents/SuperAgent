import type { VoiceProvider } from '@shared/lib/config/settings'
import type { SttProtocol } from '@shared/lib/voice/stt-protocol'
import { voiceMessagesFor } from '@shared/lib/voice/openai-voice-messages'
import type { VoiceAgentAdapter } from '../contracts/voice-agent'
import { DeepgramVoiceAgentAdapter } from '../providers/deepgram/voice-agent'
import { OpenAIVoiceAgentAdapter } from '../providers/openai/voice-agent'

// Exhaustive by protocol: a new STT protocol without an entry here is a compile
// error, not a throw when the assistant is first opened.
const adapters = {
  deepgram: (_owner: VoiceProvider) => new DeepgramVoiceAgentAdapter(),
  'openai-realtime': (owner: VoiceProvider) => new OpenAIVoiceAgentAdapter(voiceMessagesFor(owner).quotaExceeded),
} satisfies Record<SttProtocol, (owner: VoiceProvider) => VoiceAgentAdapter>

export function createVoiceAgentAdapter(protocol: SttProtocol, owner: VoiceProvider = 'openai'): VoiceAgentAdapter {
  const create = adapters[protocol] as ((owner: VoiceProvider) => VoiceAgentAdapter) | undefined
  if (!create) throw new Error(`Unknown Voice Agent protocol: ${protocol}`)
  return create(owner)
}
