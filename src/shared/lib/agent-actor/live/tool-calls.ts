/**
 * What a tool call the agent finished writing sets in motion on the host's
 * side. Most tools run in the container and need nothing here. The rest:
 *
 * - user-input tools (question, secret, connected account, file, remote MCP,
 *   browser hand-off) park on the user: their request is registered, and the
 *   session reads as waiting;
 * - a capability-gated launch (Task/Agent/Workflow under a 'review' policy)
 *   parks on an approval card;
 * - computer use and host scripts either run at once, when a grant covers
 *   them, or park on an approval card;
 * - host tools (schedules, triggers, webhook endpoints) are the host's to run,
 *   whoever calls them, except the main conversation's own (schedule_resume),
 *   which fail from a subagent;
 * - deliver_file is remembered until its result says the file was delivered
 *   without the host sending it (a sandbox from before it did);
 * - a Task/Agent call starts a subagent entry.
 *
 * Calls arrive by three paths, which act on different subsets, in the order
 * they always have: the main agent's stream, a subagent's stream, and a
 * subagent's complete message (which can repeat a call its stream already
 * delivered; registration is first-delivery-wins, runs claim their request,
 * and a host tool runs once per call).
 */
import type { ContainerClient } from '@shared/lib/container/types'
import { getToolDefinition } from '@shared/lib/tools/registry'
import { runsHostScripts, supportsComputerUse } from '@shared/lib/facts/capabilities'
import { getServerFacts } from '@shared/lib/facts/server-facts'
import { getBlockingUserInputRequestKind } from '@shared/lib/tools/user-input-tools'
import type { AgentInputRequests } from '@shared/lib/tools/requests/agent-input-requests'
import {
  isReplayableUserInputRequest,
  type StreamRequestKind,
  type UserInputRequestOutcome,
} from '@shared/lib/tools/requests/request-schema'
import type { AskUserQuestionInput } from '@shared/lib/tools/ask-user-question/definition'
import type { RequestSecretInput } from '@shared/lib/tools/request-secret/definition'
import type { RequestFileInput } from '@shared/lib/tools/request-file/definition'
import type { RequestConnectedAccountInput } from '@shared/lib/tools/request-connected-account/definition'
import type { RequestRemoteMcpInput } from '@shared/lib/tools/request-remote-mcp/definition'
import type { RequestBrowserInputInput } from '@shared/lib/tools/request-browser-input/definition'
import type { RequestLoginInput } from '@shared/lib/tools/request-login/definition'
import { summarizeLoginFields } from '@shared/lib/tools/request-login/login-request'
import type { RequestScriptRunInput } from '@shared/lib/tools/request-script-run/definition'
import { VALID_SCRIPT_TYPES, getAgentCapabilitySettings } from '@shared/lib/config/settings'
import { sessionCapabilityGrantsResponseSchema } from '@shared/lib/config/capability-policy-schema'
import type { AgentComputerUse } from '@shared/lib/computer-use/agent-permissions'
import { getRequiredPermissionLevel } from '@shared/lib/computer-use/types'
import { commandLineOf, computerUseMethodFromToolName, isComputerUseToolName } from '@shared/lib/computer-use/command-line'
import { callTargets, capturesScreen, type CallTargets } from '@shared/lib/computer-use/commands'
import { background } from '@shared/lib/background'
import { MAIN_THREAD_ONLY_TOOLS, MAIN_THREAD_ONLY_TOOL_MESSAGE } from '../../../../../agent-container/src/main-thread-tools'
import { hostToolNameOf, type HostPort, type HostToolName, type HostToolResult, type LoginDecision } from '../host-port'
import { runAutoApproved, type HostRunActor } from '../host-runs'
import type { SessionEvent } from './session-channel'

export type Capability = 'subagents' | 'workflows'

/** A tool call as the stream delivered it: input as JSON text. */
export interface ToolUse {
  id: string
  name: string
  input: string
}

export interface ToolCallContext {
  readonly agentSlug: string
  readonly sessionId: string
  /** The agent's open requests. */
  readonly requests: AgentInputRequests
  /** The agent's computer-use grants and grabbed app. */
  readonly computerUse: AgentComputerUse
  readonly host: HostPort
  /** The agent's actor, as a computer-use or script run needs it. */
  readonly runs: HostRunActor
  emit(event: SessionEvent): void
  /** The client this session's stream is attached through, when it is. */
  transport(): ContainerClient | undefined
  resolveInput(toolUseId: string, value: string): Promise<void>
  rejectInput(toolUseId: string, reason: string): Promise<void>
  /** Recompute whether the session is waiting on the user (on its live state, after any reattach). */
  syncAwaiting(): void
  /**
   * A request decided without a card (the vault answered a sign-in): its
   * transcript result may still be held back by parallel siblings, and must
   * not be parked again as an ask meanwhile.
   */
  settled(toolUseId: string, outcome: UserInputRequestOutcome): void
  capabilityGranted(capability: Capability): boolean
  grantCapability(capability: Capability): void
  /** A Task/Agent call: the subagent gets an entry. */
  trackSubagentLaunch(toolUseId: string, input: string): void
}

