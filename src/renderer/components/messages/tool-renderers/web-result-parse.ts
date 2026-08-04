/**
 * Pure parsers for the web tool-result texts emitted by
 * agent-container/src/tools/web/format-results.ts. The `Links:` JSON line is the
 * title+url contract; publishedDate/snippet are read from the formatter's own
 * deterministic lines, anchored on each known URL so prose can't false-positive.
 * Lenient by design: anything unrecognized degrades to leftover/body text.
 */

export interface SearchSource {
  title: string
  url: string
  publishedDate?: string
  snippet?: string
  /** The page's declared icon, when the vendor supplied one. Guessing /favicon.ico misses ~40%. */
  favicon?: string
}

export interface ParsedSearchResult {
  sources: SearchSource[]
  leftover: string
}

export interface ParsedFetchResult {
  title: string | null
  url: string | null
  publishedDate?: string
  favicon?: string
  body: string
  note?: string
}

const LINKS_RE = /Links:\s*(\[[\s\S]*?\])\s*\n/
const HIT_RE = /^\d+\. /
const PUBLISHED_RE = /^ {3}Published: (.+)$/
// The fetch header carries optional labelled lines between the url and the blank line.
const FETCH_HEADER_RE = /^(Published|Favicon): (.+)$/
const MULTILINE_RE = /[\r\n]/
// Both formatters append warnings as a single trailing line. Matching one line, not
// [\s\S]+, is what stops an ordinary "Note:" paragraph inside page text from claiming
// everything after it.
const TRAILING_NOTE_RE = /\n\n(Note: [^\n]+)$/

