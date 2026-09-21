import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinearClient } from './client'
import { LinearTasks } from './tasks'

const notice = { id: '3d825800-f39d-4d45-830c-1a2237d91d02', body: 'Could not start the agent. Please try again.' }
afterEach(() => vi.unstubAllGlobals())
describe('Linear host failure notices', () => {
  it('posts to the original thread and recovers a lost response without duplicating the comment', async () => {
    let created = false
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      const { query, variables } = JSON.parse(String(options.body))
      if (query.includes('commentCreate')) {
        expect(variables.input).toEqual({ ...notice, issueId: 'issue', parentId: 'thread' })
        created = true
        throw new Error('Response lost after write')
      }
      expect(variables).toEqual({ id: notice.id })
      return Response.json({ data: { comments: { nodes: created ? [{ id: notice.id, issue: { id: 'issue' } }] : [] } } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const tasks = new LinearTasks(new LinearClient(undefined, 'agent-token'))
    await expect(tasks.failureNotice('issue', notice, 'thread')).rejects.toThrow('Response lost')
    await tasks.failureNotice('issue', notice, 'thread')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
  it('does not treat a comment on another issue as successful delivery', async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: { comments: { nodes: [{ id: notice.id, issue: { id: 'other' } }] } } }))
    vi.stubGlobal('fetch', fetchMock)
    const tasks = new LinearTasks(new LinearClient(undefined, 'agent-token'))
    await expect(tasks.failureNotice('issue', notice)).rejects.toThrow('another issue')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
