/**
 * Running an approved computer-use command or host script for one of the
 * agent's requests. The agent's half of the work happens here: its grants,
 * the request's settlement, the container's pending input and the session's
 * grabbed app. The machine work itself (driving apps, running the script) is
 * the host's, through the host port.
 *
 * A request gets approved in one of two ways, and both come through here: the
 * user decides in the app (the decision routes), or a grant the agent already
 * holds covers it as it arrives (the actor). Each run claims its request first,
 * so a tool call delivered twice (a subagent's comes on two paths) or a
 * double click never drives the machine twice.
 */
import type { HostPort, HostScriptOutput, ComputerUsePermissionStatus } from './host-port'
import type { ComputerUseOps, ContainerOps, InputOps, MessageOps } from './types'
import type { PendingUserInputRequest } from '@shared/lib/tools/requests/request-schema'
import { resolveTargetApp, type ComputerUsePermissionLevel, type PermissionGrantType } from '@shared/lib/computer-use/types'

/** The parts of the agent's actor a run uses. */
export interface HostRunActor {
  readonly inputs: Pick<InputOps, 'claim' | 'releaseClaim' | 'resolve' | 'complete'> & {
    readonly computerUse: Pick<ComputerUseOps, 'grant' | 'consumeOnce' | 'setGrabbedApp' | 'clearGrabbedApp' | 'clearPending'>
  }
  readonly container: Pick<ContainerOps, 'fetch'>
  readonly messages: Pick<MessageOps, 'broadcastEvent'>
}

export interface ComputerUseRun {
  sessionId: string
  toolUseId: string
  method: string
  params: Record<string, unknown>
  permissionLevel: ComputerUsePermissionLevel
  appName?: string
  /** What the user granted with this approval; absent when a grant the agent holds covered it. */
  grantType?: PermissionGrantType
}

export interface ScriptRun {
  sessionId: string
  toolUseId: string
  script: string
  scriptType: string
  /** What the user granted with this approval; absent when a grant the agent holds covered it. */
  grantType?: PermissionGrantType
}

export type HostRunOutcome =
  /** Ran, and the container has the result. */
  | { status: 'resolved' }
  /** Another decision holds the request; this one did nothing. */
  | { status: 'claimed' }
  /** Computer use lacks macOS permissions; nothing ran and the request is still open. */
  | { status: 'missing_permissions'; permissions: ComputerUsePermissionStatus }
  /** The command failed; the agent got the error and the request is settled. */
  | { status: 'failed'; error: string }
  /** It ran, but the container would not take the result; the request is still open. */
  | { status: 'undeliverable'; detail: string }

export async function runComputerUse(actor: HostRunActor, host: HostPort, run: ComputerUseRun): Promise<HostRunOutcome> {
  const { sessionId, toolUseId, method, params, permissionLevel, appName, grantType } = run
  const { computerUse } = actor.inputs
  return withClaim(actor, toolUseId, async () => {
    const permissions = await host.call('computerUsePermissions', {})
    if (permissions) return { status: 'missing_permissions', permissions }

    if (grantType) computerUse.grant(permissionLevel, grantType, appName)

    let output: string
    try {
      output = await host.call('computerUse', { method, params })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The agent sees the failure as its tool's error.
      await rejectInput(actor, toolUseId, `Error executing ${method}: ${message}`).catch(() => {})
      // The approval was spent on a system failure, not on a decision.
      computerUse.clearPending(sessionId, toolUseId, 'invalidated')
      return { status: 'failed', error: message }
    }

    // Launching grabs the app, so it counts as a grab.
    if (method === 'grab' || method === 'launch') {
      const targetApp = appName || resolveTargetApp(method, params)
      if (targetApp) {
        computerUse.setGrabbedApp(targetApp)
        // The name now; the icon when the host has found it.
        actor.messages.broadcastEvent(sessionId, { type: 'computer_use_grab_changed', app: targetApp })
        host.call('computerUseAppIcon', { app: targetApp }).then((icon) => {
          if (icon) actor.messages.broadcastEvent(sessionId, { type: 'computer_use_grab_changed', app: targetApp, appIcon: icon })
        }).catch(() => {})
      }
    } else if (method === 'ungrab' || method === 'quit') {
      computerUse.clearGrabbedApp()
      actor.messages.broadcastEvent(sessionId, { type: 'computer_use_grab_changed', app: null })
    }

    if (grantType === 'once') computerUse.consumeOnce(permissionLevel, appName)

    const undelivered = await resolveInput(actor, toolUseId, output)
    if (undelivered !== null) return { status: 'undeliverable', detail: undelivered }
    computerUse.clearPending(sessionId, toolUseId, 'answered')
    host.send('analytics', { event: 'computer_use_executed', properties: { method, permissionLevel, grantType } })
    return { status: 'resolved' }
  })
}

