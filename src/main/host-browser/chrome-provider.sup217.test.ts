import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// SUP-217 — Electron host-browser exposes Chrome DevTools Protocol on all
// interfaces.
//
// ChromeProvider.launch() spawns Chrome with `--remote-debugging-address=0.0.0.0`
// and, on Windows, runs the fallback forwarding proxy bound to `0.0.0.0`. CDP has
// no auth token, so anything reachable on the LAN can fully remote-control the
// dedicated Chrome profile. These tests pin the guardrail: CDP / the forwarding
// proxy must bind to loopback (or a specific host-internal bridge interface),
// never all interfaces.
//
// Against current `main` (which passes 0.0.0.0) both cases FAIL; after the fix
// they pass.
// ---------------------------------------------------------------------------

// Hoisted shared mock state — referenced by the vi.mock factories (which are
// hoisted above the imports) and by the tests.
const h = vi.hoisted(() => {
  const listenCalls: Array<{ port: unknown; host: unknown }> = []
  const killedPids: number[] = []
  let failProxyListen = false
  let proxyCloseCount = 0

  // isProxy distinguishes the CDP forwarding proxy (created with a connection
  // listener) from findFreePort's throwaway server (created with no args).
  function makeServer(isProxy: boolean) {
    const handlers: Record<string, (...a: unknown[]) => void> = {}
    const server: Record<string, unknown> = {
      listen: (port: unknown, host: unknown, cb?: unknown) => {
        listenCalls.push({ port, host })
        if (isProxy && failProxyListen) {
          queueMicrotask(() => handlers.error?.(Object.assign(new Error('EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' })))
        } else if (typeof cb === 'function') {
          (cb as () => void)()
        }
        return server
      },
      on: (ev: string, cb: (...a: unknown[]) => void) => { handlers[ev] = cb; return server },
      address: () => ({ port: 9999 }),
      close: (cb?: unknown) => {
        if (isProxy) proxyCloseCount++
        if (typeof cb === 'function') (cb as () => void)()
        return server
      },
    }
    return server
  }

  function makeChild(pid: number) {
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    return {
      pid,
      killed: false,
      stderr: { on: () => {} },
      on(ev: string, cb: (...a: unknown[]) => void) {
        ;(handlers[ev] = handlers[ev] || []).push(cb)
        return this
      },
      kill() {
        this.killed = true
        killedPids.push(pid)
        // Simulate process exit so stop()'s exit-wait resolves promptly (no 5s timeout).
        queueMicrotask(() => (handlers.exit || []).forEach((cb) => cb(0, null)))
        return true
      },
    }
  }

  class Socket {
    private _h: Record<string, () => void> = {}
    setTimeout() {}
    on(ev: string, cb: () => void) {
      this._h[ev] = cb
      return this
    }
    connect() {
      // Report the port as open so waitForPort() resolves immediately.
      queueMicrotask(() => this._h.connect?.())
      return this
    }
    destroy() {}
  }

  const createServer = vi.fn((listener?: unknown) => makeServer(typeof listener === 'function'))
  const connect = vi.fn(() => ({ pipe: () => {}, on: () => {}, destroy: () => {} }))
  const netMock = { createServer, connect, Socket }

  const spawnMock = vi.fn((_cmd: string, _args: string[]) => makeChild(4321))
  const execSyncMock = vi.fn(() => 'default via 172.22.192.1 dev eth0')

  // The active container runner's host-bridge IP, as ChromeProvider reads it via
  // containerManager.getClient().getHostBridgeIp(). null = a loopback-forwarding
  // runner (Docker Desktop); a string = a runner that routes containers through a
  // real bridge gateway (Lima, WSL2, native Docker/Podman).
  let hostBridgeIp: string | null = null
  const getHostBridgeIp = vi.fn(() => hostBridgeIp)
  function setHostBridgeIp(ip: string | null) { hostBridgeIp = ip }

  // Which IPs this host "has" as local interfaces — controls whether ChromeProvider
  // treats a reported bridge IP as bindable (run the proxy) or virtual (skip the
  // proxy, loopback-direct). A virtual user-mode gateway (e.g. Lima 192.168.5.2) is
  // NOT in this set, so binding it would throw EADDRNOTAVAIL.
  let localIps: string[] = []
  function setLocalIps(ips: string[]) { localIps = ips }
  function networkInterfaces() {
    return {
      test0: localIps.map((address) => ({
        address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null,
      })),
    }
  }

  function reset() {
    listenCalls.length = 0
    killedPids.length = 0
    failProxyListen = false
    proxyCloseCount = 0
    hostBridgeIp = null
    localIps = []
    getHostBridgeIp.mockClear()
    spawnMock.mockClear().mockImplementation((_cmd: string, _args: string[]) => makeChild(4321))
    execSyncMock.mockClear().mockImplementation(() => 'default via 172.22.192.1 dev eth0')
    createServer.mockClear()
    connect.mockClear()
  }

  return {
    listenCalls, createServer, connect, netMock, spawnMock, execSyncMock,
    getHostBridgeIp, setHostBridgeIp, networkInterfaces, setLocalIps, reset,
    killedPids,
    setFailProxyListen: (v: boolean) => { failProxyListen = v },
    getProxyCloseCount: () => proxyCloseCount,
  }
})

