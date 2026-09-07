/**
 * How much of a Markdown reply that is still streaming in can be handed to
 * the synthesizer already.
 *
 * Words are appended to the speech player as they arrive and can never be
 * taken back, but the tail of a streaming reply is not settled: a word may
 * still grow, and a construct may still be open (`**bold` with no closing
 * marks yet, a table whose delimiter row has not come). Parsing an unfinished
 * construct can yield different words than the finished one will. So the
 * reply is cut at the last point where what came before cannot change:
 *
 * - a blank line (the block before it is complete), or
 * - inside a plain paragraph, the end of a sentence followed by whitespace,
 *   or a line break.
 *
 * A block that is still open and is not plain prose — a table, an HTML block
 * — is held back whole until the blank line that closes it; mid-row cuts
 * would speak its syntax.
 */

const LAST_BLANK_LINE = /\n[ \t]*\n(?![\s\S]*\n[ \t]*\n)/
const SENTENCE_OR_LINE_END = /[.!?…]["'”’)\]]*\s|\n/gu

/** The longest prefix of `markdown` whose spoken words are settled. */
export function stableMarkdownPrefix(markdown: string): string {
  const blankMatch = LAST_BLANK_LINE.exec(markdown)
  const blockStart = blankMatch ? blankMatch.index + blankMatch[0].length : 0
  const block = markdown.slice(blockStart)

  if (!isPlainProse(block)) return markdown.slice(0, blockStart)

  let cut = -1
  for (const match of block.matchAll(SENTENCE_OR_LINE_END)) {
    cut = match.index + match[0].length
  }
  if (cut === -1) return markdown.slice(0, blockStart)
  return markdown.slice(0, blockStart + cut)
}

/** True when a still-open block can be cut at sentence boundaries safely. */
function isPlainProse(block: string): boolean {
  for (const line of block.split('\n')) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('|') || trimmed.startsWith('<')) return false
  }
  return true
}
