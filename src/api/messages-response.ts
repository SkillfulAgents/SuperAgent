/**
 * The paged read of a transcript's messages and the bytes of its media refs,
 * shared by the routes of a session's own transcript and of the subagent and
 * workflow agent transcripts inside it.
 */
import { Readable } from 'stream'
import type { Context } from 'hono'
import { z } from 'zod'
import { decodeMediaRef, type AgentActor, type SubagentTranscriptRef } from '@shared/lib/agent-actor'
import { MESSAGES_PAGE_MAX_LIMIT, capMessagesPageLimit, clampMessagesPageBytes } from '@shared/lib/messages-page'
import type { TransformedItem } from '@shared/lib/utils/message-transform'

export const messagesListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MESSAGES_PAGE_MAX_LIMIT).optional(),
    cursor: z.string().min(1).max(200).optional(),
    after: z.string().min(1).max(200).optional(),
    // Opt-in: images ship as refs to the media endpoint instead of inline
    // base64. Absent means inline, so clients that predate the media endpoint
    // (and the unpaginated path) are unaffected.
    media: z.literal('ref').optional(),
    // Opt-in `max_bytes`: a soft budget on the raw transcript bytes behind a
    // backward page, clamped by clampMessagesPageBytes. Absent means the
    // reader's default, so clients that predate it are unaffected. Validated
    // on every paginated request, honored on backward pages only: a forward
    // delta is already bounded by the live turn.
    maxBytes: z.coerce.number().int().min(1).optional(),
  })
  // Backward paging and the forward delta are different protocols; a request
  // mixing them has no coherent meaning.
  .refine((q) => !(q.cursor && q.after), { message: 'cursor and after are mutually exclusive' })

export type MessagesListQuery = z.infer<typeof messagesListQuerySchema>

/** The page or delta query of a messages request, or null when it asks for the legacy full list. */
export function messagesListRequest(c: Context) {
  const raw = {
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
    after: c.req.query('after'),
    media: c.req.query('media'),
    maxBytes: c.req.query('max_bytes'),
  }
  // `media` and `max_bytes` select the paginated branch too: they are only
  // honored there, so leaving them out would silently serve the full
  // transcript to a client that asked for refs or for a bounded response —
  // and skip validating the value at all.
  const present = Object.entries(raw).filter(([, value]) => value !== undefined)
  if (present.length === 0) return null
  return messagesListQuerySchema.safeParse(Object.fromEntries(present))
}

// Buffers, not strings: Readable.toWeb hands chunks straight to the web
// ReadableStream, whose byte consumers reject non-Uint8Array chunks.
export function* messagesPageJsonChunks(page: {
  messages: TransformedItem[]
  nextCursor: string | null
}): Generator<Buffer> {
  yield Buffer.from('{"messages":[')
  for (let i = 0; i < page.messages.length; i++) {
    yield Buffer.from((i === 0 ? '' : ',') + JSON.stringify(page.messages[i]))
  }
  yield Buffer.from(`],"nextCursor":${JSON.stringify(page.nextCursor)}}`)
}

/** Answers a page or delta query on the session's transcript, or with `subagent` on that transcript inside it. */
export async function pagedMessagesResponse(
  c: Context,
  actor: AgentActor,
  sessionId: string,
  query: MessagesListQuery,
  annotate: (items: TransformedItem[]) => Promise<void>,
  subagent?: SubagentTranscriptRef,
): Promise<Response> {
  const inside = subagent ? { subagent } : {}
  // The renderer aborts superseded refetches; honor that server-side too.
  // The signal threads down to the tail reader so an abandoned request
  // stops paying for transcript reads (multi-second on network volumes)
  // instead of running the full read/parse/serialize pipeline to
  // completion for a client that hung up.
  if (query.after !== undefined) {
    // Forward delta: upserted items at-or-after the anchor (a live-session
    // refetch only cares about lines appended since the last read). The
    // window is bounded by the active turn near EOF, so this stays a few
    // KB while the full trailing page is multi-MB on long sessions.
    const delta = await actor.messages.delta(sessionId, {
      after: query.after,
      signal: c.req.raw.signal,
      media: query.media,
      ...inside,
    })
    c.req.raw.signal.throwIfAborted()
    await annotate(delta.messages)
    c.req.raw.signal.throwIfAborted()
    return c.json({
      messages: delta.messages,
      anchor: delta.anchor,
      ...(delta.resync ? { resync: true as const } : {}),
    })
  }
  // Without `max_bytes` no budget is passed and the reader's default
  // applies — the same call as before the parameter existed.
  const byteBudget = clampMessagesPageBytes(query.maxBytes)
  const page = await actor.messages.page(sessionId, {
    limit: capMessagesPageLimit(query.limit, query.cursor),
    cursor: query.cursor,
    signal: c.req.raw.signal,
    media: query.media,
    ...(byteBudget !== undefined ? { byteBudget } : {}),
    ...inside,
  })
  c.req.raw.signal.throwIfAborted()
  await annotate(page.messages)
  c.req.raw.signal.throwIfAborted()
  // Serialize item-by-item instead of one JSON.stringify of the whole
  // envelope: pages hold multi-MB tool results, and a monolithic response
  // string was one of the transients that made concurrent page fetches
  // OOM the process. Readable.from pulls lazily, so writes see real
  // backpressure from the socket.
  return c.body(Readable.toWeb(Readable.from(messagesPageJsonChunks(page))) as ReadableStream, 200, {
    'Content-Type': 'application/json',
  })
}

/** The bytes of the media ref in the `ref` param, read from the session's transcript or `subagent`'s inside it. */
export async function mediaResponse(
  c: Context,
  actor: AgentActor,
  sessionId: string,
  subagent?: SubagentTranscriptRef,
): Promise<Response> {
  const ref = decodeMediaRef(c.req.param('ref') ?? '')
  if (!ref) return c.json({ error: 'Invalid media reference' }, 400)

  const blob = await actor.messages.media(sessionId, ref, c.req.raw.signal, subagent)
  // Deletion and retention rewrite transcripts in place, so a ref the client
  // still holds can address bytes that have moved or gone. Gone for good —
  // the client shows a placeholder rather than retrying.
  if (!blob) return c.json({ error: 'Media no longer available' }, 410)

  return c.body(blob.stream, 200, {
    'Content-Type': blob.mimeType,
    'Content-Length': String(blob.bytes),
    // A ref names an immutable byte span: any edit to the transcript
    // invalidates it rather than changing what it points at.
    'Cache-Control': 'private, max-age=31536000, immutable',
    // The type comes from a magic-number sniff, never from the ref — keep
    // the browser from second-guessing it.
    'X-Content-Type-Options': 'nosniff',
  })
}
