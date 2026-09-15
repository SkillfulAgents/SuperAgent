import { useVoiceConversationEngine } from './use-voice-input'
import { useConversationMode, type UseVoiceModeArgs } from './use-conversation-mode'

export type { UseVoiceModeArgs, VoiceModeResult } from './use-conversation-mode'
export type { VoiceModePhase } from '@renderer/lib/voice-conversation'

export function useVoiceMode(args: UseVoiceModeArgs) {
  return useConversationMode(args, useVoiceConversationEngine())
}
