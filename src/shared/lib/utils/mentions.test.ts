import { describe, expect, it } from 'vitest'
import { appendMentions, parseMentions, type Mention } from './mentions'

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

  it('keeps the blocks that follow it', () => {
    const text = `${appendMentions('look', [mike])}\n\n[Attached files:]\n- /workspace/uploads/a.md`
    expect(parseMentions(text).cleanText).toBe('look\n\n[Attached files:]\n- /workspace/uploads/a.md')
  })

  it('ignores a marker with no entries, or one inside a line', () => {
    expect(parseMentions('hi\n\n[Mentioned:]\nnothing here').mentions).toEqual([])
    expect(parseMentions('see [Mentioned:]\n- @Mike Smith: teammate (user id u_mike1)').mentions).toEqual([])
  })

  it('leaves text without a block untouched', () => {
    expect(parseMentions('plain @Mike')).toEqual({ cleanText: 'plain @Mike', mentions: [], silent: false })
  })
})
