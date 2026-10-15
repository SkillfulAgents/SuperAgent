import { useEffect } from 'react'
import { readAloud } from '@renderer/lib/voice/services/read-aloud'
import { isAnyVoiceModeActive } from '@renderer/lib/voice-mode-handoff'
import { useVoiceConversationEngine } from './use-voice-input'
import { useConversationMode, type UseVoiceModeArgs } from './use-conversation-mode'

export type { UseVoiceModeArgs, VoiceModeResult } from './use-conversation-mode'
export type { VoiceModePhase } from '@renderer/lib/voice/contracts/conversation'

export function useVoiceMode(args: UseVoiceModeArgs) {
  // Whatever is being read stops with the session view, voice mode or not:
  // its controls live under the message, on the page being left. Not while
  // another session's voice mode is talking through the same reader.
  useEffect(() => () => { if (!isAnyVoiceModeActive()) readAloud.stop() }, [])
  return useConversationMode(args, useVoiceConversationEngine())
}
