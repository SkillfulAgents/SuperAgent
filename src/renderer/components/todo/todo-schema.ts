import { z } from 'zod'

/**
 * The work space (prototype): every thread of work your agents have going,
 * so you can run many at once. An item is a one-off task, a recurring job
 * (cron or webhook), or a conversation, and its `column` is its status:
 *
 *   drafts → working → attention ⇄ working → done → archive
 *
 * Attention is the part that needs you: unblocking (a question, a
 * permission, a reconnect) or reviewing output. The board shows Drafts,
 * Needs you and Working, with Done folded to the side.
 */
export const TODO_COLUMNS = ['drafts', 'attention', 'working', 'done', 'archive'] as const
export type TodoColumn = (typeof TODO_COLUMNS)[number]

/** What kind of work an item is. */
export const todoSourceSchema = z.enum(['task', 'recurring', 'conversation'])
export type TodoSource = z.infer<typeof todoSourceSchema>

export const todoColumnSchema = z.enum(TODO_COLUMNS)

export const todoAgentRefSchema = z.object({
  slug: z.string(),
  name: z.string(),
  /** The session this agent is running the task in, once started. */
  sessionId: z.string().optional(),
})
export type TodoAgentRef = z.infer<typeof todoAgentRefSchema>

export const todoAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().nonnegative(),
  kind: z.enum(['file', 'folder']),
})
export type TodoAttachment = z.infer<typeof todoAttachmentSchema>

/** Mirrors the shared `Question` shape the session question card renders. */
export const todoQuestionSchema = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
  multiSelect: z.boolean().optional(),
})
export type TodoQuestion = z.infer<typeof todoQuestionSchema>

export const todoAttentionReasonSchema = z.enum(['question', 'review', 'action'])
export type TodoAttentionReason = z.infer<typeof todoAttentionReasonSchema>

/**
 * A one-click ask, carried in the same shape a session carries it so the
 * item's page can render the session's own approval card: a script to
 * allow, or an account to reconnect.
 */
export const todoRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('script_run'),
    script: z.string(),
    explanation: z.string(),
    scriptType: z.enum(['applescript', 'shell', 'powershell']),
  }),
  z.object({
    type: z.literal('account_reauth'),
    toolkit: z.string(),
    accountStatus: z.enum(['expired', 'revoked']),
  }),
])
export type TodoRequest = z.infer<typeof todoRequestSchema>

export const todoCardSchema = z.object({
  id: z.string(),
  /** Generated from the prompt on first save; the user may overwrite it. */
  title: z.string(),
  titleIsGenerated: z.boolean().default(true),
  /** The task context — what the draft dialog edits and what an agent would be sent. */
  prompt: z.string(),
  column: todoColumnSchema,
  source: todoSourceSchema.default('task'),
  /** For a recurring job: when it runs, as a readable line. */
  schedule: z.string().optional(),
  agents: z.array(todoAgentRefSchema).default([]),
  attachments: z.array(todoAttachmentSchema).default([]),
  /** Why the card sits in Needs Attention; unset in every other column. */
  attentionReason: todoAttentionReasonSchema.optional(),
  /** One-line latest status from the agent, shown on the card. */
  lastUpdate: z.string().optional(),
  /** Set when the agent asked something with choices; absent means a freeform ask. */
  questions: z.array(todoQuestionSchema).optional(),
  /** Set when the ask is a one-click request; the item's page shows the session's card for it. */
  request: todoRequestSchema.optional(),
  /** How many times the simulated agent has handed the card back. */
  simStep: z.number().int().nonnegative().default(0),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type TodoCard = z.infer<typeof todoCardSchema>

export const todoBoardSchema = z.object({
  version: z.literal(1),
  /** Which sample board this came from; a newer sample replaces a stale one on load. */
  seedVersion: z.number().int().optional(),
  cards: z.array(todoCardSchema),
})
export type TodoBoard = z.infer<typeof todoBoardSchema>