/** The fields each parked user-input tool must carry, and the payload its card shows. */
const USER_INPUT_REQUESTS: Record<
  Exclude<StreamRequestKind, 'script_run' | 'capability_review'>,
  { label: string; payload: (input: Record<string, unknown>) => Record<string, unknown> | string }
> = {
  question: {
    label: 'AskUserQuestion',
    payload: (input) => {
      const { questions } = input as AskUserQuestionInput
      return questions?.length ? { questions } : 'missing questions'
    },
  },
  secret: {
    label: 'secret request',
    payload: (input) => {
      const { secretName, reason } = input as RequestSecretInput
      return secretName ? { secretName, reason } : 'missing secretName'
    },
  },
  connected_account: {
    label: 'connected account request',
    payload: (input) => {
      const { toolkit, reason } = input as RequestConnectedAccountInput
      return toolkit ? { toolkit: toolkit.toLowerCase(), reason } : 'missing toolkit'
    },
  },
  file: {
    label: 'file request',
    payload: (input) => {
      const { description, fileTypes } = input as RequestFileInput
      return description ? { description, fileTypes } : 'missing description'
    },
  },
  remote_mcp: {
    label: 'remote MCP request',
    payload: (input) => {
      const { url, name, reason, authHint, clientId, clientName } = input as RequestRemoteMcpInput
      return url ? { url, name, reason, authHint, clientId, clientName } : 'missing url'
    },
  },
  login: {
    label: 'sign-in request',
    payload: (input) => {
      const { message, fields, username } = input as RequestLoginInput
      // The card draws the model's field list only until the container's
      // context arrives; refs never leave the container's side of the tool.
      // No fields is a page that offers only "Continue with Google".
      return typeof message === 'string' && message.trim() && (fields === undefined || Array.isArray(fields))
        ? { message, fields: summarizeLoginFields(fields), ...(typeof username === 'string' && username.trim() ? { username: username.trim() } : {}) }
        : 'missing message or fields'
    },
  },
  browser_input: {
    label: 'browser input request',
    payload: (input) => {
      const { message, requirements } = input as RequestBrowserInputInput
      // The model controls `requirements`: a non-array (a bare string, say)
      // becomes [] so no renderer calls .map() on it.
      return message ? { message, requirements: Array.isArray(requirements) ? requirements : [] } : 'missing message'
    },
  },
}

const LAUNCH_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent'])
const REVIEWED_LAUNCH_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent', 'Workflow'])

const DELIVER_FILE_TOOL = 'mcp__user-input__deliver_file'
/** How deliver_file answers when the host did not send the file: `File "x" (n bytes) has been delivered …`. */
const SENT_BY_CHAT_CLIENTS = / bytes\) has been delivered to the user\. They can now download it from the chat\.(\n|$)/

/** A computer-use call as read on arrival, before it is placed and checked. */
interface ComputerUseCall {
  method: string
  params: Record<string, unknown>
  permissionLevel: ReturnType<typeof getRequiredPermissionLevel>
  /** The app or system target the call names, when it decides the grant. */
  appName?: string
  /** The machine places the call (its ref, window, point or the focused app). */
  placedByMachine: boolean
}

