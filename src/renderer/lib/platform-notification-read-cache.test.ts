// @vitest-environment jsdom
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { apiFetch } from './api'
import { readPlatformNotifications } from './platform-notification-read-cache'

vi.mock('./api', () => ({ apiFetch: vi.fn() }))

describe('platform notification read reconciliation', () => {
  it('restarts an initial badge request that predates the read', async () => {
    const client = new QueryClient()
    const key = ['platform-notifications', 'unread-count']
    let release!: () => void
    const old = new Promise<void>(resolve => { release = resolve })
    const fetchCount = vi.fn().mockImplementationOnce(async () => { await old; return { count: 1 } })
      .mockResolvedValue({ count: 0 })
    const observer = new QueryObserver(client, { queryKey: key, queryFn: fetchCount })
    const unsubscribe = observer.subscribe(() => {})
    try {
      vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ success: true, updated: 1 })))
      await readPlatformNotifications(client, ['n1'])
      release()
      await waitFor(() => expect(client.getQueryData(key)).toEqual({ count: 0 }))
      expect(fetchCount).toHaveBeenCalledTimes(2)
    } finally { release(); unsubscribe(); client.clear() }
  })

  it.each(['single', 'all', 'partial failure'] as const)('refreshes rows and badge after %s', async mode => {
    const client = new QueryClient()
    const keys = [['platform-notifications', 15], ['platform-notifications', 100], ['platform-notifications', 'unread-count']]
    keys.forEach(key => client.setQueryData(key, {}))
    if (mode === 'partial failure') vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Lost response'))
    else vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ success: true, updated: 1 })))
    const operation = readPlatformNotifications(client, mode === 'single' ? ['n1'] : undefined)
    if (mode === 'partial failure') await expect(operation).rejects.toThrow('Lost response')
    else await operation
    keys.forEach(key => expect(client.getQueryState(key)?.isInvalidated).toBe(true))
    client.clear()
  })
})
