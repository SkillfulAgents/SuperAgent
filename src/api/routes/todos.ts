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
import { randomUUID } from 'crypto'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { agentRegistry } from '@shared/lib/agent-actor'
import type { FileOps } from '@shared/lib/agent-actor/types'
import { normalizeWorkspacePath, workspaceBasename } from '@shared/lib/agent-actor/workspace-path'
import { getCurrentUserId } from '@shared/lib/auth/config'
import type { TodoRow } from '@shared/lib/db/schema'
import { agentExists } from '@shared/lib/services/agent-service'
import { listPendingWakesByAgent } from '@shared/lib/services/scheduled-task-service'
import { openXAgentFile } from '@shared/lib/services/x-agent-attachment-service'
import {
  addSessionTodo,
  appendTodoAttachment,
  claimStart,
  createTodo,
  deleteTodo,
  getTodo,
  listTodos,
  moveTodo,
  releaseStart,
  removeTodoAttachment,
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
  todoAttachmentSchema,
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
    attachments: parseTodoAttachments(row.attachments),
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
  const userId = getCurrentUserId(c)
  const id = c.req.param('id')
  const target = patch.agentSlug
  const before = target ? await getTodo(userId, id) : undefined
  const list = before ? parseTodoAttachments(before.attachments) : []
  if (target && before && list.some((att) => att.agentSlug !== target)) {
    // The files go along with the agent. The old copies stay, as they do in chat. A mount only takes the new name.
    const sources = [...new Set(list.flatMap((att) => (att.kind === 'mount' || att.agentSlug === target ? [] : [att.agentSlug])))]
    if (sources.length > 0) {
      const readable = await getReadableAgentIds(c, sources)
      if (!(await getReadableAgentIds(c, [target], 'user')).has(target) || sources.some((slug) => !readable.has(slug))) {
        return c.json({ error: 'Agent not found' }, 404)
      }
    }
    const copied = await copyToAgent(list, target)
    if (!copied) return c.json({ error: 'Could not copy the attached files to that agent' }, 409)
    const result = await updateDraft(userId, id, patch, { attachments: copied.list, from: before.attachments })
    // Refused (a start took the draft mid-copy): nothing points at the copies.
    if (!result.ok) await agentRegistry.get(target).files.delete(copied.dir, { recursive: true, confined: true }).catch(() => {})
    return respond(c, result)
  }
  return respond(c, await updateDraft(userId, id, patch))
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuidParam(value: string): string | null {
  return UUID.test(value) ? value : null
}

function uploadRelative(raw: string): string | null {
  try {
    const rel = normalizeWorkspacePath(raw)
    return rel.startsWith('uploads/') ? rel : null
  } catch {
    return null
  }
}

async function copyFile(source: FileOps, target: FileOps, from: string, to: string): Promise<void> {
  const { body } = await openXAgentFile(source, from)
  await target.write(to, body, { confined: true, overwrite: false })
}

async function copyTree(source: FileOps, target: FileOps, from: string, to: string): Promise<void> {
  for (const entry of await source.list(from)) {
    if (entry.kind === 'directory') await copyTree(source, target, entry.path, `${to}/${entry.name}`)
    else await copyFile(source, target, entry.path, `${to}/${entry.name}`)
  }
}

/** Copies each file and folder onto `target`, where cross-agent transfers land. Null, with nothing left behind, if one fails. */
async function copyToAgent(list: TodoAttachment[], target: string): Promise<{ list: TodoAttachment[]; dir: string } | null> {
  const files = agentRegistry.get(target).files
  const dir = `uploads/x-agent/${randomUUID()}`
  try {
    const next: TodoAttachment[] = []
    for (const [index, att] of list.entries()) {
      if (att.kind === 'mount' || att.agentSlug === target) {
        next.push({ ...att, agentSlug: target })
        continue
      }
      const from = uploadRelative(att.path)
      if (!from) throw new Error('Not an upload')
      const to = `${dir}/${index}/${workspaceBasename(from)}`
      const source = agentRegistry.get(att.agentSlug).files
      if (att.kind === 'folder') await copyTree(source, files, from, to)
      else await copyFile(source, files, from, to)
      next.push({ ...att, agentSlug: target, path: `/workspace/${to}${att.kind === 'folder' ? '/' : ''}` })
    }
    return { list: next, dir }
  } catch {
    await files.delete(dir, { recursive: true, confined: true }).catch(() => {})
    return null
  }
}

const pointerSchema = z.object({
  name: z.string().trim().min(1).max(255),
  size: z.number().int().nonnegative().optional(),
  mimeType: z.string().max(200).optional(),
  path: z.string().min(1).max(4096).optional(),
  hostPath: z.string().min(1).max(4096).optional(),
  kind: z.enum(['file', 'folder', 'mount']).optional(),
  id: z.string().uuid(),
}).strict()

// POST /api/todos/:id/attachments — remember a file already in the agent's workspace, or a mount path.
todosRouter.post('/:id/attachments', async (c) => {
  const todoId = uuidParam(c.req.param('id'))
  if (!todoId) return c.json({ error: 'Todo not found' }, 404)
  const body = await parseBody(c, pointerSchema)
  if (!body) return c.json({ error: 'Invalid attachment' }, 400)
  const userId = getCurrentUserId(c)
  const existing = await getTodo(userId, todoId)
  if (!existing) return c.json({ error: 'Todo not found' }, 404)
  if (existing.status !== 'draft' || startClaimHeld(existing) || !existing.agentSlug) {
    return c.json({ error: 'The todo has changed; reload and try again' }, 409)
  }
  if (!(await canAssign(c, existing.agentSlug))) return c.json({ error: 'Agent not found' }, 404)
  const attId = body.id
  let entry: TodoAttachment
  if (body.kind === 'mount') {
    if (!body.hostPath) return c.json({ error: 'Invalid attachment' }, 400)
    entry = {
      id: attId, name: body.name, size: 0, mimeType: 'inode/mount', addedAt: Date.now(),
      kind: 'mount', hostPath: body.hostPath, agentSlug: existing.agentSlug,
    }
  } else {
    const rel = body.path ? uploadRelative(body.path) : null
    if (!rel) return c.json({ error: 'Invalid attachment' }, 400)
    const stat = await agentRegistry.get(existing.agentSlug).files.stat(rel)
    if (!stat) return c.json({ error: 'Invalid attachment' }, 400)
    const kind = stat.kind === 'directory' ? 'folder' : 'file'
    entry = {
      id: attId,
      name: body.name,
      size: stat.size,
      mimeType: kind === 'folder' ? 'inode/directory' : (body.mimeType || 'application/octet-stream'),
      addedAt: Date.now(),
      kind,
      path: `/workspace/${rel}${kind === 'folder' ? '/' : ''}`,
      agentSlug: existing.agentSlug,
    }
  }
  const parsed = todoAttachmentSchema.safeParse(entry)
  if (!parsed.success) return c.json({ error: 'Invalid attachment' }, 400)
  const appended = await appendTodoAttachment(userId, todoId, parsed.data)
  if (!appended.ok) {
    return c.json(
      { error: appended.reason === 'not_found' ? 'Todo not found' : 'The todo has changed; reload and try again' },
      appended.reason === 'not_found' ? 404 : 409,
    )
  }
  return c.json(await viewOf(c, appended.todo))
})

// DELETE /api/todos/:id/attachments/:attId — drop the pointer. The file stays in the workspace, as it does in chat.
todosRouter.delete('/:id/attachments/:attId', async (c) => {
  return respond(c, await removeTodoAttachment(getCurrentUserId(c), c.req.param('id'), c.req.param('attId')))
})

// DELETE /api/todos/:id — take it off the board. Its session, if any, stays.
todosRouter.delete('/:id', async (c) => {
  if (!(await deleteTodo(getCurrentUserId(c), c.req.param('id')))) {
    return c.json({ error: 'Todo not found' }, 404)
  }
  return c.body(null, 204)
})

export default todosRouter
