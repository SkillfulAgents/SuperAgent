import { describe, expect, it } from 'vitest'
import { resolveSttProtocol } from './stt-protocol'

describe('resolveSttProtocol', () => {
  it('uses the host protocol when present', () => {
    expect(resolveSttProtocol({ provider: 'platform', protocol: 'openai-realtime' })).toBe('openai-realtime')
    expect(resolveSttProtocol({ provider: 'openai', protocol: 'deepgram' })).toBe('deepgram')
  })

  it('derives openai-realtime from an openai token that omitted protocol', () => {
    expect(resolveSttProtocol({ provider: 'openai' })).toBe('openai-realtime')
  })

  it('derives deepgram from a platform or deepgram token that omitted protocol', () => {
    expect(resolveSttProtocol({ provider: 'platform' })).toBe('deepgram')
    expect(resolveSttProtocol({ provider: 'deepgram' })).toBe('deepgram')
  })
})
