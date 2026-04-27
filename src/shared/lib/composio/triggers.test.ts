import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetPlatformProxyBaseUrl = vi.fn()
const mockFetch = vi.fn()

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => mockGetPlatformProxyBaseUrl(),
}))

vi.stubGlobal('fetch', mockFetch)

import type { Attribution } from '@shared/lib/attribution'
import { getAvailableTriggers } from './triggers'

describe('Composio triggers proxy client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetPlatformProxyBaseUrl.mockReturnValue('https://proxy.example.com')
  })

  function makeAttribution(memberId = 'sub_member_123'): Attribution {
    return {
      applyTo(headers) {
        headers.set('Authorization', 'Bearer plat_org_token')
        headers.set('X-Platform-Member-Id', memberId)
      },
      toHeaderEntries() {
        return [
          ['Authorization', 'Bearer plat_org_token'],
          ['X-Platform-Member-Id', memberId],
        ]
      },
      toExtraHeaderEntries() { return this.toHeaderEntries().filter(([n]) => n !== "Authorization") },
      getKey() {
        return `member:${memberId}`
      },
    }
  }

  it('sends raw bearer plus X-Platform-Member-Id', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    })

    await getAvailableTriggers('gmail', makeAttribution())

    const headers = mockFetch.mock.calls[0][1]?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer plat_org_token')
    expect(headers.get('X-Platform-Member-Id')).toBe('sub_member_123')
  })

  it('fails early in auth mode when member attribution is missing', async () => {
    await expect(getAvailableTriggers('gmail', {
      applyTo() {
        throw new Error('Member attribution is required for this request')
      },
      getKey() {
        return 'missing'
      },
    toHeaderEntries() { const h = new Headers(); this.applyTo(h); const out: Array<[string,string]> = []; h.forEach((v,k) => out.push([k,v])); return out },
      toExtraHeaderEntries() { return this.toHeaderEntries().filter(([n]) => n !== "Authorization") },
    })).rejects.toThrow(
      'Member attribution is required',
    )
  })
})
