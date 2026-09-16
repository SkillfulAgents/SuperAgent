/** Preserve Unicode and content while respecting the transport's actual input unit. */
export function splitSpeechText(text: string, limit: number, unit: 'utf16' | 'utf8', preferWords = false): string[] {
  if (!Number.isInteger(limit) || limit < 4) throw new Error('Speech chunk limit must be at least four.')
  const encoder = new TextEncoder()
  const size = (value: string) => unit === 'utf8' ? encoder.encode(value).length : value.length
  const chunks: string[] = []
  let chunk = ''
  let length = 0
  let boundary = 0
  for (const character of text) {
    const width = size(character)
    while (length + width > limit) {
      const end = preferWords && boundary > 0 ? boundary : chunk.length
      chunks.push(chunk.slice(0, end))
      chunk = chunk.slice(end)
      length = size(chunk)
      boundary = 0
    }
    chunk += character
    length += width
    if (/\s/u.test(character)) boundary = chunk.length
  }
  if (chunk) chunks.push(chunk)
  return chunks
}
