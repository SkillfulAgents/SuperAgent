/**
 * Split an in-progress streaming markdown string into already-"settled" blocks
 * and a trailing "tail" block that is still growing.
 *
 * A settled block is closed by a blank line that is NOT inside a fenced code
 * block, so it can never change as more text streams in. The renderer parses
 * each settled block exactly once (memoized) and only re-parses the small tail
 * per streaming delta — turning the O(N^2) cost of re-parsing the whole
 * accumulated markdown on every delta into O(N).
 *
 * CRITICAL: the split is fence-aware. A naive split on /\n\n/ would cut inside
 * fenced code blocks (which legally contain blank lines), freezing an
 * unterminated fence and rendering broken output mid-stream. We only treat a
 * blank line as a block boundary when not inside an open ``` / ~~~ fence, and
 * we never settle a block that still contains an unclosed fence.
 *
 * Remaining cross-block imperfections are intentionally NOT handled here because
 * they are cosmetic and self-correct the instant the message persists and
 * re-renders as a single document:
 *   - a "loose" list split across a blank line renders as adjacent lists
 *   - a reference-style link / footnote whose definition arrives in a later block
 *   - a 4-space indented code block containing a blank line (rare vs fences)
 */
export interface StreamingMarkdownSplit {
  /** Closed blocks, in order. Each is safe to parse once and memoize forever. */
  settled: string[]
  /** The still-growing last block (includes any currently-open code fence). */
  tail: string
}

const EMPTY_SPLIT: StreamingMarkdownSplit = { settled: [], tail: '' }

// A fence delimiter line: up to 3 spaces of indent, then 3+ backticks or tildes.
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/
// A closing fence may only be followed by whitespace (no info string).
const CLOSING_FENCE_LINE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

interface FenceState {
  char: string
  len: number
}

function fenceDelimiter(line: string): FenceState | null {
  const m = FENCE_LINE.exec(line)
  if (!m) return null
  return { char: m[1][0], len: m[1].length }
}

export function splitStreamingMarkdown(text: string): StreamingMarkdownSplit {
  if (text === '') return EMPTY_SPLIT

  const lines = text.split('\n')
  const blocks: string[] = []
  let cur: string[] = []
  let fence: FenceState | null = null

  const flush = () => {
    if (cur.length > 0) {
      blocks.push(cur.join('\n'))
      cur = []
    }
  }

  for (const line of lines) {
    if (fence) {
      // Inside an open fence: blank lines are content; only a matching closing
      // delimiter (same char, length >= opening, nothing but whitespace after)
      // ends it.
      cur.push(line)
      const delim = fenceDelimiter(line)
      if (
        delim &&
        delim.char === fence.char &&
        delim.len >= fence.len &&
        CLOSING_FENCE_LINE.test(line)
      ) {
        fence = null
      }
      continue
    }

    const delim = fenceDelimiter(line)
    if (delim) {
      // Opening a new fence — from here blank lines no longer split.
      fence = delim
      cur.push(line)
      continue
    }

    if (line.trim() === '') {
      // Blank line outside a fence: close the current block.
      flush()
    } else {
      cur.push(line)
    }
  }
  flush()

  if (blocks.length === 0) return EMPTY_SPLIT
  return { settled: blocks.slice(0, -1), tail: blocks[blocks.length - 1] }
}
