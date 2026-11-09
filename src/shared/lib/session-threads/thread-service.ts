import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { batch } from '@shared/lib/db/batch'
import { messageAuthor, sessionThreadReplies, sessionThreads } from '@shared/lib/db/schema'
import { getUserSummaries } from '@shared/lib/services/user-profile-service'
import {
  THREAD_SUMMARY_FACES,
  sessionThreadTaggedSchema,
  type ThreadPerson,
  type ThreadReply,
  type ThreadSummary,
} from './thread-schema'

/**
 * Threads on session messages: the replies people write under a message that
 * tagged a teammate, kept beside the transcript rather than in it. Every read
 * and write names the agent as well as the session, whose id is unique only
 * within an agent.
 */

interface ThreadKey {
  agentSlug: string
  sessionId: string
  parentMessageUuid: string
}

/** A stored tagged list; one that no longer reads is treated as empty, not an error. */
function readTagged(json: string): string[] {
  try {
    return sessionThreadTaggedSchema.parse(JSON.parse(json))
  } catch {
    return []
  }
}

/** Insertion order: two replies in one millisecond keep the order they were sent in. */
const insertionOrder = sql`${sessionThreadReplies}.rowid`

function person(profile: { id: string; name: string; image?: string | null } | undefined): ThreadPerson | null {
  return profile ? { id: profile.id, name: profile.name, image: profile.image ?? null } : null
}

/** Who wrote a user message in this session, when a person did. */
export async function getMessageAuthorUserId(agentSlug: string, sessionId: string, messageUuid: string): Promise<string | null> {
  const row = await db
    .select({ userId: messageAuthor.userId })
    .from(messageAuthor)
    .where(and(
      eq(messageAuthor.id, messageUuid),
      eq(messageAuthor.agentSlug, agentSlug),
      eq(messageAuthor.sessionId, sessionId),
      isNotNull(messageAuthor.userId),
    ))
    .get()
  return row?.userId ?? null
}

/** Every thread in a session that has a reply, for the rows under their messages. */
export async function listThreadSummaries(agentSlug: string, sessionId: string): Promise<ThreadSummary[]> {
  const rows = await db
    .select({
      parentMessageUuid: sessionThreadReplies.parentMessageUuid,
      userId: sessionThreadReplies.userId,
      createdAt: sessionThreadReplies.createdAt,
    })
    .from(sessionThreadReplies)
    .where(and(eq(sessionThreadReplies.agentSlug, agentSlug), eq(sessionThreadReplies.sessionId, sessionId)))
    .orderBy(desc(sessionThreadReplies.createdAt), desc(insertionOrder))
    .all()
  if (rows.length === 0) return []

  const threads = new Map<string, { replyCount: number; lastReplyAt: Date; repliers: string[] }>()
  for (const row of rows) {
    const thread = threads.get(row.parentMessageUuid)
    if (!thread) {
      threads.set(row.parentMessageUuid, { replyCount: 1, lastReplyAt: row.createdAt, repliers: [row.userId] })
      continue
    }
    thread.replyCount++
    if (thread.repliers.length < THREAD_SUMMARY_FACES && !thread.repliers.includes(row.userId)) thread.repliers.push(row.userId)
  }
  const profiles = await getUserSummaries([...threads.values()].flatMap((thread) => thread.repliers))
  return [...threads].map(([parentMessageUuid, thread]) => ({
    parentMessageUuid,
    replyCount: thread.replyCount,
    lastReplyAt: thread.lastReplyAt.toISOString(),
    repliers: thread.repliers.flatMap((id) => person(profiles.get(id)) ?? []),
  }))
}

/** One thread's replies, oldest first. */
export async function listThreadReplies(key: ThreadKey): Promise<ThreadReply[]> {
  const rows = await db
    .select()
    .from(sessionThreadReplies)
    .where(and(
      eq(sessionThreadReplies.agentSlug, key.agentSlug),
      eq(sessionThreadReplies.sessionId, key.sessionId),
      eq(sessionThreadReplies.parentMessageUuid, key.parentMessageUuid),
    ))
    .orderBy(asc(sessionThreadReplies.createdAt), asc(insertionOrder))
    .all()
  const profiles = await getUserSummaries(rows.map((row) => row.userId))
  return rows.map((row) => ({
    id: row.id,
    parentMessageUuid: row.parentMessageUuid,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    sender: person(profiles.get(row.userId)),
  }))
}

/**
 * Add a reply, opening the thread with it if it is the first. `taggedUserIds`
 * counts only then: the thread keeps who its parent message tagged.
 */
export async function addThreadReply(params: ThreadKey & {
  userId: string
  text: string
  taggedUserIds: readonly string[]
}): Promise<{ id: string; createdAt: Date }> {
  const id = crypto.randomUUID()
  const createdAt = new Date()
  const key = { agentSlug: params.agentSlug, sessionId: params.sessionId, parentMessageUuid: params.parentMessageUuid }
  await batch([
    db.insert(sessionThreads)
      .values({ ...key, taggedUserIds: JSON.stringify(sessionThreadTaggedSchema.parse([...new Set(params.taggedUserIds)])), createdAt })
      .onConflictDoNothing(),
    db.insert(sessionThreadReplies).values({ id, ...key, userId: params.userId, text: params.text, createdAt }),
  ])
  return { id, createdAt }
}

/**
 * Everyone a thread involves, as Slack follows a thread for you: who wrote
 * the parent message, who it tagged, and everyone who has replied.
 */
export async function listThreadParticipants(key: ThreadKey): Promise<string[]> {
  const [thread, repliers, author] = await Promise.all([
    db.select({ taggedUserIds: sessionThreads.taggedUserIds })
      .from(sessionThreads)
      .where(and(
        eq(sessionThreads.agentSlug, key.agentSlug),
        eq(sessionThreads.sessionId, key.sessionId),
        eq(sessionThreads.parentMessageUuid, key.parentMessageUuid),
      ))
      .get(),
    db.selectDistinct({ userId: sessionThreadReplies.userId })
      .from(sessionThreadReplies)
      .where(and(
        eq(sessionThreadReplies.agentSlug, key.agentSlug),
        eq(sessionThreadReplies.sessionId, key.sessionId),
        eq(sessionThreadReplies.parentMessageUuid, key.parentMessageUuid),
      ))
      .all(),
    getMessageAuthorUserId(key.agentSlug, key.sessionId, key.parentMessageUuid),
  ])
  const tagged = thread ? readTagged(thread.taggedUserIds) : []
  return [...new Set([...(author ? [author] : []), ...tagged, ...repliers.map((row) => row.userId)])]
}

/** Remove the threads of deleted sessions: nothing could open them again. */
export async function deleteSessionThreads(agentSlug: string, sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return
  await batch([
    db.delete(sessionThreadReplies).where(and(eq(sessionThreadReplies.agentSlug, agentSlug), inArray(sessionThreadReplies.sessionId, sessionIds))),
    db.delete(sessionThreads).where(and(eq(sessionThreads.agentSlug, agentSlug), inArray(sessionThreads.sessionId, sessionIds))),
  ])
}

/** The statements that remove an agent's threads, for its cleanup batch. */
export function deleteAgentThreadsStatements(agentSlug: string) {
  return [
    db.delete(sessionThreadReplies).where(eq(sessionThreadReplies.agentSlug, agentSlug)),
    db.delete(sessionThreads).where(eq(sessionThreads.agentSlug, agentSlug)),
  ] as const
}
