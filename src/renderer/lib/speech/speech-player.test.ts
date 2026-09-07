import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SpeechPlayer, type SpeechPlayerStatus } from './speech-player'
import type { TtsAdapter, TtsAudioCallback, TtsEventCallback } from '@renderer/lib/tts'
import type { SpokenWord } from './spoken-words'

const SAMPLE_RATE = 24000

/** Scripted TtsAdapter: records what was sent, lets tests push audio/events. */
class FakeAdapter implements TtsAdapter {
  readonly sampleRate = SAMPLE_RATE
  sent: string[] = []
  closed = false
  cleared = false
  audioCb: TtsAudioCallback | null = null
  eventCb: TtsEventCallback | null = null
  connectResult: Promise<void> = Promise.resolve()

  connect(): Promise<void> { return this.connectResult }
  speak(text: string): void { this.sent.push(`speak:${text}`) }
  flush(): void { this.sent.push('flush') }
  clear(): void { this.cleared = true }
  onAudio(cb: TtsAudioCallback): void { this.audioCb = cb }
  onEvent(cb: TtsEventCallback): void { this.eventCb = cb }
  close(): void { this.closed = true }

  /** Push `seconds` of silence as int16 PCM. */
  pushAudio(seconds: number): void {
    this.audioCb?.(new ArrayBuffer(Math.round(seconds * SAMPLE_RATE) * 2))
  }
  pushFlushed(): void {
    this.eventCb?.({ type: 'flushed', sequenceId: 0 })
  }
}

/** Minimal AudioContext with a settable clock and recorded schedule. */
class FakeAudioContext {
  currentTime = 0
  state: AudioContextState = 'running'
  destination = {} as AudioDestinationNode
  scheduled: { at: number; duration: number }[] = []
  closed = false
  resume = vi.fn(async () => { this.state = 'running' })
  suspend = vi.fn(async () => { this.state = 'suspended' })
  close = vi.fn(async () => { this.closed = true })
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return {
      duration: length / sampleRate,
      copyToChannel: vi.fn(),
    } as unknown as AudioBuffer
  }
  createBufferSource() {
    const ctx = this
    const source = {
      buffer: null as AudioBuffer | null,
      connect: vi.fn(),
      start(at: number) {
        ctx.scheduled.push({ at, duration: source.buffer!.duration })
      },
    }
    return source as unknown as AudioBufferSourceNode
  }
}

function words(text: string): SpokenWord[] {
  return text.split(/\s+/).filter(Boolean).map((t) => ({ text: t, blockEnd: false }))
}

function setup() {
  const adapter = new FakeAdapter()
  const ctx = new FakeAudioContext()
  const statuses: SpeechPlayerStatus[] = []
  const errors: (Error | undefined)[] = []
  const player = new SpeechPlayer({
    adapter,
    token: 't',
    voice: { voice: 'v' },
    onStatus: (s, e) => { statuses.push(s); errors.push(e) },
    createAudioContext: () => ctx as unknown as AudioContext,
  })
  return { adapter, ctx, player, statuses, errors }
}

