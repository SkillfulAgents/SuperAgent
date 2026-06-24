import { describe, it, expect } from 'vitest'
import { selectChannelContextMessages, SlackConnector, type SlackHistoryMessage } from './slack-connector'

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
  it('keeps the content subtypes on the allowlist (me_message, thread_broadcast, file_share)', () => {
    const kept = run([
      { ts: '100.0', user: 'U1', subtype: 'me_message', text: 'waves' },
      { ts: '101.0', user: 'U2', subtype: 'thread_broadcast', text: 'also here' },
      { ts: '102.0', user: 'U3', subtype: 'file_share', text: 'sharing', files: [{ name: 'x.pdf' }] },
    ])
    expect(kept.map(m => m.text)).toEqual(['waves', 'also here', 'sharing'])
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
  it('drops a message with no ts', () => {
    const kept = run([{ user: 'U1', text: 'no ts' }, { ts: '100.0', user: 'U1', text: 'has ts' }])
    expect(kept.map(m => m.text)).toEqual(['has ts'])
  })
  it('returns chronological order by NUMERIC ts (not lexical) from newest-first input', () => {
    // A lexical string sort would order these '10.0' < '100.0' < '9.0' < '90.0'; numeric is 9 < 10 < 90 < 100.
    const kept = run([
      { ts: '100.0', user: 'U1', text: 'd' },
      { ts: '9.0', user: 'U1', text: 'a' },
      { ts: '10.0', user: 'U1', text: 'b' },
      { ts: '90.0', user: 'U1', text: 'c' },
    ])
    expect(kept.map(m => m.text)).toEqual(['a', 'b', 'c', 'd'])
  })
})

function makeConnector() {
  const c = new SlackConnector({ botToken: 'xoxb-x', appToken: 'xapp-x' } as any)
  ;(c as any).botUserId = 'U_BOT'
  ;(c as any).botId = 'B_BOT'
  ;(c as any).userNameCache = new Map([
    ['U1', { value: 'Alice', ts: Date.now() }],
    ['U2', { value: 'Bob', ts: Date.now() }],
  ])
  return c
}

describe('fetchChannelHistory', () => {
  it('builds a channel-context block, skips the bot, and surfaces file presence', async () => {
    const c = makeConnector()
    ;(c as any).app = { client: { conversations: { history: async () => ({
      ok: true,
      messages: [
        { ts: '1003.0', user: 'U_BOT', text: 'on it' },
        { ts: '1002.0', user: 'U2', files: [{ name: 'report.pdf', url_private_download: 'https://files.slack.com/files-pri/T1-F1/report.pdf', mimetype: 'application/pdf' }] },
        { ts: '1001.0', user: 'U1', text: 'the deploy is broken' },
      ],
    }) } } }
    const result = await (c as any).fetchChannelHistory('C1', '1004.0')
    expect(result).not.toBeNull()
    expect(result.text).toContain('[Channel context - 2 previous messages]')
    expect(result.text).toContain('Alice: the deploy is broken')
    expect(result.text).toContain('Bob: [shared file: report.pdf]')
    expect(result.text).not.toContain('on it')
    expect(result.files).toHaveLength(1)
    expect(result.files[0].name).toBe('report.pdf')
  })

  it('caps downloaded files to the 3 newest and ignores non-downloadable (permalink-only) files', async () => {
    const c = makeConnector()
    const fileMsg = (ts: string, n: string) => ({ ts, user: 'U1', files: [{ name: n, url_private_download: `https://files.slack.com/files-pri/T1-F${n}/${n}` }] })
    ;(c as any).app = { client: { conversations: { history: async () => ({
      ok: true,
      messages: [
        fileMsg('105.0', 'e'), fileMsg('104.0', 'd'), fileMsg('103.0', 'c'), fileMsg('102.0', 'b'),
        { ts: '101.0', user: 'U1', files: [{ name: 'permalink-only', permalink: 'https://slack.com/archives/x' }] },
      ],
    }) } } }
    const result = await (c as any).fetchChannelHistory('C1', '999.0')
    // Newest 3 downloadable by ts: c, d, e. permalink-only is surfaced in text but not queued.
    expect(result.files.map((f: any) => f.name)).toEqual(['c', 'd', 'e'])
    expect(result.text).toContain('[shared file: permalink-only]')
  })

  it('returns null on API failure (missing scope, etc.)', async () => {
    const c = makeConnector()
    ;(c as any).app = { client: { conversations: { history: async () => { throw new Error('missing_scope') } } } }
    expect(await (c as any).fetchChannelHistory('C1', '999.0')).toBeNull()
  })

  it('returns null when nothing survives selection', async () => {
    const c = makeConnector()
    ;(c as any).app = { client: { conversations: { history: async () => ({ ok: true, messages: [{ ts: '1.0', user: 'U_BOT', text: 'mine' }] }) } } }
    expect(await (c as any).fetchChannelHistory('C1', '999.0')).toBeNull()
  })

  it('returns null when the API responds not-ok (missing scope without throwing)', async () => {
    const c = makeConnector()
    ;(c as any).app = { client: { conversations: { history: async () => ({ ok: false, error: 'missing_scope' }) } } }
    expect(await (c as any).fetchChannelHistory('C1', '999.0')).toBeNull()
  })

  it('returns null when the API response omits messages', async () => {
    const c = makeConnector()
    ;(c as any).app = { client: { conversations: { history: async () => ({ ok: true }) } } }
    expect(await (c as any).fetchChannelHistory('C1', '999.0')).toBeNull()
  })

  it('uses singular wording for a single previous message', async () => {
    const c = makeConnector()
    ;(c as any).app = { client: { conversations: { history: async () => ({ ok: true, messages: [{ ts: '100.0', user: 'U1', text: 'just one' }] }) } } }
    const result = await (c as any).fetchChannelHistory('C1', '999.0')
    expect(result.text).toContain('[Channel context - 1 previous message]')
  })
})
