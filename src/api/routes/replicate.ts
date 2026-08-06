import { Hono, type Context } from 'hono'
import { IsAgent } from '../middleware/auth'
import { captureException } from '@shared/lib/error-reporting'
import { getEffectiveReplicateKey } from '@shared/lib/replicate/credentials'
import { createBodySchema } from '@shared/lib/replicate/replicate-schema'
import { getWhitelistCatalog, isWhitelistedModel } from '@shared/lib/replicate/whitelist'

const REPLICATE_API_BASE = 'https://api.replicate.com'
const CANCEL_AFTER_SECONDS = 600
const MAX_CREATE_BODY_BYTES = 10_000_000
// Sits above the sync-wait ceiling the skill instructs (Prefer: wait=55) so a legitimate
// wait is never cut short, and below forever so a stalled vendor connection cannot hold a
// host request open indefinitely.
const UPSTREAM_TIMEOUT_MS = 120_000
const QUALIFIED_VERSION_RE = /^([\w.-]+)\/([\w.-]+):([0-9a-f]{64})$/
const KEYLESS_REMEDY =
  'no Replicate key configured — ask the user to add one in Settings → Media Generation'

/** Where this router is mounted. Exported so the mount site and the path match cannot drift. */
export const MOUNT_PREFIX = '/api/replicate'

type OpKind = 'read' | 'createModel' | 'createVersion'

// Deny by default: a request reaches Replicate only by matching one of these rows on both
// method and path. `doc` is the human form a refusal advertises, so what the lane allows and
// what it says it allows cannot drift apart.
const OPS: { method: string; re: RegExp; kind: OpKind; doc: string }[] = [
  { method: 'GET', re: /^\/v1\/models\/([\w.-]+)\/([\w.-]+)$/, kind: 'read', doc: 'GET /v1/models/{owner}/{name}' },
  { method: 'POST', re: /^\/v1\/models\/([\w.-]+)\/([\w.-]+)\/predictions$/, kind: 'createModel', doc: 'POST /v1/models/{owner}/{name}/predictions' },
  { method: 'POST', re: /^\/v1\/predictions$/, kind: 'createVersion', doc: 'POST /v1/predictions' },
  { method: 'GET', re: /^\/v1\/predictions\/([\w-]+)$/, kind: 'read', doc: 'GET /v1/predictions/{id}' },
  { method: 'POST', re: /^\/v1\/predictions\/([\w-]+)\/cancel$/, kind: 'read', doc: 'POST /v1/predictions/{id}/cancel' },
]

const ALLOWED_OPS = ['GET /catalog', ...OPS.map((op) => op.doc)]

const replicate = new Hono()
replicate.use('*', IsAgent())

replicate.get('/catalog', (c) => c.json({ categories: getWhitelistCatalog() }))

function refuse(error: string, remedy?: string) {
  return Response.json({ error, allowed: ALLOWED_OPS, ...(remedy ? { remedy } : {}) }, { status: 403 })
}

async function readCreateBody(
  c: Context,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  if (c.req.header('Content-Encoding')) {
    return { ok: false, response: Response.json({ error: 'Content-Encoding is not allowed' }, { status: 415 }) }
  }
  const contentType = c.req.header('Content-Type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return {
      ok: false,
      response: Response.json({ error: 'Content-Type must be application/json' }, { status: 400 }),
    }
  }
  // Check the declared length before buffering. Reading first and measuring after would let
  // an oversized body occupy host memory exactly as the cap exists to prevent; the check on
  // the buffer still runs, for a request that declares nothing or lies.
  const declared = Number(c.req.header('Content-Length'))
  const overDeclared = Number.isFinite(declared) && declared > MAX_CREATE_BODY_BYTES
  const buf = overDeclared ? null : await c.req.raw.arrayBuffer()
  if (!buf || buf.byteLength > MAX_CREATE_BODY_BYTES) {
    return { ok: false, response: Response.json({ error: 'Request body too large' }, { status: 413 }) }
  }
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(buf))
  } catch {
    return { ok: false, response: Response.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  }
  const parsed = createBodySchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, response: Response.json({ error: 'Body must be a JSON object' }, { status: 400 }) }
  }
  // Drop the vendor's callback channel on both create forms: the app has no webhook story,
  // and it is the one field that could carry a prediction record off-host.
  const body: Record<string, unknown> = { ...parsed.data }
  delete body.webhook
  delete body.webhook_events_filter
  return { ok: true, body }
}

