interface ContentBlock {
  type: string
  text?: string
  source?: { type: string; media_type?: string; data?: string }
  // MCP image format
  data?: string
  mimeType?: string
  omitted?: boolean
  originalChars?: number
}

export interface ParsedToolResult {
  text: string | null
  images: Array<{ data: string; mimeType: string }>
  omittedImages: Array<{ mimeType?: string; originalChars: number }>
}

function collectImage(
  block: ContentBlock,
  images: ParsedToolResult['images'],
  omittedImages: ParsedToolResult['omittedImages']
) {
  if (block.omitted) {
    omittedImages.push({
      mimeType: block.source?.media_type ?? block.mimeType,
      originalChars: typeof block.originalChars === 'number' ? block.originalChars : 0,
    })
    return
  }
  if (block.source?.data && block.source?.media_type) {
    images.push({ data: block.source.data, mimeType: block.source.media_type })
  } else if (block.data && block.mimeType) {
    images.push({ data: block.data, mimeType: block.mimeType })
  }
}

// Extract displayable text and images from a tool result (string, JSON blocks, or MCP array).
export function parseToolResult(result: unknown): ParsedToolResult {
  const images: Array<{ data: string; mimeType: string }> = []
  const omittedImages: ParsedToolResult['omittedImages'] = []

  if (result == null) return { text: null, images, omittedImages }
  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result)
      if (Array.isArray(parsed)) {
        return parseToolResult(parsed)
      }
    } catch {
      // Plain string
    }
    return { text: result, images, omittedImages }
  }

  if (Array.isArray(result)) {
    const textParts: string[] = []
    for (const block of result as ContentBlock[]) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text)
      } else if (block.type === 'image') {
        collectImage(block, images, omittedImages)
      }
    }
    return { text: textParts.length > 0 ? textParts.join('\n') : null, images, omittedImages }
  }

  const block = result as ContentBlock
  if (block.type === 'text' && block.text) {
    return { text: block.text, images, omittedImages }
  }
  if (block.type === 'image') {
    collectImage(block, images, omittedImages)
    return { text: null, images, omittedImages }
  }

  return { text: JSON.stringify(result, null, 2), images, omittedImages }
}
