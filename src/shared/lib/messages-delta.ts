/**
 * Forward-delta anchoring and merging for the messages list.
 *
 * A live-session refetch only cares about transcript lines appended since the
 * last read, but new JSONL lines can also MUTATE display items the client
 * already holds: a tool_result attaches to a tool_use inside an earlier
 * assistant item, and a streaming assistant message keeps merging content
 * blocks (text, thinking, usage) into the same display item across lines. The
 * delta contract therefore works in upserted windows, not appends:
 *
 * - the client picks an ANCHOR — the last display item that can no longer
 *   change — and asks the server for everything at-or-after it (`?after=`);
 * - the server re-transforms the transcript tail and returns the full current
 *   version of every item in that window;
 * - the client splices the window over its cached suffix.
 *
 * Shared between the server route (defensive window widening, response anchor)
 * and the renderer (anchor selection over the query cache, merge) so both
 * sides agree on what "can no longer change" means.
 */

/** Structural subset of TransformedItem / ApiMessageOrBoundary the anchor logic needs. */
export interface DeltaWindowItem {
  id: string
  type: string
  /** User message delivered mid-turn (queued/steering) — does not end the turn it appears in. */
  queued?: boolean
  toolCalls?: Array<{ result?: unknown }>
}

/**
 * Index of the first display item that may still change as the transcript
 * grows (`items.length` when every item is settled). Items before it are
 * immutable going forward:
 *
 * - An unresolved tool call can only receive its result while its turn is
 *   alive, and a non-queued user message ends the turn — so open calls before
 *   the last one belong to finished/interrupted turns and never resolve.
 * - The trailing assistant message may still merge streamed content blocks
 *   (same message.id across JSONL lines) even when it has no tool calls yet.
 *   Trailing system items (boundaries, banners) after it don't shield it, and
 *   neither do queued user messages — steering input lands mid-turn, so block
 *   entries for the assistant before it can still follow in the transcript.
 */
export function findDeltaWindowStart(items: readonly DeltaWindowItem[]): number {
  let turnStart = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.type === 'user' && !item.queued) {
      turnStart = i + 1
      break
    }
  }

  let start = items.length
  for (let i = turnStart; i < items.length; i++) {
    const item = items[i]
    if (item.type === 'assistant' && item.toolCalls?.some((tc) => tc.result === undefined)) {
      start = i
      break
    }
  }

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.type !== 'user' && item.type !== 'assistant') continue
    if (item.type === 'user' && item.queued) continue
    if (item.type === 'assistant') start = Math.min(start, i)
    break
  }

  return start
}

/**
 * The id to send as `?after=` — the last settled item — or null when nothing
 * is safely settled yet (caller falls back to a full page fetch).
 */
export function pickDeltaAnchor(items: readonly DeltaWindowItem[]): string | null {
  const start = findDeltaWindowStart(items)
  return start > 0 ? items[start - 1].id : null
}

/**
 * Splice a delta window over the cached list. The window is authoritative from
 * its first item to the end of the transcript: cached items in that range the
 * server no longer returns were rewritten away (deletion, interrupt cleanup).
 * Returns null when the window's first item isn't in the cache — the server
 * widened past the cached head or the anchor drifted — and the caller must
 * fall back to a full fetch.
 *
 * The kept prefix is deduped against the window: a resumed CLI can re-append
 * old history verbatim, and when the originals sit beyond the server's bounded
 * tail the replayed copies arrive as window items with ids the prefix already
 * holds. Keeping the window's copy (at its replayed position) matches what a
 * full fetch of the tail would show.
 */
export function mergeDeltaMessages<T extends { id: string }>(
  cached: readonly T[],
  delta: readonly T[]
): T[] | null {
  if (delta.length === 0) return [...cached]
  const spliceIdx = cached.findIndex((item) => item.id === delta[0].id)
  if (spliceIdx === -1) return null
  const deltaIds = new Set(delta.map((item) => item.id))
  return [
    ...cached.slice(0, spliceIdx).filter((item) => !deltaIds.has(item.id)),
    ...delta,
  ]
}
