import type { VoiceProvider } from '@shared/lib/config/settings'
import type { VoiceAgentAdapter } from '../contracts/voice-agent'
import { DeepgramVoiceAgentAdapter } from '../providers/deepgram/voice-agent'
import { OpenAIVoiceAgentAdapter } from '../providers/openai/voice-agent'

export function createVoiceAgentAdapter(provider: VoiceProvider): VoiceAgentAdapter {
  switch (provider) {
    case 'deepgram':
    case 'platform': return new DeepgramVoiceAgentAdapter()
    case 'openai': return new OpenAIVoiceAgentAdapter()
    default: throw new Error(`Unknown Voice Agent provider: ${provider}`)
  }
}
