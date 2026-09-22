import { z } from 'zod'
import type { TaskSnapshot } from '../types'
import { LinearClient } from './client'
import { reactionResultSchema, commentCreateResultSchema } from './direct-schema'

const person = z.object({ id: z.string(), name: z.string() }).nullable()
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
const commentSchema = z.object({ id: z.string(), body: z.string(), createdAt: z.string(), user: person,
  parent: z.object({ id: z.string() }).nullable() })
const attachmentSchema = z.object({ id: z.string(), title: z.string(), url: z.string() })
const issueSchema = z.object({
  id: z.string(), identifier: z.string(), title: z.string(), description: z.string().nullable(),
  url: z.string(), updatedAt: z.string(), priority: z.number(), assignee: person, delegate: person,
  state: z.object({ id: z.string(), name: z.string(), type: z.string() }),
  team: z.object({ id: z.string(), name: z.string(), states: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })) }) }),
  labels: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })) }),
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
})
const issueFields = `id identifier title description url updatedAt priority
  assignee { id name } delegate { id name } state { id name type }
  team { id name states { nodes { id name type } } } labels { nodes { id name } } project { id name }`

export class LinearTasks {
  constructor(private readonly client: LinearClient) {}
  async acknowledge(commentId: string): Promise<void> {
    const result = await this.client.request(
      'mutation($input:ReactionCreateInput!){reactionCreate(input:$input){success}}',
      { input: { commentId, emoji: 'eyes' } }, reactionResultSchema,
    )
    if (!result.reactionCreate.success) throw new Error('Linear rejected the acknowledgement')
  }
  /** Host dispatch notices are best-effort, just like chat delivery. */
  async postMessage(taskId: string, body: string, parentId?: string): Promise<void> {
    const result = await this.client.request('mutation($input:CommentCreateInput!){commentCreate(input:$input){success}}',
      { input: { issueId: taskId, body, ...(parentId ? { parentId } : {}) } },
      commentCreateResultSchema)
    if (!result.commentCreate.success) throw new Error('Linear rejected the host message')
  }
  async issue(taskId: string) {
    return (await this.client.request(`query($id:String!){ issue(id:$id){ ${issueFields} } }`, { id: taskId }, z.object({ issue: issueSchema }))).issue
  }
  async snapshot(taskId: string): Promise<TaskSnapshot> {
    const issue = await this.issue(taskId)
    const comments: TaskSnapshot['comments'] = []
    const attachments: TaskSnapshot['attachments'] = []
    let truncated = false
    for (const resource of ['comments', 'attachments'] as const) {
      let after: string | null = null
      for (let page = 0; page < 10; page++) {
        const fields = resource === 'comments' ? 'id body createdAt user { id name } parent { id }' : 'id title url'
        const data: { issue: Record<string, { nodes: unknown[]; pageInfo: z.infer<typeof pageInfo> }> } = await this.client.request(`query($id:String!,$after:String){issue(id:$id){${resource}(first:100,after:$after){nodes{${fields}} pageInfo{hasNextPage endCursor}}}}`,
          { id: taskId, after }, z.object({ issue: z.record(z.string(), z.object({ nodes: z.array(z.unknown()), pageInfo })) }))
        const connection = data.issue[resource]
        if (resource === 'comments') comments.push(...z.array(commentSchema).parse(connection.nodes).map(comment => ({
          id: comment.id, body: comment.body, createdAt: comment.createdAt, author: comment.user?.name ?? 'Unknown', parentId: comment.parent?.id,
        })))
        else attachments.push(...z.array(attachmentSchema).parse(connection.nodes))
        if (!connection.pageInfo.hasNextPage) break
        if (page === 9) truncated = true
        after = connection.pageInfo.endCursor
        if (!after) { truncated = true; break }
      }
    }
    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return { id: issue.id, identifier: issue.identifier, title: issue.title, description: issue.description ?? '',
      url: issue.url, updatedAt: issue.updatedAt, properties: { state: issue.state, team: issue.team,
        priority: issue.priority, assignee: issue.assignee, delegate: issue.delegate, project: issue.project, labels: issue.labels.nodes },
      comments, attachments, truncated }
  }

}
