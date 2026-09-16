import { describe, it, expect } from 'vitest'
import { createTtsAdapter } from './tts'
import { DeepgramTtsAdapter } from '../providers/deepgram/tts'
import { HttpTtsAdapter } from '../shared/http-tts'

describe('createTtsAdapter', () => {
  it('maps deepgram and platform to the Deepgram adapter', () => {
    expect(createTtsAdapter({ provider: 'deepgram', connection: { transport: 'websocket', token: 'jwt' } })).toBeInstanceOf(DeepgramTtsAdapter)
    expect(createTtsAdapter({ provider: 'platform', connection: { transport: 'websocket', token: 'jwt' } })).toBeInstanceOf(DeepgramTtsAdapter)
  })

  it('uses the shared HTTP adapter for HTTP synthesis', () => {
    expect(createTtsAdapter({ provider: 'openai', connection: { transport: 'http' } })).toBeInstanceOf(HttpTtsAdapter)
  })
})
