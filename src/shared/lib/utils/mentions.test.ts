import { describe, expect, it } from 'vitest'
import { appendMentions, parseMentions, type Mention } from './mentions'

const mike: Mention = { kind: 'user', id: 'u_mike1', name: 'Mike Smith', email: 'mike@acme.com' }
const billing: Mention = { kind: 'agent', slug: 'billing-agent-k3j4h5g6f7', name: 'Billing Agent' }
const q3Chat: Mention = { kind: 'chat', id: '7f3c2a10-4b1e-4d8a-9c55-2e1f0a9b6d34', name: 'Q3 revenue numbers' }
const refundChat: Mention = { kind: 'chat', id: 'c0ffee00-1111-4222-8333-444455556666', name: 'Stripe refund cleanup · Billing Agent', agentSlug: 'billing-agent-k3j4h5g6f7' }

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

  it('tells the agent how to read a mentioned chat', () => {
    expect(appendMentions('use @Q3 revenue numbers', [q3Chat])).toBe(
      'use @Q3 revenue numbers\n\n'
      + '[Mentioned:]\n'
      + '- @Q3 revenue numbers: chat in this agent, session id 7f3c2a10-4b1e-4d8a-9c55-2e1f0a9b6d34'
      + ' (read it with: python3 /opt/gamut/bin/read-session.py 7f3c2a10-4b1e-4d8a-9c55-2e1f0a9b6d34)',
    )
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

  it('round-trips chat mentions, in this agent and in another', () => {
    const text = appendMentions('use @Q3 revenue numbers and @Stripe refund cleanup · Billing Agent', [q3Chat, refundChat])
    expect(text).toContain(
      '- @Stripe refund cleanup · Billing Agent: chat in agent billing-agent-k3j4h5g6f7, session id c0ffee00-1111-4222-8333-444455556666'
      + ' (read it with get_agent_session_transcript)',
    )
    expect(parseMentions(text)).toEqual({
      cleanText: 'use @Q3 revenue numbers and @Stripe refund cleanup · Billing Agent',
      mentions: [q3Chat, refundChat],
      silent: false,
    })
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
