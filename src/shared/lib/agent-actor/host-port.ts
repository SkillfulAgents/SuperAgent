/**
 * The actor's one way back to the host.
 *
 * An agent's sessions need things done that are not the agent's own state:
 * host tools that read and write the app database (schedules, triggers,
 * webhook endpoints), work on the machine the host runs on (computer use,
 * host scripts), and side effects other parts of the app react to (the global
 * feed, notifications, analytics). The actor asks for all of them here.
 *
 * - `call` waits for the host's answer.
 * - `send` hands over a side effect and returns at once. The actor never
 *   learns whether its handler succeeded, so nothing the actor decides may
 *   depend on one.
 *
 * Requests, results and events are plain data: no functions, no promises, no
 * handles. The port can then be a function call (an actor in this process) or
 * a network hop (an actor in a Durable Object) without either side changing.
 */
import type { GlobalFeedEvent } from '@shared/lib/notifications/global-feed'
import type { PendingUserInputRequest } from '@shared/lib/tools/requests/request-schema'
import type { SessionEvent } from './live/session-channel'

export interface HostCalls {
  /** Run a host tool for a session. The actor delivers the outcome to the container. */
  hostTool: { request: HostToolRequest; response: HostToolResult }
  /** Run one computer-use command on this machine; resolves to its output, rejects with its error. */
  computerUse: { request: { method: string; params: Record<string, unknown> }; response: string }
  /** The macOS permissions computer use needs on this machine, or null when it has them all. */
  computerUsePermissions: { request: Record<string, never>; response: ComputerUsePermissionStatus | null }
  /** The app that owns a window ref, resolved on this machine; undefined when it cannot be. */
  computerUseWindowApp: { request: { ref: string }; response: string | undefined }
  /** An app's icon as base64 PNG, from this machine; null when it has none. */
  computerUseAppIcon: { request: { app: string }; response: string | null }
  /** Run a script on this machine. A script that fails still resolves, with its exit code. */
  hostScript: { request: { script: string; scriptType: string }; response: HostScriptOutput }
  /** Answer a request_login call from the user's vault, or say how to leave it for the user. */
  loginRequest: { request: LoginRequestCall; response: LoginDecision }
}

/** A request_login call, with its raw streamed input. */
export interface LoginRequestCall {
  agentSlug: string
  sessionId: string
  toolUseId: string
  input: string
}

/**
 * How the host decided a request_login call:
 * - settled: answered without the user (filled from the vault, or the
 *   saved accounts listed), so no card;
 * - none: the call already ended (its fields could not be used), so no card;
 * - ask: the user answers it: the card opens with `vault` (how the form
 *   starts) and `login` (the located fields' context) on its payload.
 */
export type LoginDecision =
  | { action: 'settled' }
  | { action: 'none' }
  | { action: 'ask'; vault: Record<string, unknown>; login?: Record<string, unknown> }

export interface HostEvents {
  /** An event for the global feed. */
  global: GlobalFeedEvent
  /** A notification about a session, for the notification manager. */
  notification: SessionNotification
  /** A product analytics event. */
  analytics: { event: string; properties?: Record<string, unknown> }
  /** An event on a session's stream, for the host's own consumers (chat replies). */
  session: { agentSlug: string; sessionId: string; event: SessionEvent }
}

/** A session-scoped host tool the agent called, with its raw streamed input. */
export interface HostToolRequest {
  agentSlug: string
  sessionId: string
  toolUseId: string
  /** The tool's bare name, e.g. `schedule_task`. */
  toolName: HostToolName
  /** The tool input as the agent streamed it: JSON text, not yet parsed. */
  input: string
}

export const HOST_TOOL_NAMES = [
  'schedule_task',
  'schedule_resume',
  'list_scheduled_tasks',
  'update_scheduled_task',
  'cancel_scheduled_task',
  'pause_scheduled_task',
  'resume_scheduled_task',
  'get_available_triggers',
  'setup_trigger',
  'list_triggers',
  'update_trigger',
  'cancel_trigger',
  'create_webhook_endpoint',
  'update_webhook_endpoint',
  'inspect_webhook_events',
] as const

