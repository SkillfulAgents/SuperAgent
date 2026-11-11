/**
 * Running an approved computer-use command or host script for one of the
 * agent's requests. The agent's half of the work happens here: its grants,
 * the request's settlement, the container's pending input and the app its
 * commands act in. The machine work itself (driving apps, running the script) is
 * the host's, through the host port.
 *
 * A request gets approved in one of two ways, and both come through here: the
 * user decides in the app (the decision routes), or a grant the agent already
 * holds covers it as it arrives (the actor). Each run claims its request first,
 * so a tool call delivered twice (a subagent's comes on two paths) or a
 * double click never drives the machine twice.
 */
import type { HostCalls, HostPort, HostScriptOutput, ComputerUsePermissionStatus } from './host-port'
import type { ComputerUseOps, ContainerOps, InputOps, MessageOps } from './types'
import type { PendingUserInputRequest } from '@shared/lib/tools/requests/request-schema'
import type { ComputerUsePermissionLevel, PermissionGrantType } from '@shared/lib/computer-use/types'
import { capturesScreen, isSystemTarget } from '@shared/lib/computer-use/commands'
import { background } from '@shared/lib/background'

/** The parts of the agent's actor a run uses. */
export interface HostRunActor {
  /** The agent the runs are for: its computer-use commands run in its sessions, under its cursor. */
  readonly slug: string
  readonly inputs: Pick<InputOps, 'claim' | 'releaseClaim' | 'resolve' | 'complete'> & {
    readonly computerUse: Pick<ComputerUseOps, 'grant' | 'consumeOnce' | 'setActiveApp' | 'clearActiveApp' | 'clearPending'>
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
  /**
   * The latest time (epoch ms) the command may start. One still queued behind
   * the session's earlier commands by then is dropped unrun, so the agent can
   * safely try again; a command that started runs to its own end.
   */
  startBy?: number
}

export interface ScriptRun {
  sessionId: string
  toolUseId: string
  script: string
  scriptType: string
  /** What the user granted with this approval; absent when a grant the agent holds covered it. */
  grantType?: PermissionGrantType
}

/** How a run started by the actor itself (not a decision) can be stopped before the machine work. */
export interface HostRunGuard {
  /**
   * Asked in the same synchronous step as the machine work starts, so a Stop
   * that came after the run claimed its request still stops it. False runs
   * nothing.
   */
  stillWanted?: () => boolean
  /** Called once the machine work has ended (or was never started), before the result is delivered. */
  machineDone?: () => void
}

export type HostRunOutcome =
  /** Ran, and the container has the result. */
  | { status: 'resolved' }
  /** Another decision holds the request; this one did nothing. */
  | { status: 'claimed' }
  /** The call was abandoned (a Stop) before the machine work started; nothing ran. */
  | { status: 'abandoned' }
  /** The call lacks macOS permissions it needs; nothing ran and the request is still open. */
  | { status: 'missing_permissions'; permissions: ComputerUsePermissionStatus }
  /** The command failed; the agent got the error and the request is settled. */
  | { status: 'failed'; error: string }
  /** It ran, but the container would not take the result; the request is still open. */
  | { status: 'undeliverable'; detail: string }

export async function runComputerUse(actor: HostRunActor, host: HostPort, run: ComputerUseRun, guard: HostRunGuard = {}): Promise<HostRunOutcome> {
  const { sessionId, toolUseId, method, params, permissionLevel, appName, grantType, startBy } = run
  const { computerUse } = actor.inputs
  return withClaim(actor, toolUseId, async () => {
    const needs = { screenRecording: capturesScreen(method, params) }
    const permissions = await host.call('computerUsePermissions', needs)
    if (permissions) return { status: 'missing_permissions', permissions }

    // "Once" approves this call alone, which the run does not check again: kept
    // as a grant, it would cover the agent's other calls while this one runs.
    if (grantType && grantType !== 'once') await computerUse.grant(permissionLevel, grantType, appName)

    let result: HostCalls['computerUse']['response']
    try {
      // Checked in the same step as the command starts: nothing in between.
      if (guard.stillWanted && !guard.stillWanted()) return { status: 'abandoned' }
      result = await host.call('computerUse', {
        method,
        params,
        caller: { sessionId, agentSlug: actor.slug },
        ...(startBy !== undefined && { startBy }),
        ...(appName !== undefined && { app: appName }),
      }).finally(() => guard.machineDone?.())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The agent sees the failure as its tool's error.
      await rejectInput(actor, toolUseId, `Error executing ${method}: ${message}`).catch(() => {})
      // The approval was spent on a system failure, not on a decision.
      await computerUse.clearPending(sessionId, toolUseId, 'invalidated')
      return { status: 'failed', error: message }
    }
    if (result.permissionDenied) {
      // A permission believed granted was taken away: nothing ran, and the
      // user is asked for it as before a run.
      const missing = await host.call('computerUsePermissions', needs)
      if (missing) return { status: 'missing_permissions', permissions: missing }
    }
    const output = result.output

    // The app the command acted in is what the session's viewers see the agent
    // working in; closing it ends that. The clipboard or the whole screen is
    // not an app the agent works in.
    const acted = result.app ?? appName
    const targetApp = acted && !isSystemTarget(acted) ? acted : undefined
    if (method === 'close-app') {
      await computerUse.clearActiveApp(sessionId)
      await actor.messages.broadcastEvent(sessionId, { type: 'computer_use_app_changed', app: null })
    } else if (targetApp && (await computerUse.setActiveApp(sessionId, targetApp))) {
      // The name now; the icon when the host has found it.
      await actor.messages.broadcastEvent(sessionId, { type: 'computer_use_app_changed', app: targetApp })
      background(host.call('computerUseAppIcon', { app: targetApp }).then(async (icon) => {
        if (icon) await actor.messages.broadcastEvent(sessionId, { type: 'computer_use_app_changed', app: targetApp, appIcon: icon })
      }).catch(() => {}), { name: 'host-runs.broadcast-app-icon' })
    }

    const undelivered = await resolveInput(actor, toolUseId, output)
    if (undelivered !== null) return { status: 'undeliverable', detail: undelivered }
    await computerUse.clearPending(sessionId, toolUseId, 'answered')
    host.send('analytics', { event: 'computer_use_executed', properties: { method, permissionLevel, grantType } })
    return { status: 'resolved' }
  })
}

export async function runScript(actor: HostRunActor, host: HostPort, run: ScriptRun, guard: HostRunGuard = {}): Promise<HostRunOutcome> {
  const { sessionId, toolUseId, script, scriptType, grantType } = run
  // An "always" grant is a settings write. Saved before the claim, a Stop
  // meanwhile cancels the request and the claim then finds nothing to run; a
  // run that already held the claim would not see that. A timed grant waits
  // for the claim. "Once" approves this script alone and is kept nowhere: as a
  // grant it would approve the agent's other scripts while this one runs.
  if (grantType === 'always') await actor.inputs.computerUse.grant('use_host_shell', 'always')
  return withClaim(actor, toolUseId, async (request) => {
    if (grantType === 'timed') await actor.inputs.computerUse.grant('use_host_shell', 'timed')
    // Checked in the same step as the script starts: nothing in between.
    if (guard.stillWanted && !guard.stillWanted()) return { status: 'abandoned' }
    const result = await host.call('hostScript', { script, scriptType })

    const undelivered = await resolveInput(actor, toolUseId, formatScriptOutput(result))
    if (undelivered !== null) return { status: 'undeliverable', detail: undelivered }
    if (request.autoApproved) {
      // No tab ever showed this request, so none needs telling it settled.
      await actor.inputs.resolve(toolUseId, 'answered')
    } else {
      await actor.inputs.complete(sessionId, toolUseId, 'answered')
    }
    host.send('analytics', { event: 'script_executed', properties: { scriptType, exitCode: result.exitCode } })
    return { status: 'resolved' }
  })
}

// A computer-use command nobody is watching must start within this long, or it
// is dropped unrun (and the agent told so). Once started, it runs to its own
// end: the executor stops one that outlives the budget its flags give it, and
// reports that as a result whose delivery is unknown, never as a failure that
// invites a second try while the first still runs.
const AUTO_RUN_START_MS = 50_000
// A backstop past the executor's longest command (5 minutes) for a host that
// never answers; a script gets this long in all.
const AUTO_RUN_TIMEOUT_MS = { computerUse: AUTO_RUN_START_MS + 6 * 60_000, script: 35_000 }

export type AutoApprovedRun = ({ kind: 'computerUse' } & ComputerUseRun) | ({ kind: 'script' } & ScriptRun)

/**
 * Run a request that a grant the agent already holds covers, as it arrives.
 * Nobody waits on it, so it is settled however it ends: a run that cannot
 * start, fails, or takes too long fails the agent's tool call rather than
 * leaving it parked. A second delivery of the same call finds the first run
 * holding the request and does nothing.
 */
export async function runAutoApproved(actor: HostRunActor, host: HostPort, run: AutoApprovedRun, guard: HostRunGuard = {}): Promise<void> {
  const { sessionId, toolUseId } = run
  const giveUp = async (reason: string) => {
    await rejectInput(actor, toolUseId, reason).catch((error) => {
      console.error(`[HostRuns] Failed to reject ${toolUseId} after a failed auto-run:`, error)
    })
    if (run.kind === 'computerUse') await actor.inputs.computerUse.clearPending(sessionId, toolUseId, 'invalidated')
    else await actor.inputs.resolve(toolUseId, 'invalidated')
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutMs = AUTO_RUN_TIMEOUT_MS[run.kind]
  const timedOut = new Promise<'timed_out'>((resolve) => {
    timer = setTimeout(() => resolve('timed_out'), timeoutMs)
  })
  try {
    const outcome = await Promise.race([
      run.kind === 'computerUse'
        ? runComputerUse(actor, host, { ...run, startBy: run.startBy ?? Date.now() + AUTO_RUN_START_MS }, guard)
        : runScript(actor, host, run, guard),
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
      // Checked before the run started, so only a permission taken away since lands here.
      await giveUp(`Auto-execute failed: this computer is missing macOS permissions computer use needs (${missing.join(', ')}). Nothing was done; the app asks the user for them when you next use the computer.`)
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
