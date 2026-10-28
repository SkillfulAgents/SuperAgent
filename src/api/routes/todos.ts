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
import { normalizeWorkspacePath } from '@shared/lib/agent-actor/workspace-path'
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
  parseTodoAttachments,
  releaseStartSchema,
  renameTodoSchema,
  startTodoSchema,
  todoAskFor,
  todoColumn,
  todoStatusChangeSchema,
  updateTodoSchema,
  type TodoAttachment,
  type TodoView,
} from '@shared/lib/todos/todo-schema'
import type { SessionMetadataMap } from '@shared/lib/types/agent'
import { Authenticated, canUseAgent, getReadableAgentIds } from '../middleware/auth'

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

/** The session metadata of each readable agent that runs some of the started work among `rows`, read once per agent. */
async function sessionMetadataFor(rows: TodoRow[], readableAgents: ReadonlySet<string>): Promise<ReadonlyMap<string, SessionMetadataMap>> {
  const slugs = [...new Set(rows.flatMap((row) =>
    row.sessionId && row.agentSlug && readableAgents.has(row.agentSlug) ? [row.agentSlug] : []))]
  return new Map(await Promise.all(slugs.map(async (slug) => [slug, await agentRegistry.get(slug).sessions.readMetadata()] as const)))
}

async function toView(
  row: TodoRow,
  readableAgents: ReadonlySet<string>,
  wakes: PendingWakes,
  metadata: ReadonlyMap<string, SessionMetadataMap>,
): Promise<TodoView> {
  // Session state is live, not stored. An agent the person can no longer
  // read tells them nothing about its session.
  const actor = row.agentSlug && row.sessionId && readableAgents.has(row.agentSlug)
    ? agentRegistry.get(row.agentSlug)
    : null
  const live = actor && row.sessionId ? await actor.sessions.live(row.sessionId) : null
  // A deleted session can leave its name in metadata: use the name only while
  // the session is known, the same check the rename fallback makes.
  const sessionName = actor && row.sessionId && (await actor.sessions.isKnown(row.sessionId))
    ? metadata.get(actor.slug)?.[row.sessionId]?.name
    : undefined
  const session = live ? { isActive: live.isActive, isAwaitingInput: live.isAwaitingInput } : null
  const column = todoColumn(row.status, session)
  return {
    id: row.id,
    // Started work is named by its session. The stored title is the draft's
    // own, or the name the work had when it joined the board.
    title: sessionName || row.title,
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
    ask: column === 'needs_input' && actor && row.sessionId ? todoAskFor(await actor.inputs.snapshot(row.sessionId)) : null,
    // Only work that is idle can be sleeping until its wake.
    pendingWakeAt: column === 'has_updates' && row.agentSlug && row.sessionId
      ? wakes.get(wakeKey(row.agentSlug, row.sessionId)) ?? null
      : null,
    attachments: parseTodoAttachments(row.attachments),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    startedAt: row.startedAt?.getTime() ?? null,
    completedAt: row.completedAt?.getTime() ?? null,
  }
}

