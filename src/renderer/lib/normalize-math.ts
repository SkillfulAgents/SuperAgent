// Code is left alone: fences (closed only by the same run that opened them, so a
// ````md fence can hold ``` blocks), then multi- and single-backtick spans.
const CODE = /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|``[\s\S]*?``|`[^`\n]*`/g
// `$` before a digit, unless a `$` later on the line closes it as math (Pandoc's
// rule: no space before the closing `$`, no digit after it), as in `$2T(n/2)$:`.
const PRICE = /(?<![\\$])\$(?=\d)(?![^$\n]*[^\s$]\$(?!\d))/g

function normalizeProse(prose: string): string {
  return prose
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, math: string) => `$$${math}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, math: string) => `$${math}$`)
    .replace(PRICE, '\\$')
}

/**
 * Rewrites the math delimiters models write into the ones remark-math reads:
 * `\[...\]` → `$$...$$`, `\(...\)` → `$...$`, and `$` before a digit becomes
 * `\$`, so "$5 and $10" stays a price instead of opening inline math.
 */
export function normalizeMath(markdown: string): string {
  if (!/[$\\]/.test(markdown)) return markdown
  let out = ''
  let last = 0
  for (const code of markdown.matchAll(CODE)) {
    out += normalizeProse(markdown.slice(last, code.index)) + code[0]
    last = code.index + code[0].length
  }
  return out + normalizeProse(markdown.slice(last))
}
