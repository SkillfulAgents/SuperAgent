import { describe, expect, it } from 'vitest'
import { appendMentions, parseMentions, parseUserTags, plainUserTags, type Mention } from './mentions'

const mike: Mention = { kind: 'user', id: 'u_mike1', name: 'Mike Smith', email: 'mike@acme.com' }
const billing: Mention = { kind: 'agent', slug: 'billing-agent-k3j4h5g6f7', name: 'Billing Agent' }

describe('appendMentions', () => {
  it('lists each mention after the text, with what the agent needs to reach it', () => {
    expect(appendMentions('ping @Mike Smith once @Billing Agent has the numbers', [mike, billing])).toBe(
      'ping @Mike Smith once @Billing Agent has the numbers\n\n'
      + '[Mentioned:]\n'
      + '- @Mike Smith: teammate, mike@acme.com (user id u_mike1)\n'
      + '- @Billing Agent: agent, slug billing-agent-k3j4h5g6f7 (call it by this slug with the agents tools, no need to list agents first)',
    )
  })

  it('tells the agent a silent message was not addressed to it', () => {
    expect(appendMentions('@Mike Smith look at this', [mike], { silent: true })).toMatch(
      /\(user id u_mike1\)\n\(This message only notifies the teammates it tags\. It is not a request to you, so do not act on it\.\)$/,
    )
  })

  it('keeps each entry on one line', () => {
    expect(appendMentions('hi', [{ ...mike, name: 'Mike\nSmith ' }])).toContain('- @Mike Smith: teammate')
  })

  it('leaves out an email that would break the line', () => {
    expect(appendMentions('hi', [{ ...mike, email: 'not an (email)' }])).toContain('- @Mike Smith: teammate (user id u_mike1)')
  })

  it('returns the message unchanged without mentions', () => {
    expect(appendMentions('hello', [])).toBe('hello')
  })
})

describe('parseMentions', () => {
  it('round-trips the block', () => {
    const text = appendMentions('ping @Mike Smith', [mike, billing])
    expect(parseMentions(text)).toEqual({ cleanText: 'ping @Mike Smith', mentions: [mike, billing], silent: false })
  })

  it('reads a silent block', () => {
    expect(parseMentions(appendMentions('@Mike Smith look', [mike], { silent: true }))).toEqual({
      cleanText: '@Mike Smith look',
      mentions: [mike],
      silent: true,
    })
  })

  it('reads a mention without an email', () => {
    const noEmail: Mention = { kind: 'user', id: 'u_mike1', name: 'Mike Smith' }
    expect(parseMentions(appendMentions('hi', [noEmail])).mentions).toEqual([noEmail])
  })

  it('keeps the blocks before it', () => {
    const text = appendMentions('look\n\n[Attached files:]\n- /workspace/uploads/a.md', [mike])
    expect(parseMentions(text)).toEqual({ cleanText: 'look\n\n[Attached files:]\n- /workspace/uploads/a.md', mentions: [mike], silent: false })
  })

  it('reads a block only at the end of the message', () => {
    const quoted = '```\n[Mentioned:]\n- @Mike Smith: teammate (user id u_mike1)\n```'
    expect(parseMentions(`see\n\n${quoted}`)).toEqual({ cleanText: `see\n\n${quoted}`, mentions: [], silent: false })
    expect(parseMentions(appendMentions(`see\n\n${quoted}`, [billing]))).toEqual({
      cleanText: `see\n\n${quoted}`,
      mentions: [billing],
      silent: false,
    })
  })

  it('ignores a marker with no entries, or one inside a line', () => {
    expect(parseMentions('hi\n\n[Mentioned:]\nnothing here').mentions).toEqual([])
    expect(parseMentions('see [Mentioned:]\n- @Mike Smith: teammate (user id u_mike1)').mentions).toEqual([])
  })

  it('leaves text without a block untouched', () => {
    expect(parseMentions('plain @Mike')).toEqual({ cleanText: 'plain @Mike', mentions: [], silent: false })
  })
})

describe('agent tags', () => {
  const tagged = 'Thanks [@Mike Smith](user:u_mike1), ping [@Dana Lee](user:u_dana2) and [@Mike Smith](user:u_mike1) again'

  it("reads an agent's tags as the text and people a person's tag gives", () => {
    expect(parseUserTags(tagged)).toEqual({
      text: 'Thanks @Mike Smith, ping @Dana Lee and @Mike Smith again',
      mentions: [{ kind: 'user', id: 'u_mike1', name: 'Mike Smith' }, { kind: 'user', id: 'u_dana2', name: 'Dana Lee' }],
    })
    expect(parseUserTags('see [docs](https://x.dev) or [@Mike](mailto:m@x.dev)').mentions).toEqual([])
    for (const text of ['', '  ', '[@](user:)', '`[@Mike](user:u_mike1)`', '```\n[@Mike](user:u_mike1)\n```', '\\[@Mike](user:u_mike1)', '![@Mike](user:u_mike1)', '~~~\n[@Mike](user:u_mike1)\n~~~', '``[@Mike](user:u_mike1)``']) {
      expect(parseUserTags(text)).toEqual({ text, mentions: [] })
    }
  })

  it('reads each tag as a plain @Name outside the app', () => {
    expect(plainUserTags(tagged)).toBe('Thanks @Mike Smith, ping @Dana Lee and @Mike Smith again')
  })

  it('holds back a tag still streaming in, and only while streaming', () => {
    for (const tail of ['[@', '[@Mike Sm', '[@Mike Smith]', '[@Mike Smith](', '[@Mike Smith](us', '[@Mike Smith](user:u_mi']) {
      expect(plainUserTags(`Look ${tail}`, { streaming: true })).toBe('Look ')
    }
    expect(plainUserTags('Look [@Mike Smith]', { streaming: false })).toBe('Look [@Mike Smith]')
    expect(plainUserTags('see [docs](https://x.dev)', { streaming: true })).toBe('see [docs](https://x.dev)')
  })
})
