import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { MiniWaveform } from '@renderer/components/ui/mini-waveform'
import { Loader2, MicOff, Pause, Phone, PhoneOff, Play, RotateCcw } from 'lucide-react'
import { useVoiceAgent, type VoiceAgentTranscriptEntry } from '@renderer/hooks/use-voice-agent'
import type { VoiceAgentConfig } from '@renderer/lib/voice-agent'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { cn } from '@shared/lib/utils'

function formatTranscript(entries: VoiceAgentTranscriptEntry[]): string {
  return entries.map(e => `${e.role}: ${e.text}`).join('\n')
}

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
  const { track } = useAnalyticsTracking()
  const sessionStartedAtRef = useRef<number | null>(null)
  const transcriptRef = useRef<VoiceAgentTranscriptEntry[]>([])

  const handleFunctionCall = useCallback((name: string, args: string) => {
    track('voice_agent_ended', {
      functionName: name,
      transcript: formatTranscript(transcriptRef.current),
      transcriptTurns: transcriptRef.current.length,
      durationMs: sessionStartedAtRef.current ? Date.now() - sessionStartedAtRef.current : undefined,
    })
    sessionStartedAtRef.current = null
    onResult?.(name, args)
  }, [onResult, track])

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

  transcriptRef.current = transcript

  useEffect(() => {
    if (state === 'active' && sessionStartedAtRef.current === null) {
      sessionStartedAtRef.current = Date.now()
      track('voice_agent_started')
    }
  }, [state, track])

  const handlePause = useCallback(() => {
    track('voice_agent_paused')
    pause()
  }, [pause, track])

  const handleStop = useCallback(() => {
    track('voice_agent_stopped', {
      transcript: formatTranscript(transcriptRef.current),
      transcriptTurns: transcriptRef.current.length,
      durationMs: sessionStartedAtRef.current ? Date.now() - sessionStartedAtRef.current : undefined,
    })
    sessionStartedAtRef.current = null
    stop()
    onClose?.()
  }, [stop, onClose, track])

  const handleRestart = useCallback(() => {
    track('voice_agent_stopped', {
      reason: 'restart',
      transcript: formatTranscript(transcriptRef.current),
      transcriptTurns: transcriptRef.current.length,
      durationMs: sessionStartedAtRef.current ? Date.now() - sessionStartedAtRef.current : undefined,
    })
    sessionStartedAtRef.current = null
    stop()
    start()
  }, [stop, start, track])

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
  }, [transcript])

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
            <PauseButton key={state} onPause={handlePause} onResume={resume} disabled={!isActive} />
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
      <div className={cn('flex flex-col h-full', className)}>
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
              role="log"
              aria-live="polite"
              aria-label="Voice agent transcript"
            >
              {transcript.map((entry, i) => (
                <div
                  key={i}
                  aria-label={entry.role === 'assistant' ? `Agent: ${entry.text}` : `You: ${entry.text}`}
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

const ORB_BASE = 'voice-agent-orb relative flex h-[150px] w-[150px] items-center justify-center rounded-full'

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
  const speakingAnalyser =
    !isConnecting && speakingState === 'user' ? analyserRef :
    !isConnecting && speakingState === 'agent' ? playbackAnalyserRef : null

  const isDark = useIsDark()
  const orbRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = orbRef.current
    if (!el) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) {
      el.style.setProperty('--orb-amp', '0.15')
      return
    }
    let raf = 0
    let smoothed = 0.15
    let freqBuf: Uint8Array<ArrayBuffer> | null = null
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const analyser = speakingAnalyser?.current
      let target: number
      if (analyser) {
        if (!freqBuf || freqBuf.length !== analyser.frequencyBinCount) {
          freqBuf = new Uint8Array(analyser.frequencyBinCount)
        }
        analyser.getByteFrequencyData(freqBuf)
        let sum = 0
        for (let i = 0; i < freqBuf.length; i++) sum += freqBuf[i]
        target = (sum / freqBuf.length) / 255
      } else {
        // Idle: slow sinusoidal breath so the orb still feels alive
        target = 0.12 + (Math.sin(performance.now() / 1600) + 1) * 0.06
      }
      smoothed += (target - smoothed) * 0.25
      el.style.setProperty('--orb-amp', smoothed.toFixed(3))
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [speakingAnalyser])

  return (
    <div ref={orbRef} className={ORB_BASE}>
      <div className="relative z-10 blur-[2px]">
        {isConnecting ? (
          <Loader2 className="h-5 w-5 animate-spin text-blue-700/70 dark:text-blue-100/70" />
        ) : speakingAnalyser ? (
          <MiniWaveform
            analyserRef={speakingAnalyser}
            bars={12}
            width={45}
            height={30}
            color={isDark ? 'rgb(191,219,254)' : 'rgb(30,64,175)'}
          />
        ) : (
          <StaticDots count={9} size={2} dotClassName="bg-blue-800/60 dark:bg-blue-100/70" />
        )}
      </div>
    </div>
  )
}

/** Tracks whether the `dark` class is applied to <html>. */
function useIsDark() {
  const [isDark, setIsDark] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  )
  useEffect(() => {
    const el = document.documentElement
    const observer = new MutationObserver(() => {
      setIsDark(el.classList.contains('dark'))
    })
    observer.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return isDark
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
function TranscriptDisplay({ entries }: { entries: VoiceAgentTranscriptEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [entries])

  return (
    <div
      ref={scrollRef}
      className="w-full max-h-48 overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm"
      role="log"
      aria-live="polite"
      aria-label="Voice agent transcript"
    >
      {entries.map((entry, i) => (
        <div
          key={i}
          aria-label={entry.role === 'assistant' ? `Agent: ${entry.text}` : `You: ${entry.text}`}
          className={cn('mb-1.5 last:mb-0', entry.role === 'assistant' ? 'text-muted-foreground' : '')}
        >
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
