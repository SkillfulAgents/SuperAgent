import { expect, it, vi } from 'vitest'
import { GitHubClient } from './client'
import { GitHubTasks } from './tasks'
import { issue, comment } from './test-fixtures'
it('hydrates PR conversation and inline context, marking bounded history as truncated', async () => {
  const client = new GitHubClient('integration')
  const request = vi.spyOn(client, 'request')
  request.mockResolvedValueOnce({ ...issue, pull_request: {} })
    .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ({ ...comment, id: i + 1 })))
    .mockResolvedValueOnce([{ ...comment, id: 101, in_reply_to_id: 99 }])
  const task = await new GitHubTasks(client).snapshot('team/project#3')
  expect(task.truncated).toBe(true)
  expect(task.properties).toMatchObject({ kind: 'pull_request' })
  expect(task.comments.at(-1)).toMatchObject({ id: '101', parentId: '99' })
  expect(request.mock.calls.map(call => call[0])).toEqual(['/repos/team/project/issues/3', '/repos/team/project/issues/3/comments?per_page=100', '/repos/team/project/pulls/3/comments?per_page=100'])
})
it('publishes host notices and acknowledgements in the right kind of GitHub thread', async () => {
  const client = new GitHubClient('integration')
  const request = vi.spyOn(client, 'request').mockResolvedValue({ id: 1 })
  const tasks = new GitHubTasks(client)
  await tasks.publish('team/project#3', 'Could not start')
  await tasks.publish('team/project#3', 'Could not start', '99')
  await tasks.acknowledge('team/project#3', '11', false)
  await tasks.acknowledge('team/project#3', '101', true)
  expect(request.mock.calls.map(call => [call[0], call[2]])).toEqual([
    ['/repos/team/project/issues/3/comments', { body: 'Could not start' }],
    ['/repos/team/project/pulls/3/comments/99/replies', { body: 'Could not start' }],
    ['/repos/team/project/issues/comments/11/reactions', { content: 'eyes' }],
    ['/repos/team/project/pulls/comments/101/reactions', { content: 'eyes' }],
  ])
  await expect(tasks.publish('https://evil.example#3', 'No')).rejects.toThrow('identifier')
  await expect(tasks.publish('team/project#3', 'No', '../42')).rejects.toThrow('comment')
  expect(request).toHaveBeenCalledTimes(4)
})
