/**
 * Verify that a remote MCP server is real and that WE actually support connecting
 * to it — exercising the same code paths the app uses when a user adds a server.
 *
 *   - oauth:  run our real `discoverOAuthMetadata` + `initiateNewServerOAuth`
 *             (401 probe -> protected-resource metadata -> AS metadata -> DCR ->
 *             build authorization URL), then HTTP-probe that authorization URL to
 *             confirm a live login page is reachable.
 *   - none:   run our real `discoverTools` handshake (initialize -> tools/list).
 *   - bearer: run `discoverTools` with a throwaway token; a 401 is the positive
 *             signal that it is a real MCP server that wants a token.
 *
 * Never throws out of a verdict — every failure is classified, so a hung or dead
 * server can't break a batch run.
 *
 * Usage:
 *   npx tsx scripts/verify-mcp-server.ts --url https://mcp.apollo.io/mcp --auth oauth --name Apollo.io
 *   npx tsx scripts/verify-mcp-server.ts --batch mcp-catalog-additions.json --out verify-results.json --concurrency 8 --filter add
 */
import { readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { discoverOAuthMetadata, initiateNewServerOAuth } from '../src/shared/lib/mcp/oauth'
import { discoverTools } from '../src/shared/lib/mcp/discover-tools'

const REDIRECT_URI = 'http://localhost:9999/mcp-oauth-callback' // placeholder; flow is never completed
const VERIFY_TOKEN = 'verify-probe-token-not-a-real-credential'
const NET_TIMEOUT_MS = 20_000

type NormAuth = 'oauth' | 'bearer' | 'none' | 'unknown'

export interface Verdict {
  name: string
  inputUrl: string
  url: string | null
  inputAuth: string
  authType: NormAuth
  /** Headline outcome. */
  status:
    | 'supported'              // connected + listed tools, or reached a live login page
    | 'supported-needs-auth'   // real MCP server that requires a token / manual client id (we support this)
    | 'reachable-login-flaky'  // OAuth discovery worked but the login URL didn't cleanly resolve
    | 'not-mcp'                // endpoint responded but does not speak MCP / no auth server
    | 'unsupported'            // we could not get it to work via our paths
    | 'skipped'                // no probeable https endpoint in the data
    | 'error'                  // network/DNS/TLS/timeout
  supported: boolean
  reclassifiedAs?: NormAuth
  evidence: Record<string, unknown>
  detail: string
  ms: number
}

function normalizeAuth(raw: string | undefined): NormAuth {
  const s = (raw || '').toLowerCase()
  if (s.includes('oauth')) return 'oauth'
  if (s.includes('bearer') || s.includes('token') || s.includes('api key') || s.includes('api-key') || s.includes('x-api-key') || s.includes('basic')) return 'bearer'
  if (s.includes('none') || s.includes('no auth') || s.includes('no-auth')) return 'none'
  return 'unknown'
}

/** A value is a probeable endpoint only if it's a clean single https URL with no spaces/placeholders. */
function probeableUrl(raw: string | undefined | null): string | null {
  if (!raw) return null
  const v = raw.trim()
  if (!/^https:\/\//i.test(v)) return null
  if (/\s/.test(v)) return null // "npx ...", "uvx ...", prose
  if (/[{}<>]/.test(v)) return null // "https://<host>/mcp", "{org}" templates
  try {
    new URL(v)
    return v
  } catch {
    return null
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms)),
  ])
}

function classifyError(e: unknown): { kind: string; message: string } {
  const msg = e instanceof Error ? e.message : String(e)
  const lower = msg.toLowerCase()
  if (lower.includes('timeout:')) return { kind: 'timeout', message: msg }
  if (lower.includes('enotfound') || lower.includes('getaddrinfo') || lower.includes('eai_again')) return { kind: 'dns', message: msg }
  if (lower.includes('certificate') || lower.includes('tls') || lower.includes('ssl') || lower.includes('self-signed')) return { kind: 'tls', message: msg }
  if (lower.includes('econnrefused') || lower.includes('econnreset') || lower.includes('socket')) return { kind: 'connection', message: msg }
  return { kind: 'other', message: msg }
}

function is401(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /\b401\b/.test(msg)
}

