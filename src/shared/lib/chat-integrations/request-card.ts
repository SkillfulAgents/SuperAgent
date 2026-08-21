/**
 * Registry envelope → the card shape connectors render.
 *
 * Chat used to consume the eight legacy per-type SSE events directly, which
 * made it a second reader of "what is the agent blocked on" — one that missed
 * recovered registrations, had no resolved signal, and silently dropped any
 * kind nobody remembered to wire up. Everything chat renders now derives from
 * the one registry event (`user_request_created`) through this module; the
 * per-connector `sendUserRequestCard` switches are unchanged and still see the
 * card shapes they always did.
 */

import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import type {
  PendingUserInputRequest,
  UserInputRequestKind,
} from '@shared/lib/user-input/request-schema'
import { formatProviderName } from './utils'

/**
 * Kind → the card `type` a connector switches on.
 *
 * Total on purpose: a twelfth request kind is a compile error here until
 * someone decides what chat does with it. Connectors render an unknown type as
 * the "finish this in the app" notice via their switch default, so the only
 * way a kind can go silent in chat is an explicit `null` in this table.
 *
 * The two review kinds are null: they are agent-scoped, arrive on the global
 * notification channel rather than any session stream, and render as the
 * synthetic Allow/Deny card `reviewCardFromRegistry` builds.
 */
const KIND_TO_CARD_TYPE: Record<UserInputRequestKind, UserRequestEvent['type'] | null> = {
  question: 'question_request',
  secret: 'secret_request',
  connected_account: 'connected_account_request',
  file: 'file_request',
  remote_mcp: 'remote_mcp_request',
  browser_input: 'browser_input_request',
  script_run: 'script_run_request',
  capability_review: 'capability_review_request',
  computer_use: 'computer_use_request',
  proxy_review: null,
  x_agent_review: null,
  account_reauth_required: null,
  mcp_reauth_required: null,
}

/**
 * The card for a session-scoped request, or null when chat should stay quiet.
 *
 * Auto-approved asks are the quiet case: they are visible-but-not-blocking (the
 * host is already executing them, `isRealWait` reads false), and chat's only
 * rendering for those kinds is "go finish this in the app" — which would send
 * the user to a screen with nothing on it.
 */
export function requestCardFromRegistry(request: PendingUserInputRequest): UserRequestEvent | null {
  const type = KIND_TO_CARD_TYPE[request.kind]
  if (!type) return null
  if (request.autoApproved) return null
  return {
    // Payload first: `type` and `toolUseId` are ours to set, and a malformed
    // tool input must not be able to redirect the card it renders as.
    ...(request.payload as Record<string, unknown>),
    type,
    toolUseId: request.id,
    ...(request.scope.agentSlug ? { agentSlug: request.scope.agentSlug } : {}),
  } as UserRequestEvent
}

/**
 * The synthetic Allow/Deny question card for an agent-scoped review.
 *
 * `toolUseId` keeps the `review:<id>:<agent>` convention byte-for-byte: it is
 * what `handleInteractiveResponse` splits on to route the press back to
 * ReviewManager rather than to a container input.
 */
export function reviewCardFromRegistry(request: PendingUserInputRequest): UserRequestEvent | null {
  if (request.kind !== 'proxy_review' && request.kind !== 'x_agent_review') return null
  const agentSlug = request.scope.agentSlug
  if (!agentSlug) return null

  const payload = request.payload as { displayText?: unknown; toolkit?: unknown }
  const displayText =
    typeof payload.displayText === 'string' && payload.displayText
      ? payload.displayText
      : 'Allow this action?'
  const toolkit = typeof payload.toolkit === 'string' ? payload.toolkit : ''
  const text = toolkit
    ? `🔐 *${formatProviderName(toolkit)} — Permission Request*\n${displayText}`
    : `🔐 *Permission Request*\n${displayText}`

  return {
    type: 'question_request',
    toolUseId: `review:${request.id}:${agentSlug}`,
    questions: [
      {
        question: text,
        options: [{ label: '✅ Allow' }, { label: '❌ Deny' }],
      },
    ],
    agentSlug,
  }
}
