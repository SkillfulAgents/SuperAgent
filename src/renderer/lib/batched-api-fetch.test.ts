import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>()
const handleUnauthorizedResponse = vi.fn(async (_status: number, _path: string) => {})
vi.mock('./api', () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetch(path, init),
  handleUnauthorizedResponse: (status: number, path: string) => handleUnauthorizedResponse(status, path),
}))

import { batchedApiFetch } from './batched-api-fetch'

const batchAnswer = (results: Array<{ status: number; body: unknown }>) =>
  Response.json({ results: results.map((result) => ({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body) })) })

beforeEach(() => {
  apiFetch.mockReset()
  handleUnauthorizedResponse.mockClear()
})

describe('batchedApiFetch', () => {
  it('sends reads asked for together as one request, and gives each caller its own answer', async () => {
    apiFetch.mockResolvedValueOnce(batchAnswer([{ status: 200, body: { hooks: [] } }, { status: 403, body: { error: 'Forbidden' } }]))

    const [hooks, mounts] = await Promise.all([batchedApiFetch('/api/agents/sales/hooks'), batchedApiFetch('/api/agents/sales/mounts')])

    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch.mock.calls[0][0]).toBe('/api/batch-reads')
    expect(JSON.parse(apiFetch.mock.calls[0][1]?.body as string)).toEqual({ paths: ['/api/agents/sales/hooks', '/api/agents/sales/mounts'] })
    expect([hooks.status, await hooks.json()]).toEqual([200, { hooks: [] }])
    expect([mounts.ok, mounts.status, await mounts.json()]).toEqual([false, 403, { error: 'Forbidden' }])
  })

  it('sends a read asked for alone as a plain request', async () => {
    apiFetch.mockResolvedValueOnce(Response.json({ hooks: [] }))

    const response = await batchedApiFetch('/api/agents/sales/hooks')

    expect(apiFetch.mock.calls).toEqual([['/api/agents/sales/hooks', undefined]])
    expect(await response.json()).toEqual({ hooks: [] })
  })

  it('sends each read by itself when the server has no batch route', async () => {
    apiFetch.mockImplementation(async (path) => (path === '/api/batch-reads' ? new Response('Not Found', { status: 404 }) : Response.json({ from: path })))

    const answers = await Promise.all([batchedApiFetch('/api/agents/sales/hooks'), batchedApiFetch('/api/agents/sales/mounts')])

    expect(await Promise.all(answers.map((answer) => answer.json()))).toEqual([{ from: '/api/agents/sales/hooks' }, { from: '/api/agents/sales/mounts' }])
  })

  it('treats an expired session inside a batch as a lone read would', async () => {
    apiFetch.mockResolvedValueOnce(batchAnswer([{ status: 401, body: {} }, { status: 200, body: {} }]))

    await Promise.all([batchedApiFetch('/api/agents/sales/hooks'), batchedApiFetch('/api/agents/sales/mounts')])

    expect(handleUnauthorizedResponse.mock.calls).toEqual([[401, '/api/agents/sales/hooks'], [200, '/api/agents/sales/mounts']])
  })

  it('rejects every read of a batch that could not be sent', async () => {
    apiFetch.mockRejectedValueOnce(new Error('offline'))

    const outcomes = await Promise.allSettled([batchedApiFetch('/api/agents/sales/hooks'), batchedApiFetch('/api/agents/sales/mounts')])

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
  })
})
