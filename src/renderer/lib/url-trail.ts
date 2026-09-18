/** Sentence punctuation prose puts after a URL. */
export const PROSE_TRAIL: ReadonlySet<string> = new Set(['.', ',', ';', ':', '!', '?'])

/** PROSE_TRAIL plus the emphasis delimiters GFM also treats as trailing. */
export const MARKDOWN_TRAIL: ReadonlySet<string> = new Set([...PROSE_TRAIL, '*', '_', '~'])

// A closing bracket is prose only when the kept URL has no opener for it.
const BRACKET_OPENER: Record<string, string> = { ')': '(', ']': '[' }

// Punctuation in CJK Symbols and Punctuation (、。「」…); letters and numerals in
// that block (々〆〇) are path characters. Punctuation and symbols in the
// fullwidth ASCII rows (！（），．：？～…); fullwidth letters and digits are not.
const CJK_PUNCTUATION = /^(?=[\u3000-\u303f])\p{P}$/u
const FULLWIDTH_PUNCTUATION = /^(?=[\uff01-\uff65])[\p{P}\p{S}]$/u

function isFullwidthSeparator(ch: string): boolean {
  return CJK_PUNCTUATION.test(ch) || FULLWIDTH_PUNCTUATION.test(ch)
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
 * the first fullwidth punctuation mark — `（public，MIT）。` is never part of one.
 * Trailing ASCII characters in `trail` are then trimmed, with brackets kept
 * while balanced so https://en.wikipedia.org/wiki/Foo_(bar) survives.
 */
export function splitUrlTrail(text: string, trail: ReadonlySet<string> = MARKDOWN_TRAIL): { url: string; trail: string } {
  let end = text.length
  for (let i = 0; i < text.length; i++) {
    if (isFullwidthSeparator(text[i])) {
      end = i
      break
    }
  }
  while (end > 0) {
    const ch = text[end - 1]
    const kept = text.slice(0, end - 1)
    const opener = BRACKET_OPENER[ch]
    const isTrail = opener !== undefined ? countOf(kept, opener) <= countOf(kept, ch) : trail.has(ch)
    if (!isTrail) break
    end--
  }
  return { url: text.slice(0, end), trail: text.slice(end) }
}
