import { z } from 'zod'

const id = z.object({ id: z.string() })
const actor = id.extend({ app: z.boolean() })
export const directPageSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
export const directIssueSchema = z.object({
  id: z.string(), identifier: z.string(), title: z.string(), updatedAt: z.string().datetime(),
  archivedAt: z.string().nullable(), delegate: id.nullable(), state: z.object({ id: z.string(), name: z.string(), type: z.string() }),
})
export const directCommentSchema = z.object({
  id: z.string(), body: z.string(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  archivedAt: z.string().nullable(), user: actor.nullable(), parent: id.nullable(), issue: directIssueSchema.nullable(),
})
export const directNotificationSchema = z.object({
  id: z.string(), type: z.string(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  issue: directIssueSchema.optional(), actor: actor.nullable().optional(),
  comment: directCommentSchema.omit({ issue: true }).nullable().optional(),
})
export const directHistorySchema = z.object({
  id: z.string(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), actor: actor.nullable(),
  fromDelegate: id.nullable(), toDelegate: id.nullable(),
  fromState: id.nullable(), toState: z.object({ id: z.string(), name: z.string(), type: z.string() }).nullable(),
  archived: z.boolean().nullable(),
})
export const directFrameSchema = z.object({
  type: z.string(), id: z.string().optional(), payload: z.unknown().optional(),
})
export type DirectIssue = z.infer<typeof directIssueSchema>
export type DirectComment = z.infer<typeof directCommentSchema>
export type DirectNotification = z.infer<typeof directNotificationSchema>
export type DirectHistory = z.infer<typeof directHistorySchema>

export const directNotificationsResponseSchema = z.object({ notifications: z.object({ nodes: z.array(directNotificationSchema), pageInfo: directPageSchema }) })
export const directCommentsResponseSchema = z.object({ comments: z.object({ nodes: z.array(directCommentSchema), pageInfo: directPageSchema }) })
export const directHistoryResponseSchema = z.object({ issue: directIssueSchema.extend({ history: z.object({ nodes: z.array(directHistorySchema), pageInfo: directPageSchema }) }) })
const wakeSchema = z.object({ id: z.string().optional(), issue: z.object({ id: z.string() }).nullable().optional() })
export const directWakeResponseSchema = z.object({ data: z.record(z.string(), wakeSchema.nullable()).nullish(), errors: z.array(z.unknown()).optional() })

export const directIssuesResponseSchema = z.object({ issues: z.object({ nodes: z.array(directIssueSchema), pageInfo: directPageSchema }) })