/** A tool result's text, whether the content is a string or blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('') : ''
}

export class ToolCalls {
  /**
   * deliver_file calls waiting for their result. The file goes to chat
   * clients off the RESULT (which confirms the file exists in the container),
   * never off the streamed input.
   */
  private readonly pendingDeliveries = new Map<string, { filePath: string; description?: string }>()
  /**
   * Capability reviews cancelled before their card existed: the handler looks
   * up the container's grants before it registers the card, so a
   * capability_review_cancelled frame can win that race. Never cleared at turn
   * boundaries (a hung lookup can outlive its turn), and carried across a
   * reattach (it can outlive its attachment too, and the cancellation then
   * lands on the next one); an id never recurs, so a straggler only ever
   * suppresses its own stale card.
   */
  private readonly cancelledReviews: Set<string>
  /**
   * request_login calls the host is deciding (answered from the vault, or a
   * card for the user), by the subagent call that made them, if any. A
   * result arriving meanwhile removes the id, and so do the session going
   * away and that subagent ending: the decision then raises no card for a
   * call nobody can answer.
   */
  private readonly loginDecisions: Map<string, string | undefined>
  /**
   * Host tool calls already run: a subagent's stream and its complete message
   * both carry each call, and a schedule_task run twice is saved twice.
   * Carried across a reattach (the second delivery can land on the next
   * attachment), and never cleared: an id never recurs.
   */
  private readonly hostToolsRun: Set<string>
  /**
   * Host scripts and computer-use commands whose grant check (a settings
   * read, and for a grab by ref a question to the machine) is in flight, by
   * the subagent call that made them, if any. Nothing is registered or run
   * until the check lands, so a Stop meanwhile finds nothing to cancel: it
   * drops the stopped turn's entries instead, as do the call's result, the
   * session going away, its container stopping and that subagent ending,
   * and the check then registers and runs nothing. A second delivery of a
   * call already being checked does nothing either. Carried across a
   * reattach, like the checks.
   */
  private readonly hostRunChecks: Map<string, string | undefined>
  /**
   * The session's computer-use line (computerUse): the work holding it, if
   * any, the calls already handled, and the parked calls holding it until
   * they are decided (by the subagent call that made them, if any). Carried
   * across a reattach, so a new attachment's calls still queue behind the
   * old one's.
   */
  private readonly computerUseLine: {
    tail: Promise<void> | null
    readonly handled: Set<string>
    readonly parked: Map<string, { parentToolUseId: string | undefined; release: () => void }>
  }

  /** `prior`: the tool calls of the attachment this one replaces. */
  constructor(private readonly ctx: ToolCallContext, prior?: ToolCalls) {
    this.cancelledReviews = prior?.cancelledReviews ?? new Set()
    this.loginDecisions = prior?.loginDecisions ?? new Map()
    this.hostToolsRun = prior?.hostToolsRun ?? new Set()
    this.hostRunChecks = prior?.hostRunChecks ?? new Map()
    this.computerUseLine = prior?.computerUseLine ?? { tail: null, handled: new Set(), parked: new Map() }
  }

  /** Stop waiting on the host's sign-in decisions: all of them, or those of the subagent call `parentToolId`. */
  dropLoginDecisions(parentToolId?: string): void {
    for (const [toolUseId, parent] of this.loginDecisions) {
      if (parentToolId === undefined || parent === parentToolId) this.loginDecisions.delete(toolUseId)
    }
  }

  /**
   * Abandon the host-run grant checks in flight whose caller `dropped`
   * selects (`undefined`: the main agent); all of them by default.
   */
  dropHostRunChecks(dropped: (parentToolUseId: string | undefined) => boolean = () => true): void {
    for (const [toolUseId, parent] of this.hostRunChecks) {
      if (dropped(parent)) this.hostRunChecks.delete(toolUseId)
    }
    // Their parked computer-use calls stop holding the session's line: a
    // spared subagent's calls must not wait on a card nobody will answer.
    for (const { parentToolUseId, release } of [...this.computerUseLine.parked.values()]) {
      if (dropped(parentToolUseId)) release()
    }
  }

  /** A tool call on the main agent's stream. */
  mainToolUse(toolUse: ToolUse): void {
    const { name } = toolUse
    if (name === 'AskUserQuestion') {
      this.ctx.host.send('analytics', { event: 'agent_requested_input', properties: { agentSlug: this.ctx.agentSlug } })
    } else if (name.startsWith('mcp__user-input__')) {
      const action = name.replace('mcp__user-input__', '')
      this.ctx.host.send('analytics', { event: `agent_${action}`, properties: { agentSlug: this.ctx.agentSlug } })
    }
    this.parkUserInput(toolUse)
    this.hostTool(toolUse)
    if (this.isScriptRun(name)) background(this.scriptRun(toolUse), { name: 'tool-calls.script-run' })
    if (isComputerUseToolName(name)) background(this.computerUse(toolUse), { name: 'tool-calls.computer-use' })
    // Under a 'review' policy the container parks the launch on an approval;
    // the review itself checks the policy and the session's grants.
    if (REVIEWED_LAUNCH_TOOLS.has(name)) background(this.capabilityReview(toolUse), { name: 'tool-calls.capability-review' })
    if (name === DELIVER_FILE_TOOL) this.rememberDelivery(toolUse)
    if (LAUNCH_TOOLS.has(name)) this.ctx.trackSubagentLaunch(toolUse.id, toolUse.input)
  }

  /** A tool call on a subagent's stream. */
  subagentStreamedToolUse(toolUse: ToolUse, parentToolId: string): void {
    this.parkUserInput(toolUse, parentToolId)
    this.hostTool(toolUse, parentToolId)
    if (this.isScriptRun(toolUse.name)) background(this.scriptRun(toolUse, parentToolId), { name: 'tool-calls.script-run' })
    if (isComputerUseToolName(toolUse.name)) background(this.computerUse(toolUse, parentToolId), { name: 'tool-calls.computer-use' })
    if (LAUNCH_TOOLS.has(toolUse.name)) this.ctx.trackSubagentLaunch(toolUse.id, toolUse.input)
    // A nested launch parks on the same approval as a top-level one.
    if (REVIEWED_LAUNCH_TOOLS.has(toolUse.name)) background(this.capabilityReview(toolUse), { name: 'tool-calls.capability-review' })
  }

  /** A tool call in a subagent's complete message. */
  subagentMessageToolUse(toolUse: ToolUse, parentToolId: string): void {
    if (LAUNCH_TOOLS.has(toolUse.name)) this.ctx.trackSubagentLaunch(toolUse.id, toolUse.input)
    this.parkUserInput(toolUse, parentToolId)
    this.hostTool(toolUse, parentToolId)
    if (this.isScriptRun(toolUse.name)) background(this.scriptRun(toolUse, parentToolId), { name: 'tool-calls.script-run' })
    if (isComputerUseToolName(toolUse.name)) background(this.computerUse(toolUse, parentToolId), { name: 'tool-calls.computer-use' })
  }

  /**
   * Main-stream tool results: a result settles the request it answers, and a
   * deliver_file result tells chat clients the file can go.
   */
  mainToolResults(content: { message?: { content?: unknown } }): void {
    const blocks = Array.isArray(content.message?.content) ? content.message.content : []
    for (const block of blocks as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      this.loginDecisions.delete(block.tool_use_id)
      this.hostRunChecks.delete(block.tool_use_id)
      this.computerUseLine.parked.get(block.tool_use_id)?.release()
      // Its result is in: replaying it to a client that connects later would
      // resurrect a decided card.
      this.ctx.requests.resolveIfInStore(block.tool_use_id, 'stream', block.is_error ? 'declined' : 'answered')
      this.ctx.emit({ type: 'tool_result', toolUseId: block.tool_use_id, result: block.content, isError: block.is_error || false })
      const delivery = this.pendingDeliveries.get(block.tool_use_id)
      if (delivery) {
        this.pendingDeliveries.delete(block.tool_use_id)
        // A sandbox that had the host send the file says what the chat did; one
        // that answered "delivered" without the host (an older one) leaves it to chat clients.
        if (!SENT_BY_CHAT_CLIENTS.test(resultText(block.content))) continue
        this.ctx.emit({
          type: 'tool_result_ready',
          toolName: DELIVER_FILE_TOOL,
          toolUseId: block.tool_use_id,
          filePath: delivery.filePath,
          description: delivery.description,
          isError: block.is_error || false,
        })
      }
    }
    this.ctx.syncAwaiting()
  }

  /**
   * A subagent's tool results, for its parked requests only: ordinary
   * subagent results (Bash, Read, …) stream constantly and must not go out as
   * main-path `tool_result` events.
   */
  subagentToolResults(content: { message?: { content?: unknown } }): void {
    const blocks = content.message?.content
    if (!Array.isArray(blocks)) return
    for (const block of blocks as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      this.loginDecisions.delete(block.tool_use_id)
      this.hostRunChecks.delete(block.tool_use_id)
      this.computerUseLine.parked.get(block.tool_use_id)?.release()
      if (!this.ctx.requests.resolveIfInStore(block.tool_use_id, 'stream', block.is_error ? 'declined' : 'answered')) continue
      // Every other tab drops the card off this (the resolving tab already did).
      this.ctx.emit({ type: 'tool_result', toolUseId: block.tool_use_id, result: block.content, isError: block.is_error || false })
    }
    this.ctx.syncAwaiting()
  }

  /** The container stopped waiting on this review. */
  reviewCancelled(toolUseId: string): 'closed' | 'tombstoned' {
    if (this.ctx.requests.getOpenRequest(toolUseId)) return 'closed'
    // No card yet: the review is still looking up grants. Tombstone it so the
    // card is dropped rather than shown after this cancellation.
    this.cancelledReviews.add(toolUseId)
    return 'tombstoned'
  }

  /**
   * Re-register parked asks the one-shot stream event was missed for, but
   * whose unanswered call the transcript shows. Marked `recovered`: they
   * carry no payload, so clients render them from the transcript.
   */
  recoverParked(unresolved: Array<{ toolUseId: string; toolName: string }>): void {
    for (const { toolUseId, toolName } of unresolved) {
      const kind = getBlockingUserInputRequestKind(toolName)
      if (!kind || this.ctx.requests.getOpenRequest(toolUseId)) continue
      // The host is deciding it: the vault may answer it, and a card is raised only if not.
      if (this.loginDecisions.has(toolUseId)) continue
      this.register(kind, toolUseId, { recovered: true })
    }
  }

  private isScriptRun(name: string): boolean {
    return getToolDefinition(name)?.request?.kind === 'script_run'
  }

  private register(
    kind: StreamRequestKind | 'computer_use',
    id: string,
    payload: Record<string, unknown>,
    opts: { parentToolUseId?: string; autoApproved?: boolean } = {},
  ): void {
    this.ctx.requests.register({
      id,
      kind,
      scope: { agentSlug: this.ctx.agentSlug, sessionId: this.ctx.sessionId },
      blocking: true,
      autoApproved: opts.autoApproved === true,
      parentToolUseId: opts.parentToolUseId,
      payload,
    })
  }

  /** A user-input tool parks on the user: its request opens, and the session waits. */
  private parkUserInput(toolUse: ToolUse, parentToolUseId?: string): void {
    const kind = getBlockingUserInputRequestKind(toolUse.name)
    if (!kind || kind === 'script_run' || kind === 'capability_review') return
    // First delivery wins. A recovered stub does not count: the real delivery
    // must replace it with a renderable one.
    const existing = this.ctx.requests.getOpenRequest(toolUse.id)
    if (existing && isReplayableUserInputRequest(existing)) return

    const { label, payload } = USER_INPUT_REQUESTS[kind]
    let input: Record<string, unknown>
    try {
      input = JSON.parse(toolUse.input)
    } catch {
      console.error(`[LiveSession] Failed to parse ${label} input:`, toolUse.input)
      this.ctx.syncAwaiting()
      return
    }
    try {
      const card = payload(input ?? {})
      if (typeof card === 'string') {
        console.error(`[LiveSession] ${label}: ${card}`)
      } else if (kind === 'login') {
        this.decideLogin(toolUse, card, parentToolUseId)
      } else {
        this.register(kind, toolUse.id, card, { parentToolUseId })
        if (kind === 'browser_input') this.captureBrowserContext(toolUse.id)
      }
    } catch (error) {
      // A field of the wrong type (the model writes these).
      console.error(`[LiveSession] Error handling ${label}:`, error)
    }
    this.ctx.syncAwaiting()
  }

  /**
   * A sign-in request: the host answers it from the user's vault when it can
   * (filling a saved account, or listing the agent's accounts on the site),
   * and only otherwise does a card open for the user. Until it decides, the
   * session is not waiting on anyone, so nothing notifies the user of a
   * sign-in that needs nobody.
   */
  private decideLogin(toolUse: ToolUse, card: Record<string, unknown>, parentToolUseId?: string): void {
    // The stream and the complete message both carry the call.
    if (this.loginDecisions.has(toolUse.id)) return
    this.loginDecisions.set(toolUse.id, parentToolUseId)
    background(async () => {
      let decision: LoginDecision
      try {
        decision = await this.ctx.host.call('loginRequest', {
          agentSlug: this.ctx.agentSlug,
          sessionId: this.ctx.sessionId,
          toolUseId: toolUse.id,
          input: toolUse.input,
        })
      } catch (error) {
        console.error('[LiveSession] Deciding a sign-in request failed:', error instanceof Error ? error.message : error)
        decision = { action: 'ask', vault: { mode: 'new' } }
      }
      // Removed by the call's result: it ended while the host decided.
      if (!this.loginDecisions.delete(toolUse.id)) return
      if (decision.action !== 'ask') {
        this.ctx.settled(toolUse.id, decision.action === 'settled' ? 'answered' : 'cancelled')
        return
      }
      this.register('login', toolUse.id, { ...card, vault: decision.vault, ...(decision.login ? { login: decision.login } : {}) }, { parentToolUseId })
      this.ctx.syncAwaiting()
    }, { name: 'tool-calls.decide-login' })
  }

  /**
   * The page a browser hand-off was asked on, observed now. It is host
   * context, never a field the model supplies; the credential fill re-checks
   * the live origin before a password crosses the boundary.
   */
  private captureBrowserContext(toolUseId: string): void {
    const client = this.ctx.transport()
    if (!client) return
    background(
      client
        .fetch(`/browser/credential-context?sessionId=${encodeURIComponent(this.ctx.sessionId)}`)
        .then(async (response) => {
          if (!response?.ok || typeof response.json !== 'function') return
          const context = (await response.json()) as { url?: unknown }
          if (typeof context.url !== 'string') return
          this.ctx.requests.enrichOpenRequestPayload(toolUseId, 'browser_input', {
            browserContext: { url: context.url, capturedAt: Date.now() },
          })
        })
        .catch((error: unknown) => {
          console.warn('[LiveSession] Failed to capture browser input context:', error instanceof Error ? error.message : error)
        }),
      { name: 'tool-calls.capture-browser-context' },
    )
  }

  /** A host tool's call, from the main agent or the subagent `parentToolUseId`: run once. */
  private hostTool(toolUse: ToolUse, parentToolUseId?: string): void {
    const toolName = hostToolNameOf(toolUse.name)
    if (!toolName || this.hostToolsRun.has(toolUse.id)) return
    this.hostToolsRun.add(toolUse.id)
    if (parentToolUseId && MAIN_THREAD_ONLY_TOOLS.has(toolUse.name)) {
      // The container's hook denies it first; failing it here unblocks a call
      // that got past the hook anyway.
      background(this.ctx.rejectInput(toolUse.id, MAIN_THREAD_ONLY_TOOL_MESSAGE).catch(console.error), {
        name: 'tool-calls.reject-main-thread-tool',
      })
      return
    }
    this.runHostTool(toolUse, toolName)
  }

  /**
   * A host tool: the host does the work, and its result goes back to the
   * container's pending input. Once the host has decided, a failed delivery
   * is only logged: rejecting then could tell the agent a saved schedule
   * failed, and it would retry into a duplicate.
   */
  private runHostTool(toolUse: ToolUse, toolName: HostToolName): void {
    background(async () => {
      let result: HostToolResult
      try {
        result = await this.ctx.host.call('hostTool', {
          agentSlug: this.ctx.agentSlug,
          sessionId: this.ctx.sessionId,
          toolUseId: toolUse.id,
          toolName,
          input: toolUse.input,
        })
      } catch (error) {
        console.error(`[LiveSession] Host tool ${toolName} failed:`, error)
        result = { status: 'rejected', reason: `Failed to run ${toolName}: ${error instanceof Error ? error.message : String(error)}` }
      }
      if (result.status === 'rejected') {
        await this.ctx.rejectInput(toolUse.id, result.reason).catch(console.error)
        return
      }
      for (const event of result.sessionEvents ?? []) this.ctx.emit(event as SessionEvent)
      await this.ctx.resolveInput(toolUse.id, result.value).catch((error) => {
        console.error(`[LiveSession] ${toolName} succeeded but its result was not delivered:`, error)
      })
    }, { name: 'tool-calls.run-host-tool' })
  }

  /** A host script: run at once under a use_host_shell grant, otherwise park on an approval. */
  private async scriptRun(toolUse: ToolUse, parentToolUseId?: string): Promise<void> {
    let input: RequestScriptRunInput
    try {
      input = JSON.parse(toolUse.input)
    } catch {
      console.error('[LiveSession] Failed to parse script run request:', toolUse.input)
      return
    }
    if (!input.script || !input.scriptType) {
      console.error('[LiveSession] Script run request missing required fields')
      return
    }
    const platform = process.platform
    if (!runsHostScripts(getServerFacts())) {
      this.autoReject(toolUse.id, 'Host scripts are not available in the Mac App Store edition, whose sandbox confines what the app runs.')
      return
    }
    const supported = VALID_SCRIPT_TYPES[platform]
    if (!supported) {
      this.autoReject(toolUse.id, `Host script execution is not supported on this platform (${platform}). Only macOS and Windows are supported.`)
      return
    }
    if (!supported.includes(input.scriptType as (typeof supported)[number])) {
      this.autoReject(toolUse.id, `Script type "${input.scriptType}" is not supported on ${platform}. Supported types: ${supported.join(', ')}`)
      return
    }

    const { script, scriptType } = input

    // Registered either way, flagged when a grant covers it: the client then
    // suppresses any fallback prompt for the brief window before the result.
    // The persisted grants are a settings read.
    await this.checkGrant(toolUse.id, parentToolUseId, async () =>
      (await this.ctx.computerUse.check('use_host_shell')) === 'granted', (autoApproved, stillWanted) => {
      this.register('script_run', toolUse.id, { script, explanation: input.explanation, scriptType }, {
        parentToolUseId,
        autoApproved,
      })
      if (autoApproved) {
        // After the registration: the run claims the request it settles.
        background(runAutoApproved(this.ctx.runs, this.ctx.host, {
          kind: 'script',
          sessionId: this.ctx.sessionId,
          toolUseId: toolUse.id,
          script,
          scriptType,
        }, { stillWanted }), { name: 'tool-calls.auto-run-script' })
      } else {
        // Parked on the user: a Stop cancels the registered request from here on.
        stillWanted()
        // Only a request the user must answer makes the session wait.
        this.ctx.syncAwaiting()
      }
    })
  }

  /**
   * A computer-use command: run when a grant covers it, otherwise park on an
   * approval. The session's calls are handled one at a time in the order they
   * arrive: calls sent together mean that order (click, then screenshot), and
   * each one's preparation (placing it in an app, the grant check) takes its
   * own time, so handling them side by side let a later call overtake an
   * earlier one. A call holds the line while it is placed, checked and run,
   * and while it is parked on an approval, until the user's decision has run
   * (a later screenshot then shows what an approved click did). Each call's
   * grant check is held in `hostRunChecks` from the moment it arrives, so a
   * Stop drops a call still waiting its turn as well as one being checked,
   * and releases its caller's parked calls.
   */
  private computerUse(toolUse: ToolUse, parentToolUseId?: string): Promise<void> {
    const call = this.computerUseCall(toolUse)
    if (!call || this.hostRunChecks.has(toolUse.id)) return Promise.resolve()
    this.hostRunChecks.set(toolUse.id, parentToolUseId)
    const line = this.computerUseLine
    const turn = (line.tail ?? Promise.resolve()).then(() => this.decideComputerUse(toolUse, parentToolUseId, call))
    const tail: Promise<void> = turn.catch(() => {}).then(() => {
      if (line.tail === tail) line.tail = null
    })
    line.tail = tail
    return turn
  }

  /**
   * The command a computer-use call asks for, and how its app is found; none
   * when the call was handled before (a subagent's arrives once streamed and
   * again in its message), cannot be read, or was refused at once.
   */
  private computerUseCall(toolUse: ToolUse): ComputerUseCall | undefined {
    if (this.computerUseLine.handled.has(toolUse.id)) return undefined
    // mcp__agent-desktop__computer_set_value → set-value, with the tool's
    // params as the command's arguments; agent_desktop names its command.
    let params: Record<string, unknown>
    try {
      params = toolUse.input.trim() ? JSON.parse(toolUse.input) : {}
    } catch {
      console.error('[LiveSession] Failed to parse computer use request:', toolUse.input)
      return undefined
    }
    this.computerUseLine.handled.add(toolUse.id)
    // The permission level, the card and the executor all see the command line.
    const { method, params: commandParams } = commandLineOf(computerUseMethodFromToolName(toolUse.name), params)

    // macOS and Windows outside the Mac App Store edition (the mock E2E
    // runtime drives no machine).
    if (process.env.E2E_MOCK !== 'true' && !supportsComputerUse(getServerFacts())) {
      this.autoReject(toolUse.id, `Computer use is not available on this machine (${process.platform}). It needs macOS or Windows, and is not in the Mac App Store edition.`)
      return undefined
    }

    const permissionLevel = getRequiredPermissionLevel(method, commandParams)
    if (permissionLevel !== 'use_application') return { method, params: commandParams, permissionLevel, placedByMachine: false }
    // The app the command acts in. A command that names only an app, or acts
    // on something that is not an app (the clipboard, the whole screen), is
    // judged by it at once; one that names a ref, a window or a point, or
    // names no app but acts in whatever app has focus, is placed by the
    // machine, which knows the snapshot or window it came from and what is
    // on screen.
    // A call no single approval can cover (a batch across apps, say) is
    // refused here, as the executor would refuse it, before any card.
    let targets: CallTargets
    try {
      targets = callTargets(method, commandParams)
    } catch (error) {
      this.autoReject(toolUse.id, error instanceof Error ? error.message : String(error))
      return undefined
    }
    const placedByMachine = targets.snapshotIds.length > 0
      || targets.windowIds.length > 0
      || (targets.points?.length ?? 0) > 0
      || targets.focused === true
    return {
      method,
      params: commandParams,
      permissionLevel,
      placedByMachine,
      ...(!placedByMachine && { appName: targets.app ?? targets.system }),
    }
  }

  /**
   * Place the call (when the machine must), check its grant, then run it or
   * park it on an approval card; resolved when the line may move on (see
   * computerUse). Placed before the check, so a failure here leaves nothing
   * parked; unplaced, the check needs a grant for no app.
   */
  private async decideComputerUse(toolUse: ToolUse, parentToolUseId: string | undefined, call: ComputerUseCall): Promise<void> {
    const { method, params, permissionLevel } = call
    let appName = call.appName
    let refused: string | undefined
    let holding: Promise<void> | undefined
    await this.checkHeldGrant(toolUse.id, async () => {
      if (call.placedByMachine) {
        try {
          const placed = await this.ctx.host.call('computerUseTargetApp', { method, params })
          if (typeof placed === 'object' && placed !== null) {
            refused = placed.refused
            return false
          }
          appName = placed
        } catch {
          // Proceed without the app name.
        }
      }
      if ((await this.ctx.computerUse.check(permissionLevel, appName, this.ctx.sessionId)) !== 'granted') return false
      // Unattended only with the macOS permissions it needs: without one, it
      // waits on the user, whose approval asks for it.
      const missing = await this.ctx.host.call('computerUsePermissions', { screenRecording: capturesScreen(method, params) }).catch(() => null)
      return missing === null
    }, (granted, stillWanted) => {
      // The machine will refuse it whatever is approved: refused now, with no card.
      if (refused !== undefined) {
        stillWanted()
        this.autoReject(toolUse.id, refused)
        return
      }
      const payload = { method, params, permissionLevel, appName }
      if (granted) {
        // Registered anyway, flagged so no projection reads it as a wait: the
        // run claims the request it settles, as a decision in the app does.
        this.register('computer_use', toolUse.id, payload, { parentToolUseId, autoApproved: true })
        // The session's next call waits for this run's machine work, not
        // for its delivery to the container.
        holding = new Promise<void>((machineDone) => {
          background(runAutoApproved(this.ctx.runs, this.ctx.host, {
            kind: 'computerUse',
            sessionId: this.ctx.sessionId,
            toolUseId: toolUse.id,
            method,
            params,
            permissionLevel,
            appName,
          }, { stillWanted, machineDone }).finally(machineDone), { name: 'tool-calls.auto-run-computer-use' })
        })
        return
      }
      this.register('computer_use', toolUse.id, payload, { parentToolUseId })
      // Parked on the user: a Stop cancels the registered request from here on.
      stillWanted()
      this.ctx.syncAwaiting()
      holding = this.holdWhileParked(toolUse.id, parentToolUseId)
    })
    await holding
  }

  /**
   * A parked call's hold on the line: released once its request settles (the
   * user's decision ran, or was a denial), its result comes in, a Stop drops
   * its caller, or the next turn supersedes it.
   */
  private holdWhileParked(toolUseId: string, parentToolUseId: string | undefined): Promise<void> {
    return new Promise<void>((resolve) => {
      const { parked } = this.computerUseLine
      const release = () => {
        if (parked.get(toolUseId)?.release === release) parked.delete(toolUseId)
        resolve()
      }
      parked.set(toolUseId, { parentToolUseId, release })
      this.ctx.requests.onSettled(toolUseId, release)
    })
  }

  /**
   * A Task/Agent/Workflow launch under a 'review' policy parks in the
   * container's canUseTool on a pending input keyed by the call: the card
   * asks for the decision. Under 'allow', 'block' or an "allow for this
   * session" grant the container never parks, so there is no card.
   */
  private async capabilityReview(toolUse: ToolUse): Promise<void> {
    try {
      const capability: Capability = toolUse.name === 'Workflow' ? 'workflows' : 'subagents'
      if ((await getAgentCapabilitySettings())[capability] !== 'review') return
      if (this.ctx.capabilityGranted(capability)) return

      // The grant mirror here is only a fast path: the container's persisted
      // grants are authoritative. A fresh host process attached to a live,
      // granted session would otherwise show a card the container never waits on.
      const client = this.ctx.transport()
      if (client) {
        try {
          const response = await client.fetch(`/sessions/${encodeURIComponent(this.ctx.sessionId)}/capability-grants`, { method: 'GET' })
          if (response.ok) {
            const { grants } = sessionCapabilityGrantsResponseSchema.parse(await response.json())
            if (grants.includes(capability)) {
              this.ctx.grantCapability(capability)
              return
            }
          }
        } catch (error) {
          // Show the card: a review the container isn't waiting on beats a
          // launch that silently skips review.
          console.warn('[LiveSession] Capability grant lookup failed; showing review card:', error)
        }
      }

      // The container may have stopped waiting while the lookup ran
      // (interrupts make this common): consume the tombstone, or the card
      // would come back unanswerable and mark the session waiting.
      if (this.cancelledReviews.delete(toolUse.id)) return

      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(toolUse.input)
      } catch {
        // An unparseable launch still needs a decision: show what there is.
      }
      this.register('capability_review', toolUse.id, { capability, toolName: toolUse.name, input })
      this.ctx.syncAwaiting()
    } catch (error) {
      console.error('[LiveSession] Error handling capability review:', error)
    }
  }

  /**
   * A host run's grant check, held in `hostRunChecks` while it is in flight,
   * then `proceed(granted, stillWanted)`, which registers (and, when granted,
   * starts) the run. `proceed` is called in the same synchronous step that
   * finds the check still wanted: returning the answer for the caller to act
   * on would leave microtasks in which a Stop finds neither a pending check to
   * drop nor a registered request to cancel. The entry stays held until
   * `stillWanted()` consumes it: at once for a request parked on the user
   * (from then on a Stop cancels the registered request), or by an auto-run
   * in the same step as the machine work starts (a claimed run does not see
   * the request's cancellation). Nothing is called when the call was
   * abandoned meanwhile (see `hostRunChecks`), or is a second delivery of a
   * call already being checked.
   */
  private async checkGrant(
    toolUseId: string,
    parentToolUseId: string | undefined,
    check: () => Promise<boolean>,
    proceed: (granted: boolean, stillWanted: () => boolean) => void,
  ): Promise<void> {
    if (this.hostRunChecks.has(toolUseId)) return
    this.hostRunChecks.set(toolUseId, parentToolUseId)
    await this.checkHeldGrant(toolUseId, check, proceed)
  }

  /**
   * `checkGrant` for a call whose entry in `hostRunChecks` was taken earlier
   * (computerUse takes it as the call arrives); nothing when the entry was
   * dropped meanwhile.
   */
  private async checkHeldGrant(
    toolUseId: string,
    check: () => Promise<boolean>,
    proceed: (granted: boolean, stillWanted: () => boolean) => void,
  ): Promise<void> {
    if (!this.hostRunChecks.has(toolUseId)) return
    let granted: boolean
    try {
      granted = await check()
    } catch (error) {
      this.hostRunChecks.delete(toolUseId)
      throw error
    }
    if (!this.hostRunChecks.has(toolUseId)) return
    proceed(granted, () => this.hostRunChecks.delete(toolUseId))
  }

  private rememberDelivery(toolUse: ToolUse): void {
    try {
      const parsed = JSON.parse(toolUse.input)
      if (parsed && typeof parsed.filePath === 'string') {
        this.pendingDeliveries.set(toolUse.id, {
          filePath: parsed.filePath,
          description: typeof parsed.description === 'string' ? parsed.description : undefined,
        })
      }
    } catch {
      // Partial or invalid JSON: nothing to deliver.
    }
  }

  private autoReject(toolUseId: string, reason: string): void {
    background(this.ctx.rejectInput(toolUseId, reason).catch((error: unknown) => {
      console.error('[LiveSession] Failed to auto-reject input request:', error)
    }), { name: 'tool-calls.auto-reject' })
  }
}
