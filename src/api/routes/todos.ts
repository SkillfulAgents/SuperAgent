/**
 * Todo board API (the `todo-board` experiment): a person's own list of
 * tasks, each a draft until they start it with an agent, then linked to the
 * session that agent runs it in.
 *
 * Starting is two calls from the client: it creates the session through
 * POST /api/agents/:id/sessions (which checks it may use the agent, and
 * takes the same path as the composer), then links it here with
 * POST /api/todos/:id/start. A session started some other way joins the
 * board through POST /api/todos/sessions.
 *
 * Everything 404s for someone who has not turned the experiment on.
 */
import { Hono, type Context } from 'hono'
import type { z } from 'zod'
import { agentRegistry } from '@shared/lib/agent-actor'
import { LlmSelectionAccessError, assertConnectionSelectionAccess } from '@shared/lib/llm-provider/connection-runtime'
import { getCurrentUserId } from '@shared/lib/auth/config'
import type { TodoRow } from '@shared/lib/db/schema'
import { agentExists } from '@shared/lib/services/agent-service'
import { listPendingWakesByAgent } from '@shared/lib/services/scheduled-task-service'
import {
  addSessionTodo,
  claimStart,
  createTodo,
  deleteTodo,
  getTodo,
  listTodos,
  moveTodo,
  releaseStart,
  renameTodo,
  setTodoStatus,
  startClaimHeld,
  startTodo,
  updateDraft,
  type TodoWriteResult,
} from '@shared/lib/services/todo-service'
import { isExperimentEnabled } from '@shared/lib/services/user-settings-service'
import {
  addSessionTodoSchema,
  createTodoSchema,
  moveTodoSchema,
  releaseStartSchema,
  renameTodoSchema,
  startTodoSchema,
  todoAskFor,
  todoColumn,
  todoStatusChangeSchema,
  updateTodoSchema,
  type TodoView,
} from '@shared/lib/todos/todo-schema'
import { Authenticated, getReadableAgentIds } from '../middleware/auth'

const todosRouter = new Hono()

todosRouter.use('*', Authenticated())
todosRouter.use('*', async (c, next) => {
  if (!(await isExperimentEnabled(getCurrentUserId(c), 'todo-board'))) {
    return c.json({ error: 'Not found' }, 404)
  }
  return next()
})

/** Scheduled resumes by `agentSlug/sessionId`, as epoch ms. */
type PendingWakes = ReadonlyMap<string, number>

const wakeKey = (agentSlug: string, sessionId: string) => `${agentSlug}/${sessionId}`

/** The pending wakes of the started work among `rows` whose agent the person can read. */
async function pendingWakesFor(rows: TodoRow[], readableAgents: ReadonlySet<string>): Promise<PendingWakes> {
  const slugs = [...new Set(rows.flatMap((row) =>
    row.status === 'active' && row.sessionId && row.agentSlug && readableAgents.has(row.agentSlug) ? [row.agentSlug] : []))]
  const wakes = (await Promise.all(slugs.map(listPendingWakesByAgent))).flat()
  return new Map(wakes.map((w) => [wakeKey(w.agentSlug, w.resumeSessionId!), w.nextExecutionAt.getTime()]))
}

function toView(row: TodoRow, readableAgents: ReadonlySet<string>, wakes: PendingWakes): TodoView {
  // Session state is live, not stored. An agent the person can no longer
  // read tells them nothing about its session.
  const actor = row.agentSlug && row.sessionId && readableAgents.has(row.agentSlug)
    ? agentRegistry.get(row.agentSlug)
    : null
  const session = actor && row.sessionId
    ? { isActive: actor.sessions.isActive(row.sessionId), isAwaitingInput: actor.sessions.isAwaitingInput(row.sessionId) }
    : null
  const column = todoColumn(row.status, session)
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    agentSlug: row.agentSlug,
    newAgent: row.newAgent,
    model: row.model,
    llmProviderId: row.llmProviderId,
    effort: row.effort,
    speed: row.speed,
    sessionId: row.sessionId,
    status: row.status,
    column,
    position: row.position,
    starting: row.status === 'draft' && startClaimHeld(row),
    // The same open requests that make the session await input (its own,
    // plus the agent-scoped ones that block every session of the agent).
    ask: column === 'needs_input' && actor && row.sessionId ? todoAskFor(actor.inputs.snapshot(row.sessionId)) : null,
    // Only work that is idle can be sleeping until its wake.
    pendingWakeAt: column === 'has_updates' && row.agentSlug && row.sessionId
      ? wakes.get(wakeKey(row.agentSlug, row.sessionId)) ?? null
      : null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    startedAt: row.startedAt?.getTime() ?? null,
    completedAt: row.completedAt?.getTime() ?? null,
  }
}

