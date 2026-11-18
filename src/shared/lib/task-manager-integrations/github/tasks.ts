import type { TaskSnapshot } from '../types'
import { GitHubClient } from './client'
import { githubCommentsSchema, githubIssueSchema, githubCreatedSchema } from './api-schema'

export function githubTaskPath(taskId: string): { path: string; number: string } {
  const match = /^([a-zA-Z0-9-]+)\/([a-zA-Z0-9_.-]+)#([1-9][0-9]*)$/.exec(taskId)
  if (!match) throw new Error('Invalid GitHub issue identifier')
  return { path: `/repos/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`, number: match[3] }
}
export class GitHubTasks {
  constructor(private readonly client: GitHubClient) {}
  async snapshot(taskId: string): Promise<TaskSnapshot> {
    const { path, number } = githubTaskPath(taskId)
    const issue = await this.client.request(`${path}/issues/${number}`, githubIssueSchema)
    const comments = await this.client.request(`${path}/issues/${number}/comments?per_page=100`, githubCommentsSchema)
    const reviewComments = issue.pull_request ? await this.client.request(`${path}/pulls/${number}/comments?per_page=100`, githubCommentsSchema) : []
    return { id: taskId, identifier: taskId, title: issue.title, description: issue.body ?? '', url: issue.html_url, updatedAt: issue.updated_at,
      properties: { status: issue.state, kind: issue.pull_request ? 'pull_request' : 'issue' },
      comments: [...comments, ...reviewComments].map(comment => ({ id: String(comment.id), body: comment.body, author: comment.user.login,
        createdAt: comment.created_at, parentId: comment.in_reply_to_id ? String(comment.in_reply_to_id) : undefined })),
      attachments: [], truncated: comments.length === 100 || reviewComments.length === 100 }
  }
  async publish(taskId: string, body: string, parentId?: string): Promise<void> {
    const { path, number } = githubTaskPath(taskId)
    if (parentId && !/^\d+$/.test(parentId)) throw new Error('Invalid GitHub review comment')
    await this.client.request(parentId ? `${path}/pulls/${number}/comments/${parentId}/replies` : `${path}/issues/${number}/comments`, githubCreatedSchema, { body })
  }
  async acknowledge(taskId: string, commentId: string, inline: boolean): Promise<void> {
    if (!/^\d+$/.test(commentId)) return
    const { path } = githubTaskPath(taskId)
    await this.client.request(`${path}/${inline ? 'pulls' : 'issues'}/comments/${commentId}/reactions`, githubCreatedSchema, { content: 'eyes' })
  }
}
