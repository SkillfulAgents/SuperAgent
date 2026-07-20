import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as dnsPromises from 'node:dns/promises'

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  return {
    ...actual,
    lookup: vi.fn(),
  }
})

import { validateMcpDiscoveryUrl } from './url-safety'

const lookupMock = dnsPromises.lookup as unknown as ReturnType<typeof vi.fn>

describe('validateMcpDiscoveryUrl DNS resolve (SSRF)', () => {
  let originalE2EMock: string | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    originalE2EMock = process.env.E2E_MOCK
    delete process.env.E2E_MOCK
  })

  afterEach(() => {
    if (originalE2EMock === undefined) delete process.env.E2E_MOCK
    else process.env.E2E_MOCK = originalE2EMock
  })

  it('rejects a public hostname that resolves to a link-local metadata address', async () => {
    lookupMock.mockResolvedValue({ address: '169.254.169.254', family: 4 })

    await expect(
      validateMcpDiscoveryUrl('http://attacker.example/mcp'),
    ).rejects.toThrow(/private or loopback/i)

    expect(lookupMock).toHaveBeenCalled()
  })

  it('rejects when any resolved address is private (multi-A)', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ])

    await expect(
      validateMcpDiscoveryUrl('http://dual.example/mcp'),
    ).rejects.toThrow(/private or loopback/i)
  })

  it('still rejects literal private IPs without needing DNS', async () => {
    await expect(
      validateMcpDiscoveryUrl('http://169.254.169.254/latest/meta-data'),
    ).rejects.toThrow(/private or loopback/i)
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it('rejects IPv4-mapped loopback in URL-canonical hex form', async () => {
    // new URL('http://[::ffff:127.0.0.1]/').hostname === '[::ffff:7f00:1]'
    await expect(
      validateMcpDiscoveryUrl('http://[::ffff:127.0.0.1]/'),
    ).rejects.toThrow(/private or loopback/i)
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it('allows localhost under E2E_MOCK even when DNS returns loopback', async () => {
    process.env.E2E_MOCK = '1'
    lookupMock.mockResolvedValue({ address: '127.0.0.1', family: 4 })

    const parsed = await validateMcpDiscoveryUrl('http://localhost:3100/mcp')
    expect(parsed.hostname).toBe('localhost')
  })
})
