import type { ReactNode } from 'react'
import { Mic, MicOff, Volume2, VolumeOff, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { COMPOSER_BOX_CLASS, FLOATING_COMPOSER_CLASS } from './chat-composer-box'
import { AttachmentPreview, type Attachment } from './attachment-preview'
import { VoiceConversationPreview } from './voice-conversation-preview'
import type { VoiceTranscriptEntry } from '@shared/lib/voice/conversation-types'
import { cn } from '@shared/lib/utils'
import type { VoiceModePhase } from '@renderer/hooks/use-voice-mode'
import { VoiceOrb } from './voice-orb'
import type { DotOrbState } from '@renderer/lib/voice/orb/dot-orb'

interface VoiceModeComposerProps {
  phase: VoiceModePhase
  /** The voice connection is up; until then the orb assembles. */
  ready?: boolean
  /** The agent's display name, labelling its lines in the transcript. */
  agentName?: string
  /** The person is talking now (the mic's turn or over the agent). */
  userSpeaking?: boolean
  /** What the person has said so far; shown while they are talking. */
  utterance: string
  /** Spoken conversation subtitles for providers with separate voice output. */
  transcript?: VoiceTranscriptEntry[]
  error: string | null
  onClearError: () => void
  onPressMic: () => void
  /** The person's microphone mute. */
  micMuted?: boolean
  onToggleMicMuted?: () => void
  /** The speaker mute for the agent's voice. */
  outputMuted?: boolean
  onToggleOutputMuted?: () => void
  /** The mic's analyser, for the level while the person talks. Null until the mic is open. */
  getAnalyser: () => AnalyserNode | null
  /** The reply's output analyser, for the level while the agent speaks; engines without one get a synthetic envelope. */
  getOutputAnalyser?: () => AnalyserNode | null
  onExit: () => void
  attachments: Attachment[]
  onRemoveAttachment: (id: string) => void
  onRetryAttachment: (id: string) => void
  /** The "+" attachment picker, owned by the composer. */
  attachmentPicker: ReactNode
  /** The model selector, owned by the composer. */
  composerOptions: ReactNode
  /** Voice mode's own settings (reading speed, hold sound), shown right, beside the exit. */
  voiceControls?: ReactNode
  footer?: ReactNode
}

const MIC_LABEL: Record<VoiceModePhase, string> = {
  listening: 'Send what you said',
  thinking: 'Interrupt and talk',
  speaking: 'Interrupt and talk',
}

/**
 * The composer while voice mode is on: the same frame as the text composer,
 * with the dot orb where the editor was, held still and stirred by the
 * person's voice while it is their turn and ringing outward while the reply
 * is spoken. What is being said runs beside it. The action row is the text
 * composer's: attachments and model on the left, voice's own controls and
 * the exit on the right where the mic and send would be.
 */
export function VoiceModeComposer({
  phase,
  ready = true,
  agentName = 'Agent',
  userSpeaking = false,
  utterance,
  transcript,
  error,
  onClearError,
  onPressMic,
  micMuted = false,
  onToggleMicMuted,
  outputMuted = false,
  onToggleOutputMuted,
  getAnalyser,
  getOutputAnalyser,
  onExit,
  attachments,
  onRemoveAttachment,
  onRetryAttachment,
  attachmentPicker,
  composerOptions,
  voiceControls,
  footer,
}: VoiceModeComposerProps) {
  // Live subtitles: until the agent has said anything. Chained speech has no
  // subtitles, so only until the connection is up.
  const initializing = transcript ? transcript.length === 0 : !ready
  return (
    <div
      className="relative"
      data-testid="voice-mode-composer"
      data-phase={phase}
      // What has been heard, in every phase: shown only while listening, but
      // words over the agent are what an interruption is judged by.
      data-utterance={utterance}
    >
      <div className={cn(COMPOSER_BOX_CLASS, FLOATING_COMPOSER_CLASS, 'composer-enter-contents')}>
        <AttachmentPreview attachments={attachments} onRemove={onRemoveAttachment} onRetry={onRetryAttachment} />
        {/* The orb takes the editor's place. While the voice connection comes
            up it sits centred with "Initializing…" beneath it; the first words
            grow the transcript column from nothing, which slides the orb to
            the right where it stays. */}
        <div className={cn('flex items-center justify-center gap-3', attachments.length > 0 && 'mt-2')}>
          {/* The row's height is the orb's alone. The strip is taken out of
              flow and pinned to it, so a long conversation scrolls inside the
              frame instead of growing it, and its fades sit at the frame's edges. */}
          <div
            className="relative min-w-0 basis-0 self-stretch transition-[flex-grow] duration-[600ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{ flexGrow: initializing ? 0 : 1 }}
          >
            {!initializing && (
              <div className="voice-strip-enter absolute inset-0 flex flex-col justify-center pl-3">
                {transcript ? <VoiceConversationPreview transcript={transcript} agentName={agentName} /> : (
                  <div
                    className="min-h-[1.25rem] text-sm italic text-muted-foreground"
                    data-testid="voice-mode-transcript"
                    aria-live="polite"
                  >
                    {phase === 'listening' ? utterance : ''}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="relative shrink-0">
            <VoiceMicButton
              phase={phase}
              ready={ready}
              monochrome={initializing}
              userSpeaking={userSpeaking}
              getAnalyser={getAnalyser}
              getOutputAnalyser={getOutputAnalyser}
              onClick={onPressMic}
            />
            {/* In the canvas's clear band under the sphere, so the row's height
                does not change; it fades and drops away as the orb slides. */}
            <div
              className={cn(
                'pointer-events-none absolute inset-x-0 -bottom-3 text-center text-sm leading-5 transition-all duration-300 ease-out',
                initializing ? 'opacity-100' : 'translate-y-1 opacity-0',
              )}
              data-testid="voice-mode-initializing"
              aria-live="polite"
              aria-hidden={!initializing}
            >
              <span className={cn('text-foreground/70', initializing && 'status-title-shimmer')}>Initializing…</span>
            </div>
          </div>
        </div>
        <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            {attachmentPicker}
            {composerOptions}
          </div>
          {/* Voice's own controls sit right, where the text composer keeps its voice
              buttons: the mic mutes, and the exit is filled like the send it replaces. */}
          <div className="flex shrink-0 items-center gap-2">
            {/* The same tooltip as the hold-sound toggle beside them: instant, below the button. */}
            <TooltipProvider delayDuration={0}>
              {onToggleOutputMuted && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="h-[34px] w-[34px]"
                      onClick={onToggleOutputMuted}
                      aria-pressed={outputMuted}
                      aria-label={outputMuted ? 'Unmute agent speech' : 'Mute agent speech'}
                      data-testid="voice-mode-mute-output"
                    >
                      {outputMuted ? <VolumeOff className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {outputMuted ? 'Unmute agent speech' : 'Mute agent speech'}
                  </TooltipContent>
                </Tooltip>
              )}
              {onToggleMicMuted && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="h-[34px] w-[34px]"
                      onClick={onToggleMicMuted}
                      aria-pressed={micMuted}
                      aria-label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
                      data-testid="voice-mode-mute"
                    >
                      {micMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {micMuted ? 'Unmute microphone' : 'Mute microphone'}
                  </TooltipContent>
                </Tooltip>
              )}
            </TooltipProvider>
            {voiceControls}
            <Button
              type="button"
              size="icon"
              className="h-[34px] w-[34px]"
              onClick={onExit}
              aria-label="Exit voice mode"
              title="Exit voice mode"
              data-testid="voice-mode-exit"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <VoiceInputError error={error} onDismiss={onClearError} className="mt-2" />
        {footer}
      </div>
    </div>
  )
}

// 152 with the sphere at 0.35 of it: a 106px orb at rest, with room inside the canvas for the full stir.
const MIC_SIZE = 152

/** Which of the orb's designed states the composer's phase is. */
export function orbStateFor(phase: VoiceModePhase, ready: boolean, userSpeaking: boolean): DotOrbState {
  if (!ready) return 'boot'
  if (phase === 'speaking') return 'agent'
  if (phase === 'thinking') return 'thinking'
  return userSpeaking ? 'user' : 'ready'
}

/**
 * The mic button is the orb itself, no plate or ring: the dot sphere sits on
 * the composer's own surface, inked on light themes and emissive on dark. The
 * level it moves to comes from the mic while the person talks and from the
 * reply's output while the agent does.
 */
function VoiceMicButton({ phase, ready, monochrome, userSpeaking, getAnalyser, getOutputAnalyser, onClick }: {
  phase: VoiceModePhase
  ready: boolean
  /** Greyscale until the conversation is under way. */
  monochrome: boolean
  userSpeaking: boolean
  getAnalyser: () => AnalyserNode | null
  getOutputAnalyser?: () => AnalyserNode | null
  onClick: () => void
}) {
  const orbState = orbStateFor(phase, ready, userSpeaking)
  const levelSource = phase === 'speaking' ? () => getOutputAnalyser?.() ?? null : getAnalyser
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={MIC_LABEL[phase]}
      title={MIC_LABEL[phase]}
      data-testid="voice-mode-mic"
      data-phase={phase}
      data-orb-state={orbState}
      className={cn(
        // The canvas already carries ~23px of clear space around the sphere; the margins top it up so the orb floats evenly.
        'voice-mic relative mx-1 mb-3 flex h-[152px] w-[152px] shrink-0 items-center justify-center overflow-hidden rounded-full',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      )}
    >
      <VoiceOrb state={orbState} monochrome={monochrome} size={MIC_SIZE} getAnalyser={levelSource} />
    </button>
  )
}
