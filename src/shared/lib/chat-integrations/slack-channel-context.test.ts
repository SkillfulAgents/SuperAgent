import { describe, it, expect } from 'vitest'
import { selectChannelContextMessages, type SlackHistoryMessage } from './slack-connector'

const BOT_USER = 'U_BOT'
const BOT_ID = 'B_BOT'

function run(messages: SlackHistoryMessage[], currentTs = '9999.0') {
  return selectChannelContextMessages(messages, currentTs, BOT_USER, BOT_ID)
}

describe('selectChannelContextMessages', () => {
  it('excludes the current (triggering) message', () => {
    const kept = run([{ ts: '100.0', user: 'U1', text: 'a' }, { ts: '9999.0', user: 'U1', text: 'b' }])
    expect(kept.map(m => m.ts)).toEqual(['100.0'])
  })
  it("excludes the bot's own messages by user id", () => {
    const kept = run([{ ts: '101.0', user: BOT_USER, text: 'on it' }, { ts: '100.0', user: 'U1', text: 'hi' }])
    expect(kept.map(m => m.text)).toEqual(['hi'])
  })
  it("excludes the bot's own messages by bot_id when user is absent", () => {
    const kept = run([{ ts: '101.0', bot_id: BOT_ID, subtype: 'bot_message', text: 'mine' }, { ts: '100.0', user: 'U1', text: 'hi' }])
    expect(kept.map(m => m.text)).toEqual(['hi'])
  })
  it('keeps other integrations (bot_message with a different bot_id)', () => {
    const kept = run([{ ts: '100.0', user: 'U1', text: 'human' }, { ts: '101.0', bot_id: 'B_OTHER', subtype: 'bot_message', text: 'deploy done' }])
    expect(kept.map(m => m.text)).toEqual(['human', 'deploy done'])
  })
  it('keeps me_message and thread_broadcast', () => {
    const kept = run([{ ts: '100.0', user: 'U1', subtype: 'me_message', text: 'waves' }, { ts: '101.0', user: 'U2', subtype: 'thread_broadcast', text: 'also here' }])
    expect(kept.map(m => m.text)).toEqual(['waves', 'also here'])
  })
  it('drops system subtypes not on the allowlist (channel_join has text)', () => {
    const kept = run([{ ts: '100.0', user: 'U1', text: 'real' }, { ts: '101.0', subtype: 'channel_join', text: 'has joined' }])
    expect(kept.map(m => m.text)).toEqual(['real'])
  })
  it('keeps a file-only message (no text, has files)', () => {
    const kept = run([{ ts: '100.0', user: 'U1', files: [{ name: 'a.pdf' }] }])
    expect(kept).toHaveLength(1)
  })
  it('drops an empty message with no text and no files', () => {
    const kept = run([{ ts: '100.0', user: 'U1', text: '   ' }])
    expect(kept).toHaveLength(0)
  })
  it('returns chronological order from newest-first input', () => {
    const kept = run([{ ts: '300.0', user: 'U1', text: 'c' }, { ts: '100.0', user: 'U1', text: 'a' }, { ts: '200.0', user: 'U1', text: 'b' }])
    expect(kept.map(m => m.text)).toEqual(['a', 'b', 'c'])
  })
})
