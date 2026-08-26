import { describe, expect, it } from 'vitest'
import { COMMON_MCP_SERVERS } from './common-servers'
// Pure data, no agent SDK import — see the note at the top of that file.
import { MCP_SERVICES } from '../../../../agent-container/src/tools/mcp-service-catalog'

/**
 * The agent's catalog is a hand-maintained copy of the host's, because the
 * container builds with plain `tsc` and cannot import from @shared. These are the
 * invariants that keep the copy honest.
 *
 * Note it is deliberately a SUBSET, not a mirror: the full host catalog is far
 * too long to sit in the model's context, which is why the tool advertises itself
 * as a partial directory. So "every host entry appears in the agent list" is NOT
 * an invariant — but everything below is.
 */
describe('agent MCP catalog parity', () => {
  const bySlug = new Map(COMMON_MCP_SERVERS.map((server) => [server.slug, server]))

  it('has no entry the app catalog does not know about', () => {
    const orphans = MCP_SERVICES.filter((service) => !bySlug.has(service.slug)).map((s) => s.slug)
    expect(orphans, `agent-only slugs: ${orphans.join(', ')}`).toEqual([])
  })

  it('agrees with the app catalog on every field it copies', () => {
    // A url or authType that drifts sends the agent at the wrong endpoint, or
    // makes it request the wrong kind of credential.
    const drifted: string[] = []
    for (const service of MCP_SERVICES) {
      const server = bySlug.get(service.slug)
      if (!server) continue
      if (server.url !== service.url) {
        drifted.push(`${service.slug}: url ${service.url} !== ${server.url}`)
      }
      if (server.authType !== service.authType) {
        drifted.push(`${service.slug}: authType ${service.authType} !== ${server.authType}`)
      }
      if (server.displayName !== service.displayName) {
        drifted.push(`${service.slug}: displayName "${service.displayName}" !== "${server.displayName}"`)
      }
      if (server.category !== service.category) {
        drifted.push(`${service.slug}: category "${service.category}" !== "${server.category}"`)
      }
    }
    expect(drifted, drifted.join('\n')).toEqual([])
  })

  it('flags a server as needing its own OAuth app exactly when the app catalog does', () => {
    // requiresOwnOAuthApp is what makes the agent warn the user before requesting
    // the server. If it falls out of step with the host's setup.requiresClientId,
    // the agent either warns about nothing or walks the user into a dead end.
    const mismatched: string[] = []
    for (const service of MCP_SERVICES) {
      const server = bySlug.get(service.slug)
      if (!server) continue
      const agentSaysSetup = service.requiresOwnOAuthApp === true
      const appSaysSetup = server.setup?.requiresClientId === true
      if (agentSaysSetup !== appSaysSetup) {
        mismatched.push(`${service.slug}: agent ${agentSaysSetup}, app ${appSaysSetup}`)
      }
    }
    expect(mismatched, mismatched.join('\n')).toEqual([])
  })

  it('carries every server that needs provider-side setup', () => {
    // The one direction where the subset must be complete. A server with a setup
    // guide cannot be connected by approving a request alone, so an agent that
    // cannot see it will suggest it via some other route and strand the user —
    // which is exactly how the Meta rows went missing here.
    const agentSlugs = new Set(MCP_SERVICES.map((service) => service.slug))
    const missing = COMMON_MCP_SERVERS.filter(
      (server) => server.setup && !agentSlugs.has(server.slug),
    ).map((server) => server.slug)
    expect(missing, `needs provider setup but hidden from the agent: ${missing.join(', ')}`).toEqual(
      [],
    )
  })

  it('keeps slugs unique on both sides', () => {
    expect(new Set(MCP_SERVICES.map((s) => s.slug)).size).toBe(MCP_SERVICES.length)
    expect(new Set(COMMON_MCP_SERVERS.map((s) => s.slug)).size).toBe(COMMON_MCP_SERVERS.length)
  })
})
