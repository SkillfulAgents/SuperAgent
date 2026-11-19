import { useEffect, useRef } from 'react'
import { observeOrbVisibility } from '@renderer/components/agents/agent-avatar/orb-visibility'
import { syntheticEnvelope } from '@renderer/lib/voice/orb/dot-orb'
import { BAND_COUNT, VoiceSpectrumMeter } from '@renderer/lib/voice/orb/voice-spectrum'
import { useIsDark } from '@renderer/hooks/use-theme'
import { cn } from '@shared/lib/utils'
import { subscribeToAmbientFrames } from '@renderer/lib/ambient-frames'

interface VoiceBarsProps {
  /** The agent's bars, in its orb's core colour. */
  agentColor: string
  /** The reply's output analyser; engines without one get a synthetic envelope while the agent speaks. */
  getAgentAnalyser: () => AnalyserNode | null
  /** The mic's analyser. Null until the mic is open. */
  getPersonAnalyser: () => AnalyserNode | null
  agentSpeaking: boolean
  personMuted: boolean
  /** Multiplies the row's size, for an orb larger than the composer's. */
  scale?: number
  className?: string
}

const BAR_WIDTH = 3
const SPACING = 3
const MAX_HEIGHT = 28
const WIDTH = BAND_COUNT * BAR_WIDTH + (BAND_COUNT - 1) * SPACING

/** Without bands, each bar's share of the level: tallest in the middle but with the edges still moving. */
const PROFILE = Array.from({ length: BAND_COUNT }, (_, i) => {
  const offset = (i - BAND_COUNT / 2) / (BAND_COUNT / 2)
  return 0.4 + 0.6 * Math.cos((offset * Math.PI) / 2)
})
/** Without bands, each bar's own flutter, in radians a second, so the row never moves as one block. */
const RATES = Array.from({ length: BAND_COUNT }, (_, i) => 5.5 + ((i * 2.37) % 4.6))

function heightsOf(bands: readonly number[] | null, level: number, time: number, seed: number, still: boolean, out: number[]) {
  for (let i = 0; i < BAND_COUNT; i++) {
    const flutter = still ? 1 : 0.62 + 0.38 * Math.sin(time * RATES[i] + seed + i * 1.7)
    const share = bands ? bands[i] : level * PROFILE[i] * flutter
    out[i] = BAR_WIDTH + (MAX_HEIGHT - BAR_WIDTH) * Math.min(1, share)
  }
  return out
}

/** How fast the row hands over to the person's voice and back, per second: quick to answer them, slower to let go between words. */
const TO_PERSON_RATE = 14
const TO_AGENT_RATE = 4
/** The mic level the agent's own reply can leave behind echo cancellation, which the person's voice must clear to take the row while the agent speaks. */
const SPEAKING_ECHO_FLOOR = 0.02
/** A still indication of speech when reduced motion is requested and there is no measured output. */
const STATIC_AGENT_LEVEL = 0.8

/**
 * Both voices in one row of bars, the iOS call screen's, one voice at a time
 * so the two never sit on top of each other: the agent's, in its orb's
 * colour, while it speaks and at rest, and the person's, in the foreground
 * colour, whenever they talk, over the reply too. The row morphs from one to the other. Each bar
 * is a frequency band, lowest on the left, where there is an analyser to hear
 * the audio; where there is only a level, the bars share it with a flutter.
 * At rest the agent's bars are a row of dots. Reduced motion keeps measured
 * levels, drops the flutter and holds unmetered speech at a fixed level.
 */
