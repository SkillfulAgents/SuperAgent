import { z } from 'zod'
import type { UserInputRequestKind } from '@shared/lib/tools/requests/request-schema'
import { EFFORT_LEVELS, SPEED_LEVELS, type EffortLevel, type SpeedLevel } from '@shared/lib/container/types'

/**
 * The Todo board's shapes, shared by the API and the renderer.
 *
 * An item's `status` is what the person decided and is stored:
 *
 *   draft ──start──▶ active ──mark done──▶ done ──archive──▶ archived
 *     │                ▲                    │ ▲                  │
 *     │                └──────reopen────────┘ └────unarchive─────┘
 *     └──archive──▶ archived ──unarchive──▶ draft
 *
 * Unarchiving puts an item back where it was archived from: Drafts if it
 * was never started, Done if it was.
 *
 * Its board `column` is derived. A draft, a done item and an archived one sit
 * in the column of the same name; an active item sits wherever its session
 * is right now — working on a turn, blocked on the person, or idle with
 * something to look at.
 */
export const TODO_STATUSES = ['draft', 'active', 'done', 'archived'] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

export const TODO_COLUMNS = ['drafts', 'working', 'needs_input', 'has_updates', 'done', 'archived'] as const
export type TodoColumn = (typeof TODO_COLUMNS)[number]

export const TODO_TITLE_MAX = 200
export const TODO_DESCRIPTION_MAX = 20_000

const titleSchema = z.string().trim().max(TODO_TITLE_MAX)
const descriptionSchema = z.string().max(TODO_DESCRIPTION_MAX)
const agentSlugSchema = z.string().trim().min(1).max(200)
const modelSchema = z.string().trim().min(1).max(200)
const runtimeFields = {
  model: modelSchema.nullable().optional(),
  llmProviderId: modelSchema.nullable().optional(),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
  speed: z.enum(SPEED_LEVELS).nullable().optional(),
}

const attachmentBase = {
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  mimeType: z.string().max(200),
  addedAt: z.number().int().nonnegative(),
  agentSlug: z.string().trim().min(1).max(200),
}

/** A file or folder already in an agent's workspace, or a mount path bound at Start. */
export const todoAttachmentSchema = z.discriminatedUnion('kind', [
  z.object({ ...attachmentBase, kind: z.literal('file'), path: z.string().min(1).max(4096) }).strict(),
  z.object({ ...attachmentBase, kind: z.literal('folder'), path: z.string().min(1).max(4096) }).strict(),
  z.object({ ...attachmentBase, kind: z.literal('mount'), hostPath: z.string().min(1).max(4096) }).strict(),
])
export type TodoAttachment = z.infer<typeof todoAttachmentSchema>

export const todoAttachmentsSchema = z.array(todoAttachmentSchema)

/** The list on the row. A bad value reads as none, so one bad write cannot blank the board. */
export function parseTodoAttachments(raw: string): TodoAttachment[] {
  try {
    const parsed = todoAttachmentsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

/**
 * Held files that still need the agent's upload. `uploaded` is what this start
 * already sent; `claimed` is the list the claim returned.
 */
export const createTodoSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema.default(''),
    agentSlug: agentSlugSchema.nullable().optional(),
    newAgent: z.boolean().optional(),
    ...runtimeFields,
  })
  .strict()
  .refine((todo) => !(todo.newAgent && todo.agentSlug), { message: 'A todo goes to an agent or a new one, not both' })
export type CreateTodoInput = z.infer<typeof createTodoSchema>

/**
 * Edits a draft. `agentSlug: null` unassigns. Assigning an agent clears
 * `newAgent` and setting `newAgent` clears the agent, so it is one or the
 * other. `model`, `effort` or `speed` null goes back to the agent's default.
 */
export const updateTodoSchema = z
  .object({
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    agentSlug: agentSlugSchema.nullable().optional(),
    newAgent: z.boolean().optional(),
    ...runtimeFields,
  })
  .strict()
  .refine((patch) => !(patch.newAgent && patch.agentSlug), { message: 'A todo goes to an agent or a new one, not both' })
