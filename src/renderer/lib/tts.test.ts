import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTtsAdapter, DeepgramTtsAdapter, type TtsEvent } from './tts'
import { MockWebSocket } from '@shared/test/mock-websocket'

class BinaryMockWebSocket extends MockWebSocket {
  binaryType = 'blob'
  simulateAudio(bytes: number[]): void {
    // The adapter's onmessage narrows on `instanceof ArrayBuffer`.
    ;(this.onmessage as unknown as (ev: { data: ArrayBuffer }) => void)?.({ data: new Uint8Array(bytes).buffer })
  }
}

const sentJson = (ws: MockWebSocket) => ws.sent.map((s) => JSON.parse(s as string))

describe('DeepgramTtsAdapter', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', BinaryMockWebSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function connect() {
    const adapter = new DeepgramTtsAdapter()
    const audio: ArrayBuffer[] = []
    const events: TtsEvent[] = []
    adapter.onAudio((chunk) => audio.push(chunk))
    adapter.onEvent((e) => events.push(e))
    const connected = adapter.connect('jwt-token', 'aura-2-thalia-en')
    const ws = MockWebSocket.instances[0] as BinaryMockWebSocket
    return { adapter, ws, audio, events, connected }
  }

  it('opens the speak endpoint with the voice as model, linear16 at 24kHz, bearer-authenticated', () => {
    const { ws, adapter } = connect()
    const url = new URL(ws.url)
    expect(url.origin + url.pathname).toBe('wss://api.deepgram.com/v1/speak')
    expect(url.searchParams.get('model')).toBe('aura-2-thalia-en')
    expect(url.searchParams.get('encoding')).toBe('linear16')
    expect(url.searchParams.get('sample_rate')).toBe('24000')
    expect(ws.protocols).toEqual(['bearer', 'jwt-token'])
    expect(ws.binaryType).toBe('arraybuffer')
    expect(adapter.sampleRate).toBe(24000)
  })

  it('buffers text queued before the socket opens and sends it in order on open', async () => {
    const { adapter, ws, connected } = connect()
    adapter.speak('Hello.')
    adapter.flush()
    expect(ws.sent).toHaveLength(0)
    ws.simulateOpen()
    await connected
    expect(sentJson(ws)).toEqual([{ type: 'Speak', text: 'Hello.' }, { type: 'Flush' }])
  })

  it('sends immediately once open, and ignores empty text', async () => {
    const { adapter, ws, connected } = connect()
    ws.simulateOpen()
    await connected
    adapter.speak('')
    adapter.speak('More.')
    adapter.clear()
    expect(sentJson(ws)).toEqual([{ type: 'Speak', text: 'More.' }, { type: 'Clear' }])
  })

  it('delivers binary frames as audio and JSON frames as events', async () => {
    const { ws, audio, events, connected } = connect()
    ws.simulateOpen()
    await connected
    ws.simulateAudio([1, 2, 3, 4])
    ws.simulateAudio([]) // empty keepalive-style frame is dropped
    ws.simulateMessage({ type: 'Metadata', request_id: 'r' })
    ws.simulateMessage({ type: 'Flushed', sequence_id: 0 })
    ws.simulateMessage({ type: 'Cleared', sequence_id: 1 })
    expect(audio.map((a) => a.byteLength)).toEqual([4])
    expect(events).toEqual([
      { type: 'flushed', sequenceId: 0 },
      { type: 'cleared', sequenceId: 1 },
    ])
  })

  it('surfaces server errors and abnormal closes as error events', async () => {
    const { ws, events, connected } = connect()
    ws.simulateOpen()
    await connected
    ws.simulateMessage({ type: 'Error', description: 'bad voice' })
    ws.simulateClose(1011, 'boom')
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'error', error: expect.objectContaining({ message: 'bad voice' }) })
    expect(events[1]).toMatchObject({ type: 'error', error: expect.objectContaining({ message: 'Deepgram speak connection closed: 1011 boom' }) })
  })

  it('a normal close after close() is silent', async () => {
    const { adapter, ws, events, connected } = connect()
    ws.simulateOpen()
    await connected
    adapter.close()
    ws.simulateClose(1000)
    expect(events).toEqual([])
    expect(ws.readyState).toBe(MockWebSocket.CLOSED)
  })

  it('rejects connect() when the socket fails before opening', async () => {
    const { ws, connected } = connect()
    ws.onerror?.({})
    await expect(connected).rejects.toThrow('Deepgram speak WebSocket connection failed')
  })
})

describe('createTtsAdapter', () => {
  it('maps deepgram and platform to the Deepgram adapter', () => {
    expect(createTtsAdapter('deepgram')).toBeInstanceOf(DeepgramTtsAdapter)
    expect(createTtsAdapter('platform')).toBeInstanceOf(DeepgramTtsAdapter)
  })

  it('rejects providers without text-to-speech', () => {
    expect(() => createTtsAdapter('openai')).toThrow('Text-to-speech not supported by openai')
  })
})
