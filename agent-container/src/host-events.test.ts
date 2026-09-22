import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifyDashboardScreenshotReady, notifyDashboardStatusChanged } from './host-events'

describe('notifyDashboardScreenshotReady', () => {
  beforeEach(() => {
    process.env.SUPERAGENT_HOST_API_URL = 'http://host.internal/api/'
    process.env.PROXY_TOKEN = 'proxy-token'
    process.env.SUPERAGENT_AGENT_SLUG = 'agent-a'
  })

  afterEach(() => {
    delete process.env.SUPERAGENT_HOST_API_URL
    delete process.env.PROXY_TOKEN
    delete process.env.SUPERAGENT_AGENT_SLUG
    vi.restoreAllMocks()
  })

  it('posts the precise screenshot event with container authentication', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    await expect(notifyDashboardScreenshotReady('sales-dashboard')).resolves.toBe(true)

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://host.internal/api/agent-bootstrap/agent-a/events/dashboard-screenshot-ready',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer proxy-token',
        },
        body: JSON.stringify({ dashboardSlug: 'sales-dashboard' }),
      },
    )
  })

  it('is a no-op when host callback configuration is unavailable', async () => {
    delete process.env.SUPERAGENT_HOST_API_URL
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(notifyDashboardScreenshotReady('sales-dashboard')).resolves.toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('surfaces a rejected event so the caller can log it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }))

    await expect(notifyDashboardScreenshotReady('sales-dashboard')).rejects.toThrow('HTTP 403')
  })

  it('posts dashboard status transitions with container authentication', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    await expect(notifyDashboardStatusChanged('sales-dashboard', 'running')).resolves.toBe(true)

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://host.internal/api/agent-bootstrap/agent-a/events/dashboard-status-changed',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer proxy-token',
        },
        body: JSON.stringify({ dashboardSlug: 'sales-dashboard', status: 'running' }),
      },
    )
  })

  it('status notifier is a no-op when host callback configuration is unavailable', async () => {
    delete process.env.SUPERAGENT_HOST_API_URL
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(notifyDashboardStatusChanged('sales-dashboard', 'crashed')).resolves.toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
