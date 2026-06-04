// Abbreviations that end with a period but do NOT terminate a sentence. Lowercase;
// matched case-insensitively against the token preceding a candidate break so
// "e.g. Foo" / "etc. Bar" stay on one line instead of breaking after them.
const NON_TERMINAL_ABBR = new Set([
  'e.g', 'i.e', 'etc', 'vs', 'approx', 'cf', 'al', 'no', 'fig',
  'min', 'max', 'sec', 'vol', 'mr', 'mrs', 'ms', 'dr', 'st',
])

/**
 * Split a short status/error message into one line per sentence for display.
 *
 * Tuned for narrow sidebar banners: it breaks on sentence-ending punctuation
 * (`.`, `!`, `?`) followed by whitespace and the start of a new sentence
 * (capital letter, digit, or opening quote/paren). A break is suppressed when
 * the preceding token is a known abbreviation (e.g., i.e., etc.) or a single
 * capitalised initial, so inline abbreviations stay intact. Version numbers and
 * decimals ("v1.2", "5.5 GB") never break because their dots aren't followed by
 * whitespace.
 *
 * Returns the trimmed whole string as a single-element array when there's
 * nothing to split, and never yields empty segments.
 */
export function splitMessageSentences(text: string): string[] {
  const lines: string[] = []
  const boundary = /[.!?]\s+(?=[A-Z0-9"'(])/g
  let start = 0
  let match: RegExpExecArray | null
  while ((match = boundary.exec(text)) !== null) {
    const end = match.index + 1 // keep the punctuation with its sentence
    const segment = text.slice(start, end)
    const lastToken = segment.slice(0, -1).split(/\s+/).pop() ?? ''
    const isFalseBoundary =
      NON_TERMINAL_ABBR.has(lastToken.toLowerCase()) ||
      /^[A-Z]$/.test(lastToken) // single capitalised initial, e.g. drive "C."
    if (isFalseBoundary) continue // keep scanning past this dot
    lines.push(segment.trim())
    start = boundary.lastIndex
  }
  const tail = text.slice(start).trim()
  if (tail) lines.push(tail)
  return lines.length ? lines : [text.trim()]
}