export async function runScript(actor: HostRunActor, host: HostPort, run: ScriptRun): Promise<HostRunOutcome> {
  const { sessionId, toolUseId, script, scriptType, grantType } = run
  return withClaim(actor, toolUseId, async (request) => {
    if (grantType) actor.inputs.computerUse.grant('use_host_shell', grantType)
    const result = await host.call('hostScript', { script, scriptType })
    if (grantType === 'once') actor.inputs.computerUse.consumeOnce('use_host_shell')

    const undelivered = await resolveInput(actor, toolUseId, formatScriptOutput(result))
    if (undelivered !== null) return { status: 'undeliverable', detail: undelivered }
    if (request.autoApproved) {
      // No tab ever showed this request, so none needs telling it settled.
      actor.inputs.resolve(toolUseId, 'answered')
    } else {
      actor.inputs.complete(sessionId, toolUseId, 'answered')
    }
    host.send('analytics', { event: 'script_executed', properties: { scriptType, exitCode: result.exitCode } })
    return { status: 'resolved' }
  })
}

// A command or script nobody is watching gets this long before the agent's
// call fails instead of staying parked.
const AUTO_RUN_TIMEOUT_MS = { computerUse: 30_000, script: 35_000 }

export type AutoApprovedRun = ({ kind: 'computerUse' } & ComputerUseRun) | ({ kind: 'script' } & ScriptRun)

/**
 * Run a request that a grant the agent already holds covers, as it arrives.
 * Nobody waits on it, so it is settled however it ends: a run that cannot
 * start, fails, or takes too long fails the agent's tool call rather than
 * leaving it parked. A second delivery of the same call finds the first run
 * holding the request and does nothing.
 */
export async function runAutoApproved(actor: HostRunActor, host: HostPort, run: AutoApprovedRun): Promise<void> {
  const { sessionId, toolUseId } = run
  const giveUp = async (reason: string) => {
    await rejectInput(actor, toolUseId, reason).catch((error) => {
      console.error(`[HostRuns] Failed to reject ${toolUseId} after a failed auto-run:`, error)
    })
    if (run.kind === 'computerUse') actor.inputs.computerUse.clearPending(sessionId, toolUseId, 'invalidated')
    else actor.inputs.resolve(toolUseId, 'invalidated')
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutMs = AUTO_RUN_TIMEOUT_MS[run.kind]
  const timedOut = new Promise<'timed_out'>((resolve) => {
    timer = setTimeout(() => resolve('timed_out'), timeoutMs)
  })
  try {
    const outcome = await Promise.race([
      run.kind === 'computerUse' ? runComputerUse(actor, host, run) : runScript(actor, host, run),
      timedOut,
    ])
    if (outcome === 'timed_out') {
      // The machine work cannot be called back; if it finishes, its result
      // finds the call already failed and goes nowhere.
      await giveUp(`Auto-execute failed: no result after ${timeoutMs / 1000} seconds`)
    } else if (outcome.status === 'missing_permissions') {
      const missing = [
        outcome.permissions.accessibility ? null : 'Accessibility',
        outcome.permissions.screen_recording ? null : 'Screen Recording',
      ].filter(Boolean)
      await giveUp(`Auto-execute failed: computer use is missing macOS permissions on this machine: ${missing.join(', ')}`)
    } else if (outcome.status === 'undeliverable') {
      console.error(`[HostRuns] Auto-run of ${toolUseId} finished, but the container did not take the result: ${outcome.detail}`)
    }
  } catch (error) {
    console.error(`[HostRuns] Auto-run of ${toolUseId} failed:`, error)
    await giveUp(`Auto-execute failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

/** Fail the container's pending input with a reason the agent reads. */
export function rejectInput(actor: HostRunActor, toolUseId: string, reason: string): Promise<Response> {
  return actor.container.fetch(`/inputs/${encodeURIComponent(toolUseId)}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  })
}

/**
 * Run while holding the request's claim, and give the claim back afterwards.
 * A run that settled the request dropped the claim with it, so giving it back
 * only matters to one that did not (or threw): the request stays open for the
 * next decision.
 */
async function withClaim(
  actor: HostRunActor,
  toolUseId: string,
  run: (request: PendingUserInputRequest) => Promise<HostRunOutcome>,
): Promise<HostRunOutcome> {
  const claim = await actor.inputs.claim(toolUseId)
  if (!claim) return { status: 'claimed' }
  try {
    return await run(claim.request)
  } finally {
    await actor.inputs.releaseClaim(toolUseId, claim.token)
  }
}

/** Deliver a value to the container's pending input; null when it took it, why not otherwise. */
async function resolveInput(actor: HostRunActor, toolUseId: string, value: string): Promise<string | null> {
  const response = await actor.container.fetch(`/inputs/${encodeURIComponent(toolUseId)}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  })
  if (response.ok) return null
  return `${response.status} ${await response.text().catch(() => '')}`
}

/** A script's result as the agent reads it. */
function formatScriptOutput({ exitCode, stdout, stderr }: HostScriptOutput): string {
  return [
    `Exit code: ${exitCode}`,
    stdout ? `stdout:\n${stdout}` : '',
    stderr ? `stderr:\n${stderr}` : '',
  ].filter(Boolean).join('\n\n')
}
