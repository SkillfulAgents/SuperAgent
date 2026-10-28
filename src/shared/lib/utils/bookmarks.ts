/**
 * One agent-home bookmark: a link, a workspace file, or a workspace folder.
 *
 * "Exactly one of the three" is the server's rule, enforced by a `superRefine`
 * on the Zod schema in the agents route. The renderer used to restate it as a
 * hand-written interface with all three optional, then reconstruct the
 * invariant at every use with a ternary chain and a `!` on each branch to get
 * back the string TypeScript could not see was there. A union says it once, and
 * the impossible bookmarks — none of the three, or two — cannot be built.
 */
export type Bookmark =
  | { name: string; link: string; file?: undefined; folder?: undefined }
  | { name: string; link?: undefined; file: string; folder?: undefined }
  | { name: string; link?: undefined; file?: undefined; folder: string }

export type BookmarkTarget =
  | { kind: 'link'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'folder'; path: string }

/**
 * What a bookmark points at, as one value rather than three optional fields.
 *
 * Null for a bookmark carrying none of them. The type rules that out, but these
 * arrive as JSON from the API, so the row that draws one still needs somewhere
 * to send a shape the server should never have returned.
 */
export function bookmarkTarget(bookmark: Bookmark): BookmarkTarget | null {
  if (bookmark.link) return { kind: 'link', url: bookmark.link }
  if (bookmark.folder) return { kind: 'folder', path: bookmark.folder }
  if (bookmark.file) return { kind: 'file', path: bookmark.file }
  return null
}
