import { z } from 'zod'

/**
 * Threads on session messages, shared by the API and the renderer. A thread is
 * a side conversation between people on a message that tagged a teammate; the
 * agent never reads it unless someone shares it (see formatThreadForAgent).
 */

export const THREAD_REPLY_MAX = 20_000
/** Faces the reply row draws under the parent message. */
export const THREAD_SUMMARY_FACES = 3

const userIdSchema = z.string().min(1).max(200)

/** `session_threads.tagged_user_ids`: who the parent message tagged. */
export const sessionThreadTaggedSchema = z.array(userIdSchema).max(100)

export const threadReplyBodySchema = z.object({
  text: z.string().trim().min(1).max(THREAD_REPLY_MAX),
  /**
   * Who the parent message tags, as its bubble reads them. Taken on the first
   * reply only, and kept to people who can open the agent: it decides who
   * the thread tells, which is what tagging them already did.
   */
  taggedUserIds: sessionThreadTaggedSchema.default([]),
})
export type ThreadReplyBody = z.infer<typeof threadReplyBodySchema>

export const threadPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string().nullable().optional(),
})
export type ThreadPerson = z.infer<typeof threadPersonSchema>

export const threadReplySchema = z.object({
  id: z.string(),
  parentMessageUuid: z.string(),
  text: z.string(),
  createdAt: z.string(),
  /** Null when the person who wrote it is no longer in the directory. */
  sender: threadPersonSchema.nullable(),
})
export type ThreadReply = z.infer<typeof threadReplySchema>

export const threadSummarySchema = z.object({
  parentMessageUuid: z.string(),
  replyCount: z.number().int().nonnegative(),
  lastReplyAt: z.string(),
  /** The latest people to reply, newest first, at most THREAD_SUMMARY_FACES. */
  repliers: z.array(threadPersonSchema),
})
export type ThreadSummary = z.infer<typeof threadSummarySchema>

export const threadSummariesResponseSchema = z.object({ threads: z.array(threadSummarySchema) })
export const threadRepliesResponseSchema = z.object({ replies: z.array(threadReplySchema) })

/** The session stream event that tells every viewer a thread changed. */
export const THREAD_REPLIES_UPDATED_EVENT = 'thread_replies_updated'