async function viewOf(c: Context, row: TodoRow): Promise<TodoView> {
  const readable = await getReadableAgentIds(c, row.agentSlug ? [row.agentSlug] : [])
  return toView(row, readable, await pendingWakesFor([row], readable))
}

async function respond(c: Context, result: TodoWriteResult) {
  if (result.ok) return c.json(await viewOf(c, result.todo))
  return result.reason === 'not_found'
    ? c.json({ error: 'Todo not found' }, 404)
    : c.json({ error: 'The todo has changed; reload and try again' }, 409)
}

async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | null> {
  const body: unknown = await c.req.json().catch(() => null)
  const parsed = schema.safeParse(body)
  return parsed.success ? parsed.data : null
}

/** An agent a draft may be given to: one that exists and that this person can see. */
async function canAssign(c: Context, agentSlug: string): Promise<boolean> {
  return (await agentExists(agentSlug)) && (await getReadableAgentIds(c, [agentSlug])).has(agentSlug)
}

/**
 * A connection the person may pick for a draft, checked as every other model
 * picker's is; `currentId` is the one the draft already has.
 */
async function canPickConnection(llmProviderId: string | null | undefined, currentId?: string | null): Promise<boolean> {
  try {
    await assertConnectionSelectionAccess(llmProviderId, currentId)
    return true
  } catch (error) {
    if (error instanceof LlmSelectionAccessError) return false
    throw error
  }
}

// GET /api/todos — the person's board, in board order.
todosRouter.get('/', async (c) => {
  const rows = await listTodos(getCurrentUserId(c))
  const agentSlugs = [...new Set(rows.flatMap((row) => (row.agentSlug ? [row.agentSlug] : [])))]
  const readable = await getReadableAgentIds(c, agentSlugs)
  const wakes = await pendingWakesFor(rows, readable)
  return c.json({ todos: rows.map((row) => toView(row, readable, wakes)) })
})

// POST /api/todos — a new draft.
todosRouter.post('/', async (c) => {
  const input = await parseBody(c, createTodoSchema)
  if (!input) return c.json({ error: 'Invalid todo' }, 400)
  if (input.agentSlug && !(await canAssign(c, input.agentSlug))) {
    return c.json({ error: 'Agent not found' }, 404)
  }
  if (!(await canPickConnection(input.llmProviderId))) return c.json({ error: 'LLM provider not found' }, 404)
  const row = await createTodo(getCurrentUserId(c), input)
  return c.json(await viewOf(c, row), 201)
})

// POST /api/todos/sessions — put a session that already exists on the board,
// whether it is working right now or not. 200 with the existing item if the
// session is already on it.
todosRouter.post('/sessions', async (c) => {
  const input = await parseBody(c, addSessionTodoSchema)
  if (!input) return c.json({ error: 'Invalid todo' }, 400)
  const readable = await getReadableAgentIds(c, [input.agentSlug])
  if (!readable.has(input.agentSlug) || !(await agentRegistry.get(input.agentSlug).sessions.isKnown(input.sessionId))) {
    return c.json({ error: 'Session not found' }, 404)
  }
  const result = await addSessionTodo(getCurrentUserId(c), input)
  if (!result) return c.json({ error: 'The todo has changed; reload and try again' }, 409)
  return c.json(toView(result.todo, readable, await pendingWakesFor([result.todo], readable)), result.created ? 201 : 200)
})