/** GET the authorization URL to confirm a live login page is actually reachable. */
async function probeLoginUrl(authorizationUrl: string): Promise<{ ok: boolean; httpStatus: number | null; locationHost?: string; note: string }> {
  try {
    const res = await withTimeout(
      fetch(authorizationUrl, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'Superagent-MCP-Verifier/1.0' } }),
      NET_TIMEOUT_MS,
      'login-probe',
    )
    const status = res.status
    const loc = res.headers.get('location')
    let locationHost: string | undefined
    if (loc) {
      try { locationHost = new URL(loc, authorizationUrl).host } catch { /* relative/odd */ }
    }
    // 2xx = login form served; 3xx = redirect into the IdP login. Both are "reachable".
    const ok = status >= 200 && status < 400
    return { ok, httpStatus: status, locationHost, note: ok ? 'login page reachable' : `authorize endpoint returned ${status}` }
  } catch (e) {
    return { ok: false, httpStatus: null, note: classifyError(e).message }
  }
}

async function verifyOAuth(url: string, name: string, ev: Record<string, unknown>): Promise<Partial<Verdict>> {
  const discovery = await withTimeout(discoverOAuthMetadata(url), NET_TIMEOUT_MS, 'discover-oauth')
  if (discovery === null) {
    // Did not 401 -> doesn't require auth at the MCP layer. Maybe it's actually open.
    ev.oauthDiscovery = 'null (server did not return 401 to unauth initialize)'
    try {
      const tools = await withTimeout(discoverTools(url), NET_TIMEOUT_MS, 'discover-tools')
      ev.toolCount = tools.length
      return { status: 'supported', supported: true, reclassifiedAs: 'none', detail: `No OAuth required; connected and listed ${tools.length} tools (reclassify -> none).` }
    } catch (e) {
      if (is401(e)) return { status: 'supported-needs-auth', supported: true, reclassifiedAs: 'bearer', detail: 'initialize did not 401 but tools/list did; likely token-gated.' }
      const c = classifyError(e)
      return { status: 'not-mcp', supported: false, detail: `No OAuth challenge and tools/list failed: ${c.message}` }
    }
  }
  ev.authorizationEndpoint = discovery.metadata.authorization_endpoint
  ev.tokenEndpoint = discovery.metadata.token_endpoint
  ev.registrationEndpoint = discovery.metadata.registration_endpoint || null
  ev.scopesSupported = discovery.scopesSupported

  // Full path: discover -> (DCR or fail) -> build the real authorization URL.
  const initiated = await withTimeout(
    initiateNewServerOAuth(url, name, [REDIRECT_URI]),
    NET_TIMEOUT_MS,
    'initiate-oauth',
  ).catch((e) => { ev.initiateError = classifyError(e).message; return null })

  if (!initiated) {
    // Discovery succeeded (real OAuth MCP server) but we couldn't auto-build the
    // login URL — no dynamic registration and no manual client id. Still supported,
    // just needs a Client ID entered. The AS demonstrably exists.
    return {
      status: 'supported-needs-auth',
      supported: true,
      detail: 'Real OAuth MCP server (auth server discovered) but no dynamic client registration — adding it requires a manual OAuth Client ID.',
    }
  }
  ev.authorizationUrl = initiated.authorizationUrl
  const login = await probeLoginUrl(initiated.authorizationUrl)
  ev.loginProbe = login
  if (login.ok) {
    return { status: 'supported', supported: true, detail: `Reached a live login page (HTTP ${login.httpStatus}${login.locationHost ? ` -> ${login.locationHost}` : ''}).` }
  }
  return { status: 'reachable-login-flaky', supported: true, detail: `OAuth discovery + client registration succeeded; login URL built but probe returned: ${login.note}. Likely still fine (some IdPs reject bare GETs).` }
}

async function verifyToolsHandshake(url: string, token: string | undefined, ev: Record<string, unknown>): Promise<Partial<Verdict>> {
  try {
    const tools = await withTimeout(discoverTools(url, token), NET_TIMEOUT_MS, 'discover-tools')
    ev.toolCount = tools.length
    ev.sampleTools = tools.slice(0, 5).map((t) => t.name)
    return { status: 'supported', supported: true, detail: `Connected and listed ${tools.length} tools.` }
  } catch (e) {
    if (is401(e)) {
      // Positive signal: it's a real MCP server that requires auth. Check whether it's actually OAuth.
      const disc = await withTimeout(discoverOAuthMetadata(url), NET_TIMEOUT_MS, 'discover-oauth').catch(() => null)
      if (disc) {
        ev.authorizationEndpoint = disc.metadata.authorization_endpoint
        return { status: 'supported-needs-auth', supported: true, reclassifiedAs: 'oauth', detail: 'Returned 401; OAuth metadata discovered (reclassify -> oauth).' }
      }
      return { status: 'supported-needs-auth', supported: true, detail: 'Returned 401 to an unauthenticated/dummy-token handshake — real MCP server requiring a token.' }
    }
    const c = classifyError(e)
    return { status: c.kind === 'other' ? 'not-mcp' : 'error', supported: false, detail: `Handshake failed (${c.kind}): ${c.message}` }
  }
}

