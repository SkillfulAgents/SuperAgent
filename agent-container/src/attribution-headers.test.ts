import { describe, it, expect } from 'vitest'
import {
  withAgentAttributionHeaders,
  withSpeedHeader,
  captureAgentIdentity,
  isAgentIdentityEnvKey,
} from './attribution-headers'

describe('withAgentAttributionHeaders', () => {
  it('adds no headers when the identity has no agent id', () => {
    const env = { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'tok' }
    expect(withAgentAttributionHeaders(env, {})).toEqual(env)
  })

  it('adds no headers when the id sanitizes to empty', () => {
    const out = withAgentAttributionHeaders({}, { id: '!!!' })
    expect(out).not.toHaveProperty('ANTHROPIC_CUSTOM_HEADERS')
  })

  it('composes id and name headers from the identity', () => {
    const out = withAgentAttributionHeaders({}, { id: 'abc123', name: 'My Agent' })
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBe(
      'X-Superagent-Agent-Id: abc123\nX-Superagent-Agent-Name: My%20Agent'
    )
  })

  it('composes only the id header when the name is missing or blank', () => {
    expect(withAgentAttributionHeaders({}, { id: 'abc123' }).ANTHROPIC_CUSTOM_HEADERS).toBe(
      'X-Superagent-Agent-Id: abc123'
    )
    expect(
      withAgentAttributionHeaders({}, { id: 'abc123', name: '  ' }).ANTHROPIC_CUSTOM_HEADERS
    ).toBe('X-Superagent-Agent-Id: abc123')
  })

  it('strips unsafe characters from the id', () => {
    const out = withAgentAttributionHeaders({}, { id: ' ab\nc: 1é ' })
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Superagent-Agent-Id: abc1')
  })

  it('percent-encodes the name so header values stay ASCII', () => {
    const out = withAgentAttributionHeaders({}, { id: 'abc123', name: 'Ünïcode: Bot\u{1F680}' })
    const value = out.ANTHROPIC_CUSTOM_HEADERS!.split('\n')[1].replace('X-Superagent-Agent-Name: ', '')
    // eslint-disable-next-line no-control-regex
    expect(value).toMatch(/^[\x21-\x7e]+$/)
    expect(decodeURIComponent(value)).toBe('Ünïcode: Bot\u{1F680}')
  })

  it('caps the name at 200 code points without splitting surrogate pairs', () => {
    const out = withAgentAttributionHeaders({}, { id: 'abc123', name: '\u{1F680}'.repeat(300) })
    const value = out.ANTHROPIC_CUSTOM_HEADERS!.split('\n')[1].replace('X-Superagent-Agent-Name: ', '')
    expect(decodeURIComponent(value)).toBe('\u{1F680}'.repeat(200))
  })

  it('survives lone surrogates in the name', () => {
    const out = withAgentAttributionHeaders({}, { id: 'abc123', name: 'bad\uD800name' })
    const value = out.ANTHROPIC_CUSTOM_HEADERS!.split('\n')[1].replace('X-Superagent-Agent-Name: ', '')
    expect(decodeURIComponent(value)).toBe('bad�name')
  })

  it('appends after existing non-attribution ANTHROPIC_CUSTOM_HEADERS lines', () => {
    const out = withAgentAttributionHeaders(
      { ANTHROPIC_CUSTOM_HEADERS: 'X-User-Header: keep-me' },
      { id: 'abc123', name: 'Bot' }
    )
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBe(
      'X-User-Header: keep-me\nX-Superagent-Agent-Id: abc123\nX-Superagent-Agent-Name: Bot'
    )
  })

  it('strips forged attribution headers case-insensitively before appending', () => {
    const out = withAgentAttributionHeaders(
      {
        ANTHROPIC_CUSTOM_HEADERS:
          'x-superagent-agent-id: victim\nX-SUPERAGENT-AGENT-NAME: fake\nX-User-Header: keep-me',
      },
      { id: 'real', name: 'Real Bot' }
    )
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBe(
      'X-User-Header: keep-me\nX-Superagent-Agent-Id: real\nX-Superagent-Agent-Name: Real%20Bot'
    )
  })

  it('strips forged attribution headers even when this container has no identity', () => {
    const out = withAgentAttributionHeaders(
      { ANTHROPIC_CUSTOM_HEADERS: 'x-superagent-agent-id: victim\nX-User-Header: keep-me' },
      {}
    )
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBe('X-User-Header: keep-me')
  })

  it('forces the identity env keys back to their boot values after merges', () => {
    const out = withAgentAttributionHeaders(
      { SUPERAGENT_AGENT_ID: 'spoofed', SUPERAGENT_AGENT_NAME: 'Spoofed' },
      { id: 'real', name: 'Real Bot' }
    )
    expect(out.SUPERAGENT_AGENT_ID).toBe('real')
    expect(out.SUPERAGENT_AGENT_NAME).toBe('Real Bot')
  })

  it('removes spoofed identity env keys when the boot identity has none', () => {
    const out = withAgentAttributionHeaders({ SUPERAGENT_AGENT_ID: 'spoofed' }, {})
    expect(out).not.toHaveProperty('SUPERAGENT_AGENT_ID')
    expect(out).not.toHaveProperty('ANTHROPIC_CUSTOM_HEADERS')
  })

  it('does not mutate the input env', () => {
    const env = { OTHER: 'v' }
    const out = withAgentAttributionHeaders(env, { id: 'abc123' })
    expect(env).not.toHaveProperty('ANTHROPIC_CUSTOM_HEADERS')
    expect(out.OTHER).toBe('v')
  })
})

