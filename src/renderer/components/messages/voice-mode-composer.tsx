import type { ReactNode } from 'react'
import { Mic, MicOff, Volume2, VolumeOff, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { COMPOSER_ACTIONS_ROW_CLASS, COMPOSER_BOX_CLASS, COMPOSER_LEFT_ACTIONS_CLASS, FLOATING_COMPOSER_CLASS } from './chat-composer-box'
import { AttachmentPreview, type Attachment } from './attachment-preview'
import { VoiceConversationPreview } from './voice-conversation-preview'
import { VoiceToggleButton } from './voice-mode-controls'
import type { VoiceTranscriptEntry } from '@shared/lib/voice/conversation-types'
import { cn } from '@shared/lib/utils'
import type { VoiceModePhase } from '@renderer/hooks/use-voice-mode'
import { VoiceOrb } from './voice-orb'
import type { DotOrbState } from '@renderer/lib/voice/orb/dot-orb'
import { avatarSource } from '@renderer/components/agents/agent-avatar/avatar-source'
import type { ApiAgent } from '@shared/lib/types/api'
import { VoiceBars } from './voice-bars'
import { AgentCallOrb, callOrbState } from './agent-call-orb'

interface VoiceModeComposerProps {
  phase: VoiceModePhase
  /** The voice connection is up; until then the orb assembles, grey, with "Initializing…" beneath it. */
  ready: boolean
  /** The agent's display name, labelling its lines in the transcript. */
  agentName?: string
  /** With an avatar, the agent's own orb takes the dot orb's place, over both voices' bars. */
  agent?: Pick<ApiAgent, 'slug' | 'avatar'>
  /** A request card is up and the conversation waits on it. */
  waitingForInput?: boolean
  /** The person is talking now (the mic's turn or over the agent). */
  userSpeaking: boolean
  /** What the person has said so far; shown while they are talking. */
  utterance: string
  /** Spoken conversation subtitles for providers with separate voice output. */
  transcript?: VoiceTranscriptEntry[]
  error: string | null
  onClearError: () => void
  onPressMic: () => void
  /** The person's microphone mute. */
  micMuted: boolean
  onToggleMicMuted: () => void
  /** The speaker mute for the agent's voice. */
  outputMuted: boolean
  onToggleOutputMuted: () => void
  /** The mic's analyser, for the level while the person talks. Null until the mic is open. */
  getAnalyser: () => AnalyserNode | null
  /** The reply's output analyser, for the level while the agent speaks; engines without one get a synthetic envelope. */
  getOutputAnalyser: () => AnalyserNode | null
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
 * with the agent's own orb over both voices' bars where the editor was (the
 * dot orb, held still and stirred by the person's voice while it is their
 * turn and ringing outward while the reply is spoken, for an agent without
 * an avatar). What is being said runs beside it. The action row is the text
 * composer's: attachments and model on the left, voice's own controls and
 * the exit on the right where the mic and send would be.
 */
export function VoiceModeComposer({
  phase,
  ready,
  agentName = 'Agent',
  agent,
  waitingForInput = false,
  userSpeaking,
  utterance,
  transcript,
  error,
  onClearError,
  onPressMic,
  micMuted,
  onToggleMicMuted,
  outputMuted,
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
        {/* The orb takes the editor's place, at the right where it stays from
            the first moment of the call, with "Initializing…" under it while
            the voice connection comes up. Once it is up the column beside it
            holds what is being said. */}
        <div className={cn('flex items-center justify-center gap-3', attachments.length > 0 && 'mt-2')}>
          {/* The row's height is the orb's alone. The strip is taken out of
              flow and pinned to it, so a long conversation scrolls inside the
              frame instead of growing it, and its fades sit at the frame's edges. */}
          <div className="relative min-w-0 flex-1 basis-0 self-stretch">
            {ready && (
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
            {agent?.avatar ? (
              <VoiceAgentOrb
                agent={agent}
                phase={phase}
                ready={ready}
                waitingForInput={waitingForInput}
                micMuted={micMuted}
                getAnalyser={getAnalyser}
                getOutputAnalyser={getOutputAnalyser}
                onClick={onPressMic}
              />
            ) : (
              <VoiceMicButton
                phase={phase}
                ready={ready}
                userSpeaking={userSpeaking}
                getAnalyser={getAnalyser}
                getOutputAnalyser={getOutputAnalyser}
                onClick={onPressMic}
              />
            )}
            {/* In the canvas's clear band under the sphere (or where the bars
                will be), so the row's height does not change; it fades and
                drops away once the call is up. */}
            <div
              className={cn(
                'pointer-events-none absolute inset-x-0 text-center text-sm leading-5 transition-all duration-300 ease-out',
                agent?.avatar ? 'bottom-3' : '-bottom-3',
                ready ? 'translate-y-1 opacity-0' : 'opacity-100',
              )}
              data-testid="voice-mode-initializing"
              aria-live="polite"
              aria-hidden={ready}
            >
              <span className={cn('text-foreground/70', !ready && 'status-title-shimmer')}>Initializing…</span>
            </div>
          </div>
        </div>
        <div className={COMPOSER_ACTIONS_ROW_CLASS}>
          <div className={COMPOSER_LEFT_ACTIONS_CLASS}>
            {attachmentPicker}
            {composerOptions}
          </div>
          {/* Voice's own controls sit right, where the text composer keeps its voice
              buttons: the mic mutes, and the exit is filled like the send it replaces. */}
          <div className="flex shrink-0 items-center gap-2">
            <VoiceToggleButton
              label={outputMuted ? 'Unmute agent speech' : 'Mute agent speech'}
              pressed={outputMuted}
              onClick={onToggleOutputMuted}
              testId="voice-mode-mute-output"
            >
              {outputMuted ? <VolumeOff className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </VoiceToggleButton>
            <VoiceToggleButton
              label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
              pressed={micMuted}
              onClick={onToggleMicMuted}
              testId="voice-mode-mute"
            >
              {micMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </VoiceToggleButton>
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
function orbStateFor(phase: VoiceModePhase, ready: boolean, userSpeaking: boolean): DotOrbState {
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
function VoiceMicButton({ phase, ready, userSpeaking, getAnalyser, getOutputAnalyser, onClick }: {
  phase: VoiceModePhase
  ready: boolean
  userSpeaking: boolean
  getAnalyser: () => AnalyserNode | null
  getOutputAnalyser: () => AnalyserNode | null
  onClick: () => void
}) {
  const orbState = orbStateFor(phase, ready, userSpeaking)
  const levelSource = phase === 'speaking' ? getOutputAnalyser : getAnalyser
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
        // Sized by the canvas, which already carries ~23px of clear space around the sphere; the margins top it up so the orb floats evenly.
        'voice-mic relative mx-1 mb-3 flex shrink-0 items-center justify-center overflow-hidden rounded-full',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      )}
    >
      {/* Greyscale until the connection is up. */}
      <VoiceOrb state={orbState} monochrome={!ready} size={MIC_SIZE} getAnalyser={levelSource} />
    </button>
  )
}

const AGENT_ORB_SIZE = 96

/**
 * The iOS call screen's orb and bars, at composer size: the agent's own orb
 * over both voices as one row of bars. The orb is the mic button, as the dot
 * orb is.
 */
function VoiceAgentOrb({ agent, phase, ready, waitingForInput, micMuted, getAnalyser, getOutputAnalyser, onClick }: {
  agent: Pick<ApiAgent, 'slug' | 'avatar'>
  phase: VoiceModePhase
  ready: boolean
  waitingForInput: boolean
  micMuted: boolean
  getAnalyser: () => AnalyserNode | null
  getOutputAnalyser: () => AnalyserNode | null
  onClick: () => void
}) {
  const state = callOrbState({ ready, waitingForInput, busy: phase !== 'listening' })
  const color = agent.avatar ? avatarSource(agent.avatar).orb.core : 'currentColor'
  return (
    <div className="mx-1 my-2 flex flex-col items-center gap-3">
      <button
        type="button"
        onClick={onClick}
        aria-label={MIC_LABEL[phase]}
        title={MIC_LABEL[phase]}
        data-testid="voice-mode-mic"
        data-phase={phase}
        data-orb-state={state}
        className="flex shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <AgentCallOrb agent={agent} state={state} size={AGENT_ORB_SIZE} />
      </button>
      <VoiceBars
        agentColor={color}
        getAgentAnalyser={getOutputAnalyser}
        getPersonAnalyser={getAnalyser}
        agentSpeaking={phase === 'speaking'}
        personMuted={micMuted}
        className={cn('transition-opacity duration-300', ready ? 'opacity-100' : 'opacity-0')}
      />
    </div>
  )
}
