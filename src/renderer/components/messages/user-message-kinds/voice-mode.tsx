import { classifyVoiceModeNotice } from '@shared/lib/voice/voice-mode-messages'
import { ThreadDivider } from '../thread-divider'
import type { UserMessageKindSpec, UserMessageRenderProps } from './types'

/**
 * A solid rule across the transcript where the person switched voice mode
 * on or off. The notice's text is for the agent, never shown.
 */
export function VoiceModeBoundary({ text }: UserMessageRenderProps) {
  const notice = classifyVoiceModeNotice(text) ?? 'entered'
  return (
    // Edge to edge like the completed-turn summary above it, no side inset.
    <ThreadDivider solid className="px-0 py-2" data-testid="voice-mode-boundary" data-notice={notice}>
      <span className="text-xs text-muted-foreground">{notice === 'exited' ? 'Voice mode: off' : 'Voice mode: on'}</span>
    </ThreadDivider>
  )
}

/**
 * The "[SYSTEM] The user switched to voice mode." / "... left voice mode."
 * notices the app appends when voice mode is toggled. System messages, so
 * the agent reads them with its next turn, but unlike the rest they are
 * shown: as a boundary, since the conversation changes register there.
 */
export const voiceModeNotice: UserMessageKindSpec = {
  kind: 'voice-mode',
  match: (text) => classifyVoiceModeNotice(text) !== null,
  hidden: false,
  Render: VoiceModeBoundary,
  chrome: 'row',
}
