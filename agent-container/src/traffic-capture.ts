/**
 * Traffic capture — record a site's network traffic as a HAR the agent can
 * mine for the site's own JSON endpoints, so a recurring task can call those
 * directly instead of driving Chrome on every run.
 *
 * agent-browser 0.32.3+ records HAR files with text response bodies
 * (`network har start --content text` … `network har stop <path>`). A raw HAR
 * carries the user's session: cookies, Authorization headers, tokens in URLs
 * and request bodies, JWTs in responses. Nothing of that reaches the
 * workspace or the model: the server reads the CLI's file, redacts it here,
 * writes the redacted copy to the workspace and deletes the original.
 *
 * Redaction keeps names and drops values — a script needs to know that an
 * `x-csrf-token` header or a `session` cookie exists, never its value (it
 * gets live values from the browser session at run time).
 */
import { z } from 'zod'

export const REDACTED = '[REDACTED]'

/** Header, cookie, parameter and JSON key names whose values are secrets. */
const SENSITIVE_NAME = /(token|secret|passw|pwd|api[-_]?key|apikey|signature|session|credential|cookie|csrf|xsrf|bearer)/i
// Whole words only: "author", "footprint" and "authority" are not secrets.
const SENSITIVE_WORD = /(^|[^a-z])(auth|authorization|authentication|oauth|otp)([^a-z]|$)/i
const SENSITIVE_EXACT = /^(key|sig|code|sid|ticket|jwt|ssn|cvv|cvc|pin)$/i
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g

export function isSensitiveName(name: string): boolean {
  const n = name.trim()
  return SENSITIVE_NAME.test(n) || SENSITIVE_WORD.test(n) || SENSITIVE_EXACT.test(n)
}

/** A value shaped like a token: long, one run of token characters, or a JWT. */
const TOKEN_SHAPED = /^[A-Za-z0-9._~+/=-]{16,}$/

/**
 * Redact this name's value? CORS headers never (they describe the endpoint,
 * not a secret: access-control-allow-credentials says it takes cookies).
 * The short ambiguous names (code, key, pin, sid…) only when the value looks
 * like a token — a branch code "A5" is data (bench, SFPL).
 */
export function shouldRedact(name: string, value: unknown): boolean {
  const n = name.trim()
  if (/^access-control-/i.test(n)) return false
  if (SENSITIVE_NAME.test(n) || SENSITIVE_WORD.test(n)) return true
  if (SENSITIVE_EXACT.test(n)) {
    const v = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
    return TOKEN_SHAPED.test(v) || /^eyJ/.test(v)
  }
  return false
}

/** Per-body cap in the redacted file; the CLI's own cap is 2 MB. */
export const BODY_TEXT_CAP = 256 * 1024
/** Whole-file cap for the redacted HAR. */
export const HAR_FILE_CAP = 25 * 1024 * 1024

// --- HAR schema (only what is read or rewritten; everything else passes through) ---

const nameValueSchema = z.object({ name: z.string(), value: z.string() }).passthrough()
const entrySchema = z.object({
  request: z.object({
    method: z.string(),
    url: z.string(),
    headers: z.array(nameValueSchema).default([]),
    cookies: z.array(nameValueSchema).default([]),
    queryString: z.array(nameValueSchema).default([]),
    postData: z.object({ mimeType: z.string().optional(), text: z.string().optional() }).passthrough().optional(),
  }).passthrough(),
  response: z.object({
    status: z.number(),
    headers: z.array(nameValueSchema).default([]),
    cookies: z.array(nameValueSchema).default([]),
    content: z.object({
      size: z.number().optional(),
      mimeType: z.string().optional(),
      text: z.string().optional(),
      encoding: z.string().optional(),
    }).passthrough(),
    redirectURL: z.string().optional(),
  }).passthrough(),
}).passthrough()
export const harSchema = z.object({
  log: z.object({ entries: z.array(entrySchema) }).passthrough(),
}).passthrough()

export type Har = z.infer<typeof harSchema>
export type HarEntry = Har['log']['entries'][number]

// --- Redaction -----------------------------------------------------------------

