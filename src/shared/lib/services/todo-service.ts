import { randomUUID } from 'crypto'
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, notExists, or } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { batch, changesOf, insertWhere } from '@shared/lib/db/batch'
import { todos, type TodoRow } from '@shared/lib/db/schema'
import {
  TODO_TRANSITIONS,
  type AddSessionTodoInput,
  type CreateTodoInput,
  type TodoStatusChange,
  type UpdateTodoInput,
} from '@shared/lib/todos/todo-schema'

/**
 * The Todo board's rows. Every read and write is scoped to one person: an
 * item is theirs alone, and an id that belongs to someone else reads as
 * missing. Writes that depend on the row's state are single conditional
 * statements, so two tabs acting on one item cannot both win.
 */

/** Why a write did not apply: there is no such item, or it is not in a state the write allows. */
export type TodoWriteFailure = 'not_found' | 'conflict'
export type TodoWriteResult = { ok: true; todo: TodoRow } | { ok: false; reason: TodoWriteFailure }

/**
 * How long a start claim holds. Starting waits for the agent's container,
 * which can take a while; a tab that goes away mid-start leaves its claim to
 * lapse after this.
 */
export const START_CLAIM_TTL_MS = 5 * 60_000

/** Whether a start claimed at `claimedAt` still holds at `now`. */
export function startClaimHeld(row: Pick<TodoRow, 'startClaim' | 'startClaimedAt'>, now = Date.now()): boolean {
  return !!row.startClaim && !!row.startClaimedAt && now - row.startClaimedAt.getTime() < START_CLAIM_TTL_MS
}

/** No start holds a claim on the row: none was made, or it lapsed. */
function unclaimed(now: Date) {
  return or(isNull(todos.startClaim), lt(todos.startClaimedAt, new Date(now.getTime() - START_CLAIM_TTL_MS)))
}

export async function listTodos(userId: string): Promise<TodoRow[]> {
  return db.select().from(todos).where(eq(todos.userId, userId)).orderBy(desc(todos.position)).all()
}

export async function getTodo(userId: string, id: string): Promise<TodoRow | undefined> {
  return db.select().from(todos).where(and(eq(todos.id, id), eq(todos.userId, userId))).get()
}

export async function createTodo(userId: string, input: CreateTodoInput): Promise<TodoRow> {
  const now = new Date()
  const row: TodoRow = {
    id: randomUUID(),
    userId,
    title: input.title,
    description: input.description,
    agentSlug: input.agentSlug ?? null,
    newAgent: input.newAgent ?? false,
    model: input.model ?? null,
    llmProviderId: input.llmProviderId ?? null,
    effort: input.effort ?? null,
    speed: input.speed ?? null,
    sessionId: null,
    status: 'draft',
    position: now.getTime(),
    startClaim: null,
    startClaimedAt: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
  }
  await db.insert(todos).values(row).run()
  return row
}

/**
 * Puts a session that already exists on the board as an active item. A
 * session is on a person's board at most once: if it already is, in any
 * column, that item comes back unchanged. The check and the insert are one
 * statement, so two clicks cannot add it twice. The caller has checked that
 * the session exists on `agentSlug`.
 */
export async function addSessionTodo(userId: string, input: AddSessionTodoInput): Promise<{ todo: TodoRow; created: boolean } | null> {
  const now = new Date()
  const row: TodoRow = {
    id: randomUUID(),
    userId,
    title: input.title,
    description: '',
    agentSlug: input.agentSlug,
    newAgent: false,
    model: null,
    llmProviderId: null,
    effort: null,
    speed: null,
    sessionId: input.sessionId,
    status: 'active',
    position: now.getTime(),
    startClaim: null,
    startClaimedAt: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
  }
  const onBoard = and(eq(todos.userId, userId), eq(todos.agentSlug, input.agentSlug), eq(todos.sessionId, input.sessionId))
  const result = await insertWhere(todos, row, notExists(db.select({ id: todos.id }).from(todos).where(onBoard))).run()
  if (changesOf(result) > 0) return { todo: row, created: true }
  // Taken off the board again in between: nothing to return.
  const existing = await db.select().from(todos).where(onBoard).get()
  return existing ? { todo: existing, created: false } : null
}

