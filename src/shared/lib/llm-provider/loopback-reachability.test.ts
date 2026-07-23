import net from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeUnreachableLocalLlm,
  diagnoseLocalLlm,
  probeHostInterfacePort,
  resolveLoopbackProbeTarget,
  type LoopbackProbeResult,
  type LoopbackProbeTarget,
} from './loopback-reachability'

const APPLE_GATEWAY = '192.168.64.1'
// Only Apple's gateway is one of our interfaces; every other runtime hands back
// a forwarding name, which must never be probed.
const isAppleGateway = (address: string) => address === APPLE_GATEWAY

describe('resolveLoopbackProbeTarget', () => {
  it('targets the rewritten port when the host address is one of our interfaces', () => {
    expect(
      resolveLoopbackProbeTarget(`http://${APPLE_GATEWAY}:11434`, APPLE_GATEWAY, isAppleGateway),
    ).toEqual({ host: APPLE_GATEWAY, port: 11434 })
  })

  // The byte-identical-behavior guard for Docker/Lima/WSL2/Podman: their host
  // address is a forwarding name that reaches the host loopback whatever the
  // bind, so there is nothing to probe and no start to fail.
  it('never probes a forwarding-name host address', () => {
    for (const name of ['host.docker.internal', 'host.containers.internal']) {
      expect(
        resolveLoopbackProbeTarget(`http://${name}:11434`, name, isAppleGateway),
      ).toBeNull()
    }
  })

  it('ignores an endpoint the loopback rewrite never touched', () => {
    // A remote model endpoint keeps its own hostname — probing the gateway
    // would be testing an address this agent will never call.
    expect(
      resolveLoopbackProbeTarget('http://ollama.example.com:11434', APPLE_GATEWAY, isAppleGateway),
    ).toBeNull()
  })

  it('falls back to the scheme default when the URL carries no port', () => {
    expect(resolveLoopbackProbeTarget(`http://${APPLE_GATEWAY}`, APPLE_GATEWAY, isAppleGateway))
      .toEqual({ host: APPLE_GATEWAY, port: 80 })
    expect(resolveLoopbackProbeTarget(`https://${APPLE_GATEWAY}`, APPLE_GATEWAY, isAppleGateway))
      .toEqual({ host: APPLE_GATEWAY, port: 443 })
  })

  it('returns null for a missing or unparseable URL', () => {
    expect(resolveLoopbackProbeTarget(undefined, APPLE_GATEWAY, isAppleGateway)).toBeNull()
    expect(resolveLoopbackProbeTarget('not-a-url', APPLE_GATEWAY, isAppleGateway)).toBeNull()
  })
})

describe('probeHostInterfacePort', () => {
  const servers: net.Server[] = []

  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  const listen = (): Promise<LoopbackProbeTarget> =>
    new Promise((resolve) => {
      const server = net.createServer()
      servers.push(server)
      server.listen(0, '127.0.0.1', () =>
        resolve({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port }),
      )
    })

  it('reports a listening port as reachable', async () => {
    expect(await probeHostInterfacePort(await listen())).toBe('reachable')
  })

  // The verdict that fails an agent start. Nothing bound to the address means
  // the container's connection would be refused for the same reason.
  it('reports a refused connection as unreachable', async () => {
    const target = await listen()
    for (const server of servers.splice(0)) server.close()
    expect(await probeHostInterfacePort(target)).toBe('unreachable')
  })

  // Anything short of a definitive refusal must stay ambiguous, so a probe that
  // cannot run never blocks a start.
  it('reports an unresolvable address as unknown, not unreachable', async () => {
    expect(
      await probeHostInterfacePort({ host: 'no-such-host.invalid', port: 11434 }),
    ).toBe('unknown')
  })
})

describe('diagnoseLocalLlm', () => {
  const target: LoopbackProbeTarget = { host: APPLE_GATEWAY, port: 11434 }
  // Answers per address, so the loopback follow-up probe is what separates
  // "wrong bind" from "nothing there".
  const probeReturning = (byHost: Record<string, LoopbackProbeResult>) => (t: LoopbackProbeTarget) =>
    Promise.resolve(byHost[t.host] ?? 'unreachable')

  it('separates a wrong bind from a server that is not running', async () => {
    expect(
      await diagnoseLocalLlm(
        target,
        probeReturning({ [APPLE_GATEWAY]: 'unreachable', '127.0.0.1': 'reachable' }),
      ),
    ).toBe('loopback-only')

    expect(
      await diagnoseLocalLlm(
        target,
        probeReturning({ [APPLE_GATEWAY]: 'unreachable', '127.0.0.1': 'unreachable' }),
      ),
    ).toBe('not-running')
  })

  it('never blocks on an ambiguous interface probe', async () => {
    expect(await diagnoseLocalLlm(target, probeReturning({ [APPLE_GATEWAY]: 'unknown' }))).toBe(
      'unknown',
    )
  })

  it('reports a reachable interface without a second probe', async () => {
    expect(await diagnoseLocalLlm(target, probeReturning({ [APPLE_GATEWAY]: 'reachable' }))).toBe(
      'reachable',
    )
  })
})

describe('describeUnreachableLocalLlm', () => {
  const target: LoopbackProbeTarget = { host: APPLE_GATEWAY, port: 11434 }

  // The bind advice is only correct when a bind is actually the problem;
  // handing it to someone whose server is down sends them after the wrong bug.
  it('advises a rebind only for a wrong bind, never for a stopped server', () => {
    expect(describeUnreachableLocalLlm(target, 'loopback-only')).toMatch(/OLLAMA_HOST=0\.0\.0\.0/)
    expect(describeUnreachableLocalLlm(target, 'not-running')).not.toMatch(/OLLAMA_HOST/)
  })
})
