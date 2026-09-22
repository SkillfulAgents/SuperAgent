import { describe, expect, it } from 'vitest'
import { VOICE_HISTORY_MAX_BYTES, VOICE_HISTORY_MAX_MESSAGE_CHARS, VOICE_HISTORY_MAX_MESSAGES, VOICE_LIVE_BODY_MAX_BYTES, voiceHistorySchema, type VoiceHistory } from './conversation-types'
import { liveMappingSchema } from './live-types'
import { boundVoiceHistoryTransport } from './voice-history-transport'

const role = (i: number): VoiceHistory[number]['role'] => (i % 2 ? 'assistant' : 'user')
const chat = (count: number, text: string): VoiceHistory => Array.from({ length: count }, (_, i) => ({ role: role(i), content: `${i} ${text}` }))
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
// Realistic worst cases for the other fields sharing the body: a max-length SDP
// offer with CRLF line endings, and max-length CJK mapping fields.
const sdp = 'a=candidate:0123456789 1 udp 2122260223 192.168.1.10 51234 typ host\r\n'.repeat(1000).slice(0, 64000)
const mapping = { kind: 'request' as const, transcript: '界'.repeat(16000), previousRequest: '界'.repeat(4000), agentBusy: true }

describe('boundVoiceHistoryTransport', () => {
  it('returns short histories intact and oldest-first', () => {
    const history = chat(3, 'hello')
    expect(boundVoiceHistoryTransport(history)).toEqual(history)
  })

  it('keeps the newest turns when 80 long turns would exceed the body limit', () => {
    const history = chat(80, 'x'.repeat(2000))
    expect(bytes({ sdp, history })).toBeGreaterThan(VOICE_LIVE_BODY_MAX_BYTES)
    const out = boundVoiceHistoryTransport(history)
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThan(history.length)
    expect(out.at(-1)).toEqual(history.at(-1))
    expect(bytes(out)).toBeLessThanOrEqual(VOICE_HISTORY_MAX_BYTES)
  })

  it.each([
    ['ascii', 'x'.repeat(VOICE_HISTORY_MAX_MESSAGE_CHARS)],
    ['cjk', '界'.repeat(VOICE_HISTORY_MAX_MESSAGE_CHARS)],
    ['emoji', '🌍'.repeat(VOICE_HISTORY_MAX_MESSAGE_CHARS / 2)],
    ['escaped', '"\\\n\t'.repeat(VOICE_HISTORY_MAX_MESSAGE_CHARS / 4)],
  ])('fits the session and mapping bodies under the host limit with %s history', (_, text) => {
    const out = boundVoiceHistoryTransport(chat(VOICE_HISTORY_MAX_MESSAGES + 10, text))
    expect(voiceHistorySchema.safeParse(out).success).toBe(true)
    expect(bytes(out)).toBeLessThanOrEqual(VOICE_HISTORY_MAX_BYTES)
    expect(bytes({ sdp, history: out })).toBeLessThanOrEqual(VOICE_LIVE_BODY_MAX_BYTES)
    const request = { ...mapping, history: out }
    expect(liveMappingSchema.safeParse(request).success).toBe(true)
    expect(bytes(request)).toBeLessThanOrEqual(VOICE_LIVE_BODY_MAX_BYTES)
  })

  it('never exceeds the message cap', () => {
    const out = boundVoiceHistoryTransport(chat(200, 'ok'))
    expect(out).toHaveLength(VOICE_HISTORY_MAX_MESSAGES)
    expect(out.at(-1)?.content).toBe('199 ok')
  })

  it('clips each turn to the schema character limit before measuring it', () => {
    const out = boundVoiceHistoryTransport([{ role: 'user', content: 'A'.repeat(3_000_000) }])
    expect(out).toHaveLength(1)
    expect(out[0].content).toHaveLength(VOICE_HISTORY_MAX_MESSAGE_CHARS)
  })
})
