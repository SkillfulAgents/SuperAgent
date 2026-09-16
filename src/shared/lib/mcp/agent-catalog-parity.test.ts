import { describe, expect, it } from 'vitest'
import { COMMON_MCP_SERVERS } from './common-servers'
// Pure data, no agent SDK import — see the note at the top of that file.
import { MCP_SERVICES } from '../../../../agent-container/src/tools/mcp-service-catalog'

/**
 * The agent's catalog is a copy of the host's, because the container builds with
 * plain `tsc` and cannot import from @shared. These are the invariants that keep
 * the copy honest — the two lists must be identical, entry for entry.
 *
 * The list is not trimmed for context: search_remote_mcp_services filters before
 * anything reaches the model, and a no-term call returns a category index rather
 * than every row. So there is no reason for the agent to know about fewer servers
 * than the app offers — which is exactly how both Meta rows went missing.
 */
describe('agent MCP catalog parity', () => {
  const bySlug = new Map(COMMON_MCP_SERVERS.map((server) => [server.slug, server]))

  it('offers the agent exactly the servers the app offers', () => {
    const agentSlugs = MCP_SERVICES.map((service) => service.slug).sort()
    const appSlugs = COMMON_MCP_SERVERS.map((server) => server.slug).sort()
    expect(agentSlugs).toEqual(appSlugs)
  })

  it('has no entry the app catalog does not know about', () => {
    const orphans = MCP_SERVICES.filter((service) => !bySlug.has(service.slug)).map((s) => s.slug)
    expect(orphans, `agent-only slugs: ${orphans.join(', ')}`).toEqual([])
  })

  it('hides no app entry from the agent', () => {
    const agentSlugs = new Set(MCP_SERVICES.map((service) => service.slug))
    const missing = COMMON_MCP_SERVERS.filter((server) => !agentSlugs.has(server.slug)).map(
      (server) => server.slug,
    )
    expect(missing, `app-only slugs: ${missing.join(', ')}`).toEqual([])
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
      if (server.description !== service.description) {
        drifted.push(`${service.slug}: description drifted`)
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

  it('keeps slugs unique on both sides', () => {
    expect(new Set(MCP_SERVICES.map((s) => s.slug)).size).toBe(MCP_SERVICES.length)
    expect(new Set(COMMON_MCP_SERVERS.map((s) => s.slug)).size).toBe(COMMON_MCP_SERVERS.length)
  })
})
