// Minimal, dependency-free CSV/TSV parser (RFC 4180-ish): handles quoted
// fields, escaped quotes (""), embedded newlines, and a small set of common
// delimiters. Used by the CSV renderer to display delimited files as a table.

const DELIMITERS = [',', '\t', ';', '|'] as const

export interface ParsedCsv {
  /** First (header) row, padded to columnCount. */
  headers: string[]
  /** Data rows (header excluded), each padded to columnCount. Blank source
   * lines are preserved as empty rows so displayed row numbers stay aligned. */
  rows: string[][]
  /** The delimiter that was detected and used for parsing. */
  delimiter: string
  /** Number of columns (max across header + rows). */
  columnCount: number
}

const MAX_SAMPLE_LINES = 10

function isDelimiter(ch: string): ch is (typeof DELIMITERS)[number] {
  return ch === ',' || ch === '\t' || ch === ';' || ch === '|'
}

/**
 * Guess the delimiter by counting candidate separators across the first few
 * logical lines. Counting is quote-aware — separators inside quoted fields are
 * ignored — so a comma inside a quoted cell can't outvote a real tab delimiter.
 * Delimiters that appear consistently on every line are favoured.
 */
function detectDelimiter(text: string): string {
  const sample = text.slice(0, 65_536)
  const perLine: Record<string, number[]> = {}
  for (const d of DELIMITERS) perLine[d] = []

  let lineCounts: Record<string, number> = {}
  const resetLine = () => {
    lineCounts = {}
    for (const d of DELIMITERS) lineCounts[d] = 0
  }
  resetLine()

  let inQuotes = false
  let lineHasContent = false
  let sampled = 0

  const flushLine = () => {
    if (lineHasContent) {
      for (const d of DELIMITERS) perLine[d].push(lineCounts[d])
      sampled++
    }
    resetLine()
    lineHasContent = false
  }

  for (let i = 0; i < sample.length && sampled < MAX_SAMPLE_LINES; i++) {
    const ch = sample[i]
    if (inQuotes) {
      if (ch === '"') {
        if (sample[i + 1] === '"') {
          i++ // escaped quote
          continue
        }
        inQuotes = false
      }
      lineHasContent = true
      continue
    }
    if (ch === '"') {
      inQuotes = true
      lineHasContent = true
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && sample[i + 1] === '\n') i++ // CRLF
      flushLine()
      continue
    }
    if (isDelimiter(ch)) {
      lineCounts[ch]++
      lineHasContent = true
      continue
    }
    // A line counts as content once it has any non-whitespace character; bare
    // spaces don't make a blank line "real".
    if (ch !== ' ') lineHasContent = true
  }
  if (sampled < MAX_SAMPLE_LINES) flushLine()

  if (sampled === 0) return ','

  let best = ','
  let bestScore = 0
  for (const d of DELIMITERS) {
    const counts = perLine[d]
    const total = counts.reduce((a, b) => a + b, 0)
    if (total === 0) continue
    const min = Math.min(...counts)
    // Reward both raw frequency and consistency across lines.
    const score = total + min * 10
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

/** Tokenize the full text into rows of raw field strings. */
function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  let started = false // current row has at least begun (guards trailing newline)

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++ // skip the escaped quote
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
      started = true
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      started = true
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++ // CRLF
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      started = false
      continue
    }

    field += ch
    started = true
  }

  // Flush the trailing row unless the file ended on a clean newline.
  if (started || field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

/** Largest value in a numeric array, without spreading (which overflows the
 * call stack for files with millions of rows). */
function maxLength(rows: string[][], floor: number): number {
  let max = floor
  for (const r of rows) {
    if (r.length > max) max = r.length
  }
  return max
}

// TODO: candidate to replace with PapaParse — battle-tested on real-world CSV
// edge cases (BOM, loose quoting, encodings) and supports streaming, which
// would let us lift the 5MB/1000-row caps for huge files. Swap here behind the
// ParsedCsv boundary; keep skipEmptyLines off to preserve row-number alignment.
export function parseCsv(text: string): ParsedCsv {
  const delimiter = detectDelimiter(text)
  // Blank lines are intentionally kept so the table's row numbers line up with
  // the source file (a comment pinned to a row references its true position).
  const all = parseRows(text, delimiter)

  const headers = all.length > 0 ? [...all[0]] : []
  const rows = all.slice(1)

  const columnCount = maxLength(rows, headers.length)

  // Pad to a rectangular shape so the table renders cleanly.
  while (headers.length < columnCount) headers.push('')
  const paddedRows = rows.map(r => {
    if (r.length >= columnCount) return r
    const copy = r.slice()
    while (copy.length < columnCount) copy.push('')
    return copy
  })

  return { headers, rows: paddedRows, delimiter, columnCount }
}
