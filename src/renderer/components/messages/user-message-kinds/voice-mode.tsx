import { AudioLines, AudioLinesOff } from 'lucide-react'
import { classifyVoiceModeNotice } from '@shared/lib/voice/voice-mode-messages'
import type { UserMessageKindSpec, UserMessageRenderProps } from './types'

/**
 * A dashed line across the transcript where the person switched voice mode
 * on or off, the way a compact boundary is drawn. The notice's text is for
 * the agent, never shown.
 */
export function VoiceModeBoundary({ text }: UserMessageRenderProps) {
  const notice = classifyVoiceModeNotice(text) ?? 'entered'
  const Icon = notice === 'exited' ? AudioLinesOff : AudioLines
  return (
    <div
      className="flex items-center gap-2 px-4 py-2"
      data-testid="voice-mode-boundary"
      data-notice={notice}
    >
      <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3 w-3" aria-hidden />
        <span>{notice === 'exited' ? 'Exited Voice Mode' : 'Entered Voice Mode'}</span>
      </div>
      <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
    </div>
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
