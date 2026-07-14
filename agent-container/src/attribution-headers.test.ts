import { describe, it, expect } from 'vitest'
import { withAgentAttributionHeaders } from './attribution-headers'

describe('withAgentAttributionHeaders', () => {
  it('returns env unchanged when no agent id is present', () => {
    const env = { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'tok' }
    expect(withAgentAttributionHeaders(env)).toBe(env)
  })

  it('returns env unchanged when the id sanitizes to empty', () => {
    const env = { SUPERAGENT_AGENT_ID: '!!!' }
    expect(withAgentAttributionHeaders(env)).toBe(env)
  })

  it('composes id and name headers', () => {
    const out = withAgentAttributionHeaders({
      SUPERAGENT_AGENT_ID: 'abc123',
      SUPERAGENT_AGENT_NAME: 'My Agent',
    })
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBe(
      'X-Superagent-Agent-Id: abc123\nX-Superagent-Agent-Name: My%20Agent'
    )
  })

  it('composes only the id header when the name is missing or blank', () => {
    expect(
      withAgentAttributionHeaders({ SUPERAGENT_AGENT_ID: 'abc123' }).ANTHROPIC_CUSTOM_HEADERS
    ).toBe('X-Superagent-Agent-Id: abc123')
    expect(
      withAgentAttributionHeaders({ SUPERAGENT_AGENT_ID: 'abc123', SUPERAGENT_AGENT_NAME: '  ' })
        .ANTHROPIC_CUSTOM_HEADERS
    ).toBe('X-Superagent-Agent-Id: abc123')
  })

  it('strips unsafe characters from the id', () => {
    const out = withAgentAttributionHeaders({ SUPERAGENT_AGENT_ID: ' ab\nc: 1é ' })
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Superagent-Agent-Id: abc1')
  })

  it('percent-encodes the name so header values stay ASCII', () => {
    const out = withAgentAttributionHeaders({
      SUPERAGENT_AGENT_ID: 'abc123',
      SUPERAGENT_AGENT_NAME: 'Ünïcode: Bot\u{1F680}',
    })
    const value = out.ANTHROPIC_CUSTOM_HEADERS!.split('\n')[1].replace('X-Superagent-Agent-Name: ', '')
    // eslint-disable-next-line no-control-regex
    expect(value).toMatch(/^[\x21-\x7e]+$/)
    expect(decodeURIComponent(value)).toBe('Ünïcode: Bot\u{1F680}')
  })

  it('caps the name at 200 code points without splitting surrogate pairs', () => {
    const name = '\u{1F680}'.repeat(300)
    const out = withAgentAttributionHeaders({
      SUPERAGENT_AGENT_ID: 'abc123',
      SUPERAGENT_AGENT_NAME: name,
    })
    const value = out.ANTHROPIC_CUSTOM_HEADERS!.split('\n')[1].replace('X-Superagent-Agent-Name: ', '')
    expect(decodeURIComponent(value)).toBe('\u{1F680}'.repeat(200))
  })

  it('survives lone surrogates in the name', () => {
    const out = withAgentAttributionHeaders({
      SUPERAGENT_AGENT_ID: 'abc123',
      SUPERAGENT_AGENT_NAME: 'bad\uD800name',
    })
    const value = out.ANTHROPIC_CUSTOM_HEADERS!.split('\n')[1].replace('X-Superagent-Agent-Name: ', '')
    expect(decodeURIComponent(value)).toBe('bad�name')
  })

  it('appends after an existing ANTHROPIC_CUSTOM_HEADERS value', () => {
    const out = withAgentAttributionHeaders({
      SUPERAGENT_AGENT_ID: 'abc123',
      SUPERAGENT_AGENT_NAME: 'Bot',
      ANTHROPIC_CUSTOM_HEADERS: 'X-User-Header: keep-me',
    })
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBe(
      'X-User-Header: keep-me\nX-Superagent-Agent-Id: abc123\nX-Superagent-Agent-Name: Bot'
    )
  })

  it('does not mutate the input env', () => {
    const env = { SUPERAGENT_AGENT_ID: 'abc123', OTHER: 'v' }
    const out = withAgentAttributionHeaders(env)
    expect(env).not.toHaveProperty('ANTHROPIC_CUSTOM_HEADERS')
    expect(out.OTHER).toBe('v')
  })
})
