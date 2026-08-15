interface ContentBlock {
  type: string
  text?: string
  source?: { type: string; media_type?: string; data?: string }
  // MCP image format
  data?: string
  mimeType?: string
  // image_ref format (server-stripped inline image; fetched via tool-images route)
  toolUseId?: string
  index?: number
}

export interface ParsedToolResultImage {
  mimeType: string
  /** Inline base64 payload (legacy / small images). */
  data?: string
  /** Server-side ref; the caller builds the tool-images URL from it. */
  ref?: { toolUseId: string; index: number }
}

export interface ParsedToolResult {
  text: string | null
  images: ParsedToolResultImage[]
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

  const pushImage = (block: ContentBlock) => {
    // Anthropic API format: { type: "image", source: { type: "base64", media_type, data } }
    if (block.source?.data && block.source?.media_type) {
      images.push({ data: block.source.data, mimeType: block.source.media_type })
    }
    // MCP format: { type: "image", data, mimeType }
    else if (block.data && block.mimeType) {
      images.push({ data: block.data, mimeType: block.mimeType })
    }
  }

  const pushImageRef = (block: ContentBlock) => {
    if (block.toolUseId && block.index !== undefined && block.mimeType) {
      images.push({ mimeType: block.mimeType, ref: { toolUseId: block.toolUseId, index: block.index } })
    }
  }

  if (Array.isArray(result)) {
    const textParts: string[] = []
    for (const block of result as ContentBlock[]) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text)
      } else if (block.type === 'image') {
        pushImage(block)
      } else if (block.type === 'image_ref') {
        pushImageRef(block)
      }
    }
    return { text: textParts.length > 0 ? textParts.join('\n') : null, images }
  }

  // Single content block object
  const block = result as ContentBlock
  if (block.type === 'text' && block.text) {
    return { text: block.text, images }
  }
  if (block.type === 'image') {
    pushImage(block)
    return { text: null, images }
  }
  if (block.type === 'image_ref') {
    pushImageRef(block)
    return { text: null, images }
  }

  // Fallback: stringify
  return { text: JSON.stringify(result, null, 2), images }
}
