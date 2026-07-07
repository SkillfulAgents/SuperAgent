import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { MiniWaveform } from '@renderer/components/ui/mini-waveform'
import { Loader2, Mic, MicOff, Phone, RotateCcw } from 'lucide-react'
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
export function VoiceAgent({ config, onResult, layout = 'vertical', className }: VoiceAgentProps) {
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
    micAnalyserRef,
    playbackAnalyserRef,
    start,
    stop,
    setMicMuted,
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

  // Push-to-talk: mic is muted unless the user is holding the Space bar.
  // Listener is attached at document capture phase so it runs ahead of Radix
  // Dialog's focus-trap (which can otherwise swallow the event).
  const [pttHeld, setPttHeld] = useState(false)
  useEffect(() => {
    if (!isActive) return

    setMicMuted(true)
    setPttHeld(false)

    const isEditableTarget = (el: Element | null): boolean => {
      if (!(el instanceof HTMLElement)) return false
      if (el.isContentEditable) return true
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditableTarget(document.activeElement)) return
      e.preventDefault()
      setPttHeld(true)
      setMicMuted(false)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      if (isEditableTarget(document.activeElement)) return
      e.preventDefault()
      setPttHeld(false)
      setMicMuted(true)
    }
    // Window blur (alt-tab, focus lost) — release so the mic doesn't get stuck open.
    const onBlur = () => {
      setPttHeld(false)
      setMicMuted(true)
    }

    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      setMicMuted(true)
      setPttHeld(false)
    }
  }, [isActive, setMicMuted])

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
      playbackAnalyserRef={playbackAnalyserRef}
    />
  )

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
          /* Visual-only mic indicator — actual gating is the Space bar. */
          <Button
            type="button"
            variant="outline"
            tabIndex={-1}
            aria-label={pttHeld ? 'Microphone live' : 'Microphone muted'}
            aria-live="polite"
            className={cn(
              'cursor-default gap-2 transition-colors hover:bg-background hover:text-current',
              pttHeld
                ? 'border-foreground text-foreground animate-voice-listening'
                : 'text-muted-foreground'
            )}
          >
            {pttHeld ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
            <span className="flex items-center gap-1 text-xs">
              {pttHeld ? (
                <MiniWaveform
                  analyserRef={micAnalyserRef}
                  width={56}
                  height={18}
                  color="black"
                />
              ) : (
                <>
                  Hold <kbd className="px-1 py-0.5 rounded border border-current bg-muted text-[9px] font-mono leading-none">Space</kbd> to talk
                </>
              )}
            </span>
          </Button>
        )}
      </div>
    </TooltipProvider>
  )

  // Top-right corner restart button — mirrors the Dialog X close's geometry
  // (same top-4 / h-4 w-4 icon / opacity treatment) so they align in the same row.
  const cornerRestart = state !== 'idle' ? (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleRestart}
            disabled={isConnecting}
            aria-label="Restart"
            className="absolute top-3 right-10 z-50 flex h-6 w-6 items-center justify-center rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none"
          >
            <RotateCcw className="h-3 w-3" />
            <span className="sr-only">Restart</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>Issues? Try restarting.</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : null

  if (layout === 'split') {
    const fadeMask = 'linear-gradient(to bottom, transparent 0, black 72px, black calc(100% - 72px), transparent 100%)'
    const showTranscript = transcript.length > 0
    return (
      <div className={cn('relative flex flex-col h-full', className)}>
        {cornerRestart}
        {/* Top: two-column content. Right column collapses to 0 until first message arrives. */}
        <div
          className="grid flex-1 min-h-0 transition-[grid-template-columns] duration-500 ease-in-out"
          style={{ gridTemplateColumns: showTranscript ? '1fr 1fr' : '1fr 0fr' }}
        >
          {/* Left column: indicator, status — centered vertically */}
          <div className="flex flex-col items-center justify-center gap-4 p-6 min-w-0">
            {indicator}
            {errorDisplay}
          </div>

          {/* Right column: full-bleed transcript with top/bottom fade */}
          <div
            className="overflow-hidden min-w-0 min-h-0"
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
    <div className={cn('relative flex flex-col items-center gap-4 p-6', className)}>
      {cornerRestart}
      {indicator}
      {errorDisplay}
      {transcript.length > 0 && <TranscriptDisplay entries={transcript} />}
      {controls}
    </div>
  )
}

const ORB_BASE = 'voice-agent-orb relative flex h-[150px] w-[150px] items-center justify-center rounded-full'

/** Waveform / idle dots indicator. Bars animate only when the agent is speaking. */
function SpeakingIndicator({
  speakingState,
  isConnecting,
  playbackAnalyserRef,
}: {
  speakingState: 'none' | 'user' | 'agent'
  isConnecting: boolean
  playbackAnalyserRef: React.RefObject<AnalyserNode | null>
}) {
  const speakingAnalyser = !isConnecting && speakingState === 'agent' ? playbackAnalyserRef : null

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
          <div className="translate-y-3">
            <MiniWaveform
              analyserRef={speakingAnalyser}
              bars={12}
              width={45}
              height={30}
              color={isDark ? 'rgb(191,219,254)' : 'rgb(30,64,175)'}
            />
          </div>
        ) : (
          <div className="translate-y-3">
            <StaticDots count={9} size={2} dotClassName="bg-blue-800/60 dark:bg-blue-100/70" />
          </div>
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

