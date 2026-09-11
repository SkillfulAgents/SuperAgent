/**
 * Messages page cursor codec.
 *
 * A cursor names the page's oldest item by transcript uuid. It may also carry
 * the byte offset of that item's JSONL line as `uuid:offset`, which lets the
 * server seek straight to the row instead of re-scanning from EOF on every
 * page. The offset is a hint: the server validates that the row at that
 * offset still carries the uuid (transcripts get rewritten by deletion,
 * retention cleanup and resync) and falls back to the id-only scan when it
 * does not. A bare uuid is always accepted — older clients, and the client's
 * own id-only fallbacks, keep working.
 *
 * Opaque to the client: it never parses or builds one.
 */
export interface PageCursor {
  id: string
  /** Byte offset of the id's line start. Absent on legacy id-only cursors. */
  offset?: number
}

// Transcript uuids are UUIDv4 (no colon), so a trailing `:digits` is
// unambiguous. Digits are capped so the offset always parses as a safe
// integer; a longer run is not treated as an offset.
const OFFSET_SUFFIX = /^(.+):(\d{1,15})$/

export function parsePageCursor(cursor: string): PageCursor {
  const m = OFFSET_SUFFIX.exec(cursor)
  if (!m) return { id: cursor }
  return { id: m[1]!, offset: Number(m[2]) }
}

export function formatPageCursor(id: string, offset: number | undefined): string {
  if (offset === undefined || !Number.isInteger(offset) || offset < 0) return id
  return `${id}:${offset}`
}