export type HostToolName = (typeof HOST_TOOL_NAMES)[number]

// The container serves the host tools from its user-input MCP server.
const HOST_TOOL_PREFIX = 'mcp__user-input__'
const hostToolNames: ReadonlySet<string> = new Set(HOST_TOOL_NAMES)

/** The host tool a streamed tool name calls, or null when it calls none. */
export function hostToolNameOf(toolName: string): HostToolName | null {
  if (!toolName.startsWith(HOST_TOOL_PREFIX)) return null
  const bare = toolName.slice(HOST_TOOL_PREFIX.length)
  return hostToolNames.has(bare) ? (bare as HostToolName) : null
}

/**
 * What a host tool decided. `resolved` carries the text the agent reads as the
 * tool's result, and the events to put on the session's own stream before it
 * is delivered (a tool card linking to the task it created, say); `rejected`
 * carries the error the agent reads instead.
 */
export type HostToolResult =
  | { status: 'resolved'; value: string; sessionEvents?: Record<string, unknown>[] }
  | { status: 'rejected'; reason: string }

/** Each permission, true when granted, as the AC daemon reports them; the decision route hands this shape to the client. */
export interface ComputerUsePermissionStatus {
  accessibility: boolean
  screen_recording: boolean
}

export interface HostScriptOutput {
  /** The exit status, or the spawn error's name (ENOENT) when the interpreter could not run. */
  exitCode: number | string
  stdout: string
  stderr: string
}

export type SessionNotification =
  | {
      kind: 'session_complete'
      agentSlug: string
      sessionId: string
      /** The turn's final answer, for the notification body. */
      responseText: string
      /** Where the transcript ended when the turn did; bounds the body's context lookup. */
      responseTranscriptEndOffset: number | null
    }
  | {
      kind: 'session_waiting_input'
      agentSlug: string
      sessionId: string
      request: Pick<PendingUserInputRequest, 'kind' | 'payload'>
    }
  | {
      kind: 'api_review_waiting'
      agentSlug: string
      sessionId: string
      reviewId: string
      displayText: string
      reviewKind: 'api_request' | 'agent_action'
    }
  | {
      /** A queued message a Stop discarded: it never ran, so what it notified is taken back. */
      kind: 'message_discarded'
      agentSlug: string
      sessionId: string
      messageUuid: string
    }

export interface HostPort {
  call<N extends keyof HostCalls>(name: N, request: HostCalls[N]['request']): Promise<HostCalls[N]['response']>
  send<N extends keyof HostEvents>(name: N, event: HostEvents[N]): void
}

export type HostCallHandlers = {
  [N in keyof HostCalls]: (request: HostCalls[N]['request']) => Promise<HostCalls[N]['response']>
}

export type HostEventHandlers = {
  [N in keyof HostEvents]: (event: HostEvents[N]) => void | Promise<void>
}

/**
 * The port for an actor in this process: a call is a function call, and a
 * send runs its handler at once, in the order sent.
 *
 * Synchronous on purpose. The host also publishes to the global feed
 * directly (container status, readiness), and the order of those events
 * relative to the actor's must not depend on which side published them; a
 * deferred queue would let a later direct publish overtake an earlier send.
 * A handler that throws, or whose promise rejects, is logged and goes no
 * further.
 */
export function createLocalHostPort(handlers: { calls: HostCallHandlers; events: HostEventHandlers }): HostPort {
  return {
    call: (name, request) => handlers.calls[name](request),
    send: (name, event) => {
      try {
        const result = handlers.events[name](event)
        if (result) {
          result.catch((error: unknown) => {
            console.error(`[HostPort] '${name}' handler failed:`, error)
          })
        }
      } catch (error) {
        console.error(`[HostPort] '${name}' handler failed:`, error)
      }
    },
  }
}
