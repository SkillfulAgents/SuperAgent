import { getApiBaseUrl } from './env'

interface ContentBlock {
  type: string
  text?: string
  source?: { type: string; media_type?: string; data?: string }
  // MCP image format
  data?: string
  mimeType?: string
  // Media ref (server answered a `media=ref` request): the bytes are fetched
  // from the session's media endpoint. See shared/lib/services/session-media.ts.
  id?: string
  bytes?: number
  width?: number
  height?: number
  // Document blocks (a PDF the Read tool returned) may carry a display title.
  title?: string
}

/** Whose transcript this result belongs to. Required before any ref becomes a
 * network request — see below. */
export interface ToolResultMediaContext {
  agentSlug: string
  sessionId: string
}

export interface ParsedToolResultImage {
  /** Ready for an <img> src: a data: URL for inline base64, an API URL for a ref. */
  src: string
  /** Decoded size when known (refs only) — the bytes aren't in hand to measure. */
  bytes?: number
  /** Intrinsic pixel size when the server could read it, so the layout can
   * reserve the box before the bytes arrive. */
  width?: number
  height?: number
  /** Refs are fetched over the network, so they can 404/410 after a transcript edit. */
  isRef: boolean
}

/** A PDF a tool returned as a `document` block (the Read tool on a .pdf) —
 * same two shapes as an image: inline base64 or a server media ref. */
export interface ParsedToolResultDocument {
  /** A data: URL for inline base64, an API URL for a ref. */
  src: string
  mimeType: 'application/pdf'
  /** Decoded size when known (refs only). */
  bytes?: number
  /** Display name, when the block carried one. */
  title?: string
  /** Refs are fetched over the network, so they can 404/410 after a transcript edit. */
  isRef: boolean
}

export interface ParsedToolResult {
  text: string | null
  images: ParsedToolResultImage[]
  documents: ParsedToolResultDocument[]
}

/**
 * Image sources reported by tools are often container-local files. The final
 * answer may embed one of those paths as Markdown, but the renderer cannot (and
 * must not) read an arbitrary `file:` URL from the host. This map ties only a
 * path explicitly reported alongside a real image block to the already-trusted
 * image source produced above.
 */
export type EmbeddedImageAliases = ReadonlyMap<string, string>

/** Preserve a verified alias map's identity when a refetch rebuilds equal contents. */
export function reuseEqualEmbeddedImageAliases(
  previous: EmbeddedImageAliases | null,
  next: EmbeddedImageAliases
): EmbeddedImageAliases {
  if (!previous || previous.size !== next.size) return next
  for (const [path, src] of previous) {
    if (next.get(path) !== src) return next
  }
  return previous
}

/** Media ids are base64url — anything else cannot have been minted here, and
 * must never reach a URL. */
const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{1,4096}$/

const PDF_MIME = 'application/pdf'

/** The media endpoint address for a ref block, or null when the block cannot
 * be vouched for.
 *
 * A tool result is untrusted text, and this function is reached by JSON that a
 * tool produced — so a block saying it is a media ref proves nothing.
 * Provenance can only come from the caller: the address is built here, from a
 * session identity the app already knows, and the block contributes only an id
 * that has to look like one we minted. Anything else is dropped rather than
 * fetched. */
function mediaRefSrc(block: ContentBlock, media?: ToolResultMediaContext): string | null {
  if (!media || typeof block.id !== 'string' || !MEDIA_ID_PATTERN.test(block.id)) return null
  const path =
    `/api/agents/${encodeURIComponent(media.agentSlug)}` +
    `/sessions/${encodeURIComponent(media.sessionId)}/media/${block.id}`
  return `${getApiBaseUrl()}${path}`
}

function imageFromBlock(
  block: ContentBlock,
  media?: ToolResultMediaContext
): ParsedToolResultImage | null {
  if (block.type === 'media_ref') {
    // A ref that names a PDF is a document, handled by documentFromBlock. A
    // ref without a type is an image: refs predate PDF support and only
    // images were ever minted without one.
    if (block.mimeType === PDF_MIME) return null
    const src = mediaRefSrc(block, media)
    if (!src) return null
    return {
      src,
      bytes: block.bytes,
      ...(typeof block.width === 'number' && typeof block.height === 'number'
        ? { width: block.width, height: block.height }
        : {}),
      isRef: true,
    }
  }
  if (block.type !== 'image') return null
  // Anthropic API format: { type: "image", source: { type: "base64", media_type, data } }
  if (block.source?.data && block.source?.media_type) {
    return { src: `data:${block.source.media_type};base64,${block.source.data}`, isRef: false }
  }
  // MCP format: { type: "image", data, mimeType }
  if (block.data && block.mimeType) {
    return { src: `data:${block.mimeType};base64,${block.data}`, isRef: false }
  }
  return null
}

