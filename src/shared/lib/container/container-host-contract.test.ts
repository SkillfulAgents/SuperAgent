import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContainerRunner } from './client-factory'
import { ALL_RUNNERS, getContainerClientClass } from './client-factory'
import { resetAppleContainerClientForTests } from './apple-container-client'
import { resetMicrovmRuntimeForTests } from './lambda-microvm-runtime'

const mockExecSyncWithPath = vi.fn()
vi.mock('./base-container-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./base-container-client')>()
  return {
    ...actual,
    execSyncWithPath: (...args: unknown[]) => mockExecSyncWithPath(...args),
  }
})

/**
 * Expected guest-side host address per runner. Exact values are intentional:
 * a name change is a product decision that must update this table. Completeness
 * over ALL_RUNNERS is the gate - a new runner with no row fails the build.
 */
type HostContract =
  | { kind: 'gateway-name'; address: string }
  | { kind: 'apple' }
  | { kind: 'remote-public-url' }

const CONTRACTS = {
  docker: { kind: 'gateway-name', address: 'host.docker.internal' },
  lima: { kind: 'gateway-name', address: 'host.docker.internal' },
  wsl2: { kind: 'gateway-name', address: 'host.docker.internal' },
  podman: { kind: 'gateway-name', address: 'host.containers.internal' },
  'apple-container': { kind: 'apple' },
  kubernetes: { kind: 'remote-public-url' },
  'lambda-microvm': { kind: 'remote-public-url' },
} as const satisfies Record<ContainerRunner, HostContract>

describe('container host-address contract', () => {
  const prevHostPublicUrl = process.env.HOST_PUBLIC_URL
  const prevEcsMetadata = process.env.ECS_CONTAINER_METADATA_URI_V4
  const prevPort = process.env.PORT

  beforeEach(() => {
    resetAppleContainerClientForTests()
    resetMicrovmRuntimeForTests()
    mockExecSyncWithPath.mockReset()
    delete process.env.ECS_CONTAINER_METADATA_URI_V4
    process.env.HOST_PUBLIC_URL = 'https://host.example'
    process.env.PORT = '47891'
  })

  afterEach(() => {
    resetAppleContainerClientForTests()
    resetMicrovmRuntimeForTests()
    if (prevHostPublicUrl === undefined) delete process.env.HOST_PUBLIC_URL
    else process.env.HOST_PUBLIC_URL = prevHostPublicUrl
    if (prevEcsMetadata === undefined) delete process.env.ECS_CONTAINER_METADATA_URI_V4
    else process.env.ECS_CONTAINER_METADATA_URI_V4 = prevEcsMetadata
    if (prevPort === undefined) delete process.env.PORT
    else process.env.PORT = prevPort
  })

  it('has a contract row for every ALL_RUNNERS entry', () => {
    for (const { name } of ALL_RUNNERS) {
      expect(CONTRACTS, `missing host-address contract for runner "${name}"`).toHaveProperty(name)
    }
  })

  it.each(ALL_RUNNERS.map((r) => r.name))('%s satisfies its host-address contract', async (name) => {
    const contract = CONTRACTS[name]
    const Client = getContainerClientClass(name)
    const client = new Client({ agentId: `contract-${name}` })

    if (contract.kind === 'gateway-name') {
      const address = client.getContainerHostAddress()
      expect(address).toBe(contract.address)
      expect(await client.getHostApiBaseUrl()).toContain(address)
      return
    }

    if (contract.kind === 'apple') {
      // Cache + getHostBridgeIp: apple-container-client.test.ts. Here: resolve + fail-closed.
      mockExecSyncWithPath.mockReturnValue(
        Buffer.from(JSON.stringify([{ status: { ipv4Gateway: '192.168.64.1' } }])),
      )
      const address = client.getContainerHostAddress()
      expect(address).toBe('192.168.64.1')
      expect(await client.getHostApiBaseUrl()).toContain(address)

      resetAppleContainerClientForTests()
      mockExecSyncWithPath.mockImplementation(() => {
        throw new Error('network inspect failed')
      })
      const closed = new Client({ agentId: `contract-${name}-closed` })
      expect(() => closed.getContainerHostAddress()).toThrow(/host gateway is unreachable/i)
      expect(() => closed.getHostApiBaseUrl()).toThrow(/host gateway is unreachable/i)
      return
    }

    // Public URL only; lambda's ECS private-IP path is in lambda-microvm-runtime.test.ts.
    expect(await client.getHostApiBaseUrl()).toBe('https://host.example')
  })
})
