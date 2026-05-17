// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getLlmPolyfillJs } from './llm-polyfill'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function installPolyfill() {
  const run = eval
  run(getLlmPolyfillJs())
}

function getAnthropic(): any {
  return (window as any).Anthropic
}

// Mock SDK constructor that the shim expects after loading anthropic-sdk.js
class MockAnthropicSDK {
  messages: any
  _opts: any
  constructor(opts: any) {
    this._opts = opts
    this.messages = {
      create: vi.fn().mockResolvedValue({
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
      }),
      stream: vi.fn().mockReturnValue({
        on: vi.fn().mockReturnThis(),
        finalMessage: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Hi' }] }),
        finalText: vi.fn().mockResolvedValue('Hi'),
      }),
    }
  }
}

function mockSdkLoad() {
  // The shim loads the SDK by injecting a <script> tag. We simulate this
  // by intercepting createElement and immediately setting window.__AnthropicSDK.
  const origCreateElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = origCreateElement(tag)
    if (tag === 'script') {
      const origAppendChild = document.head.appendChild.bind(document.head)
      vi.spyOn(document.head, 'appendChild').mockImplementation((node: any) => {
        if (node === el && node.src?.includes('anthropic-sdk.js')) {
          ;(window as any).__AnthropicSDK = MockAnthropicSDK
          setTimeout(() => node.onload?.(), 0)
          return node
        }
        return origAppendChild(node)
      })
    }
    return el
  }) as any)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LLM (Anthropic) polyfill — lazy-loading shim', () => {
  beforeEach(() => {
    delete (window as any).Anthropic
    delete (window as any).__AnthropicSDK
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('installation', () => {
    it('registers window.Anthropic', () => {
      installPolyfill()
      expect(getAnthropic()).toBeDefined()
      expect(typeof getAnthropic()).toBe('function')
    })

    it('always overrides', () => {
      ;(window as any).Anthropic = function OldStub() {}
      installPolyfill()
      expect(getAnthropic().name).not.toBe('OldStub')
    })
  })

  describe('constructor', () => {
    beforeEach(() => {
      mockSdkLoad()
      installPolyfill()
    })

    it('creates a client with messages property', () => {
      const Anthropic = getAnthropic()
      const client = new Anthropic()
      expect(client.messages).toBeDefined()
      expect(typeof client.messages.create).toBe('function')
      expect(typeof client.messages.stream).toBe('function')
    })
  })

  describe('messages.create() — delegates to real SDK', () => {
    beforeEach(() => {
      mockSdkLoad()
      installPolyfill()
    })

    it('lazy-loads SDK and forwards create() call', async () => {
      const Anthropic = getAnthropic()
      const client = new Anthropic()
      const result = await client.messages.create({
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hi' }],
      })

      expect(result.content[0].text).toBe('Hello!')

      // Verify SDK was constructed with proxy config
      expect(client._real._opts.baseURL).toContain('/api/llm')
      expect(client._real._opts.apiKey).toBe('placeholder')
      expect(client._real._opts.dangerouslyAllowBrowser).toBe(true)
    })

    it('passes user options through to SDK constructor', async () => {
      const Anthropic = getAnthropic()
      const client = new Anthropic({ defaultHeaders: { 'X-Custom': 'test' } })
      await client.messages.create({
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      })

      expect(client._real._opts.defaultHeaders['X-Custom']).toBe('test')
    })

    it('reuses SDK instance across multiple calls', async () => {
      const Anthropic = getAnthropic()
      const client = new Anthropic()

      await client.messages.create({ max_tokens: 10, messages: [{ role: 'user', content: '1' }] })
      const firstReal = client._real

      await client.messages.create({ max_tokens: 10, messages: [{ role: 'user', content: '2' }] })
      expect(client._real).toBe(firstReal)
    })
  })

  describe('messages.stream()', () => {
    beforeEach(() => {
      mockSdkLoad()
      installPolyfill()
    })

    it('works after SDK is loaded via create()', async () => {
      const Anthropic = getAnthropic()
      const client = new Anthropic()

      // First call loads the SDK
      await client.messages.create({ max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })

      // Now stream() should work synchronously
      const stream = client.messages.stream({
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hello' }],
      })

      expect(stream).toBeDefined()
      expect(typeof stream.on).toBe('function')
    })

    it('works even before SDK is loaded (lazy-loads)', async () => {
      const Anthropic = getAnthropic()
      const client = new Anthropic()

      // stream() should NOT throw — it returns a LazyMessageStream
      const stream = client.messages.stream({
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hello' }],
      })

      expect(stream).toBeDefined()
      expect(typeof stream.on).toBe('function')
      expect(typeof stream.finalText).toBe('function')

      const text = await stream.finalText()
      expect(text).toBe('Hi')
    })
  })

  describe('SDK load failure', () => {
    it('rejects create() if script fails to load', async () => {
      const origCreateElement = document.createElement.bind(document)
      vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        const el = origCreateElement(tag)
        if (tag === 'script') {
          vi.spyOn(document.head, 'appendChild').mockImplementation((node: any) => {
            if (node === el) {
              setTimeout(() => node.onerror?.(), 0)
              return node
            }
            return document.head.appendChild(node)
          })
        }
        return el
      }) as any)

      installPolyfill()
      const Anthropic = getAnthropic()
      const client = new Anthropic()

      await expect(client.messages.create({
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      })).rejects.toThrow('Failed to load Anthropic SDK')
    })

    it('stream().finalText() rejects if SDK fails to load', async () => {
      const origCreateElement = document.createElement.bind(document)
      vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        const el = origCreateElement(tag)
        if (tag === 'script') {
          vi.spyOn(document.head, 'appendChild').mockImplementation((node: any) => {
            if (node === el) {
              setTimeout(() => node.onerror?.(), 0)
              return node
            }
            return document.head.appendChild(node)
          })
        }
        return el
      }) as any)

      installPolyfill()
      const Anthropic = getAnthropic()
      const client = new Anthropic()
      const stream = client.messages.stream({
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      })

      await expect(stream.finalText()).rejects.toThrow('Failed to load Anthropic SDK')
    })

    it('stream() fires error event if SDK fails to load', async () => {
      const origCreateElement = document.createElement.bind(document)
      vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        const el = origCreateElement(tag)
        if (tag === 'script') {
          vi.spyOn(document.head, 'appendChild').mockImplementation((node: any) => {
            if (node === el) {
              setTimeout(() => node.onerror?.(), 0)
              return node
            }
            return document.head.appendChild(node)
          })
        }
        return el
      }) as any)

      installPolyfill()
      const Anthropic = getAnthropic()
      const client = new Anthropic()
      const stream = client.messages.stream({
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      })

      const errorHandler = vi.fn()
      stream.on('error', errorHandler)

      await stream.finalText().catch(() => {})
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('Failed to load'),
      }))
    })
  })
})