function redactNameValues<T extends { name: string; value: string }>(items: T[], all = false): T[] {
  return items.map(i => {
    if ((all || shouldRedact(i.name, i.value)) && i.value) return { ...i, value: REDACTED }
    // A header whose value is a URL (Referer, Location — relative ones too)
    // carries that URL's query string: the tokens request.url had redacted.
    return URL_HEADER.test(i.name.trim()) || /^https?:\/\//i.test(i.value.trim()) ? { ...i, value: redactUrl(i.value) } : i
  })
}

/** Headers whose value is a URL, absolute or relative. */
const URL_HEADER = /^(location|content-location|referer|refresh)$/i

/** In URLs the placeholder is unbracketed so it survives percent-encoding readably. */
const URL_REDACTED = 'REDACTED'

/**
 * A URL with the values of sensitive query parameters (and any userinfo)
 * replaced. A relative one (`/callback?access_token=…`, `//host/…`,
 * `?token=…`) keeps its form: its query is redacted in place.
 */
export function redactUrl(raw: string): string {
  let u: URL
  try { u = new URL(raw) } catch { return redactRelativeUrl(raw) }
  let touched = false
  if (u.username || u.password) { u.username = ''; u.password = ''; touched = true }
  for (const [k, v] of [...u.searchParams]) {
    if (shouldRedact(k, v)) { u.searchParams.set(k, URL_REDACTED); touched = true }
  }
  return (touched ? u.toString() : raw).replace(JWT, URL_REDACTED)
}

function redactRelativeUrl(raw: string): string {
  // A Refresh header's value is "5; url=/next?…": the URL is after "url=".
  const lead = /^(\s*\d+\s*;\s*url=)/i.exec(raw)?.[1] ?? ''
  let rest = raw.slice(lead.length).replace(/^(\/\/)[^/@?#]*@/, '$1')
  const q = rest.indexOf('?')
  if (q >= 0) {
    const hash = rest.indexOf('#', q)
    const query = hash >= 0 ? rest.slice(q + 1, hash) : rest.slice(q + 1)
    const params = new URLSearchParams(query)
    let touched = false
    for (const [k, v] of [...params]) {
      if (shouldRedact(k, v)) { params.set(k, URL_REDACTED); touched = true }
    }
    if (touched) rest = `${rest.slice(0, q)}?${params.toString()}${hash >= 0 ? rest.slice(hash) : ''}`
  }
  return `${lead}${rest}`.replace(JWT, URL_REDACTED)
}

/**
 * JSON with numbers kept as the page wrote them. JSON.parse rounds an integer
 * past 2^53 (12345678901234567890 → 12345678901234567000), and a body file is
 * what a script copies ids from; while parsed, such a number stands in as a
 * marked string carrying its source text (Node 21+ hands revivers the source).
 */
const NUM_MARK = '\u2063num:'
type SourceReviver = (key: string, value: unknown, context?: { source?: string }) => unknown
export function parseJsonLossless(text: string): unknown {
  const reviver: SourceReviver = (_key, value, context) =>
    typeof value === 'number' && context?.source !== undefined && String(value) !== context.source ? `${NUM_MARK}${context.source}` : value
  return (JSON.parse as (text: string, reviver: SourceReviver) => unknown)(text, reviver)
}
export function stringifyJsonLossless(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(/"\u2063num:([-+0-9.eE]+)"/g, '$1')
}
/** The source text of a marked number, else the value. */
const unmark = (v: unknown): unknown => (typeof v === 'string' && v.startsWith(NUM_MARK) ? v.slice(NUM_MARK.length) : v)

/**
 * JSON values under sensitive keys replaced, recursively; strings scanned for
 * JWTs. `changed.n` counts replacements, so an untouched body can be kept as
 * the page sent it (re-serializing loses big-integer ids and inflates sizes).
 */
export function redactJsonValue(v: unknown, changed: { n: number } = { n: 0 }): unknown {
  if (typeof v === 'string') {
    const r = v.replace(JWT, REDACTED)
    if (r !== v) changed.n++
    return r
  }
  if (Array.isArray(v)) return v.map(x => redactJsonValue(x, changed))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      if (val !== null && typeof val !== 'object' && shouldRedact(k, unmark(val))) { out[k] = REDACTED; changed.n++ } else out[k] = redactJsonValue(val, changed)
    }
    return out
  }
  return v
}

