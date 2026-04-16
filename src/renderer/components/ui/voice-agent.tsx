import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { MiniWaveform } from '@renderer/components/ui/mini-waveform'
import { Loader2, MicOff, Pause, Phone, PhoneOff, Play, RotateCcw } from 'lucide-react'
import { useVoiceAgent, type VoiceAgentTranscriptEntry } from '@renderer/hooks/use-voice-agent'
import type { VoiceAgentConfig } from '@renderer/lib/voice-agent'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils'

interface VoiceAgentProps {
  config: VoiceAgentConfig
  /** Called when the agent invokes a function call with structured output */
  onResult?: (name: string, args: string) => void
  /** Called when the user explicitly closes the voice agent */
  onClose?: () => void
  /**
   * Visual layout:
   * - 'vertical' (default): indicator + status + transcript + controls stacked
   * - 'split': left column has indicator/status/controls; right column has transcript
   */
  layout?: 'vertical' | 'split'
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
export function VoiceAgent({ config, onResult, onClose, layout = 'vertical', className }: VoiceAgentProps) {
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
    playbackAnalyserRef,
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

  // Auto-scroll the split-layout transcript to the bottom as new entries arrive
  const splitTranscriptRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = splitTranscriptRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [transcript.length])

  const indicator = (
    <SpeakingIndicator
      speakingState={speakingState}
      isConnecting={isConnecting}
      analyserRef={analyserRef}
      playbackAnalyserRef={playbackAnalyserRef}
    />
  )

  const statusLabel = state !== 'idle' ? (
    <div className="text-xs text-blue-300 mt-3">
      {isConnecting && 'connecting...'}
      {isActive && speakingState === 'user' && 'listening...'}
      {isActive && speakingState === 'agent' && 'speaking...'}
      {isActive && speakingState === 'none' && 'listening...'}
    </div>
  ) : null

  const errorDisplay = error ? (
    <div className="flex items-center gap-1.5 text-xs text-destructive">
      <MicOff className="h-3 w-3 shrink-0" />
      <span>{error}</span>
    </div>
  ) : null

  const controls = (
    <TooltipProvider delayDuration={0}>
      <div className="flex items-center gap-2">
        {state === 'idle' ? (
          <Button onClick={start} size="sm" variant="default" className="gap-2">
            <Phone className="h-4 w-4" />
            Start call
          </Button>
        ) : (
          <>
            <PauseButton key={state} onPause={pause} onResume={resume} disabled={!isActive} />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={handleStop}
                  size="icon"
                  variant="outline"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  aria-label="End"
                >
                  <PhoneOff className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>End call</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={handleRestart}
                  size="icon"
                  variant="outline"
                  disabled={isConnecting}
                  aria-label="Restart"
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Issues? Try restarting.</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </TooltipProvider>
  )

  if (layout === 'split') {
    const fadeMask = 'linear-gradient(to bottom, transparent 0, black 72px, black calc(100% - 72px), transparent 100%)'
    const showTranscript = transcript.length > 0
    return (
      <div className={cn('flex flex-col h-[420px]', className)}>
        {/* Top: two-column content. Right column collapses to 0 until first message arrives. */}
        <div
          className="grid flex-1 min-h-0 transition-[grid-template-columns] duration-500 ease-in-out"
          style={{ gridTemplateColumns: showTranscript ? '1fr 1fr' : '1fr 0fr' }}
        >
          {/* Left column: indicator, status — centered vertically */}
          <div className="flex flex-col items-center justify-center gap-4 p-6 min-w-0">
            {indicator}
            {errorDisplay}
            {statusLabel}
          </div>

          {/* Right column: full-bleed transcript with top/bottom fade */}
          <div
            className="overflow-hidden min-w-0"
            style={{ maskImage: fadeMask, WebkitMaskImage: fadeMask }}
          >
            <div
              ref={splitTranscriptRef}
              className="h-full overflow-y-auto pt-[100px] pb-[72px] pr-6 text-sm"
            >
              {transcript.map((entry, i) => (
                <div
                  key={i}
                  className={cn(
                    'mb-1.5 last:mb-0',
                    entry.role === 'assistant' ? 'text-muted-foreground' : ''
                  )}
                >
                  {entry.text}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom: centered control bar */}
        <div className="flex items-center justify-center pb-6">
          {controls}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col items-center gap-4 p-6', className)}>
      {indicator}
      {statusLabel}
      {errorDisplay}
      {transcript.length > 0 && <TranscriptDisplay entries={transcript} />}
      {controls}
    </div>
  )
}

const ORB_BASE = 'flex h-[150px] w-[150px] items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30'

/** Pulsing / waveform indicator showing who is speaking */
function SpeakingIndicator({
  speakingState,
  isConnecting,
  analyserRef,
  playbackAnalyserRef,
}: {
  speakingState: 'none' | 'user' | 'agent'
  isConnecting: boolean
  analyserRef: React.RefObject<AnalyserNode | null>
  playbackAnalyserRef: React.RefObject<AnalyserNode | null>
}) {
  if (isConnecting) {
    return (
      <div className={cn(ORB_BASE, 'shadow-[0_0_28px_rgba(59,130,246,0.28)]')}>
        <Loader2 className="h-5 w-5 animate-spin text-blue-500/50" />
      </div>
    )
  }

  const speakingAnalyser =
    speakingState === 'user' ? analyserRef :
    speakingState === 'agent' ? playbackAnalyserRef : null

  return (
    <div className={cn(ORB_BASE, 'voice-agent-breathe')}>
      {speakingAnalyser ? (
        <MiniWaveform analyserRef={speakingAnalyser} bars={12} width={45} height={30} color="rgb(59,130,246)" />
      ) : (
        <StaticDots count={9} size={2} dotClassName="bg-blue-500/50" />
      )}
    </div>
  )
}

/** Row of small static dots — used for the Ready state */
function StaticDots({
  count = 12,
  size = 4,
  dotClassName = 'bg-muted-foreground/40',
}: {
  count?: number
  size?: number
  dotClassName?: string
}) {
  return (
    <div className="flex items-center gap-[3px]">
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className={cn('rounded-full', dotClassName)}
          style={{ width: size, height: size }}
        />
      ))}
    </div>
  )
}

/** Scrollable transcript display — auto-scrolls to bottom on new entries */
function TranscriptDisplay({ entries, fullHeight = false }: { entries: VoiceAgentTranscriptEntry[]; fullHeight?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [entries.length])

  return (
    <div
      ref={scrollRef}
      className={cn(
        'w-full overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm',
        fullHeight ? 'h-full min-h-[240px]' : 'max-h-48'
      )}
    >
      {entries.map((entry, i) => (
        <div key={i} className={cn('mb-1.5 last:mb-0', entry.role === 'assistant' ? 'text-muted-foreground' : '')}>
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
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          onClick={toggle}
          size="icon"
          variant="outline"
          disabled={disabled}
          aria-label={paused ? 'Resume' : 'Pause'}
        >
          {paused ? <Play className="h-4 w-4 fill-current" /> : <Pause className="h-4 w-4 fill-current" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{paused ? 'Resume' : 'Pause'}</TooltipContent>
    </Tooltip>
  )
}
