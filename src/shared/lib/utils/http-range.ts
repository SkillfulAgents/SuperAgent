/**
 * Parse a single-range HTTP `Range: bytes=…` header against a known resource
 * size. Returns inclusive { start, end } byte offsets, or null when the header
 * is malformed, multi-range (unsupported), or unsatisfiable. Supports suffix
 * ranges (`bytes=-500` → last 500 bytes), which media players use to probe the
 * tail of a file (e.g. an mp4 moov atom) before seeking.
 */
export function parseByteRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, startRaw, endRaw] = match
  if (startRaw === '' && endRaw === '') return null

  let start: number
  let end: number
  if (startRaw === '') {
    // Suffix range: the last N bytes.
    const suffix = parseInt(endRaw, 10)
    if (Number.isNaN(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = parseInt(startRaw, 10)
    end = endRaw === '' ? size - 1 : parseInt(endRaw, 10)
  }
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  if (start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}
