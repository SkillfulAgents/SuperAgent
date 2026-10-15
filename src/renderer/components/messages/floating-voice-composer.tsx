import { forwardRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from '@tanstack/react-router'
import { Mic, MicOff, Volume2, VolumeOff, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useSession } from '@renderer/hooks/use-sessions'
import type { VoiceModePhase } from '@renderer/hooks/use-voice-mode'
import { cn } from '@shared/lib/utils'
import { VoiceMicButton } from './voice-mode-composer'
import { VoiceToggleButton } from './voice-mode-controls'

interface FloatingVoiceComposerProps {
  sessionId: string
  agentSlug: string
  phase: VoiceModePhase
  ready: boolean
  userSpeaking: boolean
  /** A request card in the session is waiting on the person. */
  suspended: boolean
  error: string | null
  onPressMic: () => void
  micMuted: boolean
  onToggleMicMuted: () => void
  outputMuted: boolean
  onToggleOutputMuted: () => void
  getAnalyser: () => AnalyserNode | null
  getOutputAnalyser: () => AnalyserNode | null
  onExit: () => void
}

const STATUS: Record<VoiceModePhase, string> = {
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
}

/** The voice composer of a session that is not on screen, floating over the one that is. */
export const FloatingVoiceComposer = forwardRef<HTMLDivElement, FloatingVoiceComposerProps>(function FloatingVoiceComposer({
  sessionId,
  agentSlug,
  phase,
  ready,
  userSpeaking,
  suspended,
  error,
  onPressMic,
  micMuted,
  onToggleMicMuted,
  outputMuted,
  onToggleOutputMuted,
  getAnalyser,
  getOutputAnalyser,
  onExit,
}, ref) {
  const { data: session } = useSession(sessionId, agentSlug)
  const navigate = useNavigate()
  const status = suspended ? 'Needs your input' : error ?? (ready ? STATUS[phase] : 'Initializing…')
  return createPortal(
    <div
      ref={ref}
      className="fixed bottom-4 right-4 z-50 flex w-96 items-center gap-2 rounded-2xl border bg-background p-2 pr-3 shadow-lg"
      data-testid="floating-voice-composer"
      data-phase={phase}
    >
      <VoiceMicButton
        phase={phase}
        ready={ready}
        userSpeaking={userSpeaking}
        getAnalyser={getAnalyser}
        getOutputAnalyser={getOutputAnalyser}
        onClick={onPressMic}
        size={64}
        className="m-0"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{session?.name ?? 'Voice mode'}</div>
        <div
          className={cn('truncate text-xs', error && !suspended ? 'text-destructive' : suspended ? 'text-foreground' : 'text-muted-foreground')}
          data-testid="floating-voice-status"
          aria-live="polite"
        >
          {status}
        </div>
      </div>
      <VoiceToggleButton
        label={outputMuted ? 'Unmute agent speech' : 'Mute agent speech'}
        pressed={outputMuted}
        onClick={onToggleOutputMuted}
        testId="floating-voice-mute-output"
      >
        {outputMuted ? <VolumeOff className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
      </VoiceToggleButton>
      <VoiceToggleButton
        label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
        pressed={micMuted}
        onClick={onToggleMicMuted}
        testId="floating-voice-mute"
      >
        {micMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </VoiceToggleButton>
      <Button
        type="button"
        variant="outline"
        className="h-[34px] px-3"
        onClick={() => void navigate({ to: '/agents/$slug/sessions/$sessionId', params: { slug: agentSlug, sessionId } })}
        data-testid="floating-voice-open"
      >
        Open
      </Button>
      <Button
        type="button"
        size="icon"
        className="h-[34px] w-[34px]"
        onClick={onExit}
        aria-label="Exit voice mode"
        title="Exit voice mode"
        data-testid="floating-voice-exit"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>,
    document.body,
  )
})