/** A request or response body: JSON and form bodies field by field, other text for JWTs only. Unchanged text is returned as sent. */
export function redactBody(text: string, mimeType = ''): string {
  const trimmed = text.trim()
  if (/json/i.test(mimeType) || /^[[{]/.test(trimmed)) {
    try {
      const changed = { n: 0 }
      const redacted = redactJsonValue(parseJsonLossless(trimmed), changed)
      return changed.n > 0 ? stringifyJsonLossless(redacted) : text
    } catch { /* not JSON after all */ }
  }
  if (/x-www-form-urlencoded/i.test(mimeType)) {
    const p = new URLSearchParams(trimmed)
    let n = 0
    for (const [k, v] of [...p]) if (shouldRedact(k, v)) { p.set(k, REDACTED); n++ }
    return n > 0 ? p.toString() : text
  }
  if (/multipart\/form-data/i.test(mimeType) || /^--\S+\r?\n/.test(text)) return redactMultipart(text, mimeType)
  return text.replace(JWT, REDACTED)
}

/**
 * A multipart/form-data body with each field's value checked by its name
 * (csrf_token, password, access_token…) and scanned for JWTs. A body whose
 * parts cannot be found is not kept: it may hold anything.
 */
function redactMultipart(text: string, mimeType: string): string {
  const boundary = /boundary="?([^";]+)"?/i.exec(mimeType)?.[1] ?? /^--(\S+)\r?\n/.exec(text)?.[1]
  if (!boundary || !text.includes(`--${boundary}`)) return '[multipart body left out: its parts could not be read for redaction]'
  const parts = text.split(`--${boundary}`)
  return parts.map(part => {
    const split = /\r?\n\r?\n/.exec(part)
    if (!split) return part
    const head = part.slice(0, split.index)
    const value = part.slice(split.index + split[0].length)
    // Quoted or bare (RFC 2183 allows a token): name="csrf_token" or name=csrf_token.
    const m = /(?:^|[;\s])name\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(head)
    const name = m ? (m[1] ?? m[2]) : undefined
    const file = /(?:^|[;\s])filename\*?\s*=/i.test(head)
    // A field whose name cannot be read is not kept: it may be the secret.
    if (!file && (name === undefined || shouldRedact(name, value.replace(/\r?\n$/, '')))) {
      return `${head}${split[0]}${REDACTED}${/\r?\n$/.exec(value)?.[0] ?? ''}`
    }
    return `${head}${split[0]}${value.replace(JWT, REDACTED)}`
  }).join(`--${boundary}`)
}

function capText(text: string): string {
  return text.length > BODY_TEXT_CAP ? `${text.slice(0, BODY_TEXT_CAP)}\n[truncated at ${BODY_TEXT_CAP} of ${text.length} chars]` : text
}

export function redactEntry(e: HarEntry): HarEntry {
  const req = e.request
  const res = e.response
  const content = { ...res.content }
  if (content.encoding === 'base64') {
    // Binary bodies are not useful for finding endpoints and can hold anything.
    delete content.text
    delete content.encoding
  } else if (typeof content.text === 'string') {
    content.text = capText(redactBody(content.text, content.mimeType))
    // The CLI reports the encoded size, 0 for some responses; the body is here.
    if (!(typeof content.size === 'number' && content.size > 0)) content.size = content.text.length
  }
  return {
    ...e,
    request: {
      ...req,
      url: redactUrl(req.url),
      headers: redactNameValues(req.headers),
      cookies: redactNameValues(req.cookies, true),
      queryString: redactNameValues(req.queryString),
      ...(req.postData && {
        postData: {
          ...req.postData,
          ...(typeof req.postData.text === 'string' && { text: capText(redactBody(req.postData.text, req.postData.mimeType)) }),
        },
      }),
    },
    response: {
      ...res,
      headers: redactNameValues(res.headers),
      cookies: redactNameValues(res.cookies, true),
      content,
      ...(typeof res.redirectURL === 'string' && { redirectURL: redactUrl(res.redirectURL) }),
    },
  }
}

