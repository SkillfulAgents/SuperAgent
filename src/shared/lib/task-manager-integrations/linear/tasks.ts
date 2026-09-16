import { z } from 'zod'
import type { IntegrationTool } from '../../agent-integrations/types'
import type { TaskEvent, TaskPublication, TaskSnapshot } from '../types'
import { LinearClient, LinearNotFoundError } from './client'
import { linearPublicationBody } from './attachments'
import { reactionResultSchema } from './reaction-schema'

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

  async publish(event: TaskEvent, publication: TaskPublication, assertActive: () => void = () => {}): Promise<string> {
    const client = this.client.withGuard(assertActive)
    // Client-generated UUIDs are persisted before sending. Reconcile ambiguous
    // outcomes on retry with the same ID; never create a second comment UUID.
    let existing: { comment: { id: string; issue: { id: string } | null } | null } | undefined
    try {
      existing = await client.request(`query($id:String!){comment(id:$id){id issue{id}}}`, { id: publication.id },
        z.object({ comment: z.object({ id: z.string(), issue: z.object({ id: z.string() }).nullable() }).nullable() }))
    } catch (error) { if (!(error instanceof LinearNotFoundError)) throw error }
    if (existing?.comment) {
      if (existing.comment.issue?.id !== event.taskId) throw new Error('Comment belongs to another issue')
      return existing.comment.id
    }
    const result = await client.request(`mutation($input:CommentCreateInput!){commentCreate(input:$input){success comment{id}}}`, {
      input: { id: publication.id, issueId: event.taskId, body: linearPublicationBody(publication), ...(event.replyTarget.commentId ? { parentId: event.replyTarget.commentId } : {}) },
    }, z.object({ commentCreate: z.object({ success: z.boolean(), comment: z.object({ id: z.string() }).nullable() }) }))
    if (!result.commentCreate.success || !result.commentCreate.comment) throw new Error('Linear did not create the comment')
    return result.commentCreate.comment.id
  }

  tools(taskId: string, assertActive: () => void): IntegrationTool[] {
    const client = this.client.withGuard(assertActive)
    const tool = <T>(name: string, description: string, schema: z.ZodType<T>, execute: (input: T) => Promise<unknown>): IntegrationTool => ({
      name, description, inputSchema: z.toJSONSchema(schema), execute: async raw => { assertActive(); return execute(schema.parse(raw)) },
    })
    const guardedIssue = async () => { const issue = await this.issue(taskId); assertActive(); return issue }
    return [
      tool('get_current_task', 'Read this issue, current properties, comments and linked attachments.', z.object({}).strict(), async () => this.snapshot(taskId)),
      tool('update_task', 'Edit this issue. Read it first and supply updatedAt to detect intervening edits. Assignment and delegation are preserved.', z.object({
        expectedUpdatedAt: z.string(), title: z.string().min(1).max(255).optional(), description: z.string().max(100000).optional(),
        priority: z.number().int().min(0).max(4).optional(),
      }).strict(), async ({ expectedUpdatedAt, ...patch }) => {
        const issue = await guardedIssue()
        if (issue.updatedAt !== expectedUpdatedAt) throw new Error('The issue changed. Read it again before editing.')
        const result = await client.request(`mutation($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success issue{id updatedAt}}}`, { id: taskId, input: patch },
          z.object({ issueUpdate: z.object({ success: z.boolean(), issue: z.object({ id: z.string(), updatedAt: z.string() }).nullable() }) }))
        if (!result.issueUpdate.success) throw new Error('Linear rejected the issue update')
        return result.issueUpdate.issue
      }),
      tool('transition_task', 'Change this issue to a state from its team. Only do this when requested; finishing a run does not close the issue.', z.object({ stateId: z.string(), expectedUpdatedAt: z.string() }).strict(), async input => {
        const issue = await guardedIssue()
        if (issue.updatedAt !== input.expectedUpdatedAt) throw new Error('The issue changed. Read it again before changing status.')
        if (!issue.team.states.nodes.some(state => state.id === input.stateId)) throw new Error('State does not belong to this issue’s team')
        const result = await client.request(`mutation($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success}}`, { id: taskId, input: { stateId: input.stateId } }, z.object({ issueUpdate: z.object({ success: z.boolean() }) }))
        if (!result.issueUpdate.success) throw new Error('Linear rejected the status change')
        return result.issueUpdate
      }),
      tool('attach_link', 'Attach an HTTPS artifact link to this issue. Repeated use of the same URL updates the existing attachment.', z.object({ title: z.string().min(1), url: z.string().url().refine(url => url.startsWith('https://'), 'Use an HTTPS link') }).strict(), async input => {
        await guardedIssue()
        const result = await client.request(`mutation($input:AttachmentCreateInput!){attachmentCreate(input:$input){success attachment{id}}}`, { input: { issueId: taskId, ...input } }, z.object({ attachmentCreate: z.object({ success: z.boolean(), attachment: z.object({ id: z.string() }).nullable() }) }))
        if (!result.attachmentCreate.success) throw new Error('Linear rejected the attachment')
        return result.attachmentCreate.attachment
      }),
      tool('update_attachment', 'Rename a linked attachment on this issue.', z.object({ attachmentId: z.string(), title: z.string().min(1) }).strict(), async input => {
        await this.assertAttachment(taskId, input.attachmentId); assertActive()
        const result = await client.request(`mutation($id:String!,$input:AttachmentUpdateInput!){attachmentUpdate(id:$id,input:$input){success}}`, { id: input.attachmentId, input: { title: input.title } }, z.object({ attachmentUpdate: z.object({ success: z.boolean() }) }))
        if (!result.attachmentUpdate.success) throw new Error('Linear rejected the attachment update')
        return result.attachmentUpdate
      }),
      tool('delete_attachment', 'Remove a linked attachment from this issue only when requested.', z.object({ attachmentId: z.string() }).strict(), async input => {
        await this.assertAttachment(taskId, input.attachmentId); assertActive()
        const result = await client.request(`mutation($id:String!){attachmentDelete(id:$id){success}}`, { id: input.attachmentId }, z.object({ attachmentDelete: z.object({ success: z.boolean() }) }))
        if (!result.attachmentDelete.success) throw new Error('Linear rejected attachment removal')
        return result.attachmentDelete
      }),
    ]
  }
  private async assertAttachment(taskId: string, attachmentId: string): Promise<void> {
    const result = await this.client.request(`query($id:String!){attachment(id:$id){issue{id}}}`, { id: attachmentId }, z.object({ attachment: z.object({ issue: z.object({ id: z.string() }) }) }))
    if (result.attachment.issue.id !== taskId) throw new Error('Attachment does not belong to this issue')
  }
}
