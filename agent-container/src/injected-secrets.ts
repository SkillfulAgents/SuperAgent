/**
 * Secrets the host injected into the browser (request_login passwords, codes
 * and other non-identifier fields), kept in memory for the browser's
 * lifetime so text the agent reads never shows them back. Snapshots mask
 * password fields, but `get value`, `eval`, a code field's snapshot line, a
 * URL a GET form put them in and captured request bodies carry the plaintext.
 *
 * Applied where text leaves for the agent (browser tool results, the
 * request_login result, the traffic capture it can read) — not on the CLI
 * output the server parses itself, where a redacted digit run would corrupt
 * timestamps, hashes and refs.
 *
 * This prevents leaks into the transcript, not a hostile agent: the agent's
 * shell runs as the same user and can reach the browser directly.
 */

export const REDACTED = '[redacted]'

/** Shorter values would redact ordinary page text (a four-digit code is the floor). */
const MIN_SECRET_LENGTH = 4

const secrets = new Set<string>()
/** Forms matched anywhere, longest first so no shorter one splits a longer match. */
let patterns: string[] = []
/**
 * Digit-only forms (codes), matched only where no digit adjoins them and not
 * as an element ref's number (`ref=e1234`, `@e1234`), which the agent needs.
 */
let digitRuns: RegExp[] = []
/** The digit-only forms themselves, for a code cut short at an output cap. */
let digitForms: string[] = []