function documentFromBlock(
  block: ContentBlock,
  media?: ToolResultMediaContext
): ParsedToolResultDocument | null {
  const title = typeof block.title === 'string' && block.title.length > 0 ? { title: block.title } : {}
  if (block.type === 'media_ref') {
    if (block.mimeType !== PDF_MIME) return null
    const src = mediaRefSrc(block, media)
    if (!src) return null
    return { src, mimeType: PDF_MIME, bytes: block.bytes, ...title, isRef: true }
  }
  if (block.type !== 'document') return null
  // Anthropic API format: { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
  if (block.source?.type === 'base64' && block.source.media_type === PDF_MIME && block.source.data) {
    return { src: `data:${PDF_MIME};base64,${block.source.data}`, mimeType: PDF_MIME, ...title, isRef: false }
  }
  return null
}

/**
 * Extract displayable text, images and documents from a tool result.
 * Results can be: a plain string, a JSON string of content blocks,
 * or an array of content block objects (from MCP).
 */
export function parseToolResult(
  result: unknown,
  media?: ToolResultMediaContext
): ParsedToolResult {
  const images: ParsedToolResultImage[] = []
  const documents: ParsedToolResultDocument[] = []

  if (result == null) return { text: null, images, documents }
  if (typeof result === 'string') {
    // Try parsing as JSON content blocks
    try {
      const parsed = JSON.parse(result)
      if (Array.isArray(parsed)) {
        return parseToolResult(parsed, media)
      }
    } catch {
      // Plain string
    }
    return { text: result, images, documents }
  }

  const collect = (block: ContentBlock): void => {
    const document = documentFromBlock(block, media)
    if (document) {
      documents.push(document)
      return
    }
    const image = imageFromBlock(block, media)
    if (image) images.push(image)
  }

  if (Array.isArray(result)) {
    const textParts: string[] = []
    for (const block of result as ContentBlock[]) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text)
      } else {
        collect(block)
      }
    }
    return { text: textParts.length > 0 ? textParts.join('\n') : null, images, documents }
  }

  // Single content block object
  const block = result as ContentBlock
  if (block.type === 'text' && block.text) {
    return { text: block.text, images, documents }
  }
  collect(block)
  if (images.length > 0 || documents.length > 0) {
    return { text: null, images, documents }
  }

  // Fallback: stringify
  return { text: JSON.stringify(result, null, 2), images, documents }
}

// Browser/image tools use lines such as:
//   Screenshot saved to: /home/claude/.../shot.png
//   **Screenshot:** /home/claude/.../shot.png
// Keep this deliberately narrower than a general filesystem-path matcher: a
// random path mentioned in tool output must not authorize a Markdown image.
const REPORTED_IMAGE_PATH =
  /^\*{0,2}(?:screenshot|image)[^:\r\n]{0,80}:\*{0,2}\s*`?((?:file:\/\/)?\/[^\r\n`]*?\.(?:avif|gif|jpe?g|png|webp))(?=[\s`]|$)/gimu

function reportedImagePaths(text: string): string[] {
  return Array.from(text.matchAll(REPORTED_IMAGE_PATH), (match) => match[1])
}

function addImagePathAliases(aliases: Map<string, string>, path: string, src: string): void {
  aliases.set(path, src)
  if (path.startsWith('/')) {
    aliases.set(`file://${path}`, src)
  } else if (path.startsWith('file:///')) {
    aliases.set(path.slice('file://'.length), src)
  }
}

/**
 * Build the allowlist used to resolve container-local Markdown image URLs.
 *
 * A result is usable only when it contains both image bytes/a server media ref
 * and a tool-reported image path. A single image may have multiple textual
 * aliases; multiple images are paired only when the tool reports the same
 * number of paths, avoiding a guess that could display the wrong capture.
 */
export function collectEmbeddedImageAliases(
  results: Iterable<unknown>,
  media?: ToolResultMediaContext
): EmbeddedImageAliases {
  const aliases = new Map<string, string>()

  for (const result of results) {
    const parsed = parseToolResult(result, media)
    if (!parsed.text || parsed.images.length === 0) continue

    const paths = reportedImagePaths(parsed.text)
    if (paths.length === 0) continue

    if (parsed.images.length === 1) {
      for (const path of paths) addImagePathAliases(aliases, path, parsed.images[0].src)
    } else if (paths.length === parsed.images.length) {
      paths.forEach((path, index) => addImagePathAliases(aliases, path, parsed.images[index].src))
    }
  }

  return aliases
}
