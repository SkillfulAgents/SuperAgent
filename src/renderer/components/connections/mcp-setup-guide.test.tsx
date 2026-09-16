import { describe, expect, it } from 'vitest'
import { resolveSetupStep, isLoopbackRedirect, renderStepInline } from './mcp-setup-guide'
import type { ReactElement } from 'react'
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

describe('renderStepInline', () => {
  it('splits a code span out of surrounding text', () => {
    const nodes = renderStepInline('add `example.com` here')
    expect(nodes).toHaveLength(3)
    expect(nodes[0]).toBe('add ')
    expect(nodes[2]).toBe(' here')
  })

  it('renders a code span as <code>, so a host can be selected and copied', () => {
    const [node] = renderStepInline('`example.com`') as ReactElement[]
    expect(node.type).toBe('code')
    expect(node.props.children).toBe('example.com')
  })

  it('renders a markdown link as an anchor that opens safely', () => {
    const [node] = renderStepInline('[console](https://developers.facebook.com/apps/creation/)') as ReactElement[]
    expect(node.type).toBe('a')
    expect(node.props.href).toBe('https://developers.facebook.com/apps/creation/')
    expect(node.props.children).toBe('console')
    expect(node.props.rel).toBe('noopener noreferrer')
  })

  it('leaves a non-https link as literal text rather than linking it', () => {
    // A catalog entry must not be able to introduce a javascript: target.
    const nodes = renderStepInline('[x](javascript:alert(1))')
    expect(nodes).toEqual(['[x](javascript:alert(1))'])
  })

  it('returns plain text unchanged', () => {
    expect(renderStepInline('no markup here')).toEqual(['no markup here'])
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
