import { getApiBaseUrl } from './env'

interface ContentBlock {
  type: string
  text?: string
  source?: { type: string; media_type?: string; data?: string }
  // MCP image format
  data?: string
  mimeType?: string
  // Media ref (server answered a `media=ref` request): the image is fetched
  // from the session's media endpoint. See shared/lib/services/session-media.ts.
  id?: string
  bytes?: number
  width?: number
  height?: number
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

export interface ParsedToolResult {
  text: string | null
  images: ParsedToolResultImage[]
}

/** Media ids are base64url — anything else cannot have been minted here, and
 * must never reach a URL. */
const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{1,4096}$/

function imageFromBlock(
  block: ContentBlock,
  media?: ToolResultMediaContext
): ParsedToolResultImage | null {
  if (block.type === 'media_ref') {
    // A tool result is untrusted text, and this function is reached by JSON
    // that a tool produced — so a block saying it is a media ref proves
    // nothing. Provenance can only come from the caller: the address is built
    // here, from a session identity the app already knows, and the block
    // contributes only an id that has to look like one we minted. Anything
    // else is dropped rather than fetched.
    if (!media || typeof block.id !== 'string' || !MEDIA_ID_PATTERN.test(block.id)) return null
    const path =
      `/api/agents/${encodeURIComponent(media.agentSlug)}` +
      `/sessions/${encodeURIComponent(media.sessionId)}/media/${block.id}`
    return {
      src: `${getApiBaseUrl()}${path}`,
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

/**
 * Extract displayable text and images from a tool result.
 * Results can be: a plain string, a JSON string of content blocks,
 * or an array of content block objects (from MCP).
 */
export function parseToolResult(
  result: unknown,
  media?: ToolResultMediaContext
): ParsedToolResult {
  const images: ParsedToolResultImage[] = []

  if (result == null) return { text: null, images }
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
    return { text: result, images }
  }

  if (Array.isArray(result)) {
    const textParts: string[] = []
    for (const block of result as ContentBlock[]) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text)
      } else {
        const image = imageFromBlock(block, media)
        if (image) images.push(image)
      }
    }
    return { text: textParts.length > 0 ? textParts.join('\n') : null, images }
  }

  // Single content block object
  const block = result as ContentBlock
  if (block.type === 'text' && block.text) {
    return { text: block.text, images }
  }
  const image = imageFromBlock(block, media)
  if (image) {
    images.push(image)
    return { text: null, images }
  }

  // Fallback: stringify
  return { text: JSON.stringify(result, null, 2), images }
}
