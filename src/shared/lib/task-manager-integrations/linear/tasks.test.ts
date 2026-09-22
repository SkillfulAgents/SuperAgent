import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinearClient } from './client'
import { LinearTasks } from './tasks'

afterEach(() => vi.unstubAllGlobals())
describe('Linear host messages', () => {
  it('posts directly to the triggering thread without a publication lookup', async () => {
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      const { query, variables } = JSON.parse(String(options.body))
      expect(query).toContain('commentCreate')
      expect(variables.input).toEqual({ issueId: 'issue', parentId: 'thread', body: 'Please try again.' })
      return Response.json({ data: { commentCreate: { success: true } } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await new LinearTasks(new LinearClient(undefined, 'agent-token')).postMessage('issue', 'Please try again.', 'thread')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('surfaces a failed notice without retrying an ambiguous write', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('Response lost') })
    vi.stubGlobal('fetch', fetchMock)
    await expect(new LinearTasks(new LinearClient(undefined, 'agent-token')).postMessage('issue', 'Please try again.')).rejects.toThrow('Response lost')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