async function viewOf(c: Context, row: TodoRow): Promise<TodoView> {
  const readable = await getReadableAgentIds(c, row.agentSlug ? [row.agentSlug] : [])
  return await toView(row, readable, await pendingWakesFor([row], readable), await sessionMetadataFor([row], readable))
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

// GET /api/todos — the person's board, in board order.
todosRouter.get('/', async (c) => {
  const rows = await listTodos(getCurrentUserId(c))
  const agentSlugs = [...new Set(rows.flatMap((row) => (row.agentSlug ? [row.agentSlug] : [])))]
  const readable = await getReadableAgentIds(c, agentSlugs)
  const [wakes, metadata] = await Promise.all([pendingWakesFor(rows, readable), sessionMetadataFor(rows, readable)])
  return c.json({ todos: await Promise.all(rows.map((row) => toView(row, readable, wakes, metadata))) })
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
  return c.json(await toView(result.todo, readable, await pendingWakesFor([result.todo], readable), await sessionMetadataFor([result.todo], readable)), result.created ? 201 : 200)
})

// PATCH /api/todos/:id — edit a draft.
todosRouter.patch('/:id', async (c) => {
  const patch = await parseBody(c, updateTodoSchema)
  if (!patch) return c.json({ error: 'Invalid todo' }, 400)
  if (patch.agentSlug && !(await canAssign(c, patch.agentSlug))) {
    return c.json({ error: 'Agent not found' }, 404)
  }
  const userId = getCurrentUserId(c)
  const id = c.req.param('id')
  const before = await getTodo(userId, id)
  if (!before) return c.json({ error: 'Todo not found' }, 404)
  // Attachments live in the agent's workspace, so the agent is fixed while there are any.
  const agent = patch.newAgent ? null : patch.agentSlug !== undefined ? patch.agentSlug : before.agentSlug
  const stored = parseTodoAttachments(before.attachments)
  if (agent !== before.agentSlug && stored.length > 0) {
    return c.json({ error: 'Remove attached files to change the agent' }, 409)
  }
  // Only what is new is checked: a stored file that has since gone must not block removing it or typing.
  const added = (patch.attachments ?? []).filter((att) => !stored.some((s) => JSON.stringify(s) === JSON.stringify(att)))
  // The list applies only over the stored list it was checked against.
  const checked = patch.attachments ? before.attachments : undefined
  if (added.length > 0) {
    if (!agent || !(await canAssign(c, agent))) return c.json({ error: 'Pick an agent to attach files' }, 400)
    if (!(await allUploaded(agent, added))) return c.json({ error: 'Invalid attachment' }, 400)
    // Sent with the list, the agent is part of the write's condition: the list cannot land on another agent.
    return respond(c, await updateDraft(userId, id, { ...patch, agentSlug: agent }, checked))
  }
  return respond(c, await updateDraft(userId, id, patch, checked))
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
// Work with a session renames the session, for everyone on the agent, under
// the same role check as PATCH /api/agents/:id/sessions/:sessionId.
todosRouter.post('/:id/title', async (c) => {
  const input = await parseBody(c, renameTodoSchema)
  if (!input) return c.json({ error: 'Invalid title' }, 400)
  const userId = getCurrentUserId(c)
  const todo = await getTodo(userId, c.req.param('id'))
  if (todo && todo.status !== 'draft' && todo.agentSlug && todo.sessionId) {
    if (!(await canUseAgent(c, todo.agentSlug))) return c.json({ error: 'Forbidden' }, 403)
    const sessions = agentRegistry.get(todo.agentSlug).sessions
    if (await sessions.isKnown(todo.sessionId)) {
      await sessions.rename(todo.sessionId, input.title)
      return c.json(await viewOf(c, todo))
    }
  }
  return respond(c, await renameTodo(userId, c.req.param('id'), input.title))
})

// POST /api/todos/:id/position — reorder within its column.
todosRouter.post('/:id/position', async (c) => {
  const input = await parseBody(c, moveTodoSchema)
  if (!input) return c.json({ error: 'Invalid position' }, 400)
  return respond(c, await moveTodo(getCurrentUserId(c), c.req.param('id'), input.position))
})

function uploadRelative(raw: string): string | null {
  try {
    const rel = normalizeWorkspacePath(raw)
    return rel.startsWith('uploads/') ? rel : null
  } catch {
    return null
  }
}

/** Every file and folder is an upload in the agent's workspace. A mount is bound at Start. */
async function allUploaded(agentSlug: string, list: TodoAttachment[]): Promise<boolean> {
  const files = agentRegistry.get(agentSlug).files
  for (const att of list) {
    if (att.kind === 'mount') continue
    const rel = uploadRelative(att.path)
    if (!rel || !(await files.stat(rel))) return false
  }
  return true
}

// DELETE /api/todos/:id — take it off the board. Its session, if any, stays.
todosRouter.delete('/:id', async (c) => {
  if (!(await deleteTodo(getCurrentUserId(c), c.req.param('id')))) {
    return c.json({ error: 'Todo not found' }, 404)
  }
  return c.body(null, 204)
})

export default todosRouter
