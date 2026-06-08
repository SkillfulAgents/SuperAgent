import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// SUP-235 — MCP OAuth discovery follows unvalidated metadata URLs (SSRF).
//
// The remote-MCP SSRF guard (validateMcpServerUrl in remote-mcps.ts) is only
// applied to the *initial* server URL. discoverOAuthMetadata then fetches
// server-controlled URLs with no private/loopback host check:
//   - resource_metadata from the WWW-Authenticate header
//   - authorization_servers[0] from the protected-resource metadata
//   - the generated .well-known/* URLs derived from the auth server
//
// A public MCP endpoint can therefore make Superagent fetch arbitrary
// internal/loopback URLs server-side. These tests assert discovery rejects
// private/loopback metadata URLs (never fetching them) while still discovering
// fully-public metadata.
// ---------------------------------------------------------------------------

// Mock DB so importing oauth.ts does not pull in a real connection. The
// discovery path under test issues no DB queries, so the chain stubs below are
// intentionally minimal.
const mockSet = vi.fn()
const mockDbFrom = vi.fn()
const mockInsertValues = vi.fn()

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({ from: mockDbFrom }),
    insert: () => ({ values: mockInsertValues }),
    update: () => ({ set: mockSet }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  remoteMcpServers: { id: 'id', oauthClientId: 'oauth_client_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Must import after mocks
import { discoverOAuthMetadata } from './oauth'

/** Did any fetch call target a URL whose string contains `needle`? */
function fetchedAny(needle: string): boolean {
  return mockFetch.mock.calls.some((call) => String(call[0]).includes(needle))
}

const PUBLIC_MCP_URL = 'https://mcp.example.com/mcp'

describe('SUP-235: discoverOAuthMetadata SSRF guard', () => {
  let originalE2EMock: string | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    // Any fetch we did not explicitly script returns a benign 404 so a leaked
    // call cannot crash on `undefined.ok` (and stays visible in mock.calls).
    mockFetch.mockResolvedValue(new Response(null, { status: 404 }))
    // Ensure the localhost exception is OFF for the negative cases. 127.0.0.1
    // is classed as localhost, so under E2E_MOCK it would be (intentionally)
    // allowed — we want the default, non-mock policy here.
    originalE2EMock = process.env.E2E_MOCK
    delete process.env.E2E_MOCK
  })

  afterEach(() => {
    if (originalE2EMock === undefined) delete process.env.E2E_MOCK
    else process.env.E2E_MOCK = originalE2EMock
  })

  // Case 1: loopback resource_metadata from the WWW-Authenticate header.
  it('rejects a loopback resource_metadata URL and never fetches it', async () => {
    // Probe (to the public MCP URL) returns 401 pointing resource_metadata at
    // a loopback address.
    mockFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 401,
        headers: {
          'WWW-Authenticate':
            'Bearer resource_metadata="http://127.0.0.1:8765/.well-known/oauth-protected-resource"',
        },
      })
    )

    const result = await discoverOAuthMetadata(PUBLIC_MCP_URL)

    expect(result).toBeNull()
    // The loopback metadata URL must never have been fetched.
    expect(fetchedAny('127.0.0.1')).toBe(false)
    // Only the initial probe (to the public host) should have been issued.
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][0]).toBe(PUBLIC_MCP_URL)
  })

  // Case 2: public resource_metadata that points authorization_servers at a
  // link-local metadata endpoint (cloud instance metadata service).
  it('rejects a link-local authorization_servers URL and never fetches its well-known URLs', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 401,
        headers: {
          'WWW-Authenticate':
            'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
        },
      })
    )
    // Public resource metadata, but it advertises a link-local auth server.
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          resource: 'https://mcp.example.com',
          authorization_servers: ['http://169.254.169.254/'],
        }),
        { status: 200 }
      )
    )

    const result = await discoverOAuthMetadata(PUBLIC_MCP_URL)

    expect(result).toBeNull()
    expect(fetchedAny('169.254.169.254')).toBe(false)
  })

  // Case 3 (regression/positive): a fully-public discovery chain still works.
  it('discovers metadata for a fully-public resource + auth server', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 401,
        headers: {
          'WWW-Authenticate':
            'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
        },
      })
    )
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          resource: 'https://mcp.example.com',
          authorization_servers: ['https://auth.example.com'],
        }),
        { status: 200 }
      )
    )
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
        }),
        { status: 200 }
      )
    )

    const result = await discoverOAuthMetadata(PUBLIC_MCP_URL)

    expect(result).not.toBeNull()
    expect(result!.metadata.authorization_endpoint).toBe(
      'https://auth.example.com/authorize'
    )
    expect(result!.metadata.token_endpoint).toBe('https://auth.example.com/token')
    expect(result!.resource).toBe('https://mcp.example.com')
  })

  // Case 4: the Electron/E2E_MOCK localhost exception must still allow a
  // localhost auth server — mirroring validateMcpServerUrl's intended behavior
  // for users running MCP servers locally.
  it('allows a localhost auth server only under the E2E_MOCK / Electron exception', async () => {
    function scriptLocalhostDiscovery() {
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        })
      )
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resource: 'https://mcp.example.com',
            authorization_servers: ['http://localhost:8899'],
          }),
          { status: 200 }
        )
      )
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'http://localhost:8899/authorize',
            token_endpoint: 'http://localhost:8899/token',
          }),
          { status: 200 }
        )
      )
    }

    // Without the exception flag: localhost is blocked, discovery fails closed.
    scriptLocalhostDiscovery()
    const blocked = await discoverOAuthMetadata(PUBLIC_MCP_URL)
    expect(blocked).toBeNull()
    expect(fetchedAny('localhost:8899')).toBe(false)

    // With E2E_MOCK set: the localhost auth server is allowed.
    // mockReset (not clearAllMocks) flushes the leftover mockResolvedValueOnce
    // the blocked phase never consumed, so the second sequence starts clean.
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(new Response(null, { status: 404 }))
    process.env.E2E_MOCK = 'true'
    scriptLocalhostDiscovery()
    const allowed = await discoverOAuthMetadata(PUBLIC_MCP_URL)
    expect(allowed).not.toBeNull()
    expect(allowed!.metadata.token_endpoint).toBe('http://localhost:8899/token')
  })
})