/** Heading markers and surrounding whitespace, for comparing or flattening a line of page text. */
const HEADING_RE = /^#{1,6}\s+/
const normalize = (line: string) => line.replace(HEADING_RE, '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Page text as a single paragraph. Snippets are raw page content, so they arrive with their own
 * blank lines and headings; rendered as-is inside a source row they read as an article rather
 * than a caption. Every word is kept - only the line structure goes.
 */
export function flattenSnippet(text: string): string {
  return text.replace(HEADING_RE, '').replace(/\n#{1,6}\s+/g, '\n').replace(/\s*\n\s*/g, ' ').trim()
}

/**
 * Drop leading lines that merely repeat the title already shown above the text. Fetched pages
 * open with their own title and an H1 of it, and search snippets start with the title that is
 * the row's link - so without this the same sentence renders up to three times. Bounded to two
 * lines and to titles long enough to match unambiguously.
 */
export function stripLeadingTitle(text: string, title?: string | null): string {
  const want = title ? normalize(title) : ''
  if (want.length < 12) return text
  const lines = text.split('\n')
  let i = 0
  let removed = 0
  while (i < lines.length && removed < 2) {
    if (lines[i].trim() === '') {
      i++
      continue
    }
    const got = normalize(lines[i])
    const repeats = got === want || got.startsWith(want) || (want.startsWith(got) && got.length >= 12)
    if (!repeats) break
    i++
    removed++
  }
  return removed > 0 ? lines.slice(i).join('\n').trimStart() : text
}

export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

export function parseSearchResult(result: string): ParsedSearchResult {
  const linksMatch = result.match(LINKS_RE)
  if (!linksMatch) {
    // Legacy pre-Links transcripts: strip the old header line if present.
    const lines = result.split('\n')
    const body = lines[0]?.startsWith('Web search results for query:')
      ? lines.slice(1).join('\n')
      : result
    return { sources: [], leftover: body.trim() }
  }

  let links: unknown[] = []
  try {
    const parsed = JSON.parse(linksMatch[1])
    if (Array.isArray(parsed)) links = parsed
  } catch {
    // Malformed JSON: fall through with no links; everything lands in leftover.
  }

  const sources: SearchSource[] = []
  for (const item of links) {
    if (typeof item !== 'object' || item === null) continue
    const { title, url, favicon } = item as { title?: unknown; url?: unknown; favicon?: unknown }
    if (typeof title !== 'string' || typeof url !== 'string') continue
    sources.push({ title, url, ...(typeof favicon === 'string' ? { favicon } : {}) })
  }

  const body = result.slice((linksMatch.index ?? 0) + linksMatch[0].length)
  const noteMatch = body.match(TRAILING_NOTE_RE)
  const hits = noteMatch?.index !== undefined ? body.slice(0, noteMatch.index) : body
  const trailer = noteMatch ? noteMatch[1] : ''

  const lines = hits.split('\n')
  // A block starts at a numbered line whose next line is one of the urls the Links contract
  // already named. Snippets routinely contain their own numbered lists, and those must not
  // read as block starts.
  const urlLines = new Set(sources.map((s) => `   ${s.url}`))
  const starts: number[] = []
  lines.forEach((line, i) => {
    if (HIT_RE.test(line) && urlLines.has(lines[i + 1])) starts.push(i)
  })

  // Anchor on block structure, not on a free search for each url line. Titles and snippets are
  // interpolated raw, so a hostile result can emit lines that look like another hit's block and
  // plant its text under that site's name, favicon and link. Three conditions have to hold, and
  // any failure degrades to the plain rendering below:
  //   - every title and url is single-line, so one hit really is one header line. A newline in a
  //     title splits its block and would otherwise hide the real one from this scan.
  //   - the block count matches the link count, so an injected extra block cannot pass.
  //   - block i's header is exactly the header the formatter writes for link i, and the line
  //     under it is that link's url.
  const anchored =
    sources.every((s) => !MULTILINE_RE.test(s.title) && !MULTILINE_RE.test(s.url)) &&
    starts.length === sources.length &&
    sources.every(
      (source, i) =>
        lines[starts[i]] === `${i + 1}. ${source.title}` &&
        lines[starts[i] + 1] === `   ${source.url}`,
    )

  if (!anchored) {
    // Formatter drift guard: keep the Links contract (bare title+url) and render the whole
    // body as before - no dates/snippets, no double-rendered rich rows.
    return { sources, leftover: body.trim() }
  }

  sources.forEach((source, i) => {
    let start = starts[i] + 2
    const published = lines[start]?.match(PUBLISHED_RE)
    if (published) {
      source.publishedDate = published[1]
      start++
    }
    // To the next hit, so a snippet containing blank or numbered-looking lines stays whole
    // instead of stranding its tail as unattributed prose under the source list.
    const snippet = lines.slice(start, starts[i + 1] ?? lines.length).join('\n').trim()
    if (snippet) source.snippet = snippet
  })

  const leftover = [...lines.slice(0, starts[0] ?? lines.length), trailer].join('\n').trim()
  return { sources, leftover }
}

export function parseFetchResult(result: string): ParsedFetchResult {
  const lines = result.split('\n')
  const urlLine = lines[1]?.trim()
  if (!urlLine || !/^https?:\/\//.test(urlLine)) {
    return { title: null, url: null, body: result }
  }
  let i = 2
  let publishedDate: string | undefined
  let favicon: string | undefined
  for (let header = lines[i]?.match(FETCH_HEADER_RE); header; header = lines[i]?.match(FETCH_HEADER_RE)) {
    if (header[1] === 'Published') publishedDate = header[2]
    else favicon = header[2]
    i++
  }
  if (lines[i]?.trim() === '') i++
  let bodyText = lines.slice(i).join('\n')
  let note: string | undefined
  // formatWebFetchResult appends warnings as a trailing '\n\nNote: ...' line after the
  // content - split it out so it renders outside the height-capped body.
  const noteMatch = bodyText.match(TRAILING_NOTE_RE)
  if (noteMatch && noteMatch.index !== undefined) {
    note = noteMatch[1]
    bodyText = bodyText.slice(0, noteMatch.index)
  }
  return {
    title: lines[0] || null,
    url: urlLine,
    ...(publishedDate !== undefined ? { publishedDate } : {}),
    ...(favicon !== undefined ? { favicon } : {}),
    body: bodyText,
    ...(note !== undefined ? { note } : {}),
  }
}