async function verifyVersion(
  key: string,
  owner: string,
  name: string,
  hash: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const res = await fetch(`${REPLICATE_API_BASE}/v1/models/${owner}/${name}/versions/${hash}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  if (res.status === 200) return { ok: true }
  if (res.status === 404) {
    return { ok: false, response: refuse('Version does not belong to the named model') }
  }
  return {
    ok: false,
    response: Response.json({ error: `Version verification failed: ${res.status}` }, { status: 502 }),
  }
}

replicate.all('/v1/*', async (c) => {
  const path = c.req.path
  const subPath = path.startsWith(MOUNT_PREFIX) ? path.slice(MOUNT_PREFIX.length) || '/' : path
  // A dot segment that survived URL normalization would be re-collapsed by the outbound
  // fetch, landing on a path the op table never approved.
  if (subPath.includes('..')) {
    return refuse('Path not allowed')
  }

  const method = c.req.method.toUpperCase()
  let op: (typeof OPS)[number] | undefined
  let match: RegExpMatchArray | null = null
  for (const candidate of OPS) {
    if (candidate.method !== method) continue
    match = subPath.match(candidate.re)
    if (match) {
      op = candidate
      break
    }
  }
  if (!op || !match) {
    return refuse('Path not allowed')
  }

  const key = getEffectiveReplicateKey()
  if (!key) {
    return Response.json({ error: KEYLESS_REMEDY, remedy: KEYLESS_REMEDY }, { status: 400 })
  }

  const isCreate = op.kind !== 'read'
  let outboundBody: string | undefined

  try {
    if (isCreate) {
      // Whitelist first, body second: an off-list model is refused without the lane reading
      // its payload at all.
      if (op.kind === 'createModel' && !isWhitelistedModel(match[1], match[2])) {
        return refuse(`Model ${match[1]}/${match[2]} is not on the approved list`)
      }
      const bodyResult = await readCreateBody(c)
      if (!bodyResult.ok) return bodyResult.response
      const body = bodyResult.body

      if (op.kind === 'createVersion') {
        const version = typeof body.version === 'string' ? body.version : ''
        const versionMatch = version.match(QUALIFIED_VERSION_RE)
        if (!versionMatch) {
          return refuse('Invalid version form', 'use the owner/name:version form (64-char hex hash)')
        }
        const [, owner, name, hash] = versionMatch
        if (!isWhitelistedModel(owner, name)) {
          return refuse(`Model ${owner}/${name} is not on the approved list`)
        }
        // Ask the vendor whether the hash belongs to the model the whitelist just approved.
        // Without it, an approved name paired with any version hash runs that version.
        const verified = await verifyVersion(key, owner, name, hash)
        if (!verified.ok) return verified.response
      }
      outboundBody = JSON.stringify(body)
    }

    // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
    const search = new URL(c.req.url).search
    const contentType = c.req.header('Content-Type')
    const prefer = c.req.header('Prefer')
    const outboundHeaders: Record<string, string> = {
      Authorization: `Bearer ${key}`,
    }
    if (contentType) outboundHeaders['Content-Type'] = contentType
    if (prefer) outboundHeaders.Prefer = prefer
    if (isCreate) outboundHeaders['Cancel-After'] = String(CANCEL_AFTER_SECONDS)

    console.log(`[replicate] ${method} ${subPath}`)

    const upstream = await fetch(`${REPLICATE_API_BASE}${subPath}${search}`, {
      method,
      headers: outboundHeaders,
      body: outboundBody,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })

    const relayHeaders = new Headers()
    const contentTypeOut = upstream.headers.get('content-type')
    if (contentTypeOut) relayHeaders.set('content-type', contentTypeOut)

    return new Response(upstream.body, {
      status: upstream.status,
      headers: relayHeaders,
    })
  } catch (error) {
    captureException(error, { tags: { component: 'replicate', operation: op.kind } })
    return Response.json(
      { error: 'Replicate is unreachable', remedy: 'retry in a moment' },
      { status: 502 },
    )
  }
})

export default replicate
