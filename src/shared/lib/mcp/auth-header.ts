// Header names the MCP transport or fetch owns; a server key can't replace them.
const RESERVED_HEADERS = new Set([
  'accept',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'host',
  'mcp-protocol-version',
  'mcp-session-id',
  'transfer-encoding',
])

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/

/**
 * Validates the header a server reads its key from. Empty means the default
 * `Authorization: Bearer <token>`. Returns the trimmed name, null for the
 * default, or an error message.
 */
export function parseAuthHeaderName(input: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: null }
  if (typeof input !== 'string') return { ok: false, error: 'Header name must be a string' }
  const name = input.trim()
  if (!name) return { ok: true, value: null }
  if (!HEADER_NAME.test(name)) return { ok: false, error: `"${name}" is not a valid header name` }
  if (RESERVED_HEADERS.has(name.toLowerCase())) return { ok: false, error: `The ${name} header can't carry the key` }
  return { ok: true, value: name }
}

/** The header that carries an MCP server's token. A named header gets the token as is. */
export function mcpAuthHeader(accessToken: string, authHeaderName?: string | null): [name: string, value: string] {
  return authHeaderName ? [authHeaderName, accessToken] : ['Authorization', `Bearer ${accessToken}`]
}
