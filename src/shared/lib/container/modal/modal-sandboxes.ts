/**
 * The live Modal sandbox of each agent, shared by the runtime client that
 * starts and stops it and the actor that writes through it while it runs.
 *
 * A leaf on purpose: the actor package imports this and the volume client,
 * never the runtime client, so building an agent handle pulls in no container
 * runtime code (and none of its process-spawning dependencies).
 */
import type { Sandbox } from 'modal'

export interface SandboxState {
  sandbox: Sandbox
  /** The tunnel's public HTTPS origin for the container API port. */
  baseUrl: string
}

// One live sandbox per agent, whatever client instance started it: the
// runtime may rebuild its client while the sandbox keeps running.
const sandboxes = new Map<string, SandboxState>()

export function getSandbox(slug: string): SandboxState | undefined {
  return sandboxes.get(slug)
}

export function setSandbox(slug: string, state: SandboxState): void {
  sandboxes.set(slug, state)
}

/** Forget the agent's sandbox. With `sandbox` given, only if it is still that one. */
export function forgetSandbox(slug: string, sandbox?: Sandbox): void {
  if (sandbox && sandboxes.get(slug)?.sandbox !== sandbox) return
  sandboxes.delete(slug)
}
