import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startAudioCapture } from './audio-capture'

describe('startAudioCapture', () => {
  class FakeNode {
    connections: unknown[] = []
    connect(target: unknown) { this.connections.push(target) }
    disconnect = vi.fn()
  }
  class FakeWorkletNode extends FakeNode {
    port: { onmessage: ((e: { data: Float32Array }) => void) | null } = { onmessage: null }
    static instances: FakeWorkletNode[] = []
    constructor(public ctx: unknown, public name: string) {
      super()
      FakeWorkletNode.instances.push(this)
    }
  }
  class FakeProcessor extends FakeNode {
    onaudioprocess: ((e: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null = null
  }
  function fakeContext(options: { worklet?: 'ok' | 'fails' | 'absent' } = {}) {
    const processors: FakeProcessor[] = []
    const ctx = {
      sampleRate: 16000,
      state: 'running',
      destination: { id: 'destination' },
      resume: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      createMediaStreamSource: () => new FakeNode(),
      createAnalyser: () => ({ fftSize: 0, smoothingTimeConstant: 0 }),
      createScriptProcessor: () => {
        const p = new FakeProcessor()
        processors.push(p)
        return p
      },
      audioWorklet: options.worklet === 'absent' ? undefined : {
        addModule: vi.fn(async () => {
          if (options.worklet === 'fails') throw new Error('no worklets here')
        }),
      },
    }
    return { ctx, processors }
  }
  const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream
  const sink = () => ({ sendAudio: vi.fn() })

  beforeEach(() => {
    FakeWorkletNode.instances = []
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:worklet') })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('captures through an AudioWorklet, handing each chunk to the sink as 16-bit PCM', async () => {
    const { ctx, processors } = fakeContext({ worklet: 'ok' })
    vi.stubGlobal('AudioContext', function FakeAudioContext() { return ctx } as unknown as typeof AudioContext)
    const a = sink()
    const handle = await startAudioCapture(a, stream)
    expect(handle.captureKind).toBe('worklet')
    expect(processors).toHaveLength(0)
    const node = FakeWorkletNode.instances[0]
    expect(node.name).toBe('pcm-capture')
    expect(node.connections).toContain(ctx.destination)
    node.port.onmessage?.({ data: Float32Array.from([0, 0.5, -0.5, 1]) })
    expect(a.sendAudio).toHaveBeenCalledTimes(1)
    const pcm = new Int16Array(a.sendAudio.mock.calls[0][0] as ArrayBuffer)
    expect(Array.from(pcm)).toEqual([0, 16383, -16384, 32767])

    // A reconnected adapter takes over the same mic; null drops the audio.
    const b = sink()
    handle.setSink(b)
    node.port.onmessage?.({ data: Float32Array.from([0.25]) })
    expect(a.sendAudio).toHaveBeenCalledTimes(1)
    expect(b.sendAudio).toHaveBeenCalledTimes(1)
    handle.setSink(null)
    node.port.onmessage?.({ data: Float32Array.from([0.25]) })
    expect(b.sendAudio).toHaveBeenCalledTimes(1)

    handle.cleanup()
    expect(node.disconnect).toHaveBeenCalled()
    expect(ctx.close).toHaveBeenCalled()
  })

  it('falls back to a ScriptProcessor where the worklet cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, processors } = fakeContext({ worklet: 'fails' })
    vi.stubGlobal('AudioContext', function FakeAudioContext() { return ctx } as unknown as typeof AudioContext)
    const a = sink()
    const handle = await startAudioCapture(a, stream)
    expect(handle.captureKind).toBe('script-processor')
    expect(FakeWorkletNode.instances).toHaveLength(0)
    expect(processors).toHaveLength(1)
    processors[0].onaudioprocess?.({ inputBuffer: { getChannelData: () => Float32Array.from([1]) } })
    expect(a.sendAudio).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('falls back to a ScriptProcessor where there is no worklet API at all', async () => {
    const { ctx, processors } = fakeContext({ worklet: 'absent' })
    vi.stubGlobal('AudioContext', function FakeAudioContext() { return ctx } as unknown as typeof AudioContext)
    await startAudioCapture(sink(), stream)
    expect(processors).toHaveLength(1)
  })
})
