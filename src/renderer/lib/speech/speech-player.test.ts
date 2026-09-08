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
  /** Push `seconds` of a square wave at `amplitude` (0..1), whose RMS is the amplitude. */
  pushTone(seconds: number, amplitude: number): void {
    const samples = new Int16Array(Math.round(seconds * SAMPLE_RATE))
    const value = Math.round(amplitude * 32767)
    for (let i = 0; i < samples.length; i++) samples[i] = i % 2 === 0 ? value : -value
    this.audioCb?.(samples.buffer)
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
  gains: Array<{ gain: { value: number; setTargetAtTime: ReturnType<typeof vi.fn> }; connect: ReturnType<typeof vi.fn> }> = []
  createGain() {
    const node = { gain: { value: 1, setTargetAtTime: vi.fn() }, connect: vi.fn() }
    this.gains.push(node)
    return node as unknown as GainNode
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return {
      duration: length / sampleRate,
      copyToChannel: vi.fn(),
    } as unknown as AudioBuffer
  }
  sources: Array<{ connect: ReturnType<typeof vi.fn> }> = []
  createBufferSource() {
    const ctx = this
    const source = {
      buffer: null as AudioBuffer | null,
      connect: vi.fn(),
      start(at: number) {
        ctx.scheduled.push({ at, duration: source.buffer!.duration })
      },
    }
    this.sources.push(source)
    return source as unknown as AudioBufferSourceNode
  }
}

const db = (linear: number) => 20 * Math.log10(linear)

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
    adapter.pushFlushed() // too little to measure a level: released on flush
    const samples = ctx.scheduled.map((s) => Math.round(s.duration * SAMPLE_RATE))
    expect(samples).toEqual([1, 2])
  })

  it('a failure pins the cursor where playback got to', () => {
    const { adapter, ctx, player } = setup()
    player.start()
    player.append(words('One two three four. Five six seven eight.'))
    adapter.pushTone(1, 0.05)
    adapter.pushFlushed()
    ctx.currentTime = 0.55 // halfway through the first segment's second
    adapter.eventCb?.({ type: 'error', error: new Error('boom') })
    expect(player.status).toBe('error')
    expect(player.getWordCursor()).toBeCloseTo(2, 0)
  })

  it('resumes a suspended audio context', () => {
    const { ctx, player } = setup()
    ctx.state = 'suspended'
    player.start()
    expect(ctx.resume).toHaveBeenCalled()
  })
})