export async function verifyServer(input: { name: string; url: string; authType: string }): Promise<Verdict> {
  const start = Date.now()
  const authType = normalizeAuth(input.authType)
  const url = probeableUrl(input.url)
  const ev: Record<string, unknown> = {}
  const base: Verdict = {
    name: input.name,
    inputUrl: input.url,
    url,
    inputAuth: input.authType,
    authType,
    status: 'skipped',
    supported: false,
    evidence: ev,
    detail: '',
    ms: 0,
  }

  if (!url) {
    return { ...base, status: 'skipped', detail: 'No clean https endpoint in the data (npx/uvx install, per-instance template, or prose) — needs a real URL before it can be verified.', ms: Date.now() - start }
  }

  try {
    let partial: Partial<Verdict>
    if (authType === 'oauth') {
      partial = await verifyOAuth(url, input.name, ev)
    } else if (authType === 'none') {
      partial = await verifyToolsHandshake(url, undefined, ev)
    } else if (authType === 'bearer') {
      partial = await verifyToolsHandshake(url, VERIFY_TOKEN, ev)
    } else {
      // unknown: try OAuth discovery first (it's the most diagnostic), fall back to a no-auth handshake.
      const disc = await withTimeout(discoverOAuthMetadata(url), NET_TIMEOUT_MS, 'discover-oauth').catch(() => null)
      if (disc) {
        partial = await verifyOAuth(url, input.name, ev)
        partial.reclassifiedAs = 'oauth'
      } else {
        partial = await verifyToolsHandshake(url, undefined, ev)
        if (partial.reclassifiedAs == null && partial.supported) partial.reclassifiedAs = 'none'
      }
    }
    return { ...base, ...partial, evidence: ev, ms: Date.now() - start }
  } catch (e) {
    const c = classifyError(e)
    return { ...base, status: 'error', supported: false, detail: `Unexpected (${c.kind}): ${c.message}`, ms: Date.now() - start }
  }
}

// ---- batch pool ----
async function runPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const batch = arg('--batch')
  if (batch) {
    const concurrency = parseInt(arg('--concurrency') || '8', 10)
    const filter = arg('--filter') || 'add' // 'add' | 'all'
    const outPath = arg('--out') || 'verify-results.json'
    const raw = JSON.parse(readFileSync(path.resolve(batch), 'utf8')) as Array<{
      name: string; mcpUrl?: string; authType?: string; recommendation?: string; category?: string
    }>
    const candidates = raw.filter((c) => filter === 'all' || c.recommendation === 'add')
    process.stderr.write(`Verifying ${candidates.length} servers (filter=${filter}, concurrency=${concurrency})...\n`)
    const verdicts = await runPool(candidates, concurrency, async (c, i) => {
      const v = await verifyServer({ name: c.name, url: c.mcpUrl || '', authType: c.authType || '' })
      process.stderr.write(`[${i + 1}/${candidates.length}] ${v.supported ? '✓' : '·'} ${v.status.padEnd(20)} ${c.name}\n`)
      return { ...v, category: c.category, recommendation: c.recommendation }
    })
    writeFileSync(path.resolve(outPath), JSON.stringify(verdicts, null, 2))
    const by = verdicts.reduce<Record<string, number>>((a, v) => { a[v.status] = (a[v.status] || 0) + 1; return a }, {})
    process.stderr.write(`\nDone. supported=${verdicts.filter((v) => v.supported).length}/${verdicts.length}\n${JSON.stringify(by, null, 2)}\nWrote ${outPath}\n`)
    process.exit(0)
  }

  const url = arg('--url')
  if (!url) {
    process.stderr.write('Usage: --url <url> --auth <oauth|bearer|none> [--name <name>]  OR  --batch <file.json> [--out <out.json>] [--concurrency N] [--filter add|all]\n')
    process.exit(1)
  }
  const verdict = await verifyServer({ name: arg('--name') || url, url, authType: arg('--auth') || 'unknown' })
  process.stdout.write(JSON.stringify(verdict, null, 2) + '\n')
  process.exit(0)
}

main()
