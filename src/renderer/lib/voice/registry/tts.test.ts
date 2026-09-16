import { describe, it, expect } from 'vitest'
import { createTtsAdapter } from './tts'
import { DeepgramTtsAdapter } from '../providers/deepgram/tts'
import { HttpTtsAdapter } from '../shared/http-tts'

describe('createTtsAdapter', () => {
  it('maps a websocket connection to the Deepgram adapter', () => {
    expect(createTtsAdapter({ provider: 'deepgram', connection: { transport: 'websocket', token: 'jwt' } })).toBeInstanceOf(DeepgramTtsAdapter)
  })

  it('maps an http connection to the server-streamed adapter for openai and platform', () => {
    expect(createTtsAdapter({ provider: 'openai', connection: { transport: 'http' } })).toBeInstanceOf(HttpTtsAdapter)
    expect(createTtsAdapter({ provider: 'platform', connection: { transport: 'http' } })).toBeInstanceOf(HttpTtsAdapter)
  })
})
