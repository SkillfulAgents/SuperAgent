import { describe, expect, it } from 'vitest'
import { parseAgentDeepLink } from './agent-deep-link'

describe('parseAgentDeepLink', () => {
  it('parses a slug-only link', () => {
    expect(parseAgentDeepLink('superagent://agent/demo', 'superagent'))
      .toEqual({ agentSlug: 'demo', sessionId: null })
  })

  it('parses the position-anchored sessions pair', () => {
    expect(parseAgentDeepLink('superagent://agent/demo/sessions/sess-1', 'superagent'))
      .toEqual({ agentSlug: 'demo', sessionId: 'sess-1' })
  })

  it('ignores a sessions pair that is not immediately after the slug', () => {
    expect(parseAgentDeepLink('superagent://agent/demo/x/sessions/sess-1', 'superagent'))
      .toEqual({ agentSlug: 'demo', sessionId: null })
  })

  it('ignores unknown extra segments (legacy lenience)', () => {
    expect(parseAgentDeepLink('superagent://agent/demo/anything/else', 'superagent'))
      .toEqual({ agentSlug: 'demo', sessionId: null })
  })

  it('ignores a sessions keyword with no id', () => {
    expect(parseAgentDeepLink('superagent://agent/demo/sessions', 'superagent'))
      .toEqual({ agentSlug: 'demo', sessionId: null })
    expect(parseAgentDeepLink('superagent://agent/demo/sessions/', 'superagent'))
      .toEqual({ agentSlug: 'demo', sessionId: null })
  })

  it('decodes the slug and the session id', () => {
    expect(parseAgentDeepLink('superagent://agent/a%2Fb%20c/sessions/s%201', 'superagent'))
      .toEqual({ agentSlug: 'a/b c', sessionId: 's 1' })
  })

  it('returns null on malformed slug encoding, degrades on malformed session encoding', () => {
    expect(parseAgentDeepLink('superagent://agent/%E0%A4%A', 'superagent')).toBeNull()
    expect(parseAgentDeepLink('superagent://agent/demo/sessions/%E0%A4%A', 'superagent'))
      .toEqual({ agentSlug: 'demo', sessionId: null })
  })

  it('returns null for empty slug and non-agent families', () => {
    expect(parseAgentDeepLink('superagent://agent/', 'superagent')).toBeNull()
    expect(parseAgentDeepLink('superagent://dashboard/a/b', 'superagent')).toBeNull()
    expect(parseAgentDeepLink('superagent://oauth-callback?x=1', 'superagent')).toBeNull()
  })

  it('respects the dev scheme', () => {
    expect(parseAgentDeepLink('superagent-dev://agent/demo/sessions/s', 'superagent-dev'))
      .toEqual({ agentSlug: 'demo', sessionId: 's' })
    expect(parseAgentDeepLink('superagent://agent/demo', 'superagent-dev')).toBeNull()
  })
})
