import { describe, it, expect, vi } from 'vitest'
import { MCP_SERVICES } from './mcp-service-catalog'
import { PREFERRED_ACCESS } from './preferred-access'
import { searchRemoteMcpServicesTool } from './search-remote-mcp-services'

// Plaid is only listed in Gamut platform mode, read at module load.
vi.stubEnv('COMPOSIO_PLATFORM_MODE', 'true')
const { SERVICES, searchConnectedAccountServicesTool } = await import('./search-connected-account-services')

async function run(tool: unknown, search: string): Promise<string> {
  const result = await (tool as any).handler({ search })
  return result.content[0].text as string
}

function lineFor(text: string, needle: string): string {
  const line = text.split('\n').find((l) => l.includes(needle))
  expect(line).toBeDefined()
  return line!
}

describe('preferred access between connected accounts and MCPs', () => {
  it('names only slugs that exist in both catalogs', () => {
    for (const p of PREFERRED_ACCESS) {
      expect(SERVICES.map((s) => s.slug)).toContain(p.account)
      expect(MCP_SERVICES.map((s) => s.slug)).toContain(p.mcp)
    }
  })

  it('points a Notion account search at the preferred MCP URL', async () => {
    const line = lineFor(await run(searchConnectedAccountServicesTool, 'notion'), '- notion (Notion)')
    expect(line).toContain('[MCP https://mcp.notion.com/mcp preferred; use this account when: bulk export')
  })

  it('tells a Notion MCP search when the account is the better fit', async () => {
    const line = lineFor(await run(searchRemoteMcpServicesTool, 'notion'), '**Notion**')
    expect(line).toContain('[preferred over connected account "notion"; use the account when:')
  })

  it('steers Confluence to the account even though the MCP slug differs', async () => {
    const mcp = lineFor(await run(searchRemoteMcpServicesTool, 'confluence'), '**Atlassian (Jira/Confluence)**')
    expect(mcp).toContain('[connected account "confluence" preferred; use this MCP when: Rovo semantic search')
    const account = lineFor(await run(searchConnectedAccountServicesTool, 'confluence'), '- confluence (Confluence)')
    expect(account).toContain('[preferred over MCP https://mcp.atlassian.com/v1/mcp; use the MCP when:')
  })

  it('leaves services offered only one way unmarked', async () => {
    const line = lineFor(await run(searchConnectedAccountServicesTool, 'gmail'), '- gmail (Gmail)')
    expect(line).not.toContain('preferred')
  })
})