export function VoiceBars({ agentColor, getAgentAnalyser, getPersonAnalyser, agentSpeaking, personMuted, scale = 1, className }: VoiceBarsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const isDark = useIsDark()
  const latest = useRef({ agentColor, getAgentAnalyser, getPersonAnalyser, agentSpeaking, personMuted, personColor: '' })
  latest.current = { ...latest.current, agentColor, getAgentAnalyser, getPersonAnalyser, agentSpeaking, personMuted }

  // The person's colour is the theme's foreground, read off the canvas's own `color`.
  useEffect(() => {
    if (canvasRef.current) latest.current.personColor = getComputedStyle(canvasRef.current).color
  }, [isDark])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(2, window.devicePixelRatio || 1) * scale
    canvas.width = Math.round(WIDTH * dpr)
    canvas.height = Math.round(MAX_HEIGHT * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const agent = new VoiceSpectrumMeter()
    const person = new VoiceSpectrumMeter()
    const heights = new Array<number>(BAND_COUNT)
    const personHeights = new Array<number>(BAND_COUNT)
    const paintedHeights = new Array<number>(BAND_COUNT).fill(-1)
    let paintedShare = -1
    let paintedAgentColor = ''
    let paintedPersonColor = ''
    // How much of the row is the person's: 0 is the agent's, 1 theirs.
    let share = 0

    const row = (color: string, alpha: number) => {
      ctx.globalAlpha = alpha
      ctx.fillStyle = color
      ctx.beginPath()
      for (let i = 0; i < BAND_COUNT; i++) {
        ctx.roundRect(i * (BAR_WIDTH + SPACING), (MAX_HEIGHT - heights[i]) / 2, BAR_WIDTH, heights[i], BAR_WIDTH / 2)
      }
      ctx.fill()
    }

    let unsubscribe: (() => void) | undefined
    let last = 0
    const tick = (now: number) => {
      const dt = Math.min(0.1, last ? (now - last) / 1000 : 1 / 60)
      last = now
      const time = now / 1000
      const current = latest.current
      const agentAnalyser = current.agentSpeaking ? current.getAgentAnalyser() : null
      const fallbackLevel = current.agentSpeaking && !agentAnalyser
        ? (still ? STATIC_AGENT_LEVEL : syntheticEnvelope(time, 1.7)) : 0
      // Unmetered speech is a still state under reduced motion, including its onset and end.
      if (still && !agentAnalyser) agent.level = fallbackLevel
      agent.advance(agentAnalyser, fallbackLevel, dt)
      person.advance(current.personMuted ? null : current.getPersonAnalyser(), 0, dt)

      // The row is the person's as soon as they are heard, the agent's otherwise, so
      // talking over the reply shows at once. While the agent speaks the mic has to
      // clear what echo cancellation leaves of the reply first.
      const heard = Math.max(0, person.level - (current.agentSpeaking ? SPEAKING_ECHO_FLOOR : 0))
      const target = Math.min(1, heard * 10)
      share += (target - share) * (1 - Math.exp(-(target > share ? TO_PERSON_RATE : TO_AGENT_RATE) * dt))
      heightsOf(agent.bands, agent.level, time, 0, still, heights)
      if (share > 0.001) {
        heightsOf(person.bands, person.level, time, 2.1, still, personHeights)
        for (let i = 0; i < BAND_COUNT; i++) heights[i] += (personHeights[i] - heights[i]) * share
      }
      // Keep sampling: an analyser can connect without a React render. Repaint only
      // visible changes, ignoring less than a tenth of a device pixel or one alpha step.
      const changed = current.agentColor !== paintedAgentColor || current.personColor !== paintedPersonColor
        || Math.abs(share - paintedShare) >= 1 / 255
        || heights.some((height, i) => Math.abs(height - paintedHeights[i]) * dpr >= 0.1)
      if (changed) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, WIDTH, MAX_HEIGHT)
        // One set of bars, its colour blended between the two voices' while it hands over.
        if (share < 0.999) row(current.agentColor, 1)
        if (share > 0.001) row(current.personColor, share)
        for (let i = 0; i < BAND_COUNT; i++) paintedHeights[i] = heights[i]
        paintedShare = share
        paintedAgentColor = current.agentColor
        paintedPersonColor = current.personColor
      }
    }
    // Live, like the voice orb: on screen, in a shown document, focus or not (ambient-frames.ts).
    const start = () => {
      if (unsubscribe) return
      last = 0
      unsubscribe = subscribeToAmbientFrames(tick, { kind: 'live' })
    }
    const stop = () => {
      unsubscribe?.()
      unsubscribe = undefined
    }
    const unobserve = observeOrbVisibility(canvas, visible => (visible ? start() : stop()))
    return () => {
      unobserve()
      stop()
    }
  }, [scale])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-testid="voice-bars"
      className={cn('block text-foreground', className)}
      style={{ width: WIDTH * scale, height: MAX_HEIGHT * scale }}
    />
  )
}
