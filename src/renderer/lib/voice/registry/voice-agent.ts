import type { VoiceProvider } from '@shared/lib/config/settings'
import type { VoiceAgentAdapter } from '../contracts/voice-agent'
import { DeepgramVoiceAgentAdapter } from '../providers/deepgram/voice-agent'
import { OpenAIVoiceAgentAdapter } from '../providers/openai/voice-agent'

// Exhaustive by type: a new provider without an entry here is a compile
// error, not a throw when the assistant is first opened.
const adapters = {
  deepgram: () => new DeepgramVoiceAgentAdapter(),
  platform: () => new DeepgramVoiceAgentAdapter(),
  openai: () => new OpenAIVoiceAgentAdapter(),
} satisfies Record<VoiceProvider, () => VoiceAgentAdapter>

export function createVoiceAgentAdapter(provider: VoiceProvider): VoiceAgentAdapter {
  const create = adapters[provider] as (() => VoiceAgentAdapter) | undefined
  if (!create) throw new Error(`Unknown Voice Agent provider: ${provider}`)
  return create()
}