vi.mock('child_process', () => ({ spawn: h.spawnMock, execSync: h.execSyncMock }))

// ChromeProvider only binds the proxy to a bridge IP that is an actual local
// interface; otherwise it falls back to loopback-direct. Control the interface
// list per test, preserving the rest of `os`.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const networkInterfaces = () => h.networkInterfaces()
  return { ...actual, networkInterfaces, default: { ...actual, networkInterfaces } }
})

vi.mock('net', () => ({ default: h.netMock, ...h.netMock }))

vi.mock('fs', () => {
  const m = {
    existsSync: () => true,
    mkdirSync: () => undefined,
    rmSync: () => undefined,
    readFileSync: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    writeFileSync: () => undefined,
    // Low-level calls used by the atomic writer (writeFileAtomicSync) for the
    // Chrome Preferences write — stubbed; this test only asserts CDP
    // bind behaviour, not Preferences contents.
    openSync: () => 1,
    fsyncSync: () => undefined,
    fchmodSync: () => undefined,
    closeSync: () => undefined,
    renameSync: () => undefined,
    statSync: () => ({ size: 0, mtimeMs: 0 }),
    accessSync: () => undefined,
    readdirSync: () => [],
    readlinkSync: () => '',
    constants: { X_OK: 1 },
  }
  return { default: m, ...m }
})

vi.mock('@shared/lib/config/data-dir', () => ({
  getDataDir: () => '/tmp/sa-sup217-data',
  getAgentDownloadsDir: () => '/tmp/sa-sup217-downloads',
}))

vi.mock('@shared/lib/browser/chrome-profile', () => ({
  listChromeProfiles: () => [],
  copyChromeProfileData: () => false,
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: () => {},
  addErrorBreadcrumb: () => {},
}))

// ChromeProvider asks the active container runner how its containers reach the
// host (getHostBridgeIp), and runs the CDP proxy bound to that IP. Mock the
// manager so each test controls that answer without loading container-manager.
vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    getClient: () => ({ getHostBridgeIp: h.getHostBridgeIp }),
  },
}))

import { ChromeProvider } from './chrome-provider'

const originalPlatform = process.platform
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

/** Find the spawned Chrome arg list (the one carrying --remote-debugging-port). */
function getChromeArgs(): string[] | null {
  for (const call of h.spawnMock.mock.calls) {
    const argList = call[1]
    if (
      Array.isArray(argList) &&
      argList.some((a) => typeof a === 'string' && a.startsWith('--remote-debugging-port='))
    ) {
      return argList as string[]
    }
  }
  return null
}