describe('SpeechPlayer leveling', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** The gain node made for segment `index` (gains[0] is the master). */
  const segmentGain = (ctx: FakeAudioContext, index: number) => ctx.gains[index + 1]
  /** The gain a segment is at: set outright before it is scheduled, ramped after. */
  const lastTarget = (gain: FakeAudioContext['gains'][number]) => (gain.gain.setTargetAtTime.mock.lastCall?.[0] as number | undefined) ?? gain.gain.value

  it('brings a quiet sentence up and a loud one down, within the cap', () => {
    const { adapter, ctx, player } = setup()
    player.start()
    player.append(words('Quiet one here. Loud one here.'))
    // -34 dBFS: 11 dB under target, so the boost is capped at +6 dB.
    adapter.pushTone(0.5, 0.02)
    expect(db(lastTarget(segmentGain(ctx, 0)))).toBeCloseTo(6, 1)
    adapter.pushFlushed()
    // -14 dBFS: 9 dB over target, cut capped at -6 dB.
    adapter.pushTone(0.5, 0.2)
    expect(db(lastTarget(segmentGain(ctx, 1)))).toBeCloseTo(-6, 1)
    // Each chunk plays through its own segment's gain, which feeds the master.
    expect(ctx.sources[0].connect).toHaveBeenCalledWith(segmentGain(ctx, 0))
    expect(ctx.sources[1].connect).toHaveBeenCalledWith(segmentGain(ctx, 1))
    expect(segmentGain(ctx, 0).connect).toHaveBeenCalledWith(ctx.gains[0])
  })

  it('lands a moderately quiet sentence on the target exactly', () => {
    const { adapter, ctx, player } = setup()
    player.start()
    player.append(words('One two three.'))
    adapter.pushTone(0.5, 0.05) // -26 dBFS: 3 dB under target
    expect(db(lastTarget(segmentGain(ctx, 0)))).toBeCloseTo(3, 1)
  })

  it('a new sentence starts at the previous one\'s gain until enough of it is heard', () => {
    const { adapter, ctx, player } = setup()
    player.start()
    player.append(words('First one here. Second one here.'))
    adapter.pushTone(0.5, 0.05)
    const first = lastTarget(segmentGain(ctx, 0))
    adapter.pushFlushed()
    // 100 ms of the next sentence: too little to judge, so it inherits.
    adapter.pushTone(0.1, 0.2)
    expect(segmentGain(ctx, 1).gain.value).toBeCloseTo(first, 5)
    expect(segmentGain(ctx, 1).gain.setTargetAtTime).not.toHaveBeenCalled()
    adapter.pushTone(0.15, 0.2)
    expect(db(lastTarget(segmentGain(ctx, 1)))).toBeCloseTo(-6, 1)
  })

  it('pauses inside a sentence do not count toward its level, and silence alone sets nothing', () => {
    const { adapter, ctx, player } = setup()
    player.start()
    player.append(words('One two three.'))
    adapter.pushAudio(1)
    expect(segmentGain(ctx, 0).gain.setTargetAtTime).not.toHaveBeenCalled()
    adapter.pushTone(0.3, 0.05)
    adapter.pushAudio(2) // a long trailing pause would otherwise read as a very quiet sentence
    expect(db(lastTarget(segmentGain(ctx, 0)))).toBeCloseTo(3, 1)
  })

  it('holds a sentence back until its level is known, then plays it at its own gain from the first sample', () => {
    const { adapter, ctx, player, statuses } = setup()
    player.start()
    player.append(words('One two three four.'))
    adapter.pushTone(0.1, 0.02)
    expect(ctx.scheduled).toHaveLength(0)
    expect(statuses).toEqual([])
    adapter.pushTone(0.15, 0.02)
    // Both chunks go out together, at +6 dB, set before anything was scheduled.
    expect(ctx.scheduled).toHaveLength(2)
    expect(db(segmentGain(ctx, 0).gain.value)).toBeCloseTo(6, 1)
    expect(segmentGain(ctx, 0).gain.setTargetAtTime).not.toHaveBeenCalled()
    expect(statuses).toEqual(['speaking'])
  })

  it('a sentence too short to measure is leveled on what there is when it is flushed', () => {
    const { adapter, ctx, player } = setup()
    player.start()
    player.append(words('Yes, of course.'))
    adapter.pushTone(0.1, 0.05)
    expect(ctx.scheduled).toHaveLength(0)
    adapter.pushFlushed()
    expect(ctx.scheduled).toHaveLength(1)
    expect(db(segmentGain(ctx, 0).gain.value)).toBeCloseTo(3, 1)
  })

  it('a sentence that opens with a long pause is not held for more than half a second', () => {
    const { adapter, ctx, player } = setup()
    player.start()
    player.append(words('One two three.'))
    adapter.pushAudio(0.3)
    expect(ctx.scheduled).toHaveLength(0)
    adapter.pushAudio(0.3)
    expect(ctx.scheduled).toHaveLength(2)
    // Its level, once heard, is ramped in rather than set, since it is playing.
    adapter.pushTone(0.3, 0.05)
    expect(segmentGain(ctx, 0).gain.setTargetAtTime).toHaveBeenCalled()
    expect(db(lastTarget(segmentGain(ctx, 0)))).toBeCloseTo(3, 1)
  })

  it('a sentence already on target is left alone', () => {
    const { adapter, ctx, player } = setup()
    player.start()
    player.append(words('One two three.'))
    adapter.pushTone(0.5, 10 ** (-23 / 20))
    expect(segmentGain(ctx, 0).gain.setTargetAtTime).not.toHaveBeenCalled()
    expect(segmentGain(ctx, 0).gain.value).toBe(1)
  })
})

