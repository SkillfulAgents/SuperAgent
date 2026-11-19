import { createServer } from 'node:http'
import { test, expect } from '@playwright/test'
import { z } from 'zod'
import { createResponseGuard } from '../helpers/response-guard'

const cases = [
  { name: 'HTTP error with HTML', status: 503, type: 'text/html', body: '<h1>Unavailable</h1>', error: 'HTTP 503, text/html' },
  { name: 'malformed JSON', status: 200, type: 'application/json', body: '{broken', error: 'HTTP 200, application/json' },
  { name: 'invalid response schema', status: 200, type: 'application/json', body: '{"name":123}', error: 'expected string' },
  { name: 'dropped connection', status: 0, type: '', body: '', error: 'fetch failed' },
  { name: 'valid response', status: 200, type: 'application/json', body: '{"name":"Renamed"}', error: null },
  { name: 'unexpected forbidden response', status: 403, type: 'application/json', body: '{"error":"Forbidden"}', error: 'HTTP 403, application/json' },
  { name: 'explicitly allowed forbidden response', status: 403, type: 'application/json', body: '{"error":"Forbidden"}', error: null, allowedStatuses: [403] },
] as const

for (const fixture of cases) {
  test(`response guard settles ${fixture.name} and preserves its result`, async ({ page }) => {
    const server = createServer((request, response) => {
      if (request.url !== '/metadata') {
        response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Response guard</title>')
      } else if (fixture.status === 0) request.socket.destroy()
      else response.writeHead(fixture.status, { 'content-type': fixture.type }).end(fixture.body)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture HTTP server has no TCP address')
    const endpoint = `http://127.0.0.1:${address.port}/metadata`
    const guard = createResponseGuard('allowedStatuses' in fixture ? { allowedStatuses: fixture.allowedStatuses } : {})
    const handler = guard.intercept(async (route, response) => {
      const schema = response.status() === 403 ? z.object({ error: z.string() }) : z.object({ name: z.string() })
      schema.parse(await response.json())
      await route.fulfill({ response })
    })
    try {
      await page.goto(`http://127.0.0.1:${address.port}`)
      await page.route(endpoint, handler)
      const received = page.evaluate(async () => {
        try {
          const response = await fetch('/metadata')
          return { status: response.status, body: await response.text(), error: null }
        } catch (error) {
          return { status: 0, body: '', error: String(error) }
        }
      })
      if (fixture.error) {
        const failed = guard.run(() => received)
        await expect(failed).rejects.toThrow(`Intercepted GET ${endpoint}`)
        await expect(failed).rejects.toThrow(fixture.error)
        await expect(failed).rejects.toHaveProperty('cause')
      } else await expect(guard.run(() => received)).resolves.toMatchObject({ status: fixture.status, body: fixture.body })
      // The browser's fetch must settle too, even when inspection failed.
      await expect(received).resolves.toMatchObject({ status: fixture.status, body: fixture.body })
      if (fixture.status === 0) expect((await received).error).toBeTruthy()
    } finally {
      await page.unroute(endpoint, handler)
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
}

test('response guard drains started interceptors and rejects a failure after the operation succeeds', async ({ page }) => {
  let releaseSlow!: () => void
  const slow = new Promise<void>(resolve => { releaseSlow = resolve })
  let bothStarted!: () => void
  const started = new Promise<void>(resolve => { bothStarted = resolve })
  const requests = new Set<string>()
  const server = createServer((request, response) => {
    if (!request.url?.startsWith('/metadata/')) {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Delayed guard</title>')
      return
    }
    requests.add(request.url)
    if (requests.size === 2) bothStarted()
    if (request.url === '/metadata/slow') {
      void slow.then(() => response.writeHead(503, { 'content-type': 'text/html' }).end('Delayed failure'))
    } else response.writeHead(200, { 'content-type': 'application/json' }).end('{"name":"Ready"}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture HTTP server has no TCP address')
  const origin = `http://127.0.0.1:${address.port}`
  const endpoint = `${origin}/metadata/*`
  const guard = createResponseGuard()
  const handler = guard.intercept(async (route, response) => {
    z.object({ name: z.string() }).parse(await response.json())
    await route.fulfill({ response })
  })
  let pendingRequests: Promise<unknown> | undefined
  try {
    await page.goto(origin)
    await page.route(endpoint, handler)
    const received = page.evaluate(async () => Promise.all(['fast', 'slow'].map(async name => {
      const response = await fetch(`/metadata/${name}`)
      return { status: response.status, body: await response.text() }
    })))
    pendingRequests = received
    let operationFinished!: () => void
    const finished = new Promise<void>(resolve => { operationFinished = resolve })
    const guarded = guard.run(async () => {
      await started
      operationFinished()
      return 'UI assertions finished'
    })
    let settled = false
    void guarded.then(() => { settled = true }, () => { settled = true })
    await finished
    // Flush the operation's resolved promise and its reactions. No wall-clock
    // delay: the HTTP response remains explicitly held until the check below.
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    releaseSlow()
    await expect(guarded).rejects.toThrow(`Intercepted GET ${origin}/metadata/slow (HTTP 503, text/html)`)
    await expect(received).resolves.toEqual([
      { status: 200, body: '{"name":"Ready"}' },
      { status: 503, body: 'Delayed failure' },
    ])
  } finally {
    releaseSlow()
    await pendingRequests?.catch(() => undefined)
    await page.unroute(endpoint, handler)
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
