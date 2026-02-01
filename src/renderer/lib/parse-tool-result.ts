interface ContentBlock {
  type: string
  text?: string
  source?: { type: string; media_type?: string; data?: string }
  // MCP image format
  data?: string
  mimeType?: string
}

export interface ParsedToolResult {
  text: string | null
  images: Array<{ data: string; mimeType: string }>
}

/**
 * Extract displayable text and images from a tool result.
 * Results can be: a plain string, a JSON string of content blocks,
 * or an array of content block objects (from MCP).
 */
export function parseToolResult(result: unknown): ParsedToolResult {
  const images: Array<{ data: string; mimeType: string }> = []

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
      } else if (block.type === 'image') {
        // Anthropic API format: { type: "image", source: { type: "base64", media_type, data } }
        if (block.source?.data && block.source?.media_type) {
          images.push({ data: block.source.data, mimeType: block.source.media_type })
        }
        // MCP format: { type: "image", data, mimeType }
        else if (block.data && block.mimeType) {
          images.push({ data: block.data, mimeType: block.mimeType })
        }
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
    if (block.source?.data && block.source?.media_type) {
      images.push({ data: block.source.data, mimeType: block.source.media_type })
    } else if (block.data && block.mimeType) {
      images.push({ data: block.data, mimeType: block.mimeType })
    }
    return { text: null, images }
  }

  // Fallback: stringify
  return { text: JSON.stringify(result, null, 2), images }
}
