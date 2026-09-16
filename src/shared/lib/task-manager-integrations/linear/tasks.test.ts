import { describe, it, expect, vi, afterEach } from 'vitest'
import { LinearTasks } from './tasks'
import { LinearClient } from './client'
const issue = { id: 'issue', identifier: 'SUP-1', title: 'Work', description: 'Details', url: 'https://linear.app/issue', updatedAt: 'v1',
  priority: 0, assignee: { id: 'human', name: 'Human' }, delegate: { id: 'app', name: 'Agent' },
  state: { id: 'todo', name: 'Todo', type: 'unstarted' }, team: { id: 'team', name: 'Team', states: { nodes: [{ id: 'done', name: 'Done', type: 'completed' }] } }, labels: { nodes: [] }, project: null }
afterEach(() => vi.unstubAllGlobals())
describe('Linear scoped task tools', () => {
  it('preserves assignment, rejects stale edits and unknown fields, and binds the issue on the host', async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const request = JSON.parse(options.body); requests.push(request)
      return Response.json({ data: request.query.startsWith('query') ? { issue } : { issueUpdate: { success: true, issue: { id: 'issue', updatedAt: 'v2' } } } })
    }))
    const tasks = new LinearTasks(new LinearClient(undefined, 'token'))
    const update = tasks.tools('issue', () => {}).find(tool => tool.name === 'update_task')!
    await expect(update.execute({ expectedUpdatedAt: 'old', title: 'Changed' })).rejects.toThrow('changed')
    await expect(update.execute({ expectedUpdatedAt: 'v1', title: 'Changed', assigneeId: 'app' })).rejects.toThrow()
    await update.execute({ expectedUpdatedAt: 'v1', title: 'Changed' })
    expect(requests.at(-1)?.variables).toEqual({ id: 'issue', input: { title: 'Changed' } })
  })
  it('rejects cross-issue attachments and stops a write if cancelled during its read', async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: { attachment: { issue: { id: 'other' } } } }))
    vi.stubGlobal('fetch', fetchMock)
    const tasks = new LinearTasks(new LinearClient(undefined, 'token'))
    const remove = tasks.tools('issue', () => {}).find(tool => tool.name === 'delete_attachment')!
    await expect(remove.execute({ attachmentId: 'attachment' })).rejects.toThrow('does not belong')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    let active = true
    fetchMock.mockImplementation(async () => { active = false; return Response.json({ data: { issue } }) })
    const update = tasks.tools('issue', () => { if (!active) throw new Error('Stopped') }).find(tool => tool.name === 'update_task')!
    await expect(update.execute({ expectedUpdatedAt: 'v1', title: 'Changed' })).rejects.toThrow('Stopped')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('publishes uploaded files in the originating thread and reconciles a repeated delivery', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ errors: [{ message: 'Entity not found: Comment', extensions: { code: 'INPUT_ERROR' } }] }))
      .mockResolvedValueOnce(Response.json({ data: { commentCreate: { success: true, comment: { id: 'publication' } } } }))
      .mockResolvedValueOnce(Response.json({ data: { comment: { id: 'publication', issue: { id: 'issue' } } } }))
    vi.stubGlobal('fetch', fetchMock)
    const tasks = new LinearTasks(new LinearClient(undefined, 'token'))
    const event = { id: 'event', taskId: 'issue', interactionId: 'thread', kind: 'invocation' as const, timestamp: '', text: '', payload: {}, replyTarget: { commentId: 'thread' } }
    const publication = { id: 'publication', kind: 'response' as const, body: 'Chart attached', attachments: [{
      id: crypto.randomUUID(), filename: 'graph.png', contentType: 'image/png', size: 5, assetUrl: 'https://uploads.linear.app/graph.png',
    }] }
    expect(await tasks.publish(event, publication)).toBe('publication')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).variables.input).toEqual({
      id: 'publication', issueId: 'issue', parentId: 'thread', body: 'Chart attached\n\n![graph.png](<https://uploads.linear.app/graph.png>)',
    })
    expect(await tasks.publish(event, publication)).toBe('publication')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
  it('reconciles an already-created response instead of double-posting a comment', async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: { comment: { id: 'publication', issue: { id: 'issue' } } } }))
    vi.stubGlobal('fetch', fetchMock)
    const tasks = new LinearTasks(new LinearClient(undefined, 'token'))
    expect(await tasks.publish({ id: 'event', taskId: 'issue', interactionId: 'native-session', kind: 'invocation', timestamp: '', text: '', payload: {}, replyTarget: { commentId: 'thread' } },
      { id: 'publication', kind: 'response', body: 'Done' })).toBe('publication')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
