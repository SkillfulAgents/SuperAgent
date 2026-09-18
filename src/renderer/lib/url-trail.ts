// Sentence punctuation and emphasis delimiters GFM also treats as trailing.
const ASCII_TRAIL = new Set(['.', ',', ';', ':', '!', '?', '*', '_', '~'])

// A closing bracket is prose only when the kept URL has no opener for it.
const BRACKET_OPENER: Record<string, string> = { ')': '(', ']': '[' }

// CJK Symbols and Punctuation, plus the punctuation rows of Halfwidth and
// Fullwidth Forms (letters and digits in that block are left alone).
function isFullwidthPunctuation(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff01 && code <= 0xff0f) ||
    (code >= 0xff1a && code <= 0xff20) ||
    (code >= 0xff3b && code <= 0xff40) ||
    (code >= 0xff5b && code <= 0xff65)
  )
}

function countOf(text: string, ch: string): number {
  let n = 0
  for (const c of text) if (c === ch) n++
  return n
}

/**
 * Split the prose punctuation a bare URL collected on its right edge.
 *
 * CJK prose puts no space between a URL and what follows, so the URL ends at
 * the first fullwidth punctuation mark — `（公开，MIT）。` is never part of one.
 * ASCII trailing punctuation is then trimmed the way GFM does, with brackets
 * kept while balanced so https://en.wikipedia.org/wiki/Foo_(bar) survives.
 */
export function splitUrlTrail(text: string): { url: string; trail: string } {
  let end = text.length
  for (let i = 0; i < text.length; i++) {
    if (isFullwidthPunctuation(text.charCodeAt(i))) {
      end = i
      break
    }
  }
  while (end > 0) {
    const ch = text[end - 1]
    const kept = text.slice(0, end - 1)
    const opener = BRACKET_OPENER[ch]
    const isTrail = opener !== undefined ? countOf(kept, opener) <= countOf(kept, ch) : ASCII_TRAIL.has(ch)
    if (!isTrail) break
    end--
  }
  return { url: text.slice(0, end), trail: text.slice(end) }
}
