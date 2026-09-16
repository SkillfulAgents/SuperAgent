import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { authenticatedHostResponse, callHost, XAgentError } from './host-client'

describe('x-agent host client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.SUPERAGENT_HOST_API_URL
    delete process.env.PROXY_TOKEN
  })

  function configure() {
    process.env.SUPERAGENT_HOST_API_URL = 'http://host/api/'
    process.env.PROXY_TOKEN = 'secret'
  }

  it('returns an authenticated raw response for binary callers', async () => {
    configure()
    const response = new Response(Uint8Array.from([0, 255]))
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)

    expect(await authenticatedHostResponse('download-file', { deliveryId: 'id' })).toBe(response)
    expect(fetchMock).toHaveBeenCalledWith('http://host/api/x-agent/download-file', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
    }))
  })

  it('validates successful JSON with the supplied schema', async () => {
    configure()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ value: 'valid' })))

    await expect(callHost('op', {}, z.object({ value: z.string() }))).resolves.toEqual({ value: 'valid' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ value: 1 })))
    await expect(callHost('op', {}, z.object({ value: z.string() }))).rejects.toBeInstanceOf(z.ZodError)
  })

  it('uses only Zod-validated JSON error messages', async () => {
    configure()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 123 }, { status: 400 })))

    await expect(authenticatedHostResponse('op', {})).rejects.toEqual(
      expect.objectContaining<XAgentError>({ status: 400, message: 'x-agent op failed (HTTP 400)' }),
    )
  })

  it('surfaces a valid JSON error message', async () => {
    configure()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'denied' }, { status: 403 })))

    await expect(authenticatedHostResponse('op', {})).rejects.toEqual(
      expect.objectContaining<XAgentError>({ status: 403, message: 'denied' }),
    )
  })
})
