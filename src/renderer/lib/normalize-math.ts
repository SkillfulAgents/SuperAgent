// Code is left alone: fences, then multi- and single-backtick spans.
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|``[\s\S]*?``|`[^`\n]*`)/
// `$` before a digit, unless it closes on the same line around LaTeX (`$2^n$`).
const PRICE = /(?<![\\$])\$(?=\d)(?![^$\n]*[\\^_{][^$\n]*\$(?!\d))/g

/**
 * Rewrites the math delimiters models write into the ones remark-math reads:
 * `\[...\]` → `$$...$$`, `\(...\)` → `$...$`, and `$` before a digit becomes
 * `\$`, so "$5 and $10" stays a price instead of opening inline math.
 */
export function normalizeMath(markdown: string): string {
  if (!/[$\\]/.test(markdown)) return markdown
  return markdown
    .split(CODE)
    .map((part, i) => (i % 2 === 1 ? part : part
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, math: string) => `$$${math}$$`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, math: string) => `$${math}$`)
      .replace(PRICE, '\\$')))
    .join('')
}