describe('ChromeProvider CDP bind address (SUP-217)', () => {
  let provider: ChromeProvider

  beforeEach(() => {
    h.reset()
    provider = new ChromeProvider()
  })

  afterEach(() => {
    setPlatform(originalPlatform)
  })

  it('always binds Chrome CDP to loopback, never 0.0.0.0', async () => {
    setPlatform('linux')
    h.setHostBridgeIp(null)

    await provider.launch('agent1')

    const args = getChromeArgs()
    expect(args, 'Chrome should have been spawned with debugging args').not.toBeNull()
    // The vulnerability: CDP advertised on every interface.
    expect(args).not.toContain('--remote-debugging-address=0.0.0.0')
    // The guardrail: loopback-only (a proxy, when needed, forwards to it).
    expect(args).toContain('--remote-debugging-address=127.0.0.1')
  })

  it('loopback-forwarding runner (no bridge IP, e.g. Docker Desktop): no proxy, only loopback binds', async () => {
    // host.docker.internal forwards to the host loopback, so the container reaches
    // Chrome's 127.0.0.1 port directly — nothing is bound to a broader interface.
    setPlatform('linux')
    h.setHostBridgeIp(null)

    await provider.launch('agent1')

    const hosts = h.listenCalls.map((c) => c.host)
    expect(hosts.length).toBeGreaterThan(0) // findFreePort binds loopback
    expect(hosts.every((host) => host === '127.0.0.1')).toBe(true)
    expect(hosts).not.toContain('0.0.0.0')
  })

  it('bridged runner with a real host interface (socket_vmnet / docker0): proxy binds that IP, never 0.0.0.0', async () => {
    // A shared bridge gateway (e.g. socket_vmnet 192.168.105.1, or docker0) is an
    // actual host interface and does NOT forward loopback, so the CDP proxy must
    // bind exactly that host-internal IP — never 0.0.0.0. (Proxy selection is
    // platform-independent; linux spawns cleanly in-harness.)
    setPlatform('linux')
    h.setHostBridgeIp('192.168.105.1')
    h.setLocalIps(['192.168.105.1']) // it IS a bindable host interface

    await provider.launch('agent1')

    const hosts = h.listenCalls.map((c) => c.host)
    expect(hosts).toContain('192.168.105.1') // proxy bound to the runner's bridge IP
    expect(hosts).not.toContain('0.0.0.0')

    const args = getChromeArgs()
    expect(args).not.toBeNull()
    expect(args).not.toContain('--remote-debugging-address=0.0.0.0')
    expect(args).toContain('--remote-debugging-address=127.0.0.1')
  })

  it('Lima user-mode / VZ-NAT virtual gateway (not a host interface): no proxy, loopback-direct — never tries to bind it', async () => {
    // Regression for EADDRNOTAVAIL: the bundled Lima (vmType: vz, no networks) uses
    // user-mode networking whose gateway (e.g. 192.168.5.2) is virtual — NOT a host
    // interface — so binding a proxy there throws. It also needs no proxy: that mode
    // forwards the gateway to the host loopback, so the container reaches Chrome's
    // 127.0.0.1 directly. We must detect the gateway isn't bindable and skip the proxy.
    setPlatform('linux')
    h.setHostBridgeIp('192.168.5.2')
    h.setLocalIps([]) // 192.168.5.2 is NOT a local interface (virtual gateway)

    await provider.launch('agent1')

    const hosts = h.listenCalls.map((c) => c.host)
    // Never attempt to bind the virtual gateway (that was the EADDRNOTAVAIL crash)…
    expect(hosts).not.toContain('192.168.5.2')
    expect(hosts).not.toContain('0.0.0.0')
    // …only the loopback findFreePort bind remains; Chrome stays on loopback.
    expect(hosts.every((host) => host === '127.0.0.1')).toBe(true)
    const args = getChromeArgs()
    expect(args).toContain('--remote-debugging-address=127.0.0.1')
  })

  it('win32 (WSL2): proxy binds the gateway IP, never 0.0.0.0; Chrome arg loopback', async () => {
    // On Windows Chrome ignores --remote-debugging-address and always binds
    // loopback, so the proxy is required; it must bind the WSL2 gateway IP.
    setPlatform('win32')
    h.setHostBridgeIp('172.22.192.1')
    h.setLocalIps(['172.22.192.1']) // WSL2's vEthernet adapter is a real host interface

    await provider.launch('agent1')

    const hosts = h.listenCalls.map((c) => c.host)
    expect(hosts.length).toBeGreaterThan(0)
    expect(hosts).toContain('172.22.192.1')
    expect(hosts).not.toContain('0.0.0.0')

    const args = getChromeArgs()
    expect(args).not.toBeNull()
    expect(args).not.toContain('--remote-debugging-address=0.0.0.0')
    expect(args).toContain('--remote-debugging-address=127.0.0.1')
  })

  it('falls back to loopback-direct (no proxy) if the runner bridge-IP lookup throws', async () => {
    // getHostBridgeIp() wraps containerManager.getClient().getHostBridgeIp() in try/catch;
    // a throwing runner must degrade to loopback-direct, never crash or bind 0.0.0.0.
    setPlatform('linux')
    h.getHostBridgeIp.mockImplementationOnce(() => { throw new Error('runner unavailable') })

    await expect(provider.launch('agent1')).resolves.toBeTruthy()

    const hosts = h.listenCalls.map((c) => c.host)
    expect(hosts.every((host) => host === '127.0.0.1')).toBe(true)
    expect(hosts).not.toContain('0.0.0.0')
  })

  it('kills the spawned Chrome and fails the launch if the proxy bind fails (no orphan)', async () => {
    // A bindable bridge IP can still fail to listen (port race, interface down). Chrome
    // is already spawned but not yet registered, so the orphan guard must tear it down.
    setPlatform('linux')
    h.setHostBridgeIp('192.168.105.1')
    h.setLocalIps(['192.168.105.1'])
    h.setFailProxyListen(true)

    await expect(provider.launch('agent1')).rejects.toThrow(/CDP proxy/i)
    expect(h.killedPids).toContain(4321) // the spawned Chrome was killed, not orphaned
  })

  it('closes the CDP proxy server on stop() for a bridged runner', async () => {
    setPlatform('linux')
    h.setHostBridgeIp('192.168.105.1')
    h.setLocalIps(['192.168.105.1'])

    await provider.launch('agent1')
    expect(h.getProxyCloseCount()).toBe(0)

    await provider.stop('agent1')
    expect(h.getProxyCloseCount()).toBeGreaterThan(0)
  })
})
