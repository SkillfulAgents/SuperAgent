import { describe, it, expect } from 'vitest'
import { createSttAdapter } from './stt'

describe('createSttAdapter', () => {
  it('creates a deepgram adapter', () => {
    const adapter = createSttAdapter('deepgram')
    expect(adapter).toBeDefined()
    expect(typeof adapter.connect).toBe('function')
    expect(typeof adapter.sendAudio).toBe('function')
    expect(typeof adapter.onTranscript).toBe('function')
    expect(typeof adapter.onError).toBe('function')
    expect(typeof adapter.close).toBe('function')
  })

  it('creates an openai adapter', () => {
    const adapter = createSttAdapter('openai')
    expect(adapter).toBeDefined()
    expect(adapter.sampleRate).toBe(24000)
  })

  it('deepgram adapter has default sample rate (undefined = 16000)', () => {
    const adapter = createSttAdapter('deepgram')
    // DeepgramAdapter doesn't set sampleRate, defaults to 16000 in startAudioCapture
    expect(adapter.sampleRate).toBeUndefined()
  })

  it('throws for unknown provider', () => {
    expect(() => createSttAdapter('unknown' as any)).toThrow('Unknown voice provider: unknown')
  })
})
