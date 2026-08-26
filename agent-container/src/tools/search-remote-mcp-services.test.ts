import { describe, it, expect } from 'vitest'
import { searchRemoteMcpServicesTool } from './search-remote-mcp-services'

async function search(term: string): Promise<string> {
  const handler = (searchRemoteMcpServicesTool as any).handler
  const result = await handler({ search: term })
  return result.content[0].text as string
}

describe('searchRemoteMcpServices', () => {
  it('marks a server that cannot connect without a user-registered OAuth app', async () => {
    const text = await search('meta ads')
    expect(text).toContain('Meta Ads (Official)')
    expect(text).toContain('[setup required]')
  })

  it('tells the model to warn the user before requesting a flagged server', async () => {
    const text = await search('meta ads')
    // The point of the flag: the user should hear about provider-side setup
    // before the approval prompt appears, not from inside it.
    expect(text).toContain('rejects dynamic client registration')
    expect(text).toMatch(/clientId/)
    expect(text).toContain('never ask them for a client secret')
  })

  it('omits the setup guidance when nothing in the results needs it', async () => {
    const text = await search('linear')
    expect(text).toContain('Linear')
    expect(text).not.toContain('[setup required]')
    expect(text).not.toContain('rejects dynamic client registration')
  })

  it('leaves servers that self-register unflagged', async () => {
    const text = await search('meta ads')
    const pipeboard = text.split('\n').find((line) => line.includes('Pipeboard'))
    expect(pipeboard).toBeDefined()
    expect(pipeboard).not.toContain('[setup required]')
  })
})