/** Redact every entry; drop response bodies (largest first) until the file fits the cap. */
export function redactHar(har: Har): Har {
  const entries = har.log.entries.map(redactEntry)
  const size = (): number => entries.reduce((n, e) => n + (e.response.content.text?.length ?? 0) + (e.request.postData?.text?.length ?? 0) + 2048, 0)
  if (size() > HAR_FILE_CAP) {
    const order = entries
      .map((e, i) => ({ i, n: e.response.content.text?.length ?? 0, api: isApiLike(e) }))
      .sort((a, b) => Number(a.api) - Number(b.api) || b.n - a.n)
    for (const { i } of order) {
      if (size() <= HAR_FILE_CAP) break
      const c = { ...entries[i].response.content }
      if (c.text === undefined) continue
      delete c.text
      entries[i] = { ...entries[i], response: { ...entries[i].response, content: c } }
    }
  }
  return { ...har, log: { ...har.log, entries } }
}

// --- Summary -------------------------------------------------------------------

const STATIC_PATH = /\.(js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wasm|map)(\?|$)/i
export const TELEMETRY = /(google-analytics|googletagmanager|doubleclick|segment\.(io|com)|sentry|datadog|hotjar|intercom|newrelic|optimizely|facebook\.com\/tr|clarity\.ms|amplitude|mixpanel|bugsnag|awswaf|px-cloud|px-cdn|perimeterx)|\/(collect|track|beacon|log|events?|telemetry|metrics|pixel)(\/|\?|$)/i

/**
 * A response that looks like data for the page rather than the page or an
 * asset: a data type, or any non-page, non-asset type fetched by the page's
 * own script (agent-browser records Chrome's resource type as `_resourceType`).
 */
