/**
 * Todo board API (the `todo-board` experiment): a person's own list of
 * tasks, each a draft until they start it with an agent, then linked to the
 * session that agent runs it in.
 *
 * Starting is two calls from the client: it creates the session through
 * POST /api/agents/:id/sessions (which checks it may use the agent, and
 * takes the same path as the composer), then links it here with
 * POST /api/todos/:id/start.
 *
 * Everything 404s for someone who has not turned the experiment on.
 */
import { Hono, type Context } from 'hono'
import type { z } from 'zod'
import { agentRegistry } from '@shared/lib/agent-actor'
import { getCurrentUserId } from '@shared/lib/auth/config'
import type { TodoRow } from '@shared/lib/db/schema'
import { agentExists } from '@shared/lib/services/agent-service'
import {
  createTodo,
  deleteTodo,
  getTodo,
  listTodos,
  setTodoStatus,
  startTodo,
  updateDraft,
  type TodoWriteResult,
} from '@shared/lib/services/todo-service'
import { isExperimentEnabled } from '@shared/lib/services/user-settings-service'
import {
  createTodoSchema,
  startTodoSchema,
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

function toView(row: TodoRow, readableAgents: ReadonlySet<string>): TodoView {
  // Session state is live, not stored. An agent the person can no longer
  // read tells them nothing about its session.
  const sessions = row.agentSlug && row.sessionId && readableAgents.has(row.agentSlug)
    ? agentRegistry.get(row.agentSlug).sessions
    : null
  const session = sessions && row.sessionId
    ? { isActive: sessions.isActive(row.sessionId), isAwaitingInput: sessions.isAwaitingInput(row.sessionId) }
    : null
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    agentSlug: row.agentSlug,
    sessionId: row.sessionId,
    status: row.status,
    column: todoColumn(row.status, session),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    startedAt: row.startedAt?.getTime() ?? null,
    completedAt: row.completedAt?.getTime() ?? null,
  }
}

async function viewOf(c: Context, row: TodoRow): Promise<TodoView> {
  return toView(row, await getReadableAgentIds(c, row.agentSlug ? [row.agentSlug] : []))
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

// GET /api/todos — the person's board, newest change first.
todosRouter.get('/', async (c) => {
  const rows = await listTodos(getCurrentUserId(c))
  const agentSlugs = [...new Set(rows.flatMap((row) => (row.agentSlug ? [row.agentSlug] : [])))]
  const readable = await getReadableAgentIds(c, agentSlugs)
  return c.json({ todos: rows.map((row) => toView(row, readable)) })
})

// POST /api/todos — a new draft.
todosRouter.post('/', async (c) => {
  const input = await parseBody(c, createTodoSchema)
  if (!input) return c.json({ error: 'Invalid todo' }, 400)
  if (input.agentSlug && !(await canAssign(c, input.agentSlug))) {
    return c.json({ error: 'Agent not found' }, 404)
  }
  const row = await createTodo(getCurrentUserId(c), input)
  return c.json(await viewOf(c, row), 201)
})

// PATCH /api/todos/:id — edit a draft.
todosRouter.patch('/:id', async (c) => {
  const patch = await parseBody(c, updateTodoSchema)
  if (!patch) return c.json({ error: 'Invalid todo' }, 400)
  if (patch.agentSlug && !(await canAssign(c, patch.agentSlug))) {
    return c.json({ error: 'Agent not found' }, 404)
  }
  return respond(c, await updateDraft(getCurrentUserId(c), c.req.param('id'), patch))
})

// POST /api/todos/:id/start — link a draft to the session its agent was started in.
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
  return respond(c, await startTodo(userId, todo.id, todo.agentSlug, input.sessionId))
})

// POST /api/todos/:id/status — mark done, archive, or put back on the board.
todosRouter.post('/:id/status', async (c) => {
  const input = await parseBody(c, todoStatusChangeSchema)
  if (!input) return c.json({ error: 'Invalid status' }, 400)
  return respond(c, await setTodoStatus(getCurrentUserId(c), c.req.param('id'), input.status))
})

// DELETE /api/todos/:id — take it off the board. Its session, if any, stays.
todosRouter.delete('/:id', async (c) => {
  if (!(await deleteTodo(getCurrentUserId(c), c.req.param('id')))) {
    return c.json({ error: 'Todo not found' }, 404)
  }
  return c.body(null, 204)
})

export default todosRouter