const HTML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** `value` with only `chars` escaped as HTML entities, as each serializer does it. */
function escapeHtml(value: string, chars: string, apostrophe = '&#39;'): string {
  return value.replace(/[&<>"']/g, (c) => (chars.includes(c) ? (c === "'" ? apostrophe : HTML_ENTITIES[c]) : c))
}

/** JSON-escaped the way serializers that keep JSON safe inside HTML do it. */
function jsonHtmlSafe(json: string): string {
  return json.replace(/[<>&']/g, (c) => `\\u00${c.charCodeAt(0).toString(16)}`)
}

/** Base64 fragments shorter than this would match by chance inside unrelated base64 data. */
const MIN_BASE64_FRAGMENT = 6

/**
 * The value base64-encoded at each of the three alignments it can have inside
 * a longer encoded string (`user:password` in a Basic header, a JSON body a
 * page encoded): the run of characters that depend on the value's bytes alone.
 */
function base64Fragments(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8')
  const fragments: string[] = []
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64')
    const fragment = encoded.slice(Math.ceil((8 * offset) / 6), Math.floor((8 * (offset + bytes.length)) / 6))
    if (fragment.length < MIN_BASE64_FRAGMENT) continue
    fragments.push(fragment, fragment.replace(/\+/g, '-').replace(/\//g, '_'))
  }
  return fragments
}

/**
 * The forms a value travels in: as typed; URL-encoded the ways browsers and
 * libraries do it (encodeURIComponent leaves `!'()*` alone, a form body
 * encodes them and spaces as `+`, some encoders use lowercase hex);
 * JSON-escaped once and twice (a JSON body inside a JSON log), also with the
 * HTML-safe `&` escapes; HTML-escaped as Chromium serializes an
 * attribute (`&"<>`, or `&"` before Chrome 138) and a text node (`&<>`), and
 * as libraries escape everything; and base64 at any alignment.
 */
function encodedForms(value: string): string[] {
  const forms = new Set<string>([value])
  try {
    const uri = encodeURIComponent(value)
    const strict = uri.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    const form = new URLSearchParams({ v: value }).toString().slice(2)
    for (const encoded of [uri, strict, form, strict.replace(/%20/g, '+')]) {
      forms.add(encoded)
      forms.add(encoded.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()))
    }
  } catch {
    // A lone surrogate cannot be URI-encoded; the raw form still applies.
  }
  const json = JSON.stringify(value).slice(1, -1)
  forms.add(json)
  forms.add(JSON.stringify(json).slice(1, -1))
  forms.add(jsonHtmlSafe(json))
  for (const html of [
    escapeHtml(value, '&"<>'),
    escapeHtml(value, '&"'),
    escapeHtml(value, '&<>'),
    escapeHtml(value, '&<>"\''),
    escapeHtml(value, '&<>"\'', '&#x27;'),
    escapeHtml(value, '&<>"\'', '&apos;'),
  ]) {
    forms.add(html)
    // eval prints a string JSON-quoted: an attribute read back through it.
    forms.add(JSON.stringify(html).slice(1, -1))
  }
  const base64 = Buffer.from(value, 'utf8').toString('base64')
  forms.add(base64)
  forms.add(base64.replace(/=+$/, ''))
  forms.add(Buffer.from(value, 'utf8').toString('base64url'))
  for (const fragment of base64Fragments(value)) forms.add(fragment)
  return [...forms].filter((form) => form.length >= MIN_SECRET_LENGTH)
}

function rebuild(): void {
  const all = new Set<string>()
  for (const secret of secrets) {
    for (const form of encodedForms(secret)) all.add(form)
  }
  const sorted = [...all].sort((a, b) => b.length - a.length)
  patterns = sorted.filter((form) => !/^\d+$/.test(form))
  digitForms = sorted.filter((form) => /^\d+$/.test(form))
  digitRuns = digitForms.map((form) => new RegExp(`(?<!\\d)(?<!\\be)${form}(?!\\d)`, 'g'))
}

/** Remember a value the host injected, so text for the agent redacts it. */
export function rememberInjectedSecret(value: string): void {
  if (value.length < MIN_SECRET_LENGTH || secrets.has(value)) return
  secrets.add(value)
  rebuild()
}

/** Forget every injected value (the browser closed). */
export function forgetInjectedSecrets(): void {
  secrets.clear()
  patterns = []
  digitRuns = []
  digitForms = []
}

/** How every output cap starts its notice (`\n…[output truncated — …]`). */
const CUT_NOTICE = '\n…['

/**
 * A value an output cap cut short keeps its head right before the cap's
 * notice, where no whole form matches: redact a head of at least the
 * minimum length there.
 */
function redactCutHeads(text: string): string {
  let out = text
  let at = out.lastIndexOf(CUT_NOTICE)
  while (at >= MIN_SECRET_LENGTH) {
    for (const form of [...patterns, ...digitForms]) {
      let length = Math.min(form.length - 1, at)
      while (length >= MIN_SECRET_LENGTH && out.slice(at - length, at) !== form.slice(0, length)) length--
      if (length >= MIN_SECRET_LENGTH) {
        out = `${out.slice(0, at - length)}${REDACTED}${out.slice(at)}`
        at -= length - REDACTED.length
        break
      }
    }
    at = out.lastIndexOf(CUT_NOTICE, at - 1)
  }
  return out
}

/** Replace every injected value in text bound for the agent. */
export function redactInjectedSecrets(text: string): string {
  if ((patterns.length === 0 && digitRuns.length === 0) || !text) return text
  let out = text
  for (const pattern of patterns) {
    if (out.includes(pattern)) out = out.split(pattern).join(REDACTED)
  }
  for (const run of digitRuns) out = out.replace(run, REDACTED)
  return out.includes(CUT_NOTICE) ? redactCutHeads(out) : out
}

/**
 * The same, for every string inside a JSON-shaped value (a captured HAR).
 * String by string rather than over the serialized text, which a value
 * containing quotes could otherwise split mid-token.
 */
export function redactInjectedSecretsDeep<T>(value: T): T {
  if (patterns.length === 0 && digitRuns.length === 0) return value
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return redactInjectedSecrets(node)
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]))
    }
    return node
  }
  return walk(value) as T
}

type ToolContent = { type: string; text?: string; [key: string]: unknown }

/**
 * A tool result with every text block redacted; images and other blocks pass
 * unchanged. `keep`: strings that go through whole, though a value redacted
 * elsewhere may be part of them — an account's username the host names, which
 * the agent passes back exactly (jane@acme.com, after the user typed "acme"
 * into a workspace field).
 */
export function redactToolResult<T extends { content: ToolContent[] }>(result: T, keep: readonly string[] = []): T {
  if (patterns.length === 0 && digitRuns.length === 0) return result
  // Longest first, so one kept string inside another stays whole.
  const kept = [...new Set(keep.filter(Boolean))].sort((a, b) => b.length - a.length)
  const marker = (index: number) => `\u0000${index}\u0000`
  const redact = (text: string) => {
    const marked = kept.reduce((out, value, index) => out.split(value).join(marker(index)), text)
    return kept.reduce((out, value, index) => out.split(marker(index)).join(value), redactInjectedSecrets(marked))
  }
  return {
    ...result,
    content: result.content.map((block) =>
      block.type === 'text' && typeof block.text === 'string' ? { ...block, text: redact(block.text) } : block),
  }
}