// PATCH /api/todos/:id — edit a draft.
todosRouter.patch('/:id', async (c) => {
  const patch = await parseBody(c, updateTodoSchema)
  if (!patch) return c.json({ error: 'Invalid todo' }, 400)
  if (patch.agentSlug && !(await canAssign(c, patch.agentSlug))) {
    return c.json({ error: 'Agent not found' }, 404)
  }
  if (patch.llmProviderId) {
    const current = await getTodo(getCurrentUserId(c), c.req.param('id'))
    if (!(await canPickConnection(patch.llmProviderId, current?.llmProviderId))) return c.json({ error: 'LLM provider not found' }, 404)
  }
  return respond(c, await updateDraft(getCurrentUserId(c), c.req.param('id'), patch))
})

// Starting is three steps, because the session is created through the
// sessions endpoint like any other: claim the draft, create the session,
// link it. The claim comes first so only one start can create a session.

// POST /api/todos/:id/claim — reserve a draft for one start. 409 while another start holds it.
todosRouter.post('/:id/claim', async (c) => {
  const userId = getCurrentUserId(c)
  const todo = await getTodo(userId, c.req.param('id'))
  if (!todo) return c.json({ error: 'Todo not found' }, 404)
  if (todo.status !== 'draft' || !todo.agentSlug) {
    return c.json({ error: 'Only a draft with an agent can be started' }, 409)
  }
  if (!(await canAssign(c, todo.agentSlug))) return c.json({ error: 'Agent not found' }, 404)
  const result = await claimStart(userId, todo.id, todo.agentSlug)
  if (!result.ok) {
    return result.reason === 'not_found'
      ? c.json({ error: 'Todo not found' }, 404)
      : c.json({ error: 'This is already starting' }, 409)
  }
  return c.json({ claim: result.claim, todo: await viewOf(c, result.todo) })
})

// POST /api/todos/:id/release — give up a claim whose start failed.
todosRouter.post('/:id/release', async (c) => {
  const input = await parseBody(c, releaseStartSchema)
  if (!input) return c.json({ error: 'Invalid claim' }, 400)
  await releaseStart(getCurrentUserId(c), c.req.param('id'), input.claim)
  return c.body(null, 204)
})

// POST /api/todos/:id/start — link a claimed draft to the session its agent was started in.
todosRouter.post('/:id/start', async (c) => {
  const input = await parseBody(c, startTodoSchema)
  if (!input) return c.json({ error: 'Invalid session' }, 400)
  const userId = getCurrentUserId(c)
  const todo = await getTodo(userId, c.req.param('id'))
  if (!todo) return c.json({ error: 'Todo not found' }, 404)
  if (todo.status !== 'draft' || !todo.agentSlug) {
    return c.json({ error: 'Only a draft with an agent can be started' }, 409)
  }
  const readable = await getReadableAgentIds(c, [todo.agentSlug])
  if (!readable.has(todo.agentSlug) || !(await agentRegistry.get(todo.agentSlug).sessions.isKnown(input.sessionId))) {
    return c.json({ error: 'Session not found' }, 404)
  }
  return respond(c, await startTodo(userId, todo.id, todo.agentSlug, input.sessionId, input.claim))
})

// POST /api/todos/:id/status — mark done, archive, unarchive, or put back on the board.
todosRouter.post('/:id/status', async (c) => {
  const input = await parseBody(c, todoStatusChangeSchema)
  if (!input) return c.json({ error: 'Invalid status' }, 400)
  return respond(c, await setTodoStatus(getCurrentUserId(c), c.req.param('id'), input.status))
})

// POST /api/todos/:id/title — rename started work. Drafts are edited with PATCH.
todosRouter.post('/:id/title', async (c) => {
  const input = await parseBody(c, renameTodoSchema)
  if (!input) return c.json({ error: 'Invalid title' }, 400)
  return respond(c, await renameTodo(getCurrentUserId(c), c.req.param('id'), input.title))
})

// POST /api/todos/:id/position — reorder within its column.
todosRouter.post('/:id/position', async (c) => {
  const input = await parseBody(c, moveTodoSchema)
  if (!input) return c.json({ error: 'Invalid position' }, 400)
  return respond(c, await moveTodo(getCurrentUserId(c), c.req.param('id'), input.position))
})

// DELETE /api/todos/:id — take it off the board. Its session, if any, stays.
todosRouter.delete('/:id', async (c) => {
  if (!(await deleteTodo(getCurrentUserId(c), c.req.param('id')))) {
    return c.json({ error: 'Todo not found' }, 404)
  }
  return c.body(null, 204)
})

export default todosRouter