describe('SpeechPlayer', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('sends each sentence as its own speak+flush batch as words arrive', () => {
    const { adapter, player } = setup()
    player.start()
    player.append(words('First one here. Second'))
    expect(adapter.sent).toEqual(['speak:First one here.', 'flush'])
    player.append(words('sentence done.'))
    player.end()
    expect(adapter.sent).toEqual([
      'speak:First one here.', 'flush',
      'speak:Second sentence done.', 'flush',
    ])
    expect(player.totalWords).toBe(6)
  })

  it('schedules audio back to back and reports speaking on the first chunk', () => {
    const { adapter, ctx, player, statuses } = setup()
    player.start()
    player.append(words('Hello world now.'))
    player.end()
    expect(player.status).toBe('connecting')
    adapter.pushAudio(0.5)
    adapter.pushAudio(0.25)
    expect(statuses).toEqual(['speaking'])
    expect(ctx.scheduled).toEqual([
      { at: 0.05, duration: 0.5 },
      { at: 0.55, duration: 0.25 },
    ])
  })

  it('tracks the spoken word by interpolating inside the current segment', () => {
    const { adapter, ctx, player } = setup()
    player.start()
    player.append(words('One two three four. Five six.'))
    player.end()
    expect(player.getWordCursor()).toBe(-1)

    adapter.pushAudio(1) // segment 0: 4 words over 1s starting at 0.05
    adapter.pushFlushed()
    adapter.pushAudio(0.5) // segment 1: 2 words over 0.5s starting at 1.05
    adapter.pushFlushed()

    ctx.currentTime = 0.05
    expect(player.getWordCursor()).toBe(0)
    ctx.currentTime = 0.55
    expect(player.getWordCursor()).toBeCloseTo(2)
    ctx.currentTime = 1.05
    expect(player.getWordCursor()).toBe(4)
    ctx.currentTime = 1.3
    expect(player.getWordCursor()).toBeCloseTo(5)
    ctx.currentTime = 2
    expect(player.getWordCursor()).toBe(6)
  })

  it('holds the cursor at the end of the last received segment while the next is still buffering', () => {
    const { adapter, ctx, player } = setup()
    player.start()
    player.append(words('One two three. Four five six.'))
    player.end()
    adapter.pushAudio(1)
    adapter.pushFlushed()
    ctx.currentTime = 5 // well past segment 0, segment 1 audio not here yet
    expect(player.getWordCursor()).toBe(3)
  })

  it('finishes once every segment is flushed and the schedule has drained', () => {
    const { adapter, ctx, player, statuses } = setup()
    player.start()
    player.append(words('Only one sentence.'))
    player.end()
    adapter.pushAudio(1)
    adapter.pushFlushed()
    expect(adapter.closed).toBe(true) // socket released as soon as all audio is in
    expect(player.status).toBe('speaking')
    // done timer was armed at t=0 for the 1.05s of scheduled audio plus grace
    vi.advanceTimersByTime(1000)
    expect(player.status).toBe('speaking')
    ctx.currentTime = 1.05
    vi.advanceTimersByTime(200)
    expect(statuses).toEqual(['speaking', 'done'])
    expect(player.getWordCursor()).toBe(3)
    expect(ctx.closed).toBe(true)
  })

  it('pause() freezes the cursor and defers finishing until resume()', () => {
    const { adapter, ctx, player, statuses } = setup()
    player.start()
    player.append(words('One two three four.'))
    player.end()
    adapter.pushAudio(1)
    ctx.currentTime = 0.55
    expect(player.getWordCursor()).toBeCloseTo(2)

    player.pause()
    expect(ctx.state).toBe('suspended')
    expect(player.status).toBe('paused')
    // All audio arrives while paused: no done timer may be armed against the frozen clock.
    adapter.pushFlushed()
    vi.advanceTimersByTime(5000)
    expect(player.status).toBe('paused')
    expect(player.getWordCursor()).toBeCloseTo(2)

    player.resume()
    expect(ctx.state).toBe('running')
    expect(player.status).toBe('speaking')
    ctx.currentTime = 1.05
    vi.advanceTimersByTime(1000)
    expect(statuses).toEqual(['speaking', 'paused', 'speaking', 'done'])
  })

  it('never reads backwards while a segment\'s audio is still arriving', () => {
    const { adapter, ctx, player } = setup()
    player.start()
    player.append(words('One two three four five six seven eight.'))
    player.end()
    adapter.pushAudio(1) // 8 words, 1s known so far
    ctx.currentTime = 0.55
    expect(player.getWordCursor()).toBeCloseTo(4)
    adapter.pushAudio(1) // the segment turns out to be 2s: raw position would drop to ~2
    expect(player.getWordCursor()).toBeCloseTo(4)
    ctx.currentTime = 1.55
    expect(player.getWordCursor()).toBeCloseTo(6)
  })

  it('pause() is a no-op unless speaking; resume() unless paused', () => {
    const { adapter, player, statuses } = setup()
    player.start()
    player.pause()
    player.resume()
    expect(statuses).toEqual([])
    player.append(words('Hi there friend.'))
    adapter.pushAudio(1)
    player.resume()
    expect(player.status).toBe('speaking')
  })

  it('a first-word offset shifts the cursor onto the whole message', () => {
    const adapter = new FakeAdapter()
    const ctx = new FakeAudioContext()
    const player = new SpeechPlayer({ adapter, token: 't', voice: { voice: 'v' }, firstWordIndex: 10, createAudioContext: () => ctx as unknown as AudioContext })
    player.start()
    expect(player.getWordCursor()).toBe(10) // the word the restart took over stays lit
    player.append(words('One two three four.'))
    player.end()
    adapter.pushAudio(1)
    adapter.pushFlushed()
    ctx.currentTime = 0.55
    expect(player.getWordCursor()).toBeCloseTo(12)
    ctx.currentTime = 1.05
    vi.advanceTimersByTime(2000)
    expect(player.status).toBe('done')
    expect(player.getWordCursor()).toBe(14)
  })

  it('hands the synthesizer only a couple of segments ahead of playback', () => {
    const { adapter, ctx, player } = setup()
    player.start()
    player.append(words('One two three. Four five six. Seven eight nine. Ten eleven twelve.'))
    player.end()
    // Two in flight; the third waits for a flush.
    expect(adapter.sent.filter((s) => s.startsWith('speak:'))).toHaveLength(2)
    adapter.pushAudio(1)
    adapter.pushFlushed()
    expect(adapter.sent.filter((s) => s.startsWith('speak:'))).toHaveLength(3)
    // Enough audio buffered (12s > AHEAD): the fourth waits for the buffer to run down.
    adapter.pushAudio(12)
    adapter.pushFlushed()
    expect(adapter.sent.filter((s) => s.startsWith('speak:'))).toHaveLength(3)
    ctx.currentTime = 4
    vi.advanceTimersByTime(3500)
    expect(adapter.sent.filter((s) => s.startsWith('speak:'))).toHaveLength(4)
    expect(player.status).toBe('speaking')
  })

  it('a connection the server closes before the reply is in is an error, not a stall', () => {
    const { adapter, player, statuses, errors } = setup()
    player.start()
    player.append(words('One two three. Four five six.'))
    player.end()
    adapter.pushAudio(1)
    adapter.pushFlushed()
    adapter.eventCb?.({ type: 'closed' })
    expect(statuses).toEqual(['speaking', 'error'])
    expect(errors[1]?.message).toMatch(/closed before the reply finished/)
  })

  it('a refused audio-context resume is an error', async () => {
    const { ctx, player, statuses, errors } = setup()
    ctx.state = 'suspended'
    ctx.resume.mockRejectedValueOnce(new Error('NotAllowedError'))
    player.start()
    await Promise.resolve()
    await Promise.resolve()
    expect(statuses).toEqual(['error'])
    expect(errors[0]?.message).toMatch(/blocked by the browser/)
  })

  it('finishes immediately when there is nothing to say', () => {
    const { player, statuses } = setup()
    player.start()
    player.end()
    expect(statuses).toEqual(['done'])
  })

  it('stop() clears the synthesizer and tears down output', () => {
    const { adapter, ctx, player, statuses } = setup()
    player.start()
    player.append(words('Some words here.'))
    adapter.pushAudio(1)
    player.stop()
    expect(adapter.cleared).toBe(true)
    expect(adapter.closed).toBe(true)
    expect(ctx.closed).toBe(true)
    expect(statuses).toEqual(['speaking', 'stopped'])
    // late audio after stop is ignored
    adapter.pushAudio(1)
    expect(ctx.scheduled).toHaveLength(1)
  })

  it('reports adapter errors and a failed connect', async () => {
    const { adapter, player, statuses, errors } = setup()
    player.start()
    adapter.eventCb?.({ type: 'error', error: new Error('nope') })
    expect(statuses).toEqual(['error'])
    expect(errors[0]?.message).toBe('nope')

    const failing = setup()
    failing.adapter.connectResult = Promise.reject(new Error('down'))
    failing.player.start()
    await Promise.resolve()
    await Promise.resolve()
    expect(failing.statuses).toEqual(['error'])
    expect(failing.errors[0]?.message).toBe('down')
  })

  it('stitches a sample split across two frames instead of dropping bytes', () => {
    const { adapter, ctx, player } = setup()
    player.start()
    player.append(words('Hi there friend.'))
    adapter.audioCb?.(new Uint8Array([0, 1, 2]).buffer) // 1.5 samples
    adapter.audioCb?.(new Uint8Array([3, 4, 5]).buffer) // + 1.5 → 3 samples total
    const samples = ctx.scheduled.map((s) => Math.round(s.duration * SAMPLE_RATE))
    expect(samples).toEqual([1, 2])
  })

  it('resumes a suspended audio context', () => {
    const { ctx, player } = setup()
    ctx.state = 'suspended'
    player.start()
    expect(ctx.resume).toHaveBeenCalled()
  })
})