/** A zero-change conditional write: missing, or there in a state the write does not allow. */
async function failure(userId: string, id: string): Promise<{ ok: false; reason: TodoWriteFailure }> {
  return { ok: false, reason: (await getTodo(userId, id)) ? 'conflict' : 'not_found' }
}

async function reread(userId: string, id: string): Promise<TodoWriteResult> {
  const todo = await getTodo(userId, id)
  return todo ? { ok: true, todo } : { ok: false, reason: 'not_found' }
}

/**
 * Edits a draft. Once started, the brief is what the agent was sent and
 * stays as it was; while starting, it is being sent.
 */
export async function updateDraft(userId: string, id: string, patch: UpdateTodoInput): Promise<TodoWriteResult> {
  const now = new Date()
  const result = await db
    .update(todos)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.agentSlug !== undefined ? { agentSlug: patch.agentSlug } : {}),
      ...(patch.agentSlug ? { newAgent: false } : {}),
      ...(patch.newAgent !== undefined ? { newAgent: patch.newAgent } : {}),
      ...(patch.newAgent ? { agentSlug: null } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.llmProviderId !== undefined ? { llmProviderId: patch.llmProviderId } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
      ...(patch.speed !== undefined ? { speed: patch.speed } : {}),
      updatedAt: now,
    })
    .where(and(eq(todos.id, id), eq(todos.userId, userId), eq(todos.status, 'draft'), unclaimed(now)))
    .run()
  return changesOf(result) > 0 ? reread(userId, id) : failure(userId, id)
}

/**
 * Renames started work: the card's title, nothing else. A draft is edited
 * through updateDraft instead, since its title is part of the brief it will
 * send. Leaves `updatedAt` alone: Done and Archived show it as when that
 * happened.
 */
export async function renameTodo(userId: string, id: string, title: string): Promise<TodoWriteResult> {
  const result = await db
    .update(todos)
    .set({ title })
    .where(and(eq(todos.id, id), eq(todos.userId, userId), ne(todos.status, 'draft')))
    .run()
  return changesOf(result) > 0 ? reread(userId, id) : failure(userId, id)
}

export type StartClaimResult = { ok: true; claim: string; todo: TodoRow } | { ok: false; reason: TodoWriteFailure }

/**
 * The first step of starting a draft: claims it for one start, before any
 * session exists. Only one claim holds at a time, so a second tab (or a
 * second click) is refused here instead of creating a second session that
 * would then fail to link. Returns the token the link step must present.
 */
export async function claimStart(userId: string, id: string, agentSlug: string): Promise<StartClaimResult> {
  const now = new Date()
  const claim = randomUUID()
  const result = await db
    .update(todos)
    .set({ startClaim: claim, startClaimedAt: now })
    .where(and(
      eq(todos.id, id),
      eq(todos.userId, userId),
      eq(todos.status, 'draft'),
      eq(todos.agentSlug, agentSlug),
      unclaimed(now),
    ))
    .run()
  if (changesOf(result) === 0) return failure(userId, id)
  const todo = await getTodo(userId, id)
  return todo ? { ok: true, claim, todo } : { ok: false, reason: 'not_found' }
}

/** Gives up a claim whose start failed, so the draft can be started again. */
export async function releaseStart(userId: string, id: string, claim: string): Promise<void> {
  await db
    .update(todos)
    .set({ startClaim: null, startClaimedAt: null })
    .where(and(eq(todos.id, id), eq(todos.userId, userId), eq(todos.startClaim, claim)))
    .run()
}

/**
 * Draft → active, linked to the session its agent is running it in, by the
 * start that holds `claim`. The caller has checked that the session exists
 * on `agentSlug`; the write applies only if the draft is still assigned to
 * that agent, so a reassignment that lands in between cannot link a session
 * of the wrong one.
 */
