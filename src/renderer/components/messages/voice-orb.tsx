import { useEffect, useRef } from 'react'
import { DotOrb, readLevel, smoothLevel, syntheticEnvelope, type DotOrbGround, type DotOrbState } from '@renderer/lib/voice/orb/dot-orb'
import { useIsDark } from '@renderer/hooks/use-theme'

interface VoiceOrbProps {
  state: DotOrbState
  /** Greyscale while set; colour eases in when it clears. */
  monochrome?: boolean
  /** CSS pixels, square. */
  size: number
  /**
   * Whoever is speaking now: the mic while the person talks, the reply's
   * output while the agent does. Null when there is nothing to meter; a
   * speaking state then moves to a synthetic speech envelope instead.
   */
  getAnalyser: () => AnalyserNode | null
  className?: string
}

/** Representative loudness for the one static frame reduced motion gets. */
const STATIC_LEVEL: Record<DotOrbState, number> = { boot: 0, ready: 0, thinking: 0, user: 0.75, agent: 0.8 }
/** Smoothed mic level above which a waiting orb shows the person talking: over a quiet room, under speech. */
const VOICE_ONSET_LEVEL = 0.1
/** How long it keeps showing them after the level drops, so gaps between words do not flicker it. */
const VOICE_HANGOVER_MS = 600

/**
 * The dot orb as a canvas: one renderer instance per size, a delta-time
 * loop that meters the analyser with attack-fast, release-slow smoothing,
 * paused while the tab is hidden and cancelled on unmount. Under reduced
 * motion it draws one still frame per state and runs no loop. The ground
 * follows the theme: ink on white in light, emissive on black in dark.
 */
export function VoiceOrb({ state, monochrome = false, size, getAnalyser, className }: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const orbRef = useRef<DotOrb | null>(null)
  const ground: DotOrbGround = useIsDark() ? 'dark' : 'light'
  const latest = useRef({ state, getAnalyser, ground, monochrome })
  latest.current = { state, getAnalyser, ground, monochrome }
  /** Under reduced motion: repaint the still frame for the current state. */
  const stillRef = useRef<(() => void) | null>(null)

  // The renderer lives as long as the canvas at this size; state changes
  // are handed to it below rather than rebuilding the lattice.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const orb = new DotOrb(size)
    orbRef.current = orb
    // A fresh orb assembles first, whatever state the composer is already in.
    orb.setState('boot')
    orb.setState(latest.current.state)
    orb.setGround(latest.current.ground)
    orb.setMonochrome(latest.current.monochrome)

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const paint = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      orb.draw(ctx)
    }
    if (reduceMotion) {
      // One still, legible frame; re-drawn from the state effect below.
      const still = () => {
        orb.setLevel(STATIC_LEVEL[latest.current.state])
        if (latest.current.state === 'agent') orb.pulse(1)
        orb.step(0.6)
        paint()
      }
      still()
      stillRef.current = still
      return () => { stillRef.current = null; orbRef.current = null }
    }

    let frame = 0
    let running = false
    let last = 0
    let level = 0
    let voicedAt = -Infinity
    let buffer: Uint8Array<ArrayBuffer> | null = null
    const tick = (now: number) => {
      if (!running) return
      const dt = Math.min(0.1, last ? (now - last) / 1000 : 1 / 60)
      last = now
      const { state: asked, getAnalyser: analyserOf } = latest.current
      let target = 0
      if (asked === 'user' || asked === 'agent' || asked === 'ready') {
        const analyser = analyserOf()
        if (analyser) {
          if (!buffer || buffer.length !== analyser.fftSize) buffer = new Uint8Array(analyser.fftSize)
          target = readLevel(analyser, buffer)
        } else if (asked !== 'ready') {
          target = syntheticEnvelope(now / 1000, asked === 'agent' ? 1.7 : 0)
        }
      }
      level = smoothLevel(level, target, dt)
      // Waiting for the person, the orb takes their voice from the mic itself:
      // an engine can say they are talking only once it has their words (Live's
      // come after they stop), and the stir has to move with the voice.
      if (asked === 'ready' && level > VOICE_ONSET_LEVEL) voicedAt = now
      else if (asked !== 'ready') voicedAt = -Infinity
      orb.setState(asked === 'ready' && now - voicedAt < VOICE_HANGOVER_MS ? 'user' : asked)
      orb.setLevel(level)
      orb.step(dt)
      paint()
      frame = requestAnimationFrame(tick)
    }
    const start = () => {
      if (running) return
      running = true
      last = 0
      frame = requestAnimationFrame(tick)
    }
    const stop = () => {
      running = false
      cancelAnimationFrame(frame)
    }
    const onVisibility = () => (document.visibilityState === 'hidden' ? stop() : start())
    document.addEventListener('visibilitychange', onVisibility)
    start()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      orbRef.current = null
    }
  }, [size])

  useEffect(() => {
    orbRef.current?.setState(state)
    orbRef.current?.setGround(ground)
    orbRef.current?.setMonochrome(monochrome)
    stillRef.current?.()
  }, [state, ground, monochrome])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-testid="voice-orb"
      data-orb-state={state}
      data-orb-ground={ground}
      className={className}
      style={{ width: size, height: size, display: 'block' }}
    />
  )
}
