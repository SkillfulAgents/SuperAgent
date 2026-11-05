import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getRequestListener } from '@hono/node-server'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import app from './index'
import { WORKSPACE_UNAVAILABLE_HEADER } from '@shared/lib/workspace-unavailable-header'

// The packaged renderer is file:// (Origin: null) calling loopback, so the
// browser only lets it read a custom response header the server exposes.
describe('CORS exposes the workspace-unavailable header', () => {
  const server = createServer(getRequestListener(app.fetch))
  let baseUrl: string

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  })

  it('lists x-workspace-unavailable in Access-Control-Expose-Headers on a real response', async () => {
    const res = await fetch(`${baseUrl}/api/voice/speech-recognition-polyfill.js`, {
      headers: { origin: 'null' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const exposed = res.headers.get('access-control-expose-headers')?.toLowerCase().split(',') ?? []
    expect(exposed).toContain(WORKSPACE_UNAVAILABLE_HEADER)
    expect(await res.text()).not.toBe('')
  })

  it('answers a renderer upload preflight with a bodyless 204 over HTTP', async () => {
    const res = await fetch(`${baseUrl}/api/agents/test-agent/upload-file`, {
      method: 'OPTIONS',
      headers: {
        origin: 'null',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-request-id',
      },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')?.split(',')).toContain('POST')
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase().split(',')).toEqual(
      expect.arrayContaining(['content-type', 'x-request-id']),
    )
    expect(await res.text()).toBe('')
  })
})
