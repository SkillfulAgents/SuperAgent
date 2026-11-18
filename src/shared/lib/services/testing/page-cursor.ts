import { parsePageCursor } from '../session-page-cursor'

/** The item id a messages page cursor names; null for the last page. */
export function cursorId(cursor: string | null): string | null {
  return cursor === null ? null : parsePageCursor(cursor).id
}