export type UpdateTodoInput = z.infer<typeof updateTodoSchema>

/** Puts a session that already exists on the board, titled by the person (the session's name by default). */
export const addSessionTodoSchema = z
  .object({
    title: titleSchema.pipe(z.string().min(1)),
    agentSlug: agentSlugSchema,
    sessionId: z.string().trim().min(1).max(200),
  })
  .strict()
export type AddSessionTodoInput = z.infer<typeof addSessionTodoSchema>

/** Renames started work. Its brief stays what the agent was sent; only the card's title changes. */
export const renameTodoSchema = z.object({ title: titleSchema.pipe(z.string().min(1)) }).strict()

const claimSchema = z.string().min(1).max(100)

/** Links a draft to the session its agent was just started in, by the start that claimed it. */
export const startTodoSchema = z.object({ sessionId: z.string().trim().min(1).max(200), claim: claimSchema }).strict()

/** Gives up a start claim. */
export const releaseStartSchema = z.object({ claim: claimSchema }).strict()

/** The statuses a person can move an item to. Starting is its own endpoint. */
export const todoStatusChangeSchema = z.object({ status: z.enum(['draft', 'active', 'done', 'archived']) }).strict()
export type TodoStatusChange = z.infer<typeof todoStatusChangeSchema>['status']

/**
 * Which statuses each target can be reached from. Unarchiving also depends
 * on whether the item was ever started: back to Drafts if not, Done if so.
 */
export const TODO_TRANSITIONS: Record<TodoStatusChange, readonly TodoStatus[]> = {
  // Unarchive a draft that was never started.
  draft: ['archived'],
  // Reopen: back on the board from Done.
  active: ['done'],
  done: ['active', 'archived'],
  archived: ['draft', 'done'],
}

/** Where unarchiving puts an item back. */
export function todoUnarchiveStatus(todo: { startedAt: number | null }): 'draft' | 'done' {
  return todo.startedAt === null ? 'draft' : 'done'
}

/** Puts an item at a place in its column. */
export const moveTodoSchema = z.object({ position: z.number().finite() }).strict()

/** Board order within a column: highest position first. */
export function byBoardOrder(a: { position: number }, b: { position: number }): number {
  return b.position - a.position
}

/**
 * The position that puts an item between `above` and `below` (either may be
 * missing, at the top or bottom of the column).
 */
export function positionBetween(above: { position: number } | undefined, below: { position: number } | undefined): number | null {
  if (above && below) return (above.position + below.position) / 2
  if (above) return above.position - 1
  if (below) return below.position + 1
  return null
}

/**
 * The new position for `movedId` dropped onto `overId`'s place in `column`
 * (in board order): it takes that place and the cards between shift by one,
 * as in a sortable list. Null when nothing moves.
 */
export function positionAfterDrop<T extends { id: string; position: number }>(column: readonly T[], movedId: string, overId: string): number | null {
  const from = column.findIndex((t) => t.id === movedId)
  const to = column.findIndex((t) => t.id === overId)
  if (from === -1 || to === -1 || from === to) return null
  const rest = column.filter((_, i) => i !== from)
  return positionBetween(rest[to - 1], rest[to])
}

/**
 * What a Needs input item is waiting for, grouped the way a person acts on
 * it: answer a question, allow something, reconnect an account that
 * expired, connect one it never had, or hand over a detail (a secret, a
 * file, something typed into the browser).
 */
export const TODO_ASKS = ['answer', 'permission', 'reconnect', 'connect', 'info'] as const
export type TodoAsk = (typeof TODO_ASKS)[number]

const ASK_BY_KIND: Record<UserInputRequestKind, TodoAsk> = {
  question: 'answer',
  script_run: 'permission',
  computer_use: 'permission',
  capability_review: 'permission',
  proxy_review: 'permission',
  x_agent_review: 'permission',
  account_reauth_required: 'reconnect',
  mcp_reauth_required: 'reconnect',
  connected_account: 'connect',
  remote_mcp: 'connect',
  secret: 'info',
  file: 'info',
  browser_input: 'info',
}

