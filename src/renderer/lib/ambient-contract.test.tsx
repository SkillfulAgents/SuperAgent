// @vitest-environment jsdom
import type { ReactElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ORBS } from '@shared/lib/types/agent-avatar-orbs'
import { orbShape } from '@shared/lib/types/agent-avatar-shapes'
import { OrbAvatar } from '@renderer/components/agents/agent-avatar/orb-avatar'
import { Halftone } from '@renderer/components/agents/halftone'
import { HomeEmptyClouds } from '@renderer/components/home/home-empty-clouds'
import { ActivityOrb } from '@renderer/components/messages/activity-orb'
import { VoiceBars } from '@renderer/components/messages/voice-bars'
import { VoiceOrb } from '@renderer/components/messages/voice-orb'
import { MiniWaveform } from '@renderer/components/ui/mini-waveform'
import { RibbonWave } from '@renderer/components/wizard/ribbon-wave'
import { TeamBrainDiagram } from '@renderer/components/team-brain/team-brain-diagram'
import { TeamBrainRadial } from '@renderer/components/team-brain/team-brain-radial'
import { AMBIENT_SLOW_MS } from './ambient-frames'

vi.mock('@renderer/hooks/use-agents', () => ({ useAgents: () => ({ data: [] }) }))

/**
 * The contract every ambient animation keeps (docs/animations.md): in a window
 * that is shown but not the one in use, it is still painted, and what it shows
 * is still current. Stopping the clock for everything broke both, each
 * component in its own way (a blank canvas where one mounted, an avatar frozen
 * on the state before last), so each is held to it here, by its kind:
 * decoration is painted and then costs nothing, status and live stay current.
 * A new animated component gets a row. The three that need a whole feature
 * mocked to mount keep theirs beside their other tests: the audio preview's
 * playhead, the microphone test's meter and the read-aloud highlight, all live.
 */

/** Canvas calls that put pixels down. */
const PAINTS = new Set(['fill', 'stroke', 'fillRect', 'strokeRect', 'drawImage', 'putImageData', 'fillText'])

/** A 2D context that accepts anything and counts what was painted. */
function recordingContext() {
  const record = { paints: 0 }
  const made: Record<string | symbol, unknown> = {}
  const gradient = { addColorStop() {} }
  const context = new Proxy(made, {
    get(target, property) {
      if (property in target) return target[property]
      const method = (..._args: unknown[]) => {
        if (PAINTS.has(String(property))) record.paints++
        if (String(property).startsWith('create')) return gradient
        if (property === 'measureText') return { width: 0 }
        if (property === 'getImageData') return { data: new Uint8ClampedArray(4) }
        return undefined
      }
      target[property] = method
      return method
    },
    set(target, property, value) {
      target[property] = value
      return true
    },
  })
  return { context: context as unknown as CanvasRenderingContext2D, record }
}

const analyser = () =>
  ({
    context: { sampleRate: 48_000 },
    fftSize: 32,
    frequencyBinCount: 16,
    getByteFrequencyData: (data: Uint8Array) => data.fill(180),
    getByteTimeDomainData: (data: Uint8Array) => data.fill(200),
    getFloatTimeDomainData: (data: Float32Array) => data.fill(0.4),
    getFloatFrequencyData: (data: Float32Array) => data.fill(-30),
  }) as unknown as AnalyserNode