describe('SpeechPlayer audibility', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('is audible only while speaking with audio scheduled ahead of the playhead', () => {
    const { adapter, ctx, player } = setup()
    expect(player.isAudible).toBe(false)
    player.start()
    player.append(words('One two three.'))
    // Connected, nothing back yet.
    expect(player.isAudible).toBe(false)
    adapter.pushAudio(1)
    expect(player.isAudible).toBe(true)
    // The scheduled second has played out and the synthesizer has sent nothing more.
    ctx.currentTime = 1.5
    expect(player.isAudible).toBe(false)
    adapter.pushAudio(1)
    expect(player.isAudible).toBe(true)
    player.stop()
    expect(player.isAudible).toBe(false)
  })
})

describe('SpeechPlayer with finishOnIdleClose', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function setupIdleClose() {
    const adapter = new FakeAdapter()
    const ctx = new FakeAudioContext()
    const statuses: SpeechPlayerStatus[] = []
    const errors: (Error | undefined)[] = []
    const player = new SpeechPlayer({
      adapter,
      token: 't',
      voice: { voice: 'v' },
      finishOnIdleClose: true,
      onStatus: (s, e) => { statuses.push(s); errors.push(e) },
      createAudioContext: () => ctx as unknown as AudioContext,
    })
    return { adapter, ctx, player, statuses, errors }
  }

  it('a close once every queued segment is in finishes the player after its audio plays', () => {
    const { adapter, ctx, player, statuses } = setupIdleClose()
    player.start()
    player.append(words('One two three.'))
    // Not ended: the reply is still streaming, the synthesizer just idled out.
    adapter.pushAudio(1)
    adapter.pushFlushed()
    adapter.eventCb?.({ type: 'closed' })
    expect(statuses).toEqual(['speaking'])
    ctx.currentTime = 2
    vi.advanceTimersByTime(2000)
    expect(statuses).toEqual(['speaking', 'done'])
    expect(adapter.closed).toBe(true)
  })

  it('refuses words after an idle close while its audio plays out, and says so', () => {
    const { adapter, ctx, player } = setupIdleClose()
    player.start()
    player.append(words('One two three.'))
    adapter.pushAudio(3)
    adapter.pushFlushed()
    expect(player.acceptsWords).toBe(true)
    adapter.eventCb?.({ type: 'closed' })
    // Still speaking (three seconds are scheduled), but closed to input.
    expect(player.status).toBe('speaking')
    expect(player.acceptsWords).toBe(false)
    player.append(words('Four five six.'))
    expect(player.totalWords).toBe(3)
    expect(adapter.sent).not.toContain('speak:Four five six.')
    ctx.currentTime = 3.2
    vi.advanceTimersByTime(3300)
    expect(player.status).toBe('done')
  })

  it('a close with a segment still outstanding is still an error', () => {
    const { adapter, player, statuses, errors } = setupIdleClose()
    player.start()
    player.append(words('One two three. Four five six.'))
    adapter.pushAudio(1)
    adapter.pushFlushed()
    adapter.eventCb?.({ type: 'closed' })
    expect(statuses).toEqual(['speaking', 'error'])
    expect(errors[1]?.message).toMatch(/closed before the reply finished/)
  })
})

describe('SpeechPlayer volume', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('routes audio through a gain node and ramps it on setVolume', () => {
    const { adapter, ctx, player } = setup()
    player.start()
    expect(ctx.gains).toHaveLength(1)
    expect(ctx.gains[0].connect).toHaveBeenCalledWith(ctx.destination)
    player.append(words('Hello there now.'))
    player.end()
    adapter.pushAudio(1)
    player.setVolume(0.15)
    expect(ctx.gains[0].gain.setTargetAtTime).toHaveBeenCalledWith(0.15, ctx.currentTime, expect.any(Number))
  })

  it('a volume set before start applies to the gain node', () => {
    const { ctx, player } = setup()
    player.setVolume(0.2)
    player.start()
    expect(ctx.gains[0].gain.value).toBe(0.2)
  })
})
