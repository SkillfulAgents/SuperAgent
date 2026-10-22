import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getRequestListener } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Exercise the web server's static middleware and SPA fallback through real
// sockets: app.request() cannot catch adapter body/framing regressions.
describe('static files over the Node HTTP adapter', () => {
  const bytes = Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => i % 251))
  let root: string
  let baseUrl: string
  let server: ReturnType<typeof createServer>

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'superagent-static-transport-'))
    await Promise.all([
      writeFile(join(root, 'sample.bin'), bytes),
      writeFile(join(root, 'empty.bin'), ''),
      writeFile(join(root, 'encoded%20name.txt'), 'literal-percent filename'),
      writeFile(join(root, 'index.html'), '<!doctype html><title>App</title>'),
    ])
    const app = new Hono()
    app.use('/*', serveStatic({ root }))
    app.get('*', serveStatic({ path: join(root, 'index.html') }))
    server = createServer(getRequestListener(app.fetch))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    try {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve())
          server.closeAllConnections()
        })
      }
    } finally {
      if (root) await rm(root, { recursive: true, force: true })
    }
  })

  it('streams a complete binary response without changing its bytes', async () => {
    const res = await fetch(`${baseUrl}/sample.bin`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(bytes.length))
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes)
  })

  it('answers HEAD with the full length and no response body', async () => {
    const res = await fetch(`${baseUrl}/sample.bin`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(bytes.length))
    expect(res.headers.get('last-modified')).toBeTruthy()
    expect((await res.arrayBuffer()).byteLength).toBe(0)
  })

  it.each([
    ['bytes=10-19', 10, 19],
    ['bytes=-12', bytes.length - 12, bytes.length - 1],
    [`bytes=${bytes.length - 16}-`, bytes.length - 16, bytes.length - 1],
    [`bytes=${bytes.length - 8}-${bytes.length + 100}`, bytes.length - 8, bytes.length - 1],
  ] as const)('serves the correct bytes for Range: %s', async (range, start, end) => {
    const res = await fetch(`${baseUrl}/sample.bin`, { headers: { range } })
    expect(res.status).toBe(206)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-range')).toBe(`bytes ${start}-${end}/${bytes.length}`)
    expect(res.headers.get('content-length')).toBe(String(end - start + 1))
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes.subarray(start, end + 1))
  })

  it.each([
    ['sample.bin', `bytes=${bytes.length}-`, bytes.length],
    ['empty.bin', 'bytes=0-0', 0],
  ] as const)('returns a bodyless 416 for an unsatisfiable range on %s', async (filename, range, length) => {
    const res = await fetch(`${baseUrl}/${filename}`, { headers: { range } })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe(`bytes */${length}`)
    expect((await res.arrayBuffer()).byteLength).toBe(0)
  })

  it('streams the SPA entry for an unmatched client-side route', async () => {
    const res = await fetch(`${baseUrl}/agents/example/chat`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toBe('<!doctype html><title>App</title>')
  })

  it('does not serve a static file or the SPA fallback for POST', async () => {
    const res = await fetch(`${baseUrl}/sample.bin`, { method: 'POST', body: 'ignored' })
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('404 Not Found')
  })

  it('does not serve a path with percent escapes remaining after Hono decodes it', async () => {
    // Ordinary escaped letters are already decoded by Hono. The adapter's
    // guard targets residual escapes (such as a literal percent filename),
    // which must fall through to the SPA without another decoding pass.
    const res = await fetch(`${baseUrl}/encoded%2520name.txt`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toBe('<!doctype html><title>App</title>')
  })
})