describe('withSpeedHeader', () => {
  it('adds no header for undefined speed', () => {
    const env = { PATH: '/usr/bin' }
    expect(withSpeedHeader(env, undefined)).toEqual(env)
  })

  it("adds no header for 'normal' — absence IS the wire default", () => {
    const out = withSpeedHeader({}, 'normal')
    expect(out).not.toHaveProperty('ANTHROPIC_CUSTOM_HEADERS')
  })

  it('emits the speed header for fast and slow', () => {
    expect(withSpeedHeader({}, 'fast').ANTHROPIC_CUSTOM_HEADERS).toBe('X-Superagent-Speed: fast')
    expect(withSpeedHeader({}, 'slow').ANTHROPIC_CUSTOM_HEADERS).toBe('X-Superagent-Speed: slow')
  })

  it('appends after existing lines, preserving them', () => {
    const out = withSpeedHeader(
      { ANTHROPIC_CUSTOM_HEADERS: 'X-Superagent-Agent-Id: abc123' },
      'fast'
    )
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBe(
      'X-Superagent-Agent-Id: abc123\nX-Superagent-Speed: fast'
    )
  })

  it('strips pre-existing speed lines case-insensitively before appending', () => {
    const out = withSpeedHeader(
      { ANTHROPIC_CUSTOM_HEADERS: 'x-superagent-speed: fast\nX-User-Header: keep-me' },
      'slow'
    )
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBe('X-User-Header: keep-me\nX-Superagent-Speed: slow')
  })

  it("strips a stale speed line when reverting to 'normal'", () => {
    const out = withSpeedHeader(
      { ANTHROPIC_CUSTOM_HEADERS: 'X-Superagent-Speed: fast\nX-User-Header: keep-me' },
      'normal'
    )
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBe('X-User-Header: keep-me')
  })

  it('removes ANTHROPIC_CUSTOM_HEADERS entirely when nothing remains', () => {
    const out = withSpeedHeader({ ANTHROPIC_CUSTOM_HEADERS: 'X-Superagent-Speed: fast' }, 'normal')
    expect(out).not.toHaveProperty('ANTHROPIC_CUSTOM_HEADERS')
  })

  it('composes with withAgentAttributionHeaders', () => {
    const out = withSpeedHeader(
      withAgentAttributionHeaders({}, { id: 'abc123', name: 'Bot' }),
      'fast'
    )
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBe(
      'X-Superagent-Agent-Id: abc123\nX-Superagent-Agent-Name: Bot\nX-Superagent-Speed: fast'
    )
  })

  it('does not mutate the input env', () => {
    const env = { OTHER: 'v' }
    const out = withSpeedHeader(env, 'fast')
    expect(env).not.toHaveProperty('ANTHROPIC_CUSTOM_HEADERS')
    expect(out.OTHER).toBe('v')
  })
})

describe('captureAgentIdentity', () => {
  it('reads the identity env keys', () => {
    expect(
      captureAgentIdentity({ SUPERAGENT_AGENT_ID: 'a1', SUPERAGENT_AGENT_NAME: 'N', OTHER: 'x' })
    ).toEqual({ id: 'a1', name: 'N' })
  })
})

describe('isAgentIdentityEnvKey', () => {
  it('flags exactly the identity keys', () => {
    expect(isAgentIdentityEnvKey('SUPERAGENT_AGENT_ID')).toBe(true)
    expect(isAgentIdentityEnvKey('SUPERAGENT_AGENT_NAME')).toBe(true)
    expect(isAgentIdentityEnvKey('SUPERAGENT_AGENT_SLUG')).toBe(false)
    expect(isAgentIdentityEnvKey('PATH')).toBe(false)
  })
})
