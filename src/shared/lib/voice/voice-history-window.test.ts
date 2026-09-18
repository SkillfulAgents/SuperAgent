import { describe, expect, it } from 'vitest'
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base'
import { voiceHistorySchema, VOICE_HISTORY_MAX_MESSAGES, type VoiceHistory } from './conversation-types'
import { clipVoiceHistoryTurn, VOICE_HISTORY_LIMITS, VOICE_HISTORY_TRUNCATION_MARKER, windowVoiceHistory } from './voice-history-window'

const role = (i: number): VoiceHistory[number]['role'] => (i % 2 ? 'assistant' : 'user')
const turn = (i: number, words = 12): VoiceHistory[number] => ({ role: role(i), content: `turn ${i} ` + 'word '.repeat(words) })

describe('windowVoiceHistory', () => {
  it('returns short histories intact and oldest-first', async () => {
    const history = [turn(0), turn(1), turn(2)]
    expect(await windowVoiceHistory(history)).toEqual(history.map((m) => ({ ...m, content: m.content.trim() })))
  })

  it('drops empty and whitespace-only turns', async () => {
    const out = await windowVoiceHistory([{ role: 'user', content: 'Research this' }, { role: 'assistant', content: '  ' }, { role: 'assistant', content: 'Found it' }])
    expect(out.map((m) => m.content)).toEqual(['Research this', 'Found it'])
  })

  it('keeps the newest turns when the token budget runs out', async () => {
    const history = Array.from({ length: 60 }, (_, i) => turn(i, 60))
    const out = await windowVoiceHistory(history, { ...VOICE_HISTORY_LIMITS, tokenBudget: 800 })
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThan(history.length)
    expect(out.at(-1)?.content).toBe(history.at(-1)?.content.trim())
    const spent = out.reduce((sum, m) => sum + countTokens(m.content) + VOICE_HISTORY_LIMITS.perMessageOverheadTokens, 0)
    expect(spent).toBeLessThanOrEqual(800)
  })

  it('never exceeds the message cap', async () => {
    const out = await windowVoiceHistory(Array.from({ length: 200 }, (_, i) => turn(i, 1)))
    expect(out).toHaveLength(VOICE_HISTORY_MAX_MESSAGES)
    expect(out.at(-1)?.content).toBe(turn(199, 1).content.trim())
  })

  it('clips a giant pasted turn to its head instead of losing the whole window', async () => {
    const giant = { role: 'user' as const, content: 'A'.repeat(3_000_000) }
    const out = await windowVoiceHistory([turn(0), turn(1), giant])
    expect(out).toHaveLength(3)
    expect(out[2].content).toHaveLength(VOICE_HISTORY_LIMITS.perMessageChars + VOICE_HISTORY_TRUNCATION_MARKER.length)
    expect(out[2].content.endsWith(VOICE_HISTORY_TRUNCATION_MARKER)).toBe(true)
  })

  it.each(['<|endoftext|>', '<|endofprompt|>', '<|fim_prefix|>'])('counts chat text quoting the %s marker as ordinary text', async (marker) => {
    const history: VoiceHistory = [
      { role: 'user', content: `Why does the model emit ${marker} here?` },
      { role: 'assistant', content: `${marker} is a tokenizer marker; your prompt should not contain it.` },
    ]
    const out = await windowVoiceHistory(history)
    expect(out).toEqual(history)
    expect(await windowVoiceHistory(history, { ...VOICE_HISTORY_LIMITS, tokenBudget: 1 })).toEqual([])
  })

  it('stays under the GPT-Live 8,192-token input cap with a full window of dense text', async () => {
    const dense: VoiceHistory = Array.from({ length: 200 }, (_, i) => ({ role: role(i), content: '中文'.repeat(1000) }))
    const out = await windowVoiceHistory(dense)
    const spent = out.reduce((sum, m) => sum + countTokens(m.content), 0)
    expect(spent).toBeLessThanOrEqual(8192)
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('clipVoiceHistoryTurn', () => {
  it('keeps the head and marks the cut', () => {
    expect(clipVoiceHistoryTurn('answer first, caveats later', 12)).toBe('answer first' + VOICE_HISTORY_TRUNCATION_MARKER)
    expect(clipVoiceHistoryTurn('  short  ', 12)).toBe('short')
  })
})

describe('voiceHistorySchema transport bound', () => {
  it('accepts a full 128-message page and rejects 129', () => {
    expect(voiceHistorySchema.safeParse(Array.from({ length: 128 }, (_, i) => turn(i, 1))).success).toBe(true)
    expect(voiceHistorySchema.safeParse(Array.from({ length: 129 }, (_, i) => turn(i, 1))).success).toBe(false)
  })
})
