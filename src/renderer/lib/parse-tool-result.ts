import { getApiBaseUrl } from './env'

interface ContentBlock {
  type: string
  text?: string
  source?: { type: string; media_type?: string; data?: string }
  // MCP image format
  data?: string
  mimeType?: string
  // Media ref (server answered a `media=ref` request): the image lives at `url`
  // instead of inline. See shared/lib/services/session-media.ts.
  url?: string
  bytes?: number
}

export interface ParsedToolResultImage {
  /** Ready for an <img> src: a data: URL for inline base64, an API URL for a ref. */
  src: string
  /** Decoded size when known (refs only) — the bytes aren't in hand to measure. */
  bytes?: number
  /** Refs are fetched over the network, so they can 404/410 after a transcript edit. */
  isRef: boolean
}

export interface ParsedToolResult {
  text: string | null
  images: ParsedToolResultImage[]
}

function imageFromBlock(block: ContentBlock): ParsedToolResultImage | null {
  if (block.type === 'media_ref') {
    if (!block.url) return null
    return { src: `${getApiBaseUrl()}${block.url}`, bytes: block.bytes, isRef: true }
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
export function parseToolResult(result: unknown): ParsedToolResult {
  const images: ParsedToolResultImage[] = []

  if (result == null) return { text: null, images }
  if (typeof result === 'string') {
    // Try parsing as JSON content blocks
    try {
      const parsed = JSON.parse(result)
      if (Array.isArray(parsed)) {
        return parseToolResult(parsed)
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
        const image = imageFromBlock(block)
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
  const image = imageFromBlock(block)
  if (image) {
    images.push(image)
    return { text: null, images }
  }

  // Fallback: stringify
  return { text: JSON.stringify(result, null, 2), images }
}