/** The ask for a session's open requests: the oldest one that blocks it. */
export function todoAskFor(requests: readonly { kind: UserInputRequestKind; blocking: boolean; autoApproved: boolean }[]): TodoAsk | null {
  const waiting = requests.find((r) => r.blocking && !r.autoApproved)
  return waiting ? ASK_BY_KIND[waiting.kind] : null
}

export const TODO_ASK_LABELS: Record<TodoAsk, string> = {
  answer: 'Needs answer',
  permission: 'Permission',
  reconnect: 'Reconnect',
  connect: 'Connect',
  info: 'Needs info',
}

/** What the list endpoint returns per item. Times are epoch milliseconds. */
export interface TodoView {
  id: string
  title: string
  description: string
  agentSlug: string | null
  /** A draft to be given to an agent created for it when it starts. */
  newAgent: boolean
  /** What was picked to run it on; each null starts it on the agent's default. */
  model: string | null
  llmProviderId: string | null
  effort: EffortLevel | null
  speed: SpeedLevel | null
  sessionId: string | null
  status: TodoStatus
  column: TodoColumn
  /** Its place in its column, highest first. */
  position: number
  /** A draft whose start is in progress, from this tab or another. */
  starting: boolean
  /** For an item in Needs input: what it is waiting for, when known. */
  ask: TodoAsk | null
  /** When its session is scheduled to resume on its own, if it is. */
  pendingWakeAt: number | null
  /** Files held with the item. The list freezes at Start, like the brief. */
  attachments: TodoAttachment[]
  createdAt: number
  updatedAt: number
  startedAt: number | null
  completedAt: number | null
}

/** What the board needs to know about an active item's session. */
export interface TodoSessionState {
  isActive: boolean
  isAwaitingInput: boolean
}

/**
 * Where an item sits on the board. A blocked session needs the person even
 * while its turn is technically still open, so input wins over working; an
 * idle one has finished a turn and has something to look at.
 */
export function todoColumn(status: TodoStatus, session: TodoSessionState | null): TodoColumn {
  switch (status) {
    case 'draft':
      return 'drafts'
    case 'done':
      return 'done'
    case 'archived':
      return 'archived'
    case 'active':
      if (session?.isAwaitingInput) return 'needs_input'
      if (session?.isActive) return 'working'
      return 'has_updates'
  }
}

/**
 * The first message the agent gets. The description is the brief; a title
 * the person wrote heads it, since it often says what the description takes
 * for granted.
 */
export function todoPrompt(todo: Pick<TodoView, 'title' | 'description'>): string {
  const title = todo.title.trim()
  const description = todo.description.trim()
  if (!title) return description
  if (!description) return title
  return `${title}\n\n${description}`
}

/** The title a card shows: the one the person wrote, else one from the description. */
export function todoDisplayTitle(todo: Pick<TodoView, 'title' | 'description'>): string {
  return todo.title.trim() || deriveTodoTitle(todo.description) || 'Untitled task'
}

/**
 * A card-sized title from a description, for a draft the person did not name:
 * the first sentence of the first line with content, trimmed to whole words.
 */
export function deriveTodoTitle(description: string): string {
  const firstLine = description
    .split(/\n/)
    .map((line) => line.replace(/^[#>*\-\s]+/, '').trim())
    .find((line) => line.length > 0)
  if (!firstLine) return ''
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0]
  let out = ''
  for (const word of sentence.split(/\s+/)) {
    if ((out + ' ' + word).trim().length > 56) break
    out = (out + ' ' + word).trim()
  }
  if (!out) out = sentence.slice(0, 56)
  out = out.replace(/[.,;:]+$/, '')
  return out.charAt(0).toUpperCase() + out.slice(1)
}
