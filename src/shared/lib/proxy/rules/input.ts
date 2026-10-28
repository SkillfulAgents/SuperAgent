/**
 * The value a proxy rule receives as its first argument. It is built the same
 * way for every provider — no vendor-specific parsing ever happens here; rules
 * decode vendor formats themselves with the format helpers.
 */

/** Bodies above this size reach the rule as null with bodyTruncated: true. */
export const MAX_RULE_BODY_BYTES = 5 * 1024 * 1024

const DROPPED_HEADERS = new Set([
  'authorization',
  'authentication',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'apikey',
  'x-goog-api-key',
  'x-amz-security-token',
  'private-token',
  'host',
  'connection',
  'content-length',
])

// Anything that looks like it carries a credential is dropped too: rules
// never need one, and the agent's request is not the place to learn it.
const CREDENTIAL_HEADER = /(auth|token|secret|password|passwd|api[-_]?key|session|cookie|credential|signature)/i

function isDroppedHeader(name: string): boolean {
  return DROPPED_HEADERS.has(name) || CREDENTIAL_HEADER.test(name)
}

export interface RuleNow {
  iso: string
  epochMs: number
}

export interface ApiRuleInput {
  kind: 'api'
  method: string
  /** The path forwarded upstream, e.g. "/gmail/v1/users/me/messages/send". */
  path: string
  host: string
  /** Query parameters; repeated keys become arrays. */
  query: Record<string, string | string[]>
  /** Lowercased request headers, minus credentials and hop-by-hop headers. */
  headers: Record<string, string>
  contentType: string | null
  /** Parsed JSON, or an object for application/x-www-form-urlencoded; else null. */
  body: unknown
  /** The body as UTF-8 text when it is textual; else null. */
  bodyText: string | null
  bodyTruncated: boolean
  now: RuleNow
}

export interface McpRuleInput {
  kind: 'mcp'
  tool: string
  /** The tools/call `arguments` object as sent; null when over the size cap. */
  args: unknown
  /** True when the arguments were over 5 MB (args is then null). */
  argsTruncated: boolean
  now: RuleNow
}

export type RuleInput = ApiRuleInput | McpRuleInput

function nowValue(date: Date): RuleNow {
  return { iso: date.toISOString(), epochMs: date.getTime() }
}

function isTextual(contentType: string | null): boolean {
  if (!contentType) return true
  const ct = contentType.toLowerCase()
  return (
    ct.startsWith('text/') ||
    ct.startsWith('message/') ||
    ct.startsWith('multipart/') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('x-www-form-urlencoded') ||
    ct.includes('graphql')
  )
}

function parseQuery(search: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of new URLSearchParams(search)) {
    const existing = out[key]
    if (existing === undefined) out[key] = value
    else out[key] = Array.isArray(existing) ? [...existing, value] : [existing, value]
  }
  return out
}

export function buildApiRuleInput(options: {
  method: string
  host: string
  path: string
  search: string
  headers: Headers
  body: ArrayBuffer | null
  now?: Date
}): ApiRuleInput {
  const headers: Record<string, string> = {}
  options.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (!isDroppedHeader(lower)) headers[lower] = value
  })
  const contentType = headers['content-type'] ?? null

  let body: unknown = null
  let bodyText: string | null = null
  let bodyTruncated = false
  const bytes = options.body
  if (bytes && bytes.byteLength > MAX_RULE_BODY_BYTES) {
    bodyTruncated = true
  } else if (bytes && bytes.byteLength > 0 && isTextual(contentType)) {
    try {
      bodyText = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      bodyText = null
    }
    if (bodyText !== null) {
      const ct = (contentType ?? '').toLowerCase()
      if (ct.includes('json') || (!contentType && /^\s*[[{]/.test(bodyText))) {
        try {
          body = JSON.parse(bodyText)
        } catch {
          body = null
        }
      } else if (ct.includes('x-www-form-urlencoded')) {
        body = parseQuery(bodyText)
      }
    }
  }

  return {
    kind: 'api',
    method: options.method.toUpperCase(),
    host: options.host,
    path: options.path.startsWith('/') ? options.path : `/${options.path}`,
    query: parseQuery(options.search),
    headers,
    contentType,
    body,
    bodyText,
    bodyTruncated,
    now: nowValue(options.now ?? new Date()),
  }
}

export function buildMcpRuleInput(options: { tool: string; args: unknown; now?: Date }): McpRuleInput {
  let args = options.args ?? null
  let argsTruncated = false
  try {
    if ((JSON.stringify(args) ?? '').length > MAX_RULE_BODY_BYTES) {
      args = null
      argsTruncated = true
    }
  } catch {
    args = null
    argsTruncated = true
  }
  return {
    kind: 'mcp',
    tool: options.tool,
    args,
    argsTruncated,
    now: nowValue(options.now ?? new Date()),
  }
}

/** Documentation for authors (agent tool description + authoring prompt). */
export const RULE_INPUT_DOC = `API rules receive req = {
  kind: 'api', method: 'POST', host: 'gmail.googleapis.com',
  path: '/gmail/v1/users/me/messages/send',        // path forwarded upstream, no query
  query: { uploadType: 'media' },                   // repeated keys become arrays
  headers: { 'content-type': 'application/json' },  // lowercased; credentials removed
  contentType: 'application/json' | null,
  body: <parsed JSON | form object | null>,         // null when not JSON/form or unparseable
  bodyText: <UTF-8 text | null>,                    // null for binary bodies
  bodyTruncated: false,                             // true when over 5 MB (body/bodyText are null)
  now: { iso, epochMs },
}
MCP rules receive req = { kind: 'mcp', tool: 'requestSendMoney', args: { ...tools/call arguments } | null, argsTruncated: false /* true (args null) over 5 MB */, now: { iso, epochMs } }`
