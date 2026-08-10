import net from 'net'
import os from 'os'

/**
 * Verdict of a host-side reachability probe. Only a positive 'unreachable'
 * verdict may fail an agent start; anything ambiguous is 'unknown' and never
 * blocks (same rule the CDP proxy probe follows in chrome-provider.ts).
 */
export type LoopbackProbeResult = 'reachable' | 'unreachable' | 'unknown'

export interface LoopbackProbeTarget {
  host: string
  port: number
}

/**
 * True if `address` is assigned to a local network interface.
 *
 * This is the whole gate. A runtime whose container-host address is a real
 * interface of ours (Apple Container's vmnet gateway) puts the guest on the
 * network side of that interface, so it only reaches services actually bound
 * to it. Runtimes that hand back a *name* — host.docker.internal on
 * Docker/Lima/WSL2, host.containers.internal on Podman — never match, because
 * those names are forwarders that reach the host's loopback regardless of
 * bind. Callers therefore no-op on every runtime but Apple.
 *
 * chrome-provider.ts carries the same predicate for the CDP bind decision;
 * SUP-459 is the consolidation point for both.
 */
export function isLocalInterfaceAddress(address: string): boolean {
  return Object.values(os.networkInterfaces()).some((addrs) =>
    addrs?.some((addr) => addr.address === address),
  )
}

/**
 * Decide whether a container-bound LLM URL is worth probing from the host, and
 * at which port. Returns null when the check does not apply: no URL, no host
 * address, an unparseable URL, or a runtime whose host address is a forwarding
 * name rather than one of our interfaces.
 *
 * Only a URL that `rewriteLoopbackForContainer` actually rewrote is a
 * candidate — its hostname is the runtime host address. A URL pointing
 * somewhere else (a remote endpoint) was never a loopback problem.
 */
export function resolveLoopbackProbeTarget(
  containerUrl: string | undefined,
  hostAddress: string | undefined,
  isLocalInterface: (address: string) => boolean = isLocalInterfaceAddress,
): LoopbackProbeTarget | null {
  if (!containerUrl || !hostAddress) return null
  if (!isLocalInterface(hostAddress)) return null

  let parsed: URL
  try {
    parsed = new URL(containerUrl)
  } catch {
    return null
  }
  if (parsed.hostname !== hostAddress) return null

  // URL rejects non-numeric and out-of-range ports at parse time; 0 is the one
  // value that survives parsing and still cannot be connected to.
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  if (port === 0) return null
  return { host: hostAddress, port }
}

/**
 * TCP-connect to a host interface from the host itself. The host sees the same
 * refusal the guest would: a service bound only to 127.0.0.1 is absent from
 * every other interface, so connecting to the gateway IP is refused here for
 * exactly the reason it is refused inside the container. That makes this probe
 * a plain socket connect — no container spawn, no runtime-specific transport.
 *
 * ECONNREFUSED is the one definitive verdict (nothing is listening on that
 * interface). Everything else — timeouts, DNS, permission errors — is ambiguous
 * and reported as 'unknown' so it can never fail a start.
 */
export function probeHostInterfacePort(
  { host, port }: LoopbackProbeTarget,
  timeoutMs = 1000,
): Promise<LoopbackProbeResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    const finish = (result: LoopbackProbeResult) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => finish('reachable'))
    socket.on('timeout', () => finish('unknown'))
    socket.on('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ECONNREFUSED' ? 'unreachable' : 'unknown'),
    )
    socket.connect(port, host)
  })
}

/**
 * Why a local model is unreachable from the container. A refusal at the host
 * interface has two very different causes with two different fixes, so the
 * loopback address is probed as well to tell them apart:
 *
 *   - 'loopback-only': the server answers on 127.0.0.1 but not on the
 *     interface the guest arrives at. Wrong bind; the port is otherwise fine.
 *   - 'not-running': nothing answers anywhere. Telling this user to change a
 *     bind would send them after the wrong problem entirely.
 */
export type LocalLlmDiagnosis = 'reachable' | 'loopback-only' | 'not-running' | 'unknown'

export async function diagnoseLocalLlm(
  target: LoopbackProbeTarget,
  probe: (t: LoopbackProbeTarget) => Promise<LoopbackProbeResult> = probeHostInterfacePort,
): Promise<LocalLlmDiagnosis> {
  const viaInterface = await probe(target)
  if (viaInterface === 'reachable') return 'reachable'
  // Anything short of a definitive refusal stays ambiguous and never blocks.
  if (viaInterface !== 'unreachable') return 'unknown'
  const viaLoopback = await probe({ host: '127.0.0.1', port: target.port })
  return viaLoopback === 'reachable' ? 'loopback-only' : 'not-running'
}

/**
 * The product-facing explanation for an unreachable local model. Names the
 * cause the probes actually established and the fix that follows from it.
 */
export function describeUnreachableLocalLlm(
  { host, port }: LoopbackProbeTarget,
  diagnosis: Extract<LocalLlmDiagnosis, 'loopback-only' | 'not-running'>,
): string {
  const preamble =
    `The local model server on port ${port} is not reachable from the agent container. ` +
    `Agents run in a VM that reaches this Mac at ${host}`

  if (diagnosis === 'not-running') {
    return (
      `${preamble}, and nothing is listening on port ${port} on this Mac at all.\n\n` +
      `Start the model server, then start the agent again. If it is already running, ` +
      `check that it is on port ${port} and that the endpoint configured in Settings ` +
      `matches.`
    )
  }

  return (
    `${preamble}. The server is running but bound to 127.0.0.1 only, so it answers on ` +
    `this Mac and is invisible to the container. That is the default for Ollama, ` +
    `LM Studio and llama.cpp.\n\n` +
    `Restart it bound to all interfaces, then start the agent again:\n` +
    `  • Ollama: set OLLAMA_HOST=0.0.0.0 (launchctl setenv OLLAMA_HOST 0.0.0.0, then restart Ollama)\n` +
    `  • LM Studio: enable "Serve on Local Network" in the server settings\n` +
    `  • llama.cpp: start it with --host 0.0.0.0`
  )
}
