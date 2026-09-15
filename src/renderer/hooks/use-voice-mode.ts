import { useEffect } from 'react'
import { readAloud } from './use-read-aloud'
import { useVoiceConversationEngine } from './use-voice-input'
import { useConversationMode, type UseVoiceModeArgs } from './use-conversation-mode'

export type { UseVoiceModeArgs, VoiceModeResult } from './use-conversation-mode'
export type { VoiceModePhase } from '@renderer/lib/voice-conversation'

export function useVoiceMode(args: UseVoiceModeArgs) {
  // Whatever is being read stops with the session view, voice mode or not:
  // its controls live under the message, on the page being left.
  useEffect(() => () => readAloud.stop(), [])
  return useConversationMode(args, useVoiceConversationEngine())
}
