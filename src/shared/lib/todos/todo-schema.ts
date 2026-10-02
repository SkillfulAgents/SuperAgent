import { z } from 'zod'

/**
 * The Todo board's shapes, shared by the API and the renderer.
 *
 * An item's `status` is what the person decided and is stored:
 *
 *   draft ──start──▶ active ──mark done──▶ done ──archive──▶ archived
 *                      ▲                    │ ▲                  │
 *                      └──────reopen────────┘ └────unarchive─────┘
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

export const createTodoSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema.default(''),
    agentSlug: agentSlugSchema.nullable().optional(),
  })
  .strict()
  .refine((todo) => todo.title.length > 0 || todo.description.trim().length > 0, {
    message: 'A todo needs a title or a description',
  })
export type CreateTodoInput = z.infer<typeof createTodoSchema>

/** Edits a draft. `agentSlug: null` unassigns. */
export const updateTodoSchema = z
  .object({
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    agentSlug: agentSlugSchema.nullable().optional(),
  })
  .strict()
export type UpdateTodoInput = z.infer<typeof updateTodoSchema>

/** Links a draft to the session its agent was just started in. */
export const startTodoSchema = z.object({ sessionId: z.string().trim().min(1).max(200) }).strict()

/** The statuses a person can move an item to after it has started. */
export const todoStatusChangeSchema = z.object({ status: z.enum(['active', 'done', 'archived']) }).strict()
export type TodoStatusChange = z.infer<typeof todoStatusChangeSchema>['status']

/** Which statuses each target can be reached from. Starting is its own endpoint. */
export const TODO_TRANSITIONS: Record<TodoStatusChange, readonly TodoStatus[]> = {
  // Reopen: back on the board from Done.
  active: ['done'],
  done: ['active', 'archived'],
  archived: ['done'],
}

/** What the list endpoint returns per item. Times are epoch milliseconds. */
export interface TodoView {
  id: string
  title: string
  description: string
  agentSlug: string | null
  sessionId: string | null
  status: TodoStatus
  column: TodoColumn
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
