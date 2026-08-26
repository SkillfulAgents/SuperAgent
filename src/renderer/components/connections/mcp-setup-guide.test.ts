import { describe, expect, it } from 'vitest'
import { resolveSetupStep, isLoopbackRedirect } from './mcp-setup-guide'
import { COMMON_MCP_SERVERS } from '@shared/lib/mcp/common-servers'

describe('resolveSetupStep', () => {
  const redirect = 'https://iddo.example.so/api/remote-mcps/oauth-callback'

  it('substitutes the redirect, its origin, and its bare host', () => {
    expect(resolveSetupStep('uri {{redirectUri}}', redirect)).toBe(`uri ${redirect}`)
    expect(resolveSetupStep('origin {{redirectOrigin}}', redirect)).toBe(
      'origin https://iddo.example.so',
    )
    // Meta's App Domains field rejects a scheme, so the bare host is its own token.
    expect(resolveSetupStep('host {{redirectHost}}', redirect)).toBe('host iddo.example.so')
  })

  it('substitutes every occurrence of a token in one step', () => {
    expect(resolveSetupStep('{{redirectHost}} and {{redirectHost}}', redirect)).toBe(
      'iddo.example.so and iddo.example.so',
    )
  })

  it('keeps the port on a loopback redirect, since consoles want an exact match', () => {
    const loopback = 'http://localhost:47892/api/remote-mcps/oauth-callback'
    expect(resolveSetupStep('{{redirectUri}}', loopback)).toBe(loopback)
    expect(resolveSetupStep('{{redirectHost}}', loopback)).toBe('localhost:47892')
  })

  it('empties origin and host for an unparseable redirect rather than rendering a broken URL', () => {
    const scheme = 'superagent://mcp-oauth-callback'
    expect(resolveSetupStep('{{redirectUri}}', scheme)).toBe(scheme)
    expect(resolveSetupStep('[{{redirectOrigin}}]', scheme)).toBe('[]')
    expect(resolveSetupStep('[{{redirectHost}}]', scheme)).toBe('[]')
  })

  it('leaves a step with no tokens untouched', () => {
    expect(resolveSetupStep('Leave the app in Development mode.', redirect)).toBe(
      'Leave the app in Development mode.',
    )
  })
})

describe('isLoopbackRedirect', () => {
  it('detects loopback hosts, whose port can shift between runs', () => {
    expect(isLoopbackRedirect('http://localhost:47891/api/remote-mcps/oauth-callback')).toBe(true)
    expect(isLoopbackRedirect('http://127.0.0.1:47891/api/remote-mcps/oauth-callback')).toBe(true)
  })

  it('does not treat a hosted deployment or an app scheme as loopback', () => {
    expect(isLoopbackRedirect('https://iddo.example.so/api/remote-mcps/oauth-callback')).toBe(false)
    expect(isLoopbackRedirect('superagent://mcp-oauth-callback')).toBe(false)
  })
})

describe('catalog setup guides', () => {
  const guided = COMMON_MCP_SERVERS.filter((server) => server.setup)

  it('ships a guide for the official Meta Ads server', () => {
    const meta = COMMON_MCP_SERVERS.find((server) => server.slug === 'meta-ads-official')
    expect(meta?.setup?.requiresClientId).toBe(true)
    expect(meta?.setup?.steps.length).toBeGreaterThan(0)
  })

  it('uses only tokens the renderer knows how to substitute', () => {
    const known = new Set(['redirectUri', 'redirectOrigin', 'redirectHost'])
    for (const server of guided) {
      for (const step of server.setup!.steps) {
        for (const [, token] of step.matchAll(/\{\{(\w+)\}\}/g)) {
          expect(known, `${server.slug}: {{${token}}}`).toContain(token)
        }
      }
    }
  })

  it('leaves no unsubstituted tokens once a redirect is applied', () => {
    for (const server of guided) {
      for (const step of server.setup!.steps) {
        const resolved = resolveSetupStep(step, 'https://example.com/api/remote-mcps/oauth-callback')
        expect(resolved, `${server.slug}`).not.toMatch(/\{\{|\}\}/)
      }
    }
  })
})