export async function startTodo(userId: string, id: string, agentSlug: string, sessionId: string, claim: string): Promise<TodoWriteResult> {
  const now = new Date()
  const result = await db
    .update(todos)
    .set({ status: 'active', sessionId, startedAt: now, updatedAt: now, position: now.getTime(), startClaim: null, startClaimedAt: null })
    .where(and(
      eq(todos.id, id),
      eq(todos.userId, userId),
      eq(todos.status, 'draft'),
      eq(todos.agentSlug, agentSlug),
      eq(todos.startClaim, claim),
    ))
    .run()
  return changesOf(result) > 0 ? reread(userId, id) : failure(userId, id)
}

/**
 * Moves an item along: done, archived, or back on the board. See
 * TODO_TRANSITIONS. It lands at the top of its new column.
 */
export async function setTodoStatus(userId: string, id: string, status: TodoStatusChange): Promise<TodoWriteResult> {
  const now = new Date()
  const result = await db
    .update(todos)
    .set({
      status,
      updatedAt: now,
      position: now.getTime(),
      // Done keeps the time it was finished through archiving; reopening clears it.
      ...(status === 'done' ? { completedAt: now } : status === 'active' ? { completedAt: null } : {}),
    })
    .where(and(
      eq(todos.id, id),
      eq(todos.userId, userId),
      inArray(todos.status, [...TODO_TRANSITIONS[status]]),
      // A draft that is starting can't be archived out from under it.
      unclaimed(now),
      // Only started work can be finished: a draft that lost its session
      // (the session or agent was deleted) went back to draft, not here.
      ...(status === 'active' ? [isNotNull(todos.sessionId)] : []),
      // Unarchiving goes back where the item came from: Done only for work
      // that was started, Drafts only for work that never was.
      ...(status === 'done' ? [isNotNull(todos.startedAt)] : []),
      ...(status === 'draft' ? [isNull(todos.startedAt)] : []),
    ))
    .run()
  return changesOf(result) > 0 ? reread(userId, id) : failure(userId, id)
}

/** Puts an item at a new place in its column. Nothing else about it changes. */
export async function moveTodo(userId: string, id: string, position: number): Promise<TodoWriteResult> {
  const result = await db
    .update(todos)
    .set({ position })
    .where(and(eq(todos.id, id), eq(todos.userId, userId)))
    .run()
  return changesOf(result) > 0 ? reread(userId, id) : failure(userId, id)
}

/** Removes an item from the board. The session it started, if any, is untouched. */
export async function deleteTodo(userId: string, id: string): Promise<boolean> {
  const result = await db.delete(todos).where(and(eq(todos.id, id), eq(todos.userId, userId))).run()
  return changesOf(result) > 0
}

/**
 * The statements that let go of deleted sessions, for every person's board:
 * an item still in progress goes back to Drafts so it can be handed out
 * again; a finished one keeps its place and just loses the link.
 *
 * Returned unexecuted so agent deletion can run them in its cleanup batch.
 * Scoped to the agent because a session id is unique only within one.
 */
export function unlinkSessionStatements(agentSlug: string, sessionIds?: string[]) {
  const linked = sessionIds
    ? and(eq(todos.agentSlug, agentSlug), inArray(todos.sessionId, sessionIds))
    : and(eq(todos.agentSlug, agentSlug), isNotNull(todos.sessionId))
  const now = new Date()
  return [
    db.update(todos)
      .set({ status: 'draft', sessionId: null, startedAt: null, updatedAt: now })
      .where(and(linked, eq(todos.status, 'active'))),
    db.update(todos)
      .set({ sessionId: null, updatedAt: now })
      .where(linked),
  ] as const
}

/** Lets go of sessions that were deleted. */
export async function unlinkTodosFromSessions(agentSlug: string, sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return
  await batch(unlinkSessionStatements(agentSlug, sessionIds))
}

/**
 * The statements for a deleted agent: its sessions go (as above), then every
 * item loses the agent, so a draft waits to be given to someone else.
 */
export function unlinkAgentStatements(agentSlug: string) {
  return [
    ...unlinkSessionStatements(agentSlug),
    db.update(todos).set({ agentSlug: null, updatedAt: new Date() }).where(eq(todos.agentSlug, agentSlug)),
  ] as const
}
