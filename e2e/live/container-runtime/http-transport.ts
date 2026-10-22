import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import {
  browserSocketSchema, imageIdSchema, transportManifestSchema, transportProofSchema,
  transportStatsSchema, transportUploadSchema, transportVersionsSchema,
} from './http-transport-schema'

const exec = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function parseJson(text: string): unknown {
  try { return JSON.parse(text) }
  catch { throw new Error('Transport fixture returned invalid JSON') }
}

async function docker(...args: string[]) {
  return (await exec('docker', args, { timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout.trim()
}

async function versions(container: string, app: boolean) {
  const script = `const root='/app/node_modules/'; process.stdout.write(JSON.stringify({hono:require(root+'hono/package.json').version,nodeServer:require(root+'@hono/node-server/package.json').version${app ? ",zodValidator:require(root+'@hono/zod-validator/package.json').version" : ''}}))`
  return transportVersionsSchema.parse(parseJson(await docker('exec', container, 'node', '-e', script)))
}

async function verifyAppEndpoint(base: string, container: string) {
  const probeName = `__transport-proof-${randomUUID()}.txt`
  const probePath = `/app/dist/renderer/${probeName}`
  const nonce = randomUUID()
  await docker('exec', container, 'node', '-e',
    "require('node:fs').writeFileSync(process.argv[1],process.argv[2],{flag:'wx',mode:0o644})", probePath, nonce)
  try {
    const response = await fetch(`${base}/${probeName}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), nonce, 'The app URL must reach the inspected production container')
  } finally {
    await docker('exec', container, 'node', '-e', "require('node:fs').unlinkSync(process.argv[1])", probePath)
  }
}

async function readFirstEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder()
  let text = ''
  let chunks = 0
  while (!text.includes('\n\n')) {
    const next = await reader.read()
    assert(!next.done, 'SSE must contain a complete first event')
    text += decoder.decode(next.value, { stream: true })
    chunks++
  }
  assert(text.includes('data: first\n\n'))
  return { text, chunks }
}

function chunkedEcho(url: string, bytes: Buffer): Promise<{ status: number; bytes: Buffer; hostTokenPresent: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('error', reject)
      response.on('end', () => resolve({
        status: response.statusCode ?? 0, bytes: Buffer.concat(chunks),
        hostTokenPresent: response.headers['x-host-token-present'] as string | undefined,
      }))
    })
    req.on('error', reject)
    req.setTimeout(30_000, () => req.destroy(new Error('Chunked echo timed out')))
    void (async () => {
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        req.write(bytes.subarray(offset, offset + 65536))
        await new Promise(resolve => setTimeout(resolve, 2))
      }
      req.end()
    })().catch(error => req.destroy(error instanceof Error ? error : new Error('Chunked upload failed')))
  })
}

export async function runHttpTransport(options: {
  base: string; slug: string; container: string; appContainer: string;
  appImageId: string; agentImageId: string; output: string; runId: string; page: Page;
}) {
  const { base, slug, container, appContainer, output, page } = options
  const checks: string[] = []
  const appImageId = imageIdSchema.parse(await docker('inspect', '--format', '{{.Image}}', appContainer))
  const agentImageId = imageIdSchema.parse(await docker('inspect', '--format', '{{.Image}}', container))
  assert.equal(appImageId, options.appImageId, 'Expected upgraded production app image')
  assert.equal(agentImageId, options.agentImageId, 'Expected upgraded agent image')
  const appVersions = await versions(appContainer, true)
  const agentVersions = await versions(container, false)
  await verifyAppEndpoint(base, appContainer)
  checks.push('production-images-and-installed-versions')

  const artifact = `transport-${options.runId.slice(0, 8)}`
  const artifactDir = `/workspace/artifacts/${artifact}`
  const manifest = transportManifestSchema.parse({
    name: 'HTTP transport smoke', description: 'Temporary deterministic protocol fixture',
    scripts: { start: 'bun run transport-server.mjs' },
  })
  const manifestFile = path.join(output, 'transport-package.json')
  await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 })
  await docker('exec', '--user', 'claude', container, 'mkdir', '-p', artifactDir)
  await docker('cp', manifestFile, `${container}:${artifactDir}/package.json`)
  await docker('cp', path.join(here, 'http-transport-server.mjs'), `${container}:${artifactDir}/transport-server.mjs`)
  await docker('exec', '--user', 'root', container, 'chown', '-R', 'claude:claude', artifactDir)
  const artifactUrl = `${base}/api/agents/${slug}/artifacts/${artifact}`
  const started = await fetch(`${artifactUrl}/start`, { method: 'POST', signal: AbortSignal.timeout(60_000) })
  assert.equal(started.status, 200, 'Start deterministic dashboard through production API')

  const bytes = Buffer.from(Array.from({ length: 2 * 1024 * 1024 }, (_, index) => index % 251))
  const sha256 = digest(bytes)
  const relative = `${artifact}/nested/report #?%.bin`
  const form = new FormData()
  form.append('file', new File([bytes], 'report #?%.bin', { type: 'application/octet-stream' }))
  form.append('relativePath', relative)
  const uploaded = await fetch(`${base}/api/agents/${slug}/upload-file`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) })
  assert.equal(uploaded.status, 200, 'Real multipart upload')
  const upload = transportUploadSchema.parse(await uploaded.json())
  assert.equal(upload.size, bytes.length)
  assert.equal(upload.path, `/workspace/uploads/${relative}`)
  const fileUrl = `${base}/api/agents/${slug}/files/${upload.path.slice('/workspace/'.length).split('/').map(encodeURIComponent).join('/')}`
  const downloaded = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) })
  assert.equal(downloaded.status, 200)
  assert.equal(digest(new Uint8Array(await downloaded.arrayBuffer())), sha256)
  checks.push('multipart-binary-upload-encoded-path-download')

  const head = await fetch(fileUrl, { method: 'HEAD', signal: AbortSignal.timeout(30_000) })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), String(bytes.length))
  assert.equal((await head.arrayBuffer()).byteLength, 0)
  const partial = await fetch(fileUrl, { headers: { Range: 'bytes=17-272' }, signal: AbortSignal.timeout(30_000) })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('content-range'), `bytes 17-272/${bytes.length}`)
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(17, 273))
  const invalidRange = await fetch(fileUrl, { headers: { Range: `bytes=${bytes.length + 1}-` }, signal: AbortSignal.timeout(30_000) })
  assert.equal(invalidRange.status, 416)
  assert.equal(invalidRange.headers.get('content-range'), `bytes */${bytes.length}`)
  await invalidRange.arrayBuffer()
  checks.push('workspace-head-and-byte-ranges')

  // The existing memories error handler maps malformed-JSON HTTPExceptions to 500.
  // Both old and upgraded dependencies return 400 for valid JSON failing the schema.
  for (const [body, expectedStatus] of [
    ['{"path":', 500], ['{"path":42,"content":false,"revision":"invalid"}', 400],
  ] as const) {
    const invalid = await fetch(`${base}/api/agents/${slug}/memories/content`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(30_000),
    })
    assert.equal(invalid.status, expectedStatus, 'Preserve existing malformed/schema-invalid JSON responses')
    await invalid.arrayBuffer()
  }
  checks.push('zod-validator-json-boundaries')

  const echoed = await chunkedEcho(`${artifactUrl}/echo?transport=chunked%20body`, bytes)
  assert.equal(echoed.status, 200)
  assert.equal(digest(echoed.bytes), sha256)
  assert.equal(echoed.hostTokenPresent, 'false')
  checks.push('chunked-body-through-both-proxies')
  const query = await fetch(`${artifactUrl}/echo?transport=encoded%20query`, {
    method: 'PUT', body: 'query-check', signal: AbortSignal.timeout(30_000),
  })
  assert.equal(query.headers.get('x-probe-method'), 'PUT')
  assert.equal(query.headers.get('x-probe-query'), '?transport=encoded%20query')
  assert.equal(await query.text(), 'query-check')
  checks.push('proxy-method-query-and-host-token-filtering')

  const streamId = randomUUID()
  const stream = await fetch(`${artifactUrl}/stream?release=${streamId}`, { signal: AbortSignal.timeout(30_000) })
  assert.equal(stream.status, 200)
  assert(stream.headers.get('content-type')?.startsWith('text/event-stream'))
  const reader = stream.body!.getReader()
  const first = await readFirstEvent(reader)
  let text = first.text
  assert(!text.includes('data: second'), 'First SSE chunk must arrive before the second is produced')
  // Release the second event only after receiving the first, avoiding timer races.
  const released = await fetch(`${artifactUrl}/release?id=${streamId}`, { method: 'POST', signal: AbortSignal.timeout(5_000) })
  assert.equal(released.status, 204)
  let streamedChunks = first.chunks
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    streamedChunks++
    text += new TextDecoder().decode(next.value)
  }
  assert(text.includes('data: second'))
  checks.push('incremental-sse-through-both-proxies')

  for (let cycle = 0; cycle < 3; cycle++) {
    const abort = new AbortController()
    const response = await fetch(`${artifactUrl}/stream?hold=1`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) })
    const pending = response.body!.getReader()
    await readFirstEvent(pending)
    abort.abort()
    await pending.cancel().catch(() => {})
    let stopped = false
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const stats = transportStatsSchema.parse(await (await fetch(`${artifactUrl}/stats`, { signal: AbortSignal.timeout(5_000) })).json())
      if (stats.activeSse === 0) { stopped = true; break }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert(stopped, 'Downstream SSE cancellation must reach the dashboard upstream')
  }
  checks.push('sse-abort-reconnect-and-upstream-cleanup')

  const socket = browserSocketSchema.parse(await page.evaluate(async url => {
    const ws = new WebSocket(url, ['transport-v1'])
    ws.binaryType = 'arraybuffer'
    const messages: unknown[] = []
    let receive: ((value: unknown) => void) | undefined
    ws.addEventListener('message', event => {
      if (receive) { const resolve = receive; receive = undefined; resolve(event.data) }
      else messages.push(event.data)
    })
    // Object methods stay self-contained when tsx serializes this browser callback.
    const probe = {
      next() { return messages.length ? Promise.resolve(messages.shift()) : new Promise<unknown>(resolve => { receive = resolve }) },
      async exercise() {
        await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('WebSocket upgrade failed')) })
        let greeting: unknown
        try { greeting = JSON.parse(String(await probe.next())) }
        catch { throw new Error('Invalid fixture greeting JSON') }
        if (!greeting || typeof greeting !== 'object' || !('hostTokenPresent' in greeting)) throw new Error('Invalid fixture greeting')
        ws.send('transport-text')
        const text = String(await probe.next())
        ws.send(new Uint8Array([0, 255, 17, 128]).buffer)
        const binary = Array.from(new Uint8Array(await probe.next() as ArrayBuffer))
        const closed = new Promise<CloseEvent>(resolve => { ws.onclose = resolve })
        ws.send('close-me')
        const event = await closed
        return { protocol: ws.protocol, text, binary, hostTokenPresent: greeting.hostTokenPresent, closeCode: event.code, closeReason: event.reason }
      },
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([probe.exercise(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('WebSocket fixture timed out')), 20_000)
      })])
    } finally {
      clearTimeout(timer)
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
    }
  }, artifactUrl.replace(/^http/, 'ws') + '/socket'))
  assert.equal(socket.text, 'transport-text')
  assert.deepEqual(socket.binary, [0, 255, 17, 128])
  checks.push('browser-websocket-text-binary-subprotocol-close')

  console.log(`[runtime-smoke] HTTP transport: ${checks.length} checks passed on production app and agent adapters`)
  return transportProofSchema.parse({
    app: { imageId: appImageId, versions: appVersions, endpointVerified: true },
    agent: { imageId: agentImageId, versions: agentVersions },
    checks, uploadBytes: bytes.length, sha256, streamedChunks, abortCycles: 3, socket,
    validationStatuses: { malformedJson: 500, invalidSchema: 400 },
  })
}