export function isApiLike(e: HarEntry): boolean {
  const mime = e.response.content.mimeType ?? ''
  // Inline data (data:, blob:) and images are never an endpoint — `+xml` would
  // otherwise take every image/svg+xml data URI (bench, USPTO: 19 KB of them).
  if (!/^https?:/i.test(e.request.url) || /^image\//i.test(mime)) return false
  if (STATIC_PATH.test(e.request.url) || TELEMETRY.test(e.request.url)) return false
  if (/json|graphql|\+xml|text\/xml|text\/csv/i.test(mime)) return true
  const kind = typeof e._resourceType === 'string' ? e._resourceType : ''
  return /^(xhr|fetch)$/i.test(kind) && !/html|javascript|css|image|font|video|audio|octet-stream/i.test(mime)
}

function registrableHost(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.')
  return parts.slice(-2).join('.')
}

export interface EndpointSummary {
  method: string
  /** One example URL (redacted). */
  url: string
  status: number
  mimeType: string
  bytes: number
  count: number
  firstParty: boolean
}

/**
 * The likely API calls, grouped by method + origin + path (query strings
 * vary per call), first-party first, then by how often they were called.
 */
export function summarizeEndpoints(har: Har, pageUrl: string, max = 30): { endpoints: EndpointSummary[]; more: number } {
  let pageHost = ''
  try { pageHost = registrableHost(new URL(pageUrl).host) } catch { /* no page */ }
  const groups = new Map<string, EndpointSummary>()
  for (const e of har.log.entries) {
    if (!isApiLike(e)) continue
    let key = `${e.request.method} ${e.request.url}`
    let firstParty = false
    try {
      const u = new URL(e.request.url)
      key = `${e.request.method} ${u.origin}${u.pathname}`
      firstParty = pageHost !== '' && registrableHost(u.host) === pageHost
    } catch { /* keep the raw key */ }
    const bytes = e.response.content.text?.length ?? e.response.content.size ?? 0
    const g = groups.get(key)
    // The group's example is its largest response: a repeat can come back
    // short (cached, revalidated — SFPL: 4.3 KB listed for a 50 KB answer).
    if (g) {
      g.count++
      if (bytes > g.bytes) Object.assign(g, { url: e.request.url, status: e.response.status, bytes })
      continue
    }
    groups.set(key, {
      method: e.request.method,
      url: e.request.url,
      status: e.response.status,
      mimeType: (e.response.content.mimeType ?? '').split(';')[0],
      bytes,
      count: 1,
      firstParty,
    })
  }
  const all = [...groups.values()].sort((a, b) => Number(b.firstParty) - Number(a.firstParty) || b.count - a.count)
  return { endpoints: all.slice(0, max), more: Math.max(0, all.length - max) }
}

function kb(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`
}

export function formatCaptureSummary(opts: {
  path: string
  requestCount: number
  endpoints: EndpointSummary[]
  more: number
  durationMs: number
  /** Endpoint (method + url) → file its first response body was written to. */
  bodies?: Map<string, string>
  /** Names of the cookies the browser holds for the page's site, when read. */
  cookieNames?: string[]
}): string {
  const lines = [`Saved ${opts.requestCount} request${opts.requestCount === 1 ? '' : 's'} recorded over ${Math.round(opts.durationMs / 1000)}s to ${opts.path}.`]
  if (opts.endpoints.length === 0) {
    lines.push('No JSON/XML/CSV responses in the recording (pages, scripts, images and telemetry are not listed).')
  } else {
    lines.push('Responses that look like data (JSON/XML/CSV, first-party first; pages, assets and telemetry left out):')
    for (const e of opts.endpoints) {
      const url = e.url.length > 200 ? `${e.url.slice(0, 199)}…` : e.url
      const body = opts.bodies?.get(`${e.method} ${e.url}`)
      lines.push(`- ${e.method} ${e.status} ${url} · ${e.mimeType || 'unknown type'} · ${kb(e.bytes)}${e.count > 1 ? ` · ×${e.count}` : ''}${e.firstParty ? '' : ' · third-party'}${body ? ` · body: ${body}` : ''}`)
    }
    if (opts.more > 0) lines.push(`… ${opts.more} more in the file`)
    if (opts.bodies && opts.bodies.size > 0) {
      lines.push('Beside each body file, <name>.request.json holds that request: method, URL, headers and body, as recorded.')
    }
  }
  // What the file does not hold matters as much: agent-browser builds the HAR
  // from Chrome's request/response events, which carry no Cookie headers and
  // none of the headers the network stack adds (bench, SFPL: an agent read the
  // missing Cookie header as "no cookies sent").
  lines.push('Not in the recording: Cookie and Set-Cookie headers, and headers the browser adds on the wire (Origin, sec-*, Accept-Encoding). Values that look like secrets (auth/token/session headers and parameters, JWTs) are replaced with [REDACTED] (REDACTED inside URLs); names are kept.')
  if (opts.cookieNames) {
    lines.push(opts.cookieNames.length > 0
      ? `Cookies the browser holds for this site (names only): ${opts.cookieNames.slice(0, 40).join(', ')}${opts.cookieNames.length > 40 ? ', …' : ''}`
      : 'The browser holds no cookies for this site.')
  }
  return lines.join('\n')
}

// --- Capture state ---------------------------------------------------------------

export interface CaptureState {
  startedAt: number
  /** The page the capture started on — first-party is judged against it. */
  url: string
}

let capture: CaptureState | null = null

export function getCapture(): CaptureState | null {
  return capture
}

export function setCapture(state: CaptureState | null): void {
  capture = state
}

/** File name for one endpoint's body: `<n>-<host><path>.json|txt`, filesystem-safe. */
export function bodyFileName(n: number, url: string, mimeType: string): string {
  let slug = url
  try { const u = new URL(url); slug = `${u.host}${u.pathname}` } catch { /* keep the raw url */ }
  slug = slug.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'body'
  return `${String(n).padStart(2, '0')}-${slug}.${/json/i.test(mimeType) ? 'json' : 'txt'}`
}

/** The request file written beside a body file. */
export function requestFileName(bodyFile: string): string {
  return bodyFile.replace(/\.(json|txt)$/, '.request.json')
}

/** A body for reading: JSON pretty-printed (one 50 KB line defeats Read), anything else as is. */
export function readableBody(text: string): string {
  try { return stringifyJsonLossless(parseJsonLossless(text), 2) } catch { return text }
}

/** File name for a capture: the caller's label (sanitised) or a timestamp. */
export function captureFileName(label: string | undefined, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
  const clean = (label ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60)
  return `${clean || 'traffic'}-${stamp}.har`
}
