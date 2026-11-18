/**
 * Messages page cursor: the page's oldest item id, optionally with the byte
 * offset of that item's transcript row as `uuid:offset`. The offset is a hint
 * the server validates before seeking; a bare uuid is always accepted. Opaque
 * to clients: they pass `nextCursor` back unchanged.
 */
export interface PageCursor {
  id: string
  /** Line-start offset of the id's row. Absent on a bare-id cursor. */
  offset?: number
}

// Transcript uuids hold no colon, so a trailing `:digits` is unambiguous. The
// digit cap keeps the offset a safe integer.
const OFFSET_SUFFIX = /^(.+):(\d{1,15})$/

export function parsePageCursor(cursor: string): PageCursor {
  const match = OFFSET_SUFFIX.exec(cursor)
  return match ? { id: match[1]!, offset: Number(match[2]) } : { id: cursor }
}

export function formatPageCursor(id: string, offset: number | undefined): string {
  return offset === undefined ? id : `${id}:${offset}`
}
