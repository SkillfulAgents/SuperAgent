import { describe, it, expect, afterEach, vi } from 'vitest'

// SUP-217: DockerContainerClient.getHostBridgeIp() drives the CDP-proxy decision.
// On native Linux the container reaches the host via the docker0 bridge gateway
// (a real host interface) -> proxy; on macOS/Windows Docker Desktop forwards host
// loopback -> null (no proxy). Control os.networkInterfaces() to exercise both.
const h = vi.hoisted(() => {
  let ifaces: Record<string, unknown> = {}
  return { setIfaces: (v: Record<string, unknown>) => { ifaces = v }, networkInterfaces: () => ifaces }
})

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const networkInterfaces = () => h.networkInterfaces()
  return { ...actual, networkInterfaces, default: { ...actual, networkInterfaces } }
})

import { DockerContainerClient } from './docker-container-client'

const originalPlatform = process.platform
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

const client = () => new DockerContainerClient({ agentId: 'x' } as never)
const v4 = (address: string, internal = false) => ({
  address, family: 'IPv4', internal, netmask: '255.255.0.0', mac: '00:00:00:00:00:00', cidr: null,
})

describe('DockerContainerClient.getHostBridgeIp (SUP-217)', () => {
  afterEach(() => setPlatform(originalPlatform))

  it('returns the docker0 gateway IP on Linux', () => {
    setPlatform('linux')
    h.setIfaces({ docker0: [v4('172.17.0.1')], en0: [v4('192.168.1.50')] })
    expect(client().getHostBridgeIp()).toBe('172.17.0.1')
  })

  it('returns null on macOS / Windows (Docker Desktop forwards host loopback)', () => {
    h.setIfaces({ docker0: [v4('172.17.0.1')] })
    setPlatform('darwin')
    expect(client().getHostBridgeIp()).toBeNull()
    setPlatform('win32')
    expect(client().getHostBridgeIp()).toBeNull()
  })

  it('returns null on Linux when docker0 is absent', () => {
    setPlatform('linux')
    h.setIfaces({ en0: [v4('192.168.1.50')] })
    expect(client().getHostBridgeIp()).toBeNull()
  })

  it('ignores an internal-only docker0 address', () => {
    setPlatform('linux')
    h.setIfaces({ docker0: [v4('127.0.0.1', true)] })
    expect(client().getHostBridgeIp()).toBeNull()
  })
})
