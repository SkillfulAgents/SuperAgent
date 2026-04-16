import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { MiniWaveform } from '@renderer/components/ui/mini-waveform'
import { Loader2, Mic, MicOff, Pause, Phone, PhoneOff, Play, RotateCcw } from 'lucide-react'
import { useVoiceAgent, type VoiceAgentTranscriptEntry } from '@renderer/hooks/use-voice-agent'
import type { VoiceAgentConfig } from '@renderer/lib/voice-agent'
import { cn } from '@shared/lib/utils'

interface VoiceAgentProps {
  config: VoiceAgentConfig
  /** Called when the agent invokes a function call with structured output */
  onResult?: (name: string, args: string) => void
  /** Called when the user explicitly closes the voice agent */
  onClose?: () => void
  /** Additional CSS class name */
  className?: string
}

/**
 * Voice Agent component — renders a full voice conversation UI with:
 * - Speaking state visualization (who is talking)
 * - Live waveform during recording
 * - Running transcript
 * - Controls: mute, stop, restart
 */
export function VoiceAgent({ config, onResult, onClose, className }: VoiceAgentProps) {
  const handleFunctionCall = useCallback((name: string, args: string) => {
    onResult?.(name, args)
  }, [onResult])

  const toolsKey = JSON.stringify(config.tools)
  const contextKey = JSON.stringify(config.conversationContext)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stable reference based on config content
  const stableConfig = useMemo(() => config, [
    config.systemPrompt, config.voice, config.greeting, toolsKey, contextKey,
  ])

  const {
    state,
    speakingState,
    transcript,
    error,
    analyserRef,
    start,
    stop,
    pause,
    resume,
    isActive,
    isConnecting,
  } = useVoiceAgent({
    config: stableConfig,
    onFunctionCall: handleFunctionCall,
  })

  const handleStop = useCallback(() => {
    stop()
    onClose?.()
  }, [stop, onClose])

  const handleRestart = useCallback(() => {
    stop()
    start()
  }, [stop, start])

  // Auto-start once on mount
  const hasStartedRef = useRef(false)
  useEffect(() => {
    if (!hasStartedRef.current) {
      hasStartedRef.current = true
      start()
    }
  }, [start])

  return (
    <div className={cn('flex flex-col items-center gap-4 p-6', className)}>
      {/* Speaking indicator */}
      <SpeakingIndicator
        speakingState={speakingState}
        isConnecting={isConnecting}
        isActive={isActive}
        analyserRef={analyserRef}
      />

      {/* Status label */}
      <div className="text-sm text-muted-foreground">
        {isConnecting && 'Connecting...'}
        {isActive && speakingState === 'user' && 'Listening...'}
        {isActive && speakingState === 'agent' && 'Speaking...'}
        {isActive && speakingState === 'none' && 'Ready'}
        {state === 'idle' && !error && 'Idle'}
      </div>

      {/* Error display */}
      {error && (
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <MicOff className="h-3 w-3 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Transcript */}
      {transcript.length > 0 && (
        <TranscriptDisplay entries={transcript} />
      )}

      {/* Controls */}
      <div className="flex items-center gap-2">
        {state === 'idle' ? (
          <Button onClick={start} size="sm" variant="default" className="gap-2">
            <Phone className="h-4 w-4" />
            Start
          </Button>
        ) : (
          <>
            <PauseButton key={state} onPause={pause} onResume={resume} disabled={!isActive} />
            <Button onClick={handleRestart} size="sm" variant="outline" className="gap-2" disabled={isConnecting}>
              <RotateCcw className="h-4 w-4" />
              Restart
            </Button>
            <Button onClick={handleStop} size="sm" variant="destructive" className="gap-2">
              <PhoneOff className="h-4 w-4" />
              End
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

/** Pulsing / waveform indicator showing who is speaking */
function SpeakingIndicator({
  speakingState,
  isConnecting,
  isActive,
  analyserRef,
}: {
  speakingState: 'none' | 'user' | 'agent'
  isConnecting: boolean
  isActive: boolean
  analyserRef: React.RefObject<AnalyserNode | null>
}) {
  if (isConnecting) {
    return (
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!isActive) {
    return (
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted">
        <Mic className="h-8 w-8 text-muted-foreground" />
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex h-20 w-20 items-center justify-center rounded-full transition-colors duration-300',
        speakingState === 'user' && 'bg-blue-100 dark:bg-blue-900/30',
        speakingState === 'agent' && 'bg-green-100 dark:bg-green-900/30',
        speakingState === 'none' && 'bg-muted',
      )}
    >
      {speakingState === 'user' ? (
        <MiniWaveform analyserRef={analyserRef} bars={12} width={48} height={32} color="rgb(59,130,246)" />
      ) : speakingState === 'agent' ? (
        <PulsingDots />
      ) : (
        <Mic className="h-8 w-8 text-muted-foreground" />
      )}
    </div>
  )
}

/** Animated dots shown when the agent is speaking */
function PulsingDots() {
  return (
    <div className="flex items-center gap-1.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-2.5 w-2.5 rounded-full bg-green-500 dark:bg-green-400"
          style={{
            animation: 'voice-agent-pulse 1.2s ease-in-out infinite',
            animationDelay: `${i * 0.2}s`,
          }}
        />
      ))}
      <style>{`
        @keyframes voice-agent-pulse {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  )
}

/** Scrollable transcript display — auto-scrolls to bottom on new entries */
function TranscriptDisplay({ entries }: { entries: VoiceAgentTranscriptEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [entries.length])

  return (
    <div ref={scrollRef} className="w-full max-h-48 overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm">
      {entries.map((entry, i) => (
        <div key={i} className={cn('mb-1.5 last:mb-0', entry.role === 'assistant' ? 'text-muted-foreground' : '')}>
          <span className="font-medium">{entry.role === 'user' ? 'You' : 'Agent'}:</span>{' '}
          {entry.text}
        </div>
      ))}
    </div>
  )
}

/** Toggle pause button — pauses both mic input and audio playback */
function PauseButton({ onPause, onResume, disabled }: { onPause: () => void; onResume: () => void; disabled: boolean }) {
  const [paused, setPaused] = useState(false)

  const toggle = useCallback(() => {
    if (paused) {
      onResume()
      setPaused(false)
    } else {
      onPause()
      setPaused(true)
    }
  }, [paused, onPause, onResume])

  return (
    <Button onClick={toggle} size="sm" variant="outline" className="gap-2" disabled={disabled}>
      {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
      {paused ? 'Resume' : 'Pause'}
    </Button>
  )
}
