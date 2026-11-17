/**
 * Telegram Bot API 10.1 Rich Messages — markdown converter.
 *
 * Rich Markdown is "compatible with GitHub Flavored Markdown where possible",
 * so the agent's markdown goes to Telegram nearly as written. Telegram parses it
 * into rich blocks server-side; we do NOT build RichBlock objects.
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { splitChatMessage } from './utils'
import { splitStreamingMarkdown } from '../split-streaming-markdown'
import type { Nodes } from 'mdast'
import type { InputRichMessage } from 'grammy/types'

/** Max UTF-8 chars in a rich message (Bot API 10.1). */
export const RICH_MAX_LENGTH = 32768

export interface RichMessageOptions {
  skipEntityDetection?: boolean
}

/** Wrap agent markdown as an InputRichMessage, with the text Telegram would break kept as text. */
export function markdownToRichMessage(md: string, opts: RichMessageOptions = {}): InputRichMessage {
  return {
    markdown: keepLiteral(md),
    ...(opts.skipEntityDetection ? { skip_entity_detection: true } : {}),
  }
}

/** A price: a `$` no backslash escapes, before a digit. */
const PRICE = /(?<!\\)((?:\\\\)*)\$(?=\d)/g
/** A tag no backslash escapes, with its name; quoted attribute values may hold `>`. */
const TAG = /(?<!\\)((?:\\\\)*)<(\/?([A-Za-z][\w-]*)(?:\s(?:[^<>"']|"[^"]*"|'[^']*')*)?\/?>)/g
/** The HTML tags Telegram's rich messages render (Bot API, "Rich HTML style"). Any other tag is dropped with its name. */
const TELEGRAM_TAGS = new Set(['a', 'aside', 'audio', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'del', 'details', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'li', 'mark', 'ol', 'p', 'pre', 's', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'td', 'th', 'tr', 'u', 'ul', 'video',
  'tg-button', 'tg-button-row', 'tg-collage', 'tg-document', 'tg-emoji', 'tg-map', 'tg-math', 'tg-math-block', 'tg-reference', 'tg-slideshow', 'tg-spoiler', 'tg-thinking', 'tg-time'])
const rendersInTelegram = (name: string) => TELEGRAM_TAGS.has(name.toLowerCase())
/** `==` or `||` between two letters or digits, as code writes them (`a==b`, `x||y`). A highlight or spoiler opens after a space. */
const CODE_LIKE = /(?<=[A-Za-z0-9])(?:={2,}|\|{2,})(?=[A-Za-z0-9])/g
/**
 * A formula: `$$...$$`, or `$...$` that opens on neither a digit nor a space and closes on neither
 * a space nor a word (so `$600 ... $108` and `$HOME ... $PATH` are not formulas).
 */
const FORMULA = /(?<!\\)\$\$[\s\S]+?\$\$|(?<![\\$])\$(?![\d\s$])[^$\n]*?(?<!\s)\$(?!\w)/g
/** What nests and slows the parse: brackets, emphasis, and list markers. A paragraph with thousands takes it seconds. */
const NESTING = /[[*_~]|(?:^|\s)(?:[-+]|\d+[.)])(?=\s)/g
const MAX_NESTING = 1000
const FENCE_START = /^ {0,3}(`{3,}|~{3,})/

const parser = unified().use(remarkParse).use(remarkGfm)

/**
 * Where Telegram must get the text as written: code, and where a link points (an address, a
 * reference id, an autolink, a definition), as the app's own markdown parser reads them; then,
 * between those, formulas and the tags Telegram renders with their attributes. Also each table,
 * where `||` is an empty cell.
 */
function asWritten(md: string): { kept: Array<[number, number]>; tables: Array<[number, number]> } {
  const kept: Array<[number, number]> = []
  const tables: Array<[number, number]> = []
  const walk = (node: Nodes) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start !== undefined && end !== undefined) {
      if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'definition' || node.type === 'image' || node.type === 'imageReference') kept.push([start, end])
      if (node.type === 'table') tables.push([start, end])
      // A bracketed link keeps its label as text. A shortcut or collapsed reference's label
      // is also its id, and an autolink is all address, so those stay whole.
      if (node.type === 'link' || node.type === 'linkReference') {
        const label = node.children.at(-1)?.position?.end.offset
        const whole = md[start] !== '[' || (node.type === 'linkReference' && node.referenceType !== 'full')
        kept.push([whole ? start : label ?? start, end])
      }
    }
    if ('children' in node) node.children.forEach(walk)
  }
  walk(parser.parse(md))
  kept.sort(([a], [b]) => a - b)
  const between: Array<[number, number]> = []
  let at = 0
  for (const [start, end] of [...kept, [md.length, md.length] as [number, number]]) {
    for (const m of md.slice(at, Math.max(start, at)).matchAll(FORMULA)) between.push([at + m.index, at + m.index + m[0].length])
    for (const m of md.slice(at, Math.max(start, at)).matchAll(TAG)) {
      if (rendersInTelegram(m[3])) between.push([at + m.index, at + m.index + m[0].length])
    }
    at = Math.max(at, end)
  }
  return { kept: [...kept, ...between].sort(([a], [b]) => a - b), tables }
}

const tag = (all: string, backslashes: string, rest: string, name: string) => (rendersInTelegram(name) ? all : `${backslashes}&lt;${rest}`)
const escapeEach = (run: string) => run.replace(/./g, '\\$&')

/**
 * Keep the text Telegram would otherwise break: prices it reads as a formula (`$600 is $108`),
 * a tag it does not know and drops (`<your-token>`), and code-like `a==b` or `x||y` it reads as
 * a highlight or spoiler. Formulas, highlights, spoilers and tags it renders are left to render.
 * Code and link addresses are left as written.
 */
export function keepLiteral(md: string): string {
  if (!/\$\d|<|==|\|\|/.test(md)) return md
  // A paragraph flooded with nesting symbols would stall the parse, so such a reply goes as written.
  // Code blocks are not counted: their symbols nest nothing.
  const { settled, tail } = splitStreamingMarkdown(md)
  if ([...settled, tail].some((block) => !FENCE_START.test(block) && (block.match(NESTING)?.length ?? 0) > MAX_NESTING)) return md
  let found: ReturnType<typeof asWritten>
  try {
    found = asWritten(md)
  } catch {
    // The parser's recursion has a depth limit (thousands of nested quotes or lists); such a reply goes as written.
    return md
  }
  const inTable = (at: number) => found.tables.some(([start, end]) => at >= start && at < end)
  // Code-like runs first, while offsets still match the source.
  const prose = (text: string, offset: number) => text
    .replace(CODE_LIKE, (run, at: number) => (run[0] === '|' && inTable(offset + at) ? run : escapeEach(run)))
    .replace(PRICE, '$1\\$').replace(TAG, tag)
  let out = ''
  let at = 0
  for (const [start, end] of found.kept) {
    if (end <= at) continue
    const from = Math.max(start, at)
    out += prose(md.slice(at, from), at) + md.slice(from, end)
    at = end
  }
  return out + prose(md.slice(at), at)
}

/**
 * Escape the inline-formatting metacharacters so an interpolated value renders
 * literally instead of as bold/italic/strikethrough/code/link markup. Use when
 * splicing untrusted text into a markdown literal in normal (non-code-span)
 * context. Block-level chars like `.`/`#`/`-` are left alone — they only carry
 * meaning at line start, and escaping them risks stray backslashes.
 */
export function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_~[\]])/g, '\\$1')
}

/**
 * Wrap a value in a markdown code span using a backtick fence longer than any
 * run of backticks inside it, so the value can't break out of the span. Backslash
 * escaping does not work inside code spans, so a longer fence is the only robust
 * option. A pad space lets the span hold values that start or end with a backtick.
 */
export function codeSpan(value: string): string {
  const longestRun = (value.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(longestRun + 1)
  const pad = /^`|`$/.test(value) ? ' ' : ''
  return `${fence}${pad}${value}${pad}${fence}`
}

/** Split an over-long body on block/paragraph boundaries, so each chunk stays under the rich ceiling once kept literal. */
export function splitForRichLimits(md: string): string[] {
  const split = (text: string, limit: number): string[] => splitChatMessage(text, limit).flatMap((chunk) => {
    // Escaping at most quadruples a character, so a chunk under a quarter of the ceiling needs no check.
    const sent = chunk.length * 4 <= RICH_MAX_LENGTH ? chunk.length : keepLiteral(chunk).length
    return sent > RICH_MAX_LENGTH ? split(chunk, Math.max(1, Math.floor(limit * chunk.length / sent))) : [chunk]
  })
  return split(md, RICH_MAX_LENGTH)
}

/** Telegram's plain (parse_mode) message text limit — the legacy HTML sink. */
export const HTML_MAX_LENGTH = 4096

/** Split for the legacy HTML sink, which the rich path falls back to on error. */
export function splitForHtmlLimits(md: string): string[] {
  return splitChatMessage(md, HTML_MAX_LENGTH)
}
