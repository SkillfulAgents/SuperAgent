// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getPolyfillJs } from './speech-recognition-polyfill'

// ---------------------------------------------------------------------------
// Helpers to set up the polyfill in jsdom
// ---------------------------------------------------------------------------

function installPolyfill() {
  // jsdom doesn't execute script elements — use indirect eval to run in global scope
  const run = eval
  run(getPolyfillJs())
}

function getSpeechRecognition(): any {
  return (window as any).SpeechRecognition
}

// Minimal mock WebSocket that records sent messages and can simulate server events
class MockWebSocket {
  static instances: MockWebSocket[] = []
  url: string
  protocols: string | string[]
  readyState = 0 // CONNECTING
  onopen: ((ev: any) => void) | null = null
  onclose: ((ev: any) => void) | null = null
  onmessage: ((ev: any) => void) | null = null
  onerror: ((ev: any) => void) | null = null
  sent: any[] = []

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols || []
    MockWebSocket.instances.push(this)
    // Auto-open via microtask so it resolves within the same promise chain tick
    Promise.resolve().then(() => {
      this.readyState = 1 // OPEN
      this.onopen?.({})
    })
  }

  send(data: any) { this.sent.push(data) }
  close() { this.readyState = 3 }

  simulateMessage(data: any) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }

  simulateClose(code = 1000, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

// Mock AudioContext and getUserMedia
function mockAudioCapture() {
  const mockStream = { getTracks: () => [{ stop: vi.fn() }] }
  const mockProcessor = {
    onaudioprocess: null as any,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
  const mockSource = { connect: vi.fn() }
  const mockAudioContext = {
    state: 'running',
    resume: vi.fn().mockResolvedValue(undefined),
    createMediaStreamSource: vi.fn().mockReturnValue(mockSource),
    createScriptProcessor: vi.fn().mockReturnValue(mockProcessor),
    destination: {},
    close: vi.fn(),
  }

  ;(window as any).AudioContext = function MockAudioContext() { return mockAudioContext } as any

  // navigator.mediaDevices doesn't exist in jsdom, so we define it
  if (!navigator.mediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {},
      writable: true,
      configurable: true,
    })
  }
  ;(navigator as any).mediaDevices.getUserMedia = vi.fn().mockResolvedValue(mockStream)

  return { mockStream, mockProcessor, mockAudioContext }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SpeechRecognition polyfill', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    (window as any).WebSocket = MockWebSocket as any
    delete (window as any).SpeechRecognition
    delete (window as any).webkitSpeechRecognition
    mockAudioCapture()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('installation', () => {
    it('registers window.SpeechRecognition', () => {
      installPolyfill()
      expect(getSpeechRecognition()).toBeDefined()
      expect(typeof getSpeechRecognition()).toBe('function')
    })

    it('registers window.webkitSpeechRecognition', () => {
      installPolyfill()
      expect((window as any).webkitSpeechRecognition).toBe(getSpeechRecognition())
    })

    it('overrides existing native webkitSpeechRecognition', () => {
      // Simulate Chromium's broken stub
      ;(window as any).webkitSpeechRecognition = function NativeStub() {}
      installPolyfill()
      expect(getSpeechRecognition().name).not.toBe('NativeStub')
    })
  })

  describe('constructor and properties', () => {
    beforeEach(() => installPolyfill())

    it('creates an instance with default properties', () => {
      const SR = getSpeechRecognition()
      const r = new SR()
      expect(r.continuous).toBe(false)
      expect(r.interimResults).toBe(false)
      expect(r.lang).toBe('')
      expect(r.maxAlternatives).toBe(1)
    })

    it('is an EventTarget', () => {
      const SR = getSpeechRecognition()
      const r = new SR()
      expect(r).toBeInstanceOf(EventTarget)
      expect(typeof r.addEventListener).toBe('function')
      expect(typeof r.dispatchEvent).toBe('function')
    })

    it('supports on* event handler properties', () => {
      const SR = getSpeechRecognition()
      const r = new SR()
      const handler = vi.fn()
      r.onresult = handler
      expect(r.onresult).toBe(handler)
      r.onresult = null
      expect(r.onresult).toBe(null)
    })
  })

  describe('start() — token fetch', () => {
    beforeEach(() => installPolyfill())

    it('fetches /api/stt/token on start', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ provider: 'deepgram', token: 'test-token' }),
      })
      vi.stubGlobal('fetch', fetchSpy)

      const SR = getSpeechRecognition()
      const r = new SR()
      r.start()

      await vi.waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith('/api/stt/token')
      })
    })

    it('fires error event when token fetch returns non-ok', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'No STT provider configured' }),
      }))

      const SR = getSpeechRecognition()
      const r = new SR()
      const errorHandler = vi.fn()
      const endHandler = vi.fn()
      r.onerror = errorHandler
      r.onend = endHandler

      r.start()

      await vi.waitFor(() => {
        expect(errorHandler).toHaveBeenCalled()
      })

      const event = errorHandler.mock.calls[0][0]
      expect(event.error).toBe('service-not-allowed')
      expect(endHandler).toHaveBeenCalled()
    })

    it('throws InvalidStateError if already started', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ provider: 'deepgram', token: 'tok' }),
      }))

      const SR = getSpeechRecognition()
      const r = new SR()
      r.start()

      expect(() => r.start()).toThrow('Recognition is already started')
    })
  })

  describe('start() — full flow with Deepgram', () => {
    beforeEach(() => {
      installPolyfill()
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ provider: 'deepgram', token: 'dg-token' }),
      }))
    })

    it('fires start and audiostart events after connecting', async () => {
      const SR = getSpeechRecognition()
      const r = new SR()
      const startHandler = vi.fn()
      const audioStartHandler = vi.fn()
      r.onstart = startHandler
      r.onaudiostart = audioStartHandler

      r.start()

      await vi.waitFor(() => {
        expect(startHandler).toHaveBeenCalled()
        expect(audioStartHandler).toHaveBeenCalled()
      })
    })

    it('opens WebSocket to Deepgram with bearer token subprotocol', async () => {
      const SR = getSpeechRecognition()
      const r = new SR()
      r.start()

      await vi.waitFor(() => {
        expect(MockWebSocket.instances.length).toBeGreaterThan(0)
      })

      const ws = MockWebSocket.instances[0]
      expect(ws.url).toContain('wss://api.deepgram.com/v1/listen')
      expect(ws.protocols).toEqual(['bearer', 'dg-token'])
    })
  })

  describe('start() — full flow with OpenAI', () => {
    beforeEach(() => {
      installPolyfill()
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ provider: 'openai', token: 'oai-token' }),
      }))
    })

    it('opens WebSocket to OpenAI realtime endpoint', async () => {
      const SR = getSpeechRecognition()
      const r = new SR()
      r.start()

      await vi.waitFor(() => {
        expect(MockWebSocket.instances.length).toBeGreaterThan(0)
      })

      const ws = MockWebSocket.instances[0]
      expect(ws.url).toContain('wss://api.openai.com/v1/realtime')
      expect(ws.protocols).toContain('openai-insecure-api-key.oai-token')
    })

    it('sends session.update config after connecting', async () => {
      const SR = getSpeechRecognition()
      const r = new SR()
      r.start()

      await vi.waitFor(() => {
        const ws = MockWebSocket.instances[0]
        return expect(ws?.sent.length).toBeGreaterThan(0)
      })

      const ws = MockWebSocket.instances[0]
      const config = JSON.parse(ws.sent[0])
      expect(config.type).toBe('session.update')
      expect(config.session.type).toBe('transcription')
    })
  })

  describe('transcript events — Deepgram', () => {
    beforeEach(() => {
      installPolyfill()
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ provider: 'deepgram', token: 'tok' }),
      }))
    })

    it('fires result event with final transcript', async () => {
      const SR = getSpeechRecognition()
      const r = new SR()
      r.continuous = true
      r.interimResults = true
      const resultHandler = vi.fn()
      r.onresult = resultHandler

      r.start()

      await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1))
      // Wait for start event
      await vi.waitFor(() => expect(r._state).toBe('active'))

      const ws = MockWebSocket.instances[0]
      ws.simulateMessage({
        type: 'Results',
        is_final: true,
        channel: { alternatives: [{ transcript: 'hello world' }] },
      })

      expect(resultHandler).toHaveBeenCalled()
      const event = resultHandler.mock.calls[0][0]
      expect(event.results[0][0].transcript).toBe('hello world')
      expect(event.results[0].isFinal).toBe(true)
    })

    it('fires interim results when interimResults=true', async () => {
      const SR = getSpeechRecognition()
      const r = new SR()
      r.continuous = true
      r.interimResults = true
      const resultHandler = vi.fn()
      r.onresult = resultHandler

      r.start()
      await vi.waitFor(() => expect(r._state).toBe('active'))

      const ws = MockWebSocket.instances[0]
      ws.simulateMessage({
        type: 'Results',
        is_final: false,
        channel: { alternatives: [{ transcript: 'hel' }] },
      })

      expect(resultHandler).toHaveBeenCalled()
      const event = resultHandler.mock.calls[0][0]
      expect(event.results[0].isFinal).toBe(false)
      expect(event.results[0][0].transcript).toBe('hel')
    })

    it('suppresses interim results when interimResults=false', async () => {
      const SR = getSpeechRecognition()
      const r = new SR()
      r.continuous = true
      r.interimResults = false
      const resultHandler = vi.fn()
      r.onresult = resultHandler

      r.start()
      await vi.waitFor(() => expect(r._state).toBe('active'))

      const ws = MockWebSocket.instances[0]
      ws.simulateMessage({
        type: 'Results',
        is_final: false,
        channel: { alternatives: [{ transcript: 'hel' }] },
      })

      expect(resultHandler).not.toHaveBeenCalled()
    })

    it('auto-stops after first final result when continuous=false', async () => {
      const SR = getSpeechRecognition()
      const r = new SR()
      r.continuous = false
      r.interimResults = false
      const endHandler = vi.fn()
      r.onend = endHandler

      r.start()
      await vi.waitFor(() => expect(r._state).toBe('active'))

      const ws = MockWebSocket.instances[0]
      ws.simulateMessage({
        type: 'Results',
        is_final: true,
        channel: { alternatives: [{ transcript: 'done' }] },
      })

      expect(endHandler).toHaveBeenCalled()
    })

    it('fires speechstart on first transcript', async () => {
      const SR = getSpeechRecognition()
      const r = new SR()
      r.continuous = true
      r.interimResults = true
      const speechStartHandler = vi.fn()
      r.onspeechstart = speechStartHandler

      r.start()
      await vi.waitFor(() => expect(r._state).toBe('active'))

      const ws = MockWebSocket.instances[0]
      ws.simulateMessage({
        type: 'Results',
        is_final: false,
        channel: { alternatives: [{ transcript: 'hi' }] },
      })

      expect(speechStartHandler).toHaveBeenCalled()
    })
  })

  describe('stop() and abort()', () => {
    beforeEach(() => {
      installPolyfill()
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ provider: 'deepgram', token: 'tok' }),
      }))
    })

    it('stop() fires audioend and end events', async () => {
      const SR = getSpeechRecognition()
      const r = new SR()
      r.continuous = true
      const audioEndHandler = vi.fn()
      const endHandler = vi.fn()
      r.onaudioend = audioEndHandler
      r.onend = endHandler

      r.start()
      await vi.waitFor(() => expect(r._state).toBe('active'))

      r.stop()

      expect(audioEndHandler).toHaveBeenCalled()
      expect(endHandler).toHaveBeenCalled()
    })

    it('abort() fires end event', async () => {
      const SR = getSpeechRecognition()
      const r = new SR()
      r.continuous = true
      const endHandler = vi.fn()
      r.onend = endHandler

      r.start()
      await vi.waitFor(() => expect(r._state).toBe('active'))

      r.abort()

      expect(endHandler).toHaveBeenCalled()
    })

    it('stop() is a no-op when inactive', () => {
      const SR = getSpeechRecognition()
      const r = new SR()
      // Should not throw
      r.stop()
    })
  })

  describe('error handling', () => {
    beforeEach(() => installPolyfill())

    it('fires not-allowed error when mic is denied', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ provider: 'deepgram', token: 'tok' }),
      }))
      const micError = new DOMException('Permission denied', 'NotAllowedError')
      ;(navigator as any).mediaDevices.getUserMedia = vi.fn().mockRejectedValue(micError)

      const SR = getSpeechRecognition()
      const r = new SR()
      const errorHandler = vi.fn()
      r.onerror = errorHandler

      r.start()

      await vi.waitFor(() => expect(errorHandler).toHaveBeenCalled())
      expect(errorHandler.mock.calls[0][0].error).toBe('not-allowed')
    })

    it('fires network error when WebSocket closes unexpectedly', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ provider: 'deepgram', token: 'tok' }),
      }))

      const SR = getSpeechRecognition()
      const r = new SR()
      r.continuous = true
      const errorHandler = vi.fn()
      r.onerror = errorHandler

      r.start()
      await vi.waitFor(() => expect(r._state).toBe('active'))

      const ws = MockWebSocket.instances[0]
      ws.simulateClose(1006, 'abnormal')

      expect(errorHandler).toHaveBeenCalled()
      expect(errorHandler.mock.calls[0][0].error).toBe('network')
    })
  })

  describe('result accumulation', () => {
    beforeEach(() => {
      installPolyfill()
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ provider: 'deepgram', token: 'tok' }),
      }))
    })

    it('accumulates multiple final results in continuous mode', async () => {
      const SR = getSpeechRecognition()
      const r = new SR()
      r.continuous = true
      r.interimResults = false
      const resultHandler = vi.fn()
      r.onresult = resultHandler

      r.start()
      await vi.waitFor(() => expect(r._state).toBe('active'))

      const ws = MockWebSocket.instances[0]
      ws.simulateMessage({
        type: 'Results', is_final: true,
        channel: { alternatives: [{ transcript: 'first' }] },
      })
      ws.simulateMessage({
        type: 'Results', is_final: true,
        channel: { alternatives: [{ transcript: 'second' }] },
      })

      expect(resultHandler).toHaveBeenCalledTimes(2)
      const lastEvent = resultHandler.mock.calls[1][0]
      expect(lastEvent.results.length).toBe(2)
      expect(lastEvent.results[0][0].transcript).toBe('first')
      expect(lastEvent.results[1][0].transcript).toBe('second')
    })

    it('replaces interim result with final', async () => {
      const SR = getSpeechRecognition()
      const r = new SR()
      r.continuous = true
      r.interimResults = true
      const resultHandler = vi.fn()
      r.onresult = resultHandler

      r.start()
      await vi.waitFor(() => expect(r._state).toBe('active'))

      const ws = MockWebSocket.instances[0]
      ws.simulateMessage({
        type: 'Results', is_final: false,
        channel: { alternatives: [{ transcript: 'hel' }] },
      })
      ws.simulateMessage({
        type: 'Results', is_final: true,
        channel: { alternatives: [{ transcript: 'hello' }] },
      })

      const lastEvent = resultHandler.mock.calls[1][0]
      expect(lastEvent.results.length).toBe(1)
      expect(lastEvent.results[0][0].transcript).toBe('hello')
      expect(lastEvent.results[0].isFinal).toBe(true)
    })
  })
})
