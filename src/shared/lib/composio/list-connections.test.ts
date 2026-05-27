import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveComposioApiKey: () => 'test-key',
  getComposioUserId: () => 'test-user',
}))

vi.mock('@shared/lib/auth/platform-auth-service', () => ({
  getPlatformAccessToken: () => null,
  getPlatformProxyBaseUrl: () => null,
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { listConnections } from './client'

function makeResponse(items: Array<{ id: string; status: string; toolkit: { slug: string }; created_at?: string }>, nextCursor?: string) {
  return {
    ok: true,
    json: () => Promise.resolve({
      items,
      next_cursor: nextCursor,
      total_pages: nextCursor ? 2 : 1,
    }),
  }
}

describe('listConnections pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns all items from a single page', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse([
      { id: 'conn-1', status: 'ACTIVE', toolkit: { slug: 'gmail' }, created_at: '2026-01-01T00:00:00Z' },
      { id: 'conn-2', status: 'EXPIRED', toolkit: { slug: 'slack' } },
    ]))

    const result = await listConnections()
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ id: 'conn-1', status: 'ACTIVE', toolkitSlug: 'gmail', createdAt: '2026-01-01T00:00:00Z' })
    expect(result[1]).toEqual({ id: 'conn-2', status: 'EXPIRED', toolkitSlug: 'slack', createdAt: undefined })
  })

  it('paginates through multiple pages using next_cursor', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(
        [{ id: 'conn-1', status: 'ACTIVE', toolkit: { slug: 'gmail' } }],
        'cursor-abc',
      ))
      .mockResolvedValueOnce(makeResponse(
        [{ id: 'conn-2', status: 'ACTIVE', toolkit: { slug: 'slack' } }],
      ))

    const result = await listConnections()
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('conn-1')
    expect(result[1].id).toBe('conn-2')

    expect(mockFetch).toHaveBeenCalledTimes(2)
    const secondUrl = mockFetch.mock.calls[1][0] as string
    expect(secondUrl).toContain('cursor=cursor-abc')
  })

  it('passes user_id and toolkit_slug as query params', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse([]))

    await listConnections('gmail', 'custom-user')

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('user_ids=custom-user')
    expect(url).toContain('toolkit_slugs=gmail')
  })

  it('stops after max pages to prevent infinite loops', async () => {
    // Every page returns a next_cursor — should stop at 20 iterations
    mockFetch.mockImplementation(() =>
      Promise.resolve(makeResponse(
        [{ id: `conn-${mockFetch.mock.calls.length}`, status: 'ACTIVE', toolkit: { slug: 'gmail' } }],
        'always-more',
      ))
    )

    const result = await listConnections()
    expect(mockFetch.mock.calls.length).toBe(20)
    expect(result).toHaveLength(20)
  })
})