describe('ambient animation in a window that is shown but not in use', () => {
  /** The frames asked for and not yet shown, by the id each was asked under. */
  let callbacks: Map<number, FrameRequestCallback>
  let frameId: number
  let now: number
  let record: { paints: number }
  /** Every ResizeObserver on the page, to deliver a resize to. */
  let resizes: Array<() => void>

  /** Let `ms` go by: the loop's timers, and every frame of a 60 Hz display. */
  const pass = (ms: number) => {
    for (let t = 0; t < ms; t += 1000 / 60) {
      act(() => {
        vi.advanceTimersByTime(1000 / 60)
        now += 1000 / 60
        const due = [...callbacks.values()]
        callbacks.clear()
        due.forEach((callback) => callback(now))
      })
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    callbacks = new Map()
    frameId = 0
    resizes = []
    // Frame timestamps and performance.now() are one clock, as in a browser.
    now = performance.now()
    // Not the window in use: open, on screen, behind another app.
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.set(++frameId, callback)
      return frameId
    })
    // Only the frame named: a component cancelling a frame of its own must not take the loop's.
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => void callbacks.delete(id))
    const recording = recordingContext()
    record = recording.record
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(recording.context)
    // jsdom lays nothing out: every element is 320 × 180, on screen.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(180)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180, x: 0, y: 0, toJSON: () => ({}),
    })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) {
          const deliver = () =>
            this.callback(
              [{ target, contentRect: { width: 320, height: 180 } } as unknown as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            )
          resizes.push(deliver)
          deliver()
        }
        unobserve() {}
        disconnect() {}
      },
    )
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private readonly callback: IntersectionObserverCallback) {}
        observe(target: Element) {
          this.callback(
            [{ target, isIntersecting: true, intersectionRatio: 1 } as unknown as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          )
        }
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return []
        }
      },
    )
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // What each kind owes after its first frame: `again` is how long until it must have painted once more.
  // Decoration holds its frame here: it owes a picture when it mounts, and again when a resize clears it.
  const decorations: Array<{ name: string; element: ReactElement }> = [
    { name: 'Halftone card', element: <Halftone motif="flow_3d" /> },
    { name: 'Halftone pulse', element: <Halftone motif="pulse" state="alert" /> },
    { name: 'RibbonWave', element: <RibbonWave /> },
  ]

  it.each(decorations)('$name (decoration) is painted when it mounts and after a resize, and otherwise holds', ({ element }) => {
    render(element)
    pass(50)
    expect(record.paints).toBeGreaterThan(0)

    record.paints = 0
    pass(5000)
    expect(record.paints).toBe(0)
    expect(callbacks.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    act(() => resizes.forEach((resize) => resize()))
    pass(50)
    expect(record.paints).toBeGreaterThan(0)
  })

  // Status and live keep painting: `again` is how long until each must have painted once more.
  const canvases: Array<{ name: string; element: ReactElement; again: number }> = [
    { name: 'ActivityOrb working (status)', element: <ActivityOrb state="working" />, again: AMBIENT_SLOW_MS },
    { name: 'ActivityOrb spinning (status)', element: <ActivityOrb state="spinning" />, again: AMBIENT_SLOW_MS },
    { name: 'ActivityOrb compacting (status)', element: <ActivityOrb state="compacting" />, again: AMBIENT_SLOW_MS },
    { name: 'ActivityOrb waiting (status)', element: <ActivityOrb state="waiting" />, again: AMBIENT_SLOW_MS },
    { name: 'ActivityOrb retrying (status)', element: <ActivityOrb state="retrying" />, again: AMBIENT_SLOW_MS },
    { name: 'VoiceOrb (live)', element: <VoiceOrb state="agent" size={64} getAnalyser={analyser} />, again: 50 },
    {
      name: 'MiniWaveform (live)',
      element: <MiniWaveform analyserRef={{ current: analyser() }} />,
      again: 50,
    },
  ]

  it.each(canvases)('$name is painted when it mounts, and stays painted', ({ element, again }) => {
    render(element)
    pass(50)
    expect(record.paints).toBeGreaterThan(0)

    // Whatever cleared it since is put right within its clock's beat, whatever its component forgot.
    record.paints = 0
    pass(again + 50)
    expect(record.paints).toBeGreaterThan(0)
  })

  it('VoiceBars (live) is painted when it mounts, and follows the voice at once', () => {
    let speaking = false
    const bars = () => (
      <VoiceBars
        agentColor="#333"
        getAgentAnalyser={analyser}
        getPersonAnalyser={() => null}
        agentSpeaking={speaking}
        personMuted
      />
    )
    const { rerender } = render(bars())
    pass(50)
    expect(record.paints).toBeGreaterThan(0)

    // The agent starts to speak while the person works in another window.
    speaking = true
    rerender(bars())
    record.paints = 0
    pass(100)
    expect(record.paints).toBeGreaterThan(2)
  })

  it('ActivityOrb (status) paints its new state at once when it changes', () => {
    const { rerender } = render(<ActivityOrb state="working" />)
    pass(50)
    record.paints = 0
    rerender(<ActivityOrb state="retrying" />)
    pass(50)
    expect(record.paints).toBeGreaterThan(0)
  })

  it('HomeEmptyClouds (decoration) is laid out when it mounts and after a resize, and otherwise holds', () => {
    const { container } = render(<HomeEmptyClouds />)
    pass(50)
    const blobs = Array.from(container.querySelectorAll<HTMLElement>('[style*="translate"]'))
    expect(blobs.length).toBeGreaterThan(1)
    const before = blobs.map((blob) => blob.style.transform)
    pass(5000)
    expect(blobs.map((blob) => blob.style.transform)).toEqual(before)
    expect(vi.getTimerCount()).toBe(0)

    // A resize re-fits the whole stage: it has to be laid out again there and then.
    for (const blob of blobs) blob.style.transform = ''
    act(() => resizes.forEach((resize) => resize()))
    expect(blobs.map((blob) => blob.style.transform)).toEqual(before)
  })

  it('TeamBrainDiagram (decoration) is laid out when it mounts, holds, and carries on from there', () => {
    const { container } = render(<TeamBrainDiagram />)
    pass(50)
    const lines = () => Array.from(container.querySelectorAll('svg path')).map((path) => path.getAttribute('d'))
    const before = lines()
    expect(before.filter(Boolean).length).toBeGreaterThan(3)
    pass(5000)
    expect(lines()).toEqual(before)

    // Back in use: the drift carries on from the frame it held, and does not jump to where
    // five seconds would have taken it.
    vi.mocked(document.hasFocus).mockReturnValue(true)
    act(() => void window.dispatchEvent(new Event('focus')))
    pass(20)
    const numbers = (d: string | null) => (d?.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)
    const moved = lines().map((d, i) => numbers(d).map((n, j) => Math.abs(n - numbers(before[i])[j])))
    expect(Math.max(...moved.flat())).toBeLessThan(1)
    pass(1000)
    expect(lines()).not.toEqual(before)
  })

  it('TeamBrainRadial (decoration) asks for no frames once it has opened', () => {
    render(
      <TeamBrainRadial
        drive={[]}
        expanded={new Set()}
        onExpandedChange={() => {}}
        onOpenFile={() => {}}
        height={400}
        selected={null}
        onSelectedChange={() => {}}
      />,
    )
    // Its opening is a transition, and plays whatever the window: the drift after it is the decoration.
    pass(4000)
    const requested = vi.mocked(window.requestAnimationFrame).mock.calls.length
    pass(5000)
    expect(vi.mocked(window.requestAnimationFrame).mock.calls.length).toBe(requested)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('OrbAvatar (status) mounted mid-change plays it out at once, not a step a second', () => {
    render(<OrbAvatar orb={DEFAULT_ORBS[0]} shape={orbShape('circle')} diameter={28} restingPhi={-90} state="working" />)
    const dots = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-orb-layer="dot"]')).filter(
        (dot) => dot.style.display !== 'none',
      ).length
    // The dots are out within a second and a half of animation, which here is as long on the clock.
    pass(2000)
    expect(dots()).toBe(3)
  })

  it('HomeEmptyClouds (decoration) is shown in full when it mounts, with no entrance left to play', () => {
    const { container } = render(<HomeEmptyClouds />)
    pass(50)
    expect(container.querySelector<HTMLElement>('.home-empty-glow')?.style.opacity).toBe('1')
  })

  it('OrbAvatar (status) shows its state when it mounts, and a new one as soon as it changes', () => {
    const orb = (state: 'idle' | 'working') => (
      <OrbAvatar orb={DEFAULT_ORBS[0]} shape={orbShape('circle')} diameter={28} restingPhi={-90} state={state} />
    )
    const dots = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-orb-layer="dot"]')).filter(
        (dot) => dot.style.display !== 'none',
      ).length
    const { rerender } = render(orb('idle'))
    pass(50)
    expect(document.querySelector<HTMLElement>('[data-orb-layer="face"]')?.style.transform).toContain('translate')
    expect(dots()).toBe(0)

    rerender(orb('working'))
    pass(2500)
    expect(dots()).toBe(3)
  })
})
