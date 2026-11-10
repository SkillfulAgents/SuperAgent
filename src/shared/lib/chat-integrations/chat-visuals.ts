import { Marked, type Token, type Tokens } from 'marked'
import { agentRegistry, WorkspaceFileError, workspaceBasename } from '../agent-actor'
import { splitStreamingMarkdown } from '../split-streaming-markdown'
import { getFileExtension } from '../utils/mime'
import { localFilePath } from '../utils/workspace-file-url'

/** A token, where it sits in its block, and the tokens it sits inside, outermost first. */
interface PlacedToken {
  token: Token
  start: number
  end: number
  parents: Token[]
}

/** A visual's image. Throws when there is none. */
type Draw = (agentSlug: string) => Promise<{ data: Buffer; filename: string; alt?: string }>

/** A kind of visual the app draws and a chat shows as an image. */
interface ChatVisual {
  /** This kind's visuals in one settled block, given the block's placed tokens, each with how to draw it. */
  match(tokens: PlacedToken[]): Array<{ start: number; end: number; draw: Draw }>
}

/** A visual with no image for an expected reason (a missing file, a refused source): its source goes out unreported. */
export class NoImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoImageError'
  }
}

export interface VisualSegment {
  kind: 'visual'
  source: string
  draw: Draw
}

export type ChatSegment = { kind: 'text'; source: string } | VisualSegment

// Raster types chat apps take as photos. SVG and HEIC stay links.
const CHAT_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
// Chat apps preview photos far below this (Telegram takes photos up to 10 MB). A larger image stays a link, unread.
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024

function isChatImage(filename: string): boolean {
  return CHAT_IMAGE_EXTENSIONS.has(getFileExtension(filename))
}

const chatMarked = new Marked({ async: false, gfm: true })
const isList = (token: Token): token is Tokens.List => token.type === 'list'
const isImage = (token: Token): token is Tokens.Image => token.type === 'image'
const isLink = (token: Token): token is Tokens.Link => token.type === 'link'
const isParagraph = (token: Token): token is Tokens.Paragraph => token.type === 'paragraph'

/**
 * Each token with its range in `block`, in order. One cursor moves past every token,
 * code included, so nothing is found inside an earlier token, and children are found
 * inside their parent. Table cells are not walked: a table cannot be split. Nor is an
 * image's alt text: an image is one visual. A token not contiguous in the block (a
 * blockquote's lines) has no range; its children do.
 */
function place(block: string, tokens: Token[], cursor = { at: 0 }, parents: Token[] = []): PlacedToken[] {
  return tokens.flatMap((token) => {
    const children = isList(token) ? token.items : token.type !== 'table' && !isImage(token) && 'tokens' in token && token.tokens ? token.tokens : []
    const start = block.indexOf(token.raw, cursor.at)
    if (start === -1) return place(block, children, cursor, [...parents, token])
    cursor.at = start
    const inner = place(block, children, cursor, [...parents, token])
    cursor.at = start + token.raw.length
    return [{ token, start, end: cursor.at, parents }, ...inner]
  })
}

/**
 * Where an image can be cut out with valid markdown left on both sides: the image itself in a
 * top-level paragraph, or the whole link it is the only content of. Inside emphasis, a list, a
 * quote, a heading, inline HTML or brackets a later block resolves, a cut would break the
 * markup, so there the image stays as it is.
 */
function imageRange(image: PlacedToken, placed: PlacedToken[]): PlacedToken | null {
  const [paragraph, link, ...deeper] = image.parents
  if (!paragraph || !isParagraph(paragraph) || deeper.length) return null
  const cut = link ? (isLink(link) && link.tokens.length === 1 ? link : null) : image.token
  if (!cut || paragraph.tokens.some(({ type }) => type === 'html')) return null
  const at = paragraph.tokens.indexOf(cut)
  if (paragraph.tokens[at - 1]?.raw.endsWith('[') || paragraph.tokens[at + 1]?.raw.startsWith(']')) return null
  return placed.find(({ token }) => token === cut) ?? null
}

/** The workspace path of an image the app draws inline (`workspaceImageUrl`): an absolute `/workspace` or `file:///workspace` path. */
function workspaceImagePath(url: string): string | null {
  const path = localFilePath(url)
  return path?.startsWith('/workspace/') && isChatImage(path) ? path : null
}

/**
 * A workspace file's bytes, read confined: a path or link that leaves the workspace is refused.
 * A file over `maxBytes` is refused before it is read.
 */
async function readWorkspaceFile(agentSlug: string, path: string, maxBytes: number): Promise<Buffer> {
  const { size, stream } = await agentRegistry.get(agentSlug).files.readSized(path, { confined: true })
  if (size > maxBytes) {
    await stream.cancel()
    throw new WorkspaceFileError('not-accessible', `${path} is over ${maxBytes} bytes`)
  }
  return Buffer.from(await new Response(stream).arrayBuffer())
}

async function workspaceImage(agentSlug: string, path: string, alt: string): Promise<{ data: Buffer; filename: string; alt?: string }> {
  const data = await readWorkspaceFile(agentSlug, path, MAX_INLINE_IMAGE_BYTES).catch((err: unknown) => {
    // Missing, outside the workspace, not a file, or too large: the link stays, as it did before.
    throw err instanceof WorkspaceFileError ? new NoImageError(err.message) : err
  })
  return { data, filename: workspaceBasename(path), alt: alt || undefined }
}

const image: ChatVisual = {
  match: (tokens) => tokens.flatMap((placed) => {
    const { token } = placed
    if (!isImage(token)) return []
    const path = workspaceImagePath(token.href)
    const range = path ? imageRange(placed, tokens) : null
    return path && range ? [{ start: range.start, end: range.end, draw: (agentSlug: string) => workspaceImage(agentSlug, path, token.text) }] : []
  }),
}

const CHAT_VISUALS: ChatVisual[] = [image]

/**
 * Agent markdown as ordered text and visual segments, and the tail left unsplit.
 * The sources and the tail concatenate back to `text` exactly. With `settledOnly`,
 * the block still streaming stays in the tail, as the app leaves it unrendered.
 */
export function segments(text: string, { settledOnly }: { settledOnly: boolean }): { segments: ChatSegment[]; tail: string } {
  const split = splitStreamingMarkdown(text)
  const blocks = settledOnly ? split.settled : [...split.settled, split.tail]
  const result: ChatSegment[] = []
  let cut = 0
  let searchFrom = 0
  for (const block of blocks) {
    const blockStart = text.indexOf(block, searchFrom)
    searchFrom = blockStart + block.length
    const tokens = place(block, chatMarked.lexer(block))
    const found = CHAT_VISUALS.flatMap((visual) => visual.match(tokens)).sort((a, b) => a.start - b.start)
    for (const { start, end, draw } of found) {
      if (blockStart + start > cut) result.push({ kind: 'text', source: text.slice(cut, blockStart + start) })
      result.push({ kind: 'visual', source: block.slice(start, end), draw })
      cut = blockStart + end
    }
  }
  const end = settledOnly && split.tail ? text.indexOf(split.tail, searchFrom) : text.length
  if (end > cut) result.push({ kind: 'text', source: text.slice(cut, end) })
  return { segments: result, tail: text.slice(end) }
}
